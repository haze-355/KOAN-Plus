chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});

const AUTH_DB_NAME = "koan-plus-secrets-v1";
const AUTH_STORE_NAME = "vault";
const AUTH_RECORD_KEY = "primary";
const AUTH_ORIGIN = "https://ou-idp.auth.osaka-u.ac.jp";
const MFA_ORIGIN = "https://auth-mfa.auth.osaka-u.ac.jp";
const KOAN_PORTAL_URL = "https://koan.osaka-u.ac.jp/campusweb/campusportal.do?page=main";
const CLE_ORIGIN = "https://www.cle.osaka-u.ac.jp";
const CLE_HOME_URL = `${CLE_ORIGIN}/ultra`;
const CLE_PROBE_URL = `${CLE_ORIGIN}/learn/api/v1/messages/summary?offset=0&limit=1`;
const MAX_CLE_RESPONSE_TEXT_LENGTH = 10 * 1024 * 1024;
const MFA_REGISTRATION_PATH = "/AttributeRegistSite/MfaInfoServlet";
const MFA_PENDING_TTL_MS = 10 * 60 * 1000;
const MFA_AUTO_FLOW_TTL_MS = 2 * 60 * 1000;
const EXTENSION_ONLY_AUTH_TYPES = new Set([
  "auth-check-login",
  "auth-claim-startup-refresh",
  "auth-claim-dashboard-refresh",
  "auth-settings",
  "auth-get-secrets",
  "auth-focus-pending-mfa",
  "auth-mfa-registration-result",
  "auth-mfa-cancel-auto-tab",
  "auth-delete",
  "auth-delete-mfa",
  "auth-save",
  "auth-ensure-koan",
  "auth-ensure-cle",
  "auth-refresh-cle",
  "auth-open-url",
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let koanLoginTask;
let cleLoginTask;
const loginTabs = new Map();
const LOGIN_TAB_KEY_PREFIX = "authLoginTab:";
const manualFlows = new Map();
let pendingMfa = null;
const PENDING_MFA_KEY = "authPendingMfa";
const AUTO_COLLECT_TAB_IDS_KEY = "authAutoCollectTabIds";
const MFA_AUTO_FLOW_KEY_PREFIX = "authMfaAutoFlow:";
const MANUAL_FLOW_KEY_PREFIX = "authManualFlow:";
const MANUAL_FLOW_TTL_MS = 5 * 60 * 1000;
const STARTUP_REFRESH_CLAIMED_KEY = "startupRefreshClaimed";
const DASHBOARD_REFRESH_ATTEMPT_KEY = "dashboardRefreshAttempt";
const autoCollectTabIds = new Set();
let startupRefreshClaimTask = Promise.resolve();
let dashboardRefreshClaimTask = Promise.resolve();

chrome.tabs.onRemoved.addListener((tabId) => {
  // Reload the session-backed set first. The worker may have restarted since
  // the tab was registered, so deleting from an empty in-memory Set would
  // otherwise erase registrations for every other tab.
  void removeAutoCollectTabId(tabId).catch(() => {});
  void clearManualFlow(tabId).catch(() => {});
  void readMfaAutoFlow(tabId).then((flow) => {
    if (flow?.status === "pending") {
      return writeMfaAutoFlow(tabId, {
        status: "cancelled",
        error: "MFA登録が完了する前に画面が閉じられました。",
        completedAt: Date.now(),
      });
    }
  }).catch(() => {});
  void readPendingMfa().then((value) => {
    if (value?.tabId === tabId) return clearPendingMfa();
  }).catch(() => {});
});

const toBase64 = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

function senderUrl(sender) {
  try {
    return new URL(sender.url || sender.origin || "");
  } catch {
    return null;
  }
}

const AUTHENTICATION_PERMISSION_ERROR = "Firefoxで自動ログインまたはMFAを使用するには認証情報の利用許可が必要です。設定画面から再許可してください。";

function isFirefoxDataConsentEnv() {
  try {
    return new URL(chrome.runtime.getURL("")).protocol === "moz-extension:";
  } catch {
    return false;
  }
}

async function hasDataCollectionPermission(type) {
  const firefox = isFirefoxDataConsentEnv();
  if (typeof chrome.permissions?.getAll !== "function") return !firefox;
  try {
    const permissions = await chrome.permissions.getAll();
    if (!Object.prototype.hasOwnProperty.call(permissions, "data_collection")) return !firefox;
    return Array.isArray(permissions.data_collection) && permissions.data_collection.includes(type);
  } catch {
    return !firefox;
  }
}

async function requireAuthenticationInfoPermission() {
  if (!await hasDataCollectionPermission("authenticationInfo")) {
    const error = new Error(AUTHENTICATION_PERMISSION_ERROR);
    error.permissionRequired = true;
    throw error;
  }
}

// ---- ブラウザ互換 helper ----

/** 拡張ページ由来の sender かどうか (Chrome/Firefox 両対応) */
function isExtensionPageSender(sender) {
  const url = senderUrl(sender);
  if (!sender || sender.id !== chrome.runtime.id) return false;
  // Firefox では runtime.id (gecko.id) と拡張ページ URL の host (内部 UUID) が
  // 一致しないため、chrome.runtime.getURL("") から実際の host を取得して比較する
  if (!url?.host) return false;
  let extensionHost;
  try {
    extensionHost = new URL(chrome.runtime.getURL("")).host;
  } catch {
    return false;
  }
  if (url.host !== extensionHost) return false;
  return url.protocol === "chrome-extension:" || url.protocol === "moz-extension:";
}

function isIdpSender(sender) {
  const url = senderUrl(sender);
  return url?.origin === AUTH_ORIGIN && url.pathname.startsWith("/idp/");
}

function isMfaSender(sender) {
  return senderUrl(sender)?.origin === MFA_ORIGIN;
}

function isMfaRegistrationSender(sender) {
  const url = senderUrl(sender);
  return url?.origin === MFA_ORIGIN && url.pathname === MFA_REGISTRATION_PATH;
}

function isCleLoginSender(sender) {
  const url = senderUrl(sender);
  if (url?.origin !== CLE_ORIGIN) return false;
  return url.pathname === "/" ||
    url.pathname === "/ultra" ||
    url.pathname === "/ultra/" ||
    url.pathname === "/webapps/login" ||
    url.pathname.startsWith("/webapps/login/");
}

function requireExtensionPageSender(sender) {
  if (!isExtensionPageSender(sender)) {
    throw new Error("この操作はKOAN Plusの画面からのみ実行できます。");
  }
}

async function openAuthDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(AUTH_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(AUTH_STORE_NAME)) {
        request.result.createObjectStore(AUTH_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readAuthRecord() {
  const db = await openAuthDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AUTH_STORE_NAME, "readonly");
    const request = transaction.objectStore(AUTH_STORE_NAME).get(AUTH_RECORD_KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function writeAuthRecord(record) {
  const db = await openAuthDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AUTH_STORE_NAME, "readwrite");
    transaction.objectStore(AUTH_STORE_NAME).put(record, AUTH_RECORD_KEY);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function clearAuthRecord() {
  const db = await openAuthDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AUTH_STORE_NAME, "readwrite");
    transaction.objectStore(AUTH_STORE_NAME).delete(AUTH_RECORD_KEY);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function encryptCredentials(credentials, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(credentials)),
  );
  return { iv: toBase64(iv), encrypted: toBase64(new Uint8Array(encrypted)) };
}

async function decryptCredentials(record) {
  if (!record?.key || !record?.payload) throw new Error("認証情報が設定されていません。");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(record.payload.iv) },
    record.key,
    fromBase64(record.payload.encrypted),
  );
  return JSON.parse(decoder.decode(decrypted));
}

function normalizeTotpSecret(secret) {
  return String(secret || "").toUpperCase().replace(/[\s=-]/g, "");
}

function decodeBase32(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = normalizeTotpSecret(secret);
  if (!normalized || [...normalized].some((character) => !alphabet.includes(character))) {
    throw new Error("TOTP シークレットは Base32 形式で入力してください。");
  }
  let bits = "";
  for (const character of normalized) bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return new Uint8Array(bytes);
}

async function generateTotp(secret, now = Date.now()) {
  const counter = Math.floor(now / 30000);
  const counterBytes = new Uint8Array(8);
  new DataView(counterBytes.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase32(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1000000).padStart(6, "0");
}

async function readAuthSettings(record) {
  const current = record || await readAuthRecord();
  let idHint = "";
  let isConfigured = false;
  if (current?.payload) {
    try {
      const credentials = await decryptCredentials(current);
      if (credentials.id && credentials.password) {
        isConfigured = true;
        idHint = credentials.id.length <= 4
          ? "*".repeat(credentials.id.length)
          : `${credentials.id.slice(0, 2)}${"*".repeat(credentials.id.length - 4)}${credentials.id.slice(-2)}`;
      }
    } catch {
      idHint = "読み込み失敗";
      isConfigured = false;
    }
  }
  return {
    configured: isConfigured,
    enabled: Boolean(current?.enabled),
    autoSubmit: current?.autoSubmit !== false,
    mfaEnabled: Boolean(current?.mfaEnabled),
    idHint,
  };
}

let koanProbeTask;

// Share only an active request. A later check must still observe session expiry
// immediately instead of reusing a cached authentication decision.
function probeKoanLogin() {
  if (koanProbeTask) return koanProbeTask;
  const task = probeKoanLoginOnce().finally(() => {
    if (koanProbeTask === task) koanProbeTask = undefined;
  });
  koanProbeTask = task;
  return task;
}

async function probeKoanLoginOnce() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(KOAN_PORTAL_URL, {
      credentials: "include",
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await response.text();
    const ok = response.ok &&
      new URL(response.url).origin === "https://koan.osaka-u.ac.jp" &&
      /id=["']portal-body["']/.test(text);
    return { ok, text: ok ? text : "", url: response.url };
  } catch {
    return { ok: false, text: "", url: KOAN_PORTAL_URL };
  } finally {
    clearTimeout(timeout);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function restoreAutoCollectTabIds() {
  if (!chrome.storage?.session) return;
  const stored = await chrome.storage.session.get(AUTO_COLLECT_TAB_IDS_KEY);
  const tabIds = Array.isArray(stored[AUTO_COLLECT_TAB_IDS_KEY])
    ? stored[AUTO_COLLECT_TAB_IDS_KEY]
    : [];
  autoCollectTabIds.clear();
  for (const tabId of tabIds) {
    if (Number.isInteger(tabId)) autoCollectTabIds.add(tabId);
  }
}

async function persistAutoCollectTabIds() {
  if (!chrome.storage?.session) return;
  await chrome.storage.session.set({
    [AUTO_COLLECT_TAB_IDS_KEY]: [...autoCollectTabIds],
  });
}

async function addAutoCollectTabId(tabId) {
  await restoreAutoCollectTabIds();
  autoCollectTabIds.add(tabId);
  await persistAutoCollectTabIds();
}

async function removeAutoCollectTabId(tabId) {
  await restoreAutoCollectTabIds();
  autoCollectTabIds.delete(tabId);
  await persistAutoCollectTabIds();
}

async function isAutoCollectTabId(tabId) {
  await restoreAutoCollectTabIds();
  return autoCollectTabIds.has(tabId);
}

function mfaAutoFlowKey(tabId) {
  return `${MFA_AUTO_FLOW_KEY_PREFIX}${tabId}`;
}

async function readMfaAutoFlow(tabId) {
  if (!chrome.storage?.session) return null;
  const key = mfaAutoFlowKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const flow = stored[key] || null;
  const completedAt = Number(flow?.completedAt || 0);
  if (
    flow &&
    (flow.status === "saved" || flow.status === "cancelled") &&
    completedAt > 0 &&
    Date.now() - completedAt > MFA_AUTO_FLOW_TTL_MS
  ) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return flow;
}

async function writeMfaAutoFlow(tabId, value) {
  if (!chrome.storage?.session) return;
  await chrome.storage.session.set({ [mfaAutoFlowKey(tabId)]: value });
}

async function cleanupExpiredMfaAutoFlows() {
  if (!chrome.storage?.session) return;
  const stored = await chrome.storage.session.get();
  const now = Date.now();
  const expiredKeys = Object.entries(stored)
    .filter(([key, value]) => {
      const flow = value && typeof value === "object" ? value : null;
      const completedAt = Number(flow?.completedAt || 0);
      return key.startsWith(MFA_AUTO_FLOW_KEY_PREFIX) &&
        (flow?.status === "saved" || flow?.status === "cancelled") &&
        completedAt > 0 &&
        now - completedAt > MFA_AUTO_FLOW_TTL_MS;
    })
    .map(([key]) => key);
  if (expiredKeys.length) await chrome.storage.session.remove(expiredKeys);
}

chrome.runtime.onStartup?.addListener(() => {
  void Promise.all([
    cleanupExpiredMfaAutoFlows(),
    cleanupExpiredManualFlows(),
  ]).catch(() => {});
});

function manualFlowKey(tabId) {
  return `${MANUAL_FLOW_KEY_PREFIX}${tabId}`;
}

async function readManualFlow(tabId) {
  const cached = manualFlows.get(tabId);
  if (cached) {
    const createdAt = Number(cached.createdAt || 0);
    if (createdAt <= 0 || Date.now() - createdAt <= MANUAL_FLOW_TTL_MS) return cached;
    manualFlows.delete(tabId);
    if (chrome.storage?.session) {
      await chrome.storage.session.remove(manualFlowKey(tabId)).catch(() => {});
    }
    return null;
  }
  if (!chrome.storage?.session) return null;
  const key = manualFlowKey(tabId);
  let stored;
  try {
    stored = await chrome.storage.session.get(key);
  } catch {
    return null;
  }
  const flow = stored[key] || null;
  const createdAt = Number(flow?.createdAt || 0);
  if (flow && createdAt > 0 && Date.now() - createdAt > MANUAL_FLOW_TTL_MS) {
    await chrome.storage.session.remove(key).catch(() => {});
    return null;
  }
  if (flow) manualFlows.set(tabId, flow);
  return flow;
}

async function writeManualFlow(tabId, value) {
  const flow = {
    returnTabId: Number.isInteger(value?.returnTabId) ? value.returnTabId : null,
    createdAt: Number.isFinite(value?.createdAt) ? value.createdAt : Date.now(),
  };
  manualFlows.set(tabId, flow);
  if (chrome.storage?.session) {
    try {
      await chrome.storage.session.set({ [manualFlowKey(tabId)]: flow });
    } catch {
      // Keep the in-memory fallback; storage.session may be unavailable in a
      // restricted profile or while the worker is shutting down.
    }
  }
  return flow;
}

async function clearManualFlow(tabId) {
  manualFlows.delete(tabId);
  if (chrome.storage?.session) {
    try {
      await chrome.storage.session.remove(manualFlowKey(tabId));
    } catch {
      // The tab is already gone; an unavailable session store needs no retry.
    }
  }
}

async function cleanupExpiredManualFlows() {
  if (!chrome.storage?.session) return;
  const stored = await chrome.storage.session.get();
  const now = Date.now();
  const expiredKeys = Object.entries(stored)
    .filter(([key, value]) => {
      const flow = value && typeof value === "object" ? value : null;
      const createdAt = Number(flow?.createdAt || 0);
      return key.startsWith(MANUAL_FLOW_KEY_PREFIX) &&
        createdAt > 0 &&
        now - createdAt > MANUAL_FLOW_TTL_MS;
    })
    .map(([key]) => key);
  if (expiredKeys.length) await chrome.storage.session.remove(expiredKeys);
}

async function beginMfaAutoFlow(tabId) {
  const current = await readMfaAutoFlow(tabId);
  if (current?.status === "saved") return;
  await writeMfaAutoFlow(tabId, {
    status: "pending",
    startedAt: current?.startedAt || Date.now(),
  });
}

async function consumeMfaAutoFlow(tabId) {
  const key = mfaAutoFlowKey(tabId);
  let flow = await readMfaAutoFlow(tabId);
  if (flow?.status === "pending" && !await tabExists(tabId)) {
    flow = {
      ...flow,
      status: "cancelled",
      error: "MFA登録が完了する前に画面が閉じられました。",
      completedAt: Date.now(),
    };
  }
  if (flow?.status === "saved" || flow?.status === "cancelled") {
    await chrome.storage.session.remove(key);
  }
  return flow;
}

async function savePendingMfa(value) {
  pendingMfa = value;
  if (chrome.storage?.session) {
    await chrome.storage.session.set({ [PENDING_MFA_KEY]: value });
  }
}

async function readPendingMfa() {
  if (!pendingMfa && chrome.storage?.session) {
    const stored = await chrome.storage.session.get(PENDING_MFA_KEY);
    pendingMfa = stored[PENDING_MFA_KEY] || null;
  }
  if (pendingMfa && Date.now() - Number(pendingMfa.createdAt || 0) > MFA_PENDING_TTL_MS) {
    pendingMfa = null;
    if (chrome.storage?.session) await chrome.storage.session.remove(PENDING_MFA_KEY);
  }
  return pendingMfa;
}

async function clearPendingMfa() {
  pendingMfa = null;
  if (chrome.storage?.session) {
    await chrome.storage.session.remove(PENDING_MFA_KEY);
  }
}

async function cancelMfaAutoTab(tabId) {
  await removeAutoCollectTabId(tabId);

  // Keep the cancellation result in session storage until the extension page
  // asks for auth-mfa-registration-result. This survives a service-worker
  // restart and prevents a user-initiated close from being reported as an
  // ambiguous registration failure.
  const currentFlow = await readMfaAutoFlow(tabId);
  if (currentFlow?.status !== "saved") {
    await writeMfaAutoFlow(tabId, {
      status: "cancelled",
      error: "MFA登録をキャンセルしました。",
      completedAt: Date.now(),
    });
  }

  const currentPendingMfa = await readPendingMfa();
  if (currentPendingMfa?.tabId === tabId) await clearPendingMfa();

  return {
    ok: true,
    status: currentFlow?.status === "saved" ? "saved" : "cancelled",
  };
}

async function handleAuthenticationPermissionRemoved(permissions) {
  if (!isFirefoxDataConsentEnv() || !permissions.data_collection?.includes("authenticationInfo")) return;
  await restoreAutoCollectTabIds();
  for (const tabId of [...autoCollectTabIds]) await cancelMfaAutoTab(tabId);
  // Discard only an unfinished registration; keep the encrypted saved settings.
  await clearPendingMfa();
}

chrome.permissions?.onRemoved?.addListener((permissions) => {
  void handleAuthenticationPermissionRemoved(permissions).catch(() => {
    console.warn("KOAN Plus: MFA登録の取消状態を保存できませんでした。権限確認により自動操作は停止します。");
  });
});

async function withTimeout(task, milliseconds, message = "timeout") {
  let timeoutId;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function tabExists(tabId) {
  if (!tabId) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function findKoanTab() {
  const tabs = await chrome.tabs.query({ url: "https://koan.osaka-u.ac.jp/*" });
  return tabs
    .filter((candidate) => !candidate.discarded && candidate.id)
    .sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0))[0];
}

async function waitForTabComplete(tabId, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return tab;
    } catch {
      throw new Error("KOANタブが閉じられたため、取得を中止しました。");
    }
    await wait(250);
  }
  throw new Error("KOANタブの読み込みが完了しませんでした。再読み込みして再試行してください。");
}

async function waitForTabUrlIncludes(tabId, fragment, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete" && tab.url?.includes(fragment)) return tab;
    } catch {
      throw new Error("CLEタブが閉じられたため、資料取得を中止しました。");
    }
    await wait(250);
  }
  throw new Error("CLE資料ページの読み込みが完了しませんでした。");
}

function sanitizeDownloadPath(value) {
  return String(value || "")
    .split("/")
    .map((part) => part.replace(/[<>:"\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

async function startCleDownload(rawUrl, rawFileName) {
  const url = new URL(rawUrl);
  if (url.origin !== CLE_ORIGIN) {
    throw new Error("CLE以外からのダウンロードは許可されていません。");
  }
  const fileName = sanitizeDownloadPath(rawFileName);
  if (!fileName) throw new Error("ダウンロードするファイル名が不正です。");
  return chrome.downloads.download({
    url: url.toString(),
    filename: fileName,
    // Never replace an existing user file; Chrome will append a suffix instead.
    conflictAction: "uniquify",
    saveAs: false,
  });
}

async function waitForDownloadsToSettle(downloadIds, milliseconds = 10 * 60 * 1000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const states = await Promise.all(downloadIds.map(
      (id) => chrome.downloads.search({ id }).then((items) => items[0]?.state).catch(() => "interrupted"),
    ));
    if (!states.includes("in_progress")) return;
    await wait(500);
  }
}

async function extractCleDocumentFiles(tabId) {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const files = [];
      const seen = new Set();
      const addFile = (url, fileName) => {
        const normalizedUrl = String(url || "").trim();
        const normalizedName = String(fileName || "").trim();
        const key = `${normalizedUrl}\n${normalizedName}`;
        if (!normalizedUrl || !normalizedName || seen.has(key)) return;
        seen.add(key);
        files.push({ url: normalizedUrl, fileName: normalizedName });
      };

      document.querySelectorAll('[role="region"]').forEach((region) => {
        const labelAttr = region.getAttribute("aria-label") || "";
        if (!/^(ファイル|file|attachment)s?$/i.test(labelAttr.trim())) return;

        const url = region.querySelector("[data-ally-file-preview-url]")
          ?.getAttribute("data-ally-file-preview-url") ||
          region.querySelector("a[href]")?.getAttribute("href") || "";
        const preview = [...region.querySelectorAll("[aria-label][aria-controls]")]
          .map((element) => {
            const label = element.getAttribute("aria-label") || "";
            const match = label.match(/^ファイル\s+(.+?)\s+をプレビュー$/) ||
              label.match(/^Preview\s+(?:file\s+)?(.+?)$/i);
            return match?.[1]?.trim() || "";
          })
          .find(Boolean);
        const menu = [...region.querySelectorAll("[aria-label]")]
          .map((element) => {
            const label = element.getAttribute("aria-label") || "";
            const match = label.match(/^(.+?)\s+のその他のオプション$/) ||
              label.match(/^More\s+options\s+for\s+(.+?)$/i);
            return match?.[1]?.trim() || "";
          })
          .find(Boolean);
        const visibleText = region.querySelector(".js-file-viewer-attachment-meta")?.textContent?.trim() ||
          region.querySelector("a")?.textContent?.trim() || "";
        addFile(url, preview || menu || visibleText);
      });

      document.querySelectorAll("[aria-label][aria-controls]").forEach((element) => {
        const label = element.getAttribute("aria-label") || "";
        const controls = element.getAttribute("aria-controls") || "";
        const match = label.match(/^ファイル\s+(.+?)\s+をプレビュー$/) ||
          label.match(/^Preview\s+(?:file\s+)?(.+?)$/i);
        if (match && controls) addFile(controls.replace(/^file-preview-/, ""), match[1]);
      });

      // Label wording varies by locale/version, so also pair the file-viewer
      // preview targets with the visible file name text next to them.
      document.querySelectorAll('[aria-controls^="file-preview-"]').forEach((element) => {
        const url = (element.getAttribute("aria-controls") || "").replace(/^file-preview-/, "");
        const scope = element.closest(".js-file-viewer-attachment-meta") || element;
        const name = scope.querySelector('[class*="fileText"]')?.textContent?.trim() ||
          scope.textContent?.trim() || "";
        if (url && /\.[a-z0-9]{1,8}$/i.test(name)) addFile(url, name);
      });
      return files;
    },
  });
  return Array.isArray(execution?.result) ? execution.result : [];
}

async function waitForCleDocumentFiles(tabId, milliseconds = 8000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const files = await extractCleDocumentFiles(tabId).catch(() => []);
    if (files.length) return files;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return [];
}

function cleDocumentUrl(courseId, contentId) {
  return `${CLE_ORIGIN}/ultra/courses/${encodeURIComponent(courseId)}/outline/edit/document/${encodeURIComponent(contentId)}?courseId=${encodeURIComponent(courseId)}&view=content&state=view`;
}

async function openCleDocument(tabId, courseId, contentId) {
  await chrome.tabs.update(tabId, { url: cleDocumentUrl(courseId, contentId) });
  await waitForTabUrlIncludes(tabId, `/document/${contentId}`);
}

async function ensureKoanTab(active = false) {
  let tab = await findKoanTab();
  if (!tab?.id) {
    tab = await chrome.tabs.create({ url: KOAN_PORTAL_URL, active });
  } else if (active && !tab.active) {
    tab = await chrome.tabs.update(tab.id, { active: true });
  }
  if (!tab?.id) throw new Error("KOANタブを作成できませんでした。");
  await waitForTabComplete(tab.id);
  return tab;
}

async function focusTab(tabId) {
  if (!tabId) return;
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
  if (Number.isInteger(tab?.windowId)) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
}

async function returnToDashboard(flowTabId) {
  const flow = await readManualFlow(flowTabId);
  if (!flow) return;
  await clearManualFlow(flowTabId);
  await focusTab(flow.returnTabId);
  await chrome.tabs.remove(flowTabId).catch(() => {});
}

async function rememberLoginTab(service, tabId) {
  // Keep an explicit cleared value so a failed session.remove cannot revive
  // an old tab on the next attempt in this worker.
  loginTabs.set(service, Number.isInteger(tabId) ? tabId : null);
  if (!chrome.storage?.session) return;
  const key = `${LOGIN_TAB_KEY_PREFIX}${service}`;
  try {
    if (Number.isInteger(tabId)) await chrome.storage.session.set({ [key]: tabId });
    else await chrome.storage.session.remove(key);
  } catch {
    // Keep the in-memory fallback if session storage is unavailable.
  }
}

async function findLoginTab(service) {
  let tabId = loginTabs.get(service);
  if (!loginTabs.has(service) && chrome.storage?.session) {
    const key = `${LOGIN_TAB_KEY_PREFIX}${service}`;
    const stored = await chrome.storage.session.get(key).catch(() => ({}));
    tabId = stored[key];
  }
  if (!Number.isInteger(tabId)) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  try {
    const url = new URL(tab?.pendingUrl || tab?.url);
    const serviceOrigin = service === "koan" ? new URL(KOAN_PORTAL_URL).origin : CLE_ORIGIN;
    if ([serviceOrigin, AUTH_ORIGIN, MFA_ORIGIN].includes(url.origin)) {
      loginTabs.set(service, tabId);
      return tab;
    }
  } catch { /* A closed tab or an unrelated navigation is no longer our login flow. */ }
  await rememberLoginTab(service, null);
  return null;
}

async function openLoginTab(url, record, sender, activeWhenManual = true, existingTab = null) {
  const manual = !record?.enabled || !record.payload;
  const guideMfa = Boolean(record?.enabled && record.payload && !record.mfaEnabled);
  const service = url === KOAN_PORTAL_URL ? "koan" : "cle";
  let tab = await findLoginTab(service);
  // A polling timeout does not mean the user has finished entering their OTP.
  // Reuse only a tab we own, without navigating away from its current form.
  if (!tab) {
    const options = { url, active: manual ? activeWhenManual : false };
    tab = existingTab?.id
      ? await chrome.tabs.update(existingTab.id, options)
      : await chrome.tabs.create(options);
    await rememberLoginTab(service, tab.id);
  }
  if ((manual || guideMfa) && tab.id) {
    await writeManualFlow(tab.id, { returnTabId: sender?.tab?.id });
  }
  return { manual, tab };
}

const KOAN_LOGIN_POLL_INTERVAL_MS = 5 * 1000;

async function ensureKoanLogin(record, sender, requireTab = false) {
  const initialProbe = await probeKoanLogin();
  if (initialProbe.ok) {
    if (!koanLoginTask) await rememberLoginTab("koan", null);
    const tab = requireTab ? await ensureKoanTab(false) : null;
    return {
      ok: true,
      loginStarted: false,
      portalHtml: initialProbe.text,
      portalUrl: initialProbe.url,
      tabId: tab?.id,
    };
  }
  if (record?.enabled && record.payload) await requireAuthenticationInfoPermission();
  if (koanLoginTask) {
    const result = await koanLoginTask;
    if (!requireTab || result.tabId) return result;
    const tab = await ensureKoanTab(false);
    return { ...result, tabId: tab.id };
  }

  koanLoginTask = (async () => {
    let tab;
    try {
      const opened = await openLoginTab(KOAN_PORTAL_URL, record, sender);
      const manual = opened.manual;
      tab = opened.tab;
      const deadline = Date.now() + 90 * 1000;
      let nextProbeAt = Date.now() + KOAN_LOGIN_POLL_INTERVAL_MS;
      while (Date.now() < deadline) {
        // Keep local tab-close detection responsive; only the network probe
        // waits five seconds between attempts.
        await wait(1000);
        if (tab.id && !await tabExists(tab.id)) {
          throw new Error("認証画面が閉じられたため、更新を中止しました。");
        }
        if (Date.now() < nextProbeAt) continue;
        const probe = await probeKoanLogin();
        nextProbeAt = Date.now() + KOAN_LOGIN_POLL_INTERVAL_MS;
        if (probe.ok) {
          await rememberLoginTab("koan", null);
          if (tab.id) {
            const flow = await readManualFlow(tab.id);
            const shouldReturn = Boolean(flow);
            if (requireTab) {
              if (shouldReturn) {
                await clearManualFlow(tab.id);
                await focusTab(flow?.returnTabId);
              }
              await waitForTabComplete(tab.id);
            } else if (shouldReturn) {
              await returnToDashboard(tab.id);
            } else {
              await chrome.tabs.remove(tab.id);
            }
          }
          return {
            ok: true,
            loginStarted: true,
            portalHtml: probe.text,
            portalUrl: probe.url,
            tabId: requireTab ? tab.id : undefined,
          };
        }
      }
      throw new Error(manual
        ? "認証が完了していません。開いた認証画面でログインしてください。"
        : "KOANの自動ログインが完了しませんでした。開いた認証画面を確認してから、もう一度更新してください。");
    } finally {
      if (tab?.id) await clearManualFlow(tab.id);
      koanLoginTask = undefined;
    }
  })();
  return koanLoginTask;
}

const cleProbeTasks = new Map();

function cleApiReady(tabId) {
  const existing = cleProbeTasks.get(tabId);
  if (existing) return existing;
  const task = cleApiReadyOnce(tabId).finally(() => {
    if (cleProbeTasks.get(tabId) === task) cleProbeTasks.delete(tabId);
  });
  cleProbeTasks.set(tabId, task);
  return task;
}

async function cleApiReadyOnce(tabId) {
  try {
    const [execution] = await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (url) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await fetch(url, {
            credentials: "include",
            redirect: "follow",
            signal: controller.signal,
          });
          return {
            contentType: response.headers.get("content-type") || "",
            ok: response.ok,
          };
        } catch {
          return { contentType: "", ok: false };
        } finally {
          clearTimeout(timeout);
        }
      },
      args: [CLE_PROBE_URL],
    }), 7000);
    return execution?.result?.ok &&
      execution.result.contentType.toLowerCase().includes("application/json");
  } catch {
    return false;
  }
}

async function findCleTab() {
  const tabs = await chrome.tabs.query({ url: `${CLE_ORIGIN}/*` });
  return tabs
    .filter((candidate) => !candidate.discarded)
    .sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0))[0];
}

async function findReadyCleTab() {
  const tabs = await chrome.tabs.query({ url: `${CLE_ORIGIN}/*` });
  const candidates = tabs
    .filter((candidate) => !candidate.discarded && candidate.id)
    .sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0));
  const readiness = await Promise.all(
    candidates.map((candidate) => cleApiReady(candidate.id)),
  );
  return candidates.find((candidate, index) => readiness[index]) || null;
}

async function focusPendingMfaTab() {
  const tabs = await chrome.tabs.query({ url: [
    `${AUTH_ORIGIN}/*`,
    `${MFA_ORIGIN}/*`,
    `${CLE_ORIGIN}/*`,
  ] });
  for (const tab of tabs) {
    if (!tab.id || tab.discarded) continue;
    try {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const text = `${document.title} ${document.body?.innerText || ""}`;
          const hasOtpInput = [...document.querySelectorAll("input")].some((input) => {
            const hint = [input.id, input.name, input.autocomplete, input.placeholder].join(" ");
            return input instanceof HTMLInputElement &&
              !["hidden", "checkbox", "submit", "button"].includes(input.type) &&
              (/otp|one-time|auth.?code|certification|secondaryAuthToken/i.test(hint) || input.maxLength === 6);
          });
          return hasOtpInput && /認証コード|ワンタイムパスワード|OTP|MFA認証|Type the Code/i.test(text);
        },
      });
      if (execution?.result === true) {
        await chrome.tabs.update(tab.id, { active: true });
        if (Number.isInteger(tab.windowId)) {
          await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
        return { found: true, tabId: tab.id };
      }
    } catch {
      // Ignore tabs that are navigating or cannot be inspected.
    }
  }
  return { found: false };
}

async function ensureCleLogin(record, sender, force = false) {
  let tab = !force ? await findReadyCleTab() : await findCleTab();
  if (!force && tab?.id) {
    if (!cleLoginTask) await rememberLoginTab("cle", null);
    return { ok: true, loginStarted: false, tabId: tab.id };
  }
  if (!tab?.id) tab = await findCleTab();
  if (record?.enabled && record.payload) await requireAuthenticationInfoPermission();
  if (cleLoginTask) return cleLoginTask;

  cleLoginTask = (async () => {
    const manual = !record?.enabled || !record.payload;
    try {
      ({ tab } = await openLoginTab(CLE_HOME_URL, record, sender, true, tab));
      const deadline = Date.now() + 45 * 1000;
      while (Date.now() < deadline) {
        await wait(1000);
        if (tab.id && !await tabExists(tab.id)) {
          throw new Error("CLE認証画面が閉じられたため、更新を中止しました。");
        }
        if (tab.id && await cleApiReady(tab.id)) {
          await rememberLoginTab("cle", null);
          const flow = await readManualFlow(tab.id);
          if (flow) {
            await clearManualFlow(tab.id);
            await focusTab(flow?.returnTabId);
          }
          return { ok: true, loginStarted: true, tabId: tab.id };
        }
      }
      throw new Error(manual
        ? "CLEの認証が完了していません。開いた認証画面でログインしてください。"
        : "CLEの自動再認証が完了しませんでした。CLEタブを確認してください。");
    } finally {
      if (tab?.id) await clearManualFlow(tab.id);
      cleLoginTask = undefined;
    }
  })();
  return cleLoginTask;
}

function requireAuthenticatedTarget(rawUrl) {
  const url = new URL(String(rawUrl || ""));
  const isKoan = url.origin === "https://koan.osaka-u.ac.jp" &&
    url.pathname.startsWith("/campusweb/");
  const isCle = url.origin === CLE_ORIGIN;
  if (!isKoan && !isCle) {
    throw new Error("KOANまたはCLE以外のページは認証付きで開けません。");
  }
  return { isKoan, url };
}

async function openAuthenticatedUrl(rawUrl, record, sender) {
  const target = requireAuthenticatedTarget(rawUrl);
  if (target.isKoan) {
    await ensureKoanLogin(record, sender);
    const tab = await chrome.tabs.create({
      url: target.url.toString(),
      active: true,
    });
    if (Number.isInteger(tab?.windowId)) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return { ok: true, tabId: tab.id };
  }

  const auth = await ensureCleLogin(record, sender);
  const tab = auth.loginStarted && Number.isInteger(auth.tabId)
    ? await chrome.tabs.update(auth.tabId, {
        url: target.url.toString(),
        active: true,
      })
    : await chrome.tabs.create({
        url: target.url.toString(),
        active: true,
      });
  if (Number.isInteger(tab?.windowId)) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  return { ok: true, tabId: tab.id };
}

async function authResponse(message, sender) {
  if (EXTENSION_ONLY_AUTH_TYPES.has(message.type)) {
    requireExtensionPageSender(sender);
  }

  if (message.type === "auth-check-login") {
    const [koanProbe, cleTab] = await Promise.all([
      probeKoanLogin(),
      findReadyCleTab(),
    ]);
    return { ok: true, koanLoggedIn: koanProbe.ok, cleLoggedIn: Boolean(cleTab?.id) };
  }

  if (message.type === "auth-claim-startup-refresh") {
    const claim = startupRefreshClaimTask.then(async () => {
      if (!chrome.storage?.session) return true;
      const stored = await chrome.storage.session.get(STARTUP_REFRESH_CLAIMED_KEY);
      if (stored[STARTUP_REFRESH_CLAIMED_KEY]) return false;
      await chrome.storage.session.set({ [STARTUP_REFRESH_CLAIMED_KEY]: true });
      return true;
    });
    startupRefreshClaimTask = claim.then(() => undefined, () => undefined);
    return { ok: true, shouldRefresh: await claim };
  }

  if (message.type === "auth-claim-dashboard-refresh") {
    const claim = dashboardRefreshClaimTask.then(async () => {
      if (!chrome.storage?.session) return true;
      const stored = await chrome.storage.session.get(DASHBOARD_REFRESH_ATTEMPT_KEY);
      const previous = Number(stored[DASHBOARD_REFRESH_ATTEMPT_KEY]) || 0;
      const retryAfterMs = Math.max(0, 60 * 1000 - (Date.now() - previous));
      if (retryAfterMs > 0) return { allowed: false, retryAfterMs };
      await chrome.storage.session.set({ [DASHBOARD_REFRESH_ATTEMPT_KEY]: Date.now() });
      return { allowed: true, retryAfterMs: 60 * 1000 };
    });
    dashboardRefreshClaimTask = claim.then(() => undefined, () => undefined);
    return { ok: true, ...await claim };
  }

  const record = await readAuthRecord();
  if (message.type === "auth-settings") return { ok: true, ...await readAuthSettings(record) };

  if (message.type === "auth-mfa-pending-save") {
    if (!isMfaRegistrationSender(sender) || !Number.isInteger(sender.tab?.id)) {
      throw new Error("MFA登録画面以外からは登録情報を仮保存できません。");
    }
    await requireAuthenticationInfoPermission();
    const { secret, temporaryCancelCode } = message;
    if (!secret || !temporaryCancelCode) {
      throw new Error("シークレットまたは一時解除コードが指定されていません。");
    }
    decodeBase32(secret); // Validate base32 secret
    const transactionId = crypto.randomUUID();
    await savePendingMfa({
      secret,
      temporaryCancelCode,
      tabId: sender.tab.id,
      transactionId,
      createdAt: Date.now(),
    });
    return { ok: true, code: await generateTotp(secret), transactionId };
  }

  if (message.type === "auth-mfa-click-proceed") {
    if (!isMfaRegistrationSender(sender)) {
      throw new Error("MFA情報画面以外では遷移操作を実行しません。");
    }
    await requireAuthenticationInfoPermission();
    if (!sender.tab?.id) throw new Error("MFA情報画面のタブを特定できませんでした。");
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: (forceFallback) => {
        const viewIdInput = document.querySelector('input[name="viewId"]');
        const isDisplayPage = viewIdInput?.value === "MfaInfoDisplay.jsp" ||
          document.body.innerText.includes("MFA情報表示");
        if (!isDisplayPage) {
          return { started: false, method: "not-display-page" };
        }

        if (!forceFallback && typeof globalThis.execSrvStatus === "function") {
          globalThis.execSrvStatus("register");
          return { started: true, method: "execSrvStatus" };
        }

        const button = [...document.querySelectorAll('input[type="button"], input[type="submit"], button')].find((candidate) =>
          (candidate.value || "").includes("MFA登録に進む") ||
          (candidate.textContent || "").includes("MFA登録に進む")
        );
        if (button instanceof HTMLElement) {
          button.click();
          return { started: true, method: "button-click-main" };
        }

        const form = document.forms.namedItem("cmdForm") || document.querySelector("form");
        const methodName = document.querySelector('input[name="methodName"]');
        if (form instanceof HTMLFormElement && methodName instanceof HTMLInputElement) {
          methodName.value = "register";
          HTMLFormElement.prototype.submit.call(form);
          return { started: true, method: "form-submit-fallback" };
        }

        return { started: false, method: "no-target" };
      },
      args: [message.forceFallback === true],
    });
    return { ok: true, ...(execution?.result || { started: false }) };
  }

  if (message.type === "auth-mfa-confirm-save") {
    if (!isMfaRegistrationSender(sender) || !Number.isInteger(sender.tab?.id)) {
      throw new Error("MFA登録画面以外からは登録を確定できません。");
    }
    await requireAuthenticationInfoPermission();
    const savedPendingMfa = await readPendingMfa();
    if (!savedPendingMfa) {
      return { ok: false, error: "仮保存されたMFA情報がありません。" };
    }
    if (
      savedPendingMfa.tabId !== sender.tab.id ||
      !message.transactionId ||
      message.transactionId !== savedPendingMfa.transactionId
    ) {
      throw new Error("MFA登録を開始したタブと確認要求が一致しません。");
    }
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: () => {
        const text = document.body?.innerText || "";
        return text.includes("MFA登録\t：\t登録済") ||
          text.includes("MFA登録 ： 登録済");
      },
    });
    if (execution?.result !== true) {
      throw new Error("MFA登録の完了画面を確認できませんでした。");
    }
    const current = record || await readAuthRecord();
    const previous = current?.payload ? await decryptCredentials(current) : {};
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const payload = await encryptCredentials({
      id: previous.id || "",
      password: previous.password || "",
      totpSecret: savedPendingMfa.secret,
      temporaryCancelCode: savedPendingMfa.temporaryCancelCode,
      mfaConsent: true,
    }, key);
    const hasSavedCredentials = Boolean(previous.id && previous.password);
    await writeAuthRecord({
      enabled: hasSavedCredentials ? Boolean(current?.enabled) : true,
      autoSubmit: true,
      mfaEnabled: true,
      key,
      payload,
    });
    await clearPendingMfa();
    await writeMfaAutoFlow(sender.tab.id, {
      status: "saved",
      completedAt: Date.now(),
    });
    return { ok: true };
  }

  if (message.type === "auth-get-secrets") {
    if (!record?.payload) {
      return { ok: true, configured: false };
    }
    try {
      const credentials = await decryptCredentials(record);
      return {
        ok: true,
        configured: Boolean(credentials.totpSecret),
        totpSecret: credentials.totpSecret || "",
        temporaryCancelCode: credentials.temporaryCancelCode || "",
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  if (message.type === "auth-mfa-register-auto-tab") {
    const requestedTabId = Number.isInteger(message.tabId) ? message.tabId : null;
    if (requestedTabId) {
      requireExtensionPageSender(sender);
    } else if (!isMfaRegistrationSender(sender)) {
      throw new Error("MFA登録画面以外からは自動取得タブを登録できません。");
    }
    await requireAuthenticationInfoPermission();
    const tabId = requestedTabId || sender.tab?.id;
    if (tabId) {
      await addAutoCollectTabId(tabId);
      await beginMfaAutoFlow(tabId);
    }
    return { ok: true };
  }

  if (message.type === "auth-mfa-cancel-auto-tab") {
    if (!Number.isInteger(message.tabId)) {
      throw new Error("MFA登録タブを特定できませんでした。");
    }
    return cancelMfaAutoTab(message.tabId);
  }

  if (message.type === "auth-mfa-check-auto-tab") {
    if (!isMfaRegistrationSender(sender)) {
      throw new Error("MFA登録画面以外からは自動取得状態を確認できません。");
    }
    await requireAuthenticationInfoPermission();
    const isAuto = Boolean(sender.tab && await isAutoCollectTabId(sender.tab.id));
    return { ok: true, isAutoCollect: isAuto };
  }

  if (message.type === "auth-focus-pending-mfa") {
    return { ok: true, ...await focusPendingMfaTab() };
  }

  if (message.type === "auth-mfa-registration-result") {
    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId)) {
      throw new Error("MFA登録タブを特定できませんでした。");
    }
    const flow = await consumeMfaAutoFlow(tabId);
    return {
      ok: true,
      status: flow?.status || "cancelled",
      error: flow?.error || "",
    };
  }

  if (message.type === "auth-close-tab") {
    if (isMfaRegistrationSender(sender) &&
        sender.tab?.id &&
        await isAutoCollectTabId(sender.tab.id)) {
      await removeAutoCollectTabId(sender.tab.id);
      await chrome.tabs.remove(sender.tab.id);
      return { ok: true };
    }
    return { ok: false, error: "タブが特定できませんでした。" };
  }

  if (message.type === "auth-delete") {
    const record = await readAuthRecord();
    if (record?.payload) {
      try {
        const credentials = await decryptCredentials(record);
        if (credentials.totpSecret) {
          const key = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          );
          const payload = await encryptCredentials({
            id: "",
            password: "",
            totpSecret: credentials.totpSecret,
            temporaryCancelCode: credentials.temporaryCancelCode || "",
            mfaConsent: credentials.mfaConsent,
          }, key);
          await writeAuthRecord({
            enabled: false,
            autoSubmit: true,
            mfaEnabled: false,
            key,
            payload,
          });
        } else {
          await clearAuthRecord();
        }
      } catch {
        await clearAuthRecord();
      }
    } else {
      await clearAuthRecord();
    }
    return { ok: true, ...await readAuthSettings(await readAuthRecord()) };
  }

  if (message.type === "auth-delete-mfa") {
    const record = await readAuthRecord();
    if (record?.payload) {
      try {
        const credentials = await decryptCredentials(record);
        if (credentials.id && credentials.password) {
          const key = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          );
          const payload = await encryptCredentials({
            id: credentials.id,
            password: credentials.password,
            totpSecret: "",
            temporaryCancelCode: "",
            mfaConsent: false,
          }, key);
          await writeAuthRecord({
            enabled: record.enabled,
            autoSubmit: record.autoSubmit,
            mfaEnabled: false,
            key,
            payload,
          });
        } else {
          await clearAuthRecord();
        }
      } catch {
        await clearAuthRecord();
      }
    } else {
      await clearAuthRecord();
    }
    return { ok: true, ...await readAuthSettings(await readAuthRecord()) };
  }

  if (message.type === "auth-save") {
    const values = message.values || {};
    if (!values.enabled) {
      if (record?.payload) {
        await writeAuthRecord({
          ...record,
          enabled: false,
          autoSubmit: true,
        });
        return { ok: true, ...await readAuthSettings(await readAuthRecord()) };
      }
      return { ok: true, configured: false, enabled: false, autoSubmit: true, mfaEnabled: false, idHint: "" };
    }
    // permissionなしでも無効化できるよう、新規有効化またはsecret更新時だけ許可を要求する。
    const enablingAutoLogin = record?.enabled !== true;
    const updatingSecrets = Boolean(values.id || values.password || values.totpSecret);
    const enablingMfa = values.mfaEnabled === true && record?.mfaEnabled !== true;
    if (enablingAutoLogin || updatingSecrets || enablingMfa) {
      await requireAuthenticationInfoPermission();
    }
    if (!values.id || !values.password) {
      if (!record?.payload) throw new Error("ID とパスワードを入力してください。");
    }
    const previous = record?.payload ? await decryptCredentials(record) : {};
    const nextId = values.id || previous.id || "";
    const nextPassword = values.password || previous.password || "";
    if (!nextId || !nextPassword) {
      throw new Error("ID とパスワードを入力してください。");
    }
    const totpSecret = normalizeTotpSecret(values.totpSecret) || previous.totpSecret || "";
    const mfaConsent = Boolean(totpSecret && (values.mfaConsent || previous.mfaConsent));
    if (values.mfaEnabled && !mfaConsent) {
      throw new Error("MFA 自動化のリスクを確認し、同意してください。");
    }
    if (values.mfaEnabled && !totpSecret) {
      throw new Error("TOTP シークレットを入力してください。");
    }
    if (totpSecret) decodeBase32(totpSecret);
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const payload = await encryptCredentials({
      id: nextId,
      password: nextPassword,
      totpSecret,
      temporaryCancelCode: previous.temporaryCancelCode || "",
      mfaConsent,
    }, key);
    await writeAuthRecord({
      enabled: true,
      autoSubmit: true,
      mfaEnabled: Boolean(values.mfaEnabled && totpSecret && mfaConsent),
      key,
      payload,
    });
    return { ok: true, ...await readAuthSettings(await readAuthRecord()) };
  }

  if (message.type === "auth-ensure-koan") {
    return ensureKoanLogin(record, sender, Boolean(message.requireTab));
  }

  if (message.type === "auth-ensure-cle") {
    return ensureCleLogin(record, sender);
  }

  if (message.type === "auth-refresh-cle") {
    return ensureCleLogin(record, sender, true);
  }

  if (message.type === "auth-open-url") {
    return openAuthenticatedUrl(message.url, record, sender);
  }

  if (message.type === "auth-auto-login-state") {
    if (!isIdpSender(sender) && !isCleLoginSender(sender)) {
      throw new Error("認証画面以外には自動ログイン状態を渡しません。");
    }
    await requireAuthenticationInfoPermission();
    const settings = await readAuthSettings(record);
    return {
      ok: true,
      enabled: Boolean(settings.enabled && settings.configured),
      autoSubmit: record?.autoSubmit !== false,
    };
  }

  if (message.type === "auth-credentials") {
    if (!isIdpSender(sender) && !isCleLoginSender(sender)) {
      throw new Error("認証画面以外には認証情報を渡しません。");
    }
    await requireAuthenticationInfoPermission();
    if (!record?.enabled) return { ok: true };
    const credentials = await decryptCredentials(record);
    if (!credentials.id || !credentials.password) {
      throw new Error("保存済みのIDまたはパスワードが不完全です。");
    }
    return { ok: true, credentials: { id: credentials.id, password: credentials.password }, autoSubmit: true };
  }

  if (message.type === "auth-submit-idp") {
    if (!isIdpSender(sender)) throw new Error("認証基盤以外ではログイン送信を実行しません。");
    await requireAuthenticationInfoPermission();
    if (!sender.tab?.id) throw new Error("認証基盤のタブを特定できませんでした。");
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: () => {
        if (typeof globalThis.LoginSubmit === "function") {
          globalThis.LoginSubmit("ログイン");
          return { started: true, method: "LoginSubmit" };
        }
        const submit = document.querySelector('input[name="cmdForm.Submit"]');
        if (submit instanceof HTMLInputElement) {
          submit.click();
          return { started: true, method: "button-click" };
        }
        const form = document.forms.namedItem("cmdForm") || document.querySelector("form");
        if (form instanceof HTMLFormElement) {
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit();
          } else {
            HTMLFormElement.prototype.submit.call(form);
          }
          return { started: true, method: "form-submit" };
        }
        return { started: false, method: "no-target" };
      },
    });
    return { ok: true, ...(execution?.result || { started: false, method: "no-result" }) };
  }

  if (message.type === "auth-totp") {
    if (!isMfaSender(sender) && !isIdpSender(sender)) {
      throw new Error("MFA認証画面以外には認証コードを渡しません。");
    }
    await requireAuthenticationInfoPermission();
    if (!record?.enabled) return { ok: true };
    if (!record.mfaEnabled) {
      if (sender.tab?.id) {
        await chrome.tabs.update(sender.tab.id, { active: true }).catch(() => {});
        if (Number.isInteger(sender.tab.windowId)) {
          await chrome.windows.update(sender.tab.windowId, { focused: true }).catch(() => {});
        }
      }
      return { ok: true, mfaRequired: true };
    }
    const credentials = await decryptCredentials(record);
    if (!credentials.mfaConsent || !credentials.totpSecret) return { ok: true };
    return { ok: true, code: await generateTotp(credentials.totpSecret), autoSubmit: true };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (String(message?.type || "").startsWith("auth-")) {
    authResponse(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        permissionRequired: error?.permissionRequired === true,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  if (message?.type === "cle-download") {
    (async () => {
      requireExtensionPageSender(sender);
      const downloadId = await startCleDownload(message.url, message.fileName);
      return { ok: true, downloadId };
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  if (message?.type === "cle-download-batch") {
    (async () => {
      requireExtensionPageSender(sender);
      const prepared = (Array.isArray(message.files) ? message.files : [])
        .slice(0, 500)
        .map((file) => ({
          url: String(file?.url || ""),
          fileName: String(file?.fileName || ""),
        }));
      if (!prepared.length) return { ok: true, started: 0, failed: [] };
      // Hide the download bubble while the batch runs so it doesn't pop up
      // once per file; restored after every started download settles.
      const canToggleUi = typeof chrome.downloads.setUiOptions === "function";
      if (canToggleUi) {
        await chrome.downloads.setUiOptions({ enabled: false }).catch(() => {});
      }
      const downloadIds = [];
      const failed = [];
      try {
        for (const file of prepared) {
          try {
            downloadIds.push(await startCleDownload(file.url, file.fileName));
          } catch (error) {
            failed.push({
              fileName: file.fileName,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } finally {
        if (canToggleUi) {
          waitForDownloadsToSettle(downloadIds).finally(() => {
            chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
          });
        }
      }
      return { ok: true, started: downloadIds.length, failed };
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  if (message?.type === "cle-visible-files") {
    (async () => {
      requireExtensionPageSender(sender);
      const tabs = await chrome.tabs.query({ url: `${CLE_ORIGIN}/*` });
      const candidates = message.tabId
        ? [
            ...tabs.filter((tab) => tab.id === message.tabId),
            ...tabs.filter((tab) => tab.id !== message.tabId),
          ]
        : tabs;
      const files = [];
      for (const tab of candidates) {
        if (!tab.id || tab.discarded) continue;
        files.push(...await extractCleDocumentFiles(tab.id).catch(() => []));
      }
      return { ok: true, files };
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  if (message?.type === "cle-head-batch") {
    (async () => {
      requireExtensionPageSender(sender);
      const urls = [...new Set(
        (Array.isArray(message.urls) ? message.urls : [])
          .map((value) => String(value || ""))
          .filter((value) => {
            try {
              return new URL(value).origin === CLE_ORIGIN;
            } catch {
              return false;
            }
          }),
      )].slice(0, 200);
      if (!urls.length) return { ok: true, heads: [] };

      const tabs = await chrome.tabs.query({ url: `${CLE_ORIGIN}/*` });
      const tab = message.tabId
        ? tabs.find((candidate) => candidate.id === message.tabId)
        : tabs
            .filter((candidate) => !candidate.discarded)
            .sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0))[0];
      if (!tab?.id) {
        throw new Error("CLEをログイン済みのタブで開いてから取得してください。");
      }

      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: async (targetUrls) => {
          const heads = [];
          let index = 0;
          const worker = async () => {
            while (index < targetUrls.length) {
              const url = targetUrls[index++];
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 10000);
              try {
                const response = await fetch(url, {
                  method: "GET",
                  credentials: "include",
                  redirect: "follow",
                  signal: controller.signal,
                });
                const contentDisposition = response.headers.get("content-disposition") || "";
                const contentType = response.headers.get("content-type") || "";
                heads.push({
                  url,
                  ok: response.ok,
                  contentDisposition,
                  contentType,
                });
                if (response.body) {
                  try {
                    await response.body.getReader().cancel();
                  } catch {}
                }
              } catch {
                if (!heads.some((h) => h.url === url)) {
                  heads.push({ url, ok: false, contentDisposition: "", contentType: "" });
                }
              } finally {
                clearTimeout(timeout);
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(3, targetUrls.length) }, worker));
          return heads;
        },
        args: [urls],
      });
      return { ok: true, heads: Array.isArray(execution?.result) ? execution.result : [] };
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  if (message?.type === "cle-document-files") {
    (async () => {
      requireExtensionPageSender(sender);
      const courseId = String(message.courseId || "");
      const contentIds = [...new Set(
        (Array.isArray(message.contentIds) ? message.contentIds : [])
          .map((value) => String(value || ""))
          .filter((value) => /^_\d+_\d+$/.test(value)),
      )].slice(0, 30);
      if (!/^_\d+_\d+$/.test(courseId) || !contentIds.length) {
        return { ok: true, files: [] };
      }

      const sourceTabs = await chrome.tabs.query({ url: `${CLE_ORIGIN}/*` });
      const sourceTab = message.tabId
        ? sourceTabs.find((candidate) => candidate.id === message.tabId)
        : sourceTabs.find((candidate) => !candidate.discarded);
      if (!sourceTab?.id) throw new Error("CLEタブが見つかりません。");

      const scanTab = await chrome.tabs.create({
        active: false,
        url: cleDocumentUrl(courseId, contentIds[0]),
      });
      if (!scanTab.id) throw new Error("資料確認用のCLEタブを開けませんでした。");
      const files = [];
      try {
        for (const [index, contentId] of contentIds.entries()) {
          try {
            if (index === 0) {
              await waitForTabUrlIncludes(scanTab.id, `/document/${contentId}`);
            } else {
              await openCleDocument(scanTab.id, courseId, contentId);
            }
            const documentFiles = await waitForCleDocumentFiles(scanTab.id);
            files.push(...documentFiles.map((file) => ({ ...file, contentId })));
          } catch {
            // Continue with the remaining documents; unresolved files keep their fallback names.
          }
        }
      } finally {
        await chrome.tabs.remove(scanTab.id).catch(() => {});
      }
      return { ok: true, files };
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  const targets = {
    "koan-fetch": {
      label: "KOAN",
      origin: "https://koan.osaka-u.ac.jp",
      methods: ["GET", "POST"],
    },
    "cle-fetch": {
      label: "CLE",
      origin: "https://www.cle.osaka-u.ac.jp",
      methods: ["GET", "HEAD"],
    },
  };
  const target = targets[message?.type];
  if (!target) return;

  (async () => {
    requireExtensionPageSender(sender);
    const requestUrl = new URL(message.request?.url);
    const method = message.request?.options?.method || "GET";
    if (requestUrl.origin !== target.origin) {
      throw new Error(`${target.label}以外への通信は許可されていません。`);
    }
    if (!target.methods.includes(method)) {
      throw new Error("許可されていない通信方式です。");
    }

    const tabs = await chrome.tabs.query({
      url: `${target.origin}/*`,
    });
    const usableTabs = tabs.filter((candidate) => !candidate.discarded && !candidate.frozen);
    // A closed/frozen pinned tab must not permanently strand a read-only Web Flow.
    let tab = usableTabs.find((candidate) => candidate.id === message.tabId)
      || usableTabs
          .sort((left, right) => {
            if (left.status !== right.status) return left.status === "complete" ? -1 : 1;
            if (left.active !== right.active) return left.active ? -1 : 1;
            return (right.lastAccessed || 0) - (left.lastAccessed || 0);
          })[0];
    if (!tab?.id && target.label === "KOAN") {
      tab = await chrome.tabs.create({ url: KOAN_PORTAL_URL, active: false });
      try {
        await waitForTabComplete(tab.id, 7000);
      } catch (error) {
        await chrome.tabs.remove(tab.id).catch(() => {});
        throw error;
      }
    }
    if (!tab?.id) {
      throw new Error(`${target.label}をログイン済みのタブで開いてから取得してください。`);
    }

    const deadline = Date.now() + 20000;
    const [execution] = await withTimeout(chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // Waiting for document_idle can hang on a portal with long-lived frames.
      injectImmediately: true,
      world: target.label === "KOAN" ? "ISOLATED" : "MAIN",
      func: async (request, label, maxResponseTextLength, deadline) => {
        // Frozen tabs may execute only after the caller has already given up.
        if (Date.now() >= deadline) throw new Error(`${label}の取得開始期限を過ぎました。`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.min(15000, deadline - Date.now()));
        try {
          const response = await fetch(request.url, {
            credentials: "include",
            redirect: "follow",
            ...request.options,
            signal: controller.signal,
          });

          const declaredLength = Number(response.headers.get("content-length"));
          if (Number.isFinite(declaredLength) && declaredLength > maxResponseTextLength) {
            controller.abort();
            throw new Error(`${label}の応答が大きすぎるため、取得を中止しました。`);
          }

          let text = "";
          if (response.body) {
            const reader = response.body.getReader?.();
            if (!reader) {
              controller.abort();
              throw new Error(`${label}の応答ストリームを利用できません。`);
            }
            const chunks = [];
            let totalBytes = 0;
            try {
              while (true) {
                const part = await reader.read();
                if (part.done) break;
                const chunk = part.value instanceof Uint8Array
                  ? part.value
                  : new Uint8Array(part.value || 0);
                totalBytes += chunk.byteLength;
                if (totalBytes > maxResponseTextLength) {
                  await reader.cancel().catch(() => {});
                  controller.abort();
                  throw new Error(`${label}の応答が大きすぎるため、取得を中止しました。`);
                }
                chunks.push(chunk);
              }
            } finally {
              reader.releaseLock?.();
            }
            const bytes = new Uint8Array(totalBytes);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            text = new TextDecoder().decode(bytes);
          }
          return {
            ok: response.ok,
            status: response.status,
            text,
            retryAfter: response.headers.get("retry-after") || "",
            contentDisposition: response.headers.get("content-disposition") || "",
            contentType: response.headers.get("content-type") || "",
            url: response.url,
          };
        } catch (error) {
          throw new Error(
            error?.name === "AbortError"
              ? `${label}の応答が15秒以内に返りませんでした。${label}タブを再読み込みして再試行してください。`
              : `${label}タブ内の取得に失敗しました: ${error?.message || String(error)}`,
          );
        } finally {
          clearTimeout(timeout);
        }
      },
      args: [message.request, target.label, MAX_CLE_RESPONSE_TEXT_LENGTH, deadline],
    }), 21000, `${target.label}タブの取得が応答しませんでした。保存済みデータを保持し、再試行します。`);
    if (!execution.result) {
      throw new Error(`${target.label}タブから応答を取得できませんでした。`);
    }
    const responseUrl = new URL(execution.result.url || requestUrl.href);
    if (responseUrl.protocol !== "https:" || responseUrl.origin !== target.origin) {
      throw new Error(`${target.label}以外へリダイレクトされたため、取得を中止しました。`);
    }
    execution.result.url = responseUrl.href;
    sendResponse({ ok: true, response: execution.result, tabId: tab.id });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return true;
});
