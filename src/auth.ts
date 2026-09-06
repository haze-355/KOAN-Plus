export type AuthSettings = {
  configured: boolean;
  enabled: boolean;
  autoSubmit: boolean;
  mfaEnabled: boolean;
  idHint: string;
};

type DataCollectionPermissions = {
  data_collection?: string[];
};

export function isFirefoxDataConsentEnv(): boolean {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.getURL !== "function") return false;
  try {
    return new URL(chrome.runtime.getURL("")).protocol === "moz-extension:";
  } catch {
    return false;
  }
}

async function getDataCollectionPermissions(): Promise<string[] | null> {
  const firefox = isFirefoxDataConsentEnv();
  if (typeof chrome === "undefined" || typeof chrome.permissions?.getAll !== "function") {
    return firefox ? [] : null;
  }
  try {
    const permissions = await chrome.permissions.getAll() as DataCollectionPermissions;
    if (!Object.prototype.hasOwnProperty.call(permissions, "data_collection")) return firefox ? [] : null;
    return Array.isArray(permissions.data_collection) ? permissions.data_collection : [];
  } catch {
    return firefox ? [] : null;
  }
}

export async function hasDataCollectionPermission(type: string): Promise<boolean> {
  const permissions = await getDataCollectionPermissions();
  return permissions === null || permissions.includes(type);
}

export async function requestAuthenticationInfoPermission(): Promise<boolean> {
  if (!isFirefoxDataConsentEnv()) return true;
  if (typeof chrome.permissions?.request !== "function") return false;
  try {
    // 事前確認をawaitするとuser activationを失う可能性があるため、Firefoxではrequestを最初に呼ぶ。
    return await chrome.permissions.request({ data_collection: ["authenticationInfo"] });
  } catch {
    return false;
  }
}

type AuthResponse = AuthSettings & {
  ok: boolean;
  error?: string;
  loginStarted?: boolean;
  tabId?: number;
  shouldRefresh?: boolean;
  portalHtml?: string;
  portalUrl?: string;
  allowed?: boolean;
  retryAfterMs?: number;
};

function requireRuntimeResponse<T>(response: T | null | undefined): T {
  if (response == null) {
    throw new Error(
      "拡張機能のバックグラウンドから応答がありません。KOAN Plusを再読み込みして、画面を開き直してください。",
    );
  }
  return response;
}

async function sendAuthMessage(message: unknown): Promise<AuthResponse> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new Error("自動ログイン設定はブラウザ拡張機能から開いてください。");
  }
  const response = requireRuntimeResponse(
    await chrome.runtime.sendMessage(message) as AuthResponse | null | undefined,
  );
  if (!response.ok) throw new Error(response.error || "自動ログイン設定の更新に失敗しました。");
  return response;
}

export function loadAuthSettings() {
  return sendAuthMessage({ type: "auth-settings" });
}

export function saveAuthSettings(values: {
  enabled: boolean;
  id: string;
  password: string;
  totpSecret: string;
  mfaConsent: boolean;
  mfaEnabled: boolean;
}) {
  return sendAuthMessage({ type: "auth-save", values });
}

export function deleteAuthSettings() {
  return sendAuthMessage({ type: "auth-delete" });
}

export function deleteMfaSettings() {
  return sendAuthMessage({ type: "auth-delete-mfa" });
}

export function ensureKoanLogin(options?: { requireTab?: boolean }) {
  return sendAuthMessage({
    type: "auth-ensure-koan",
    requireTab: Boolean(options?.requireTab),
  });
}

export function ensureCleLogin() {
  return sendAuthMessage({ type: "auth-ensure-cle" });
}

export function refreshCleLogin() {
  return sendAuthMessage({ type: "auth-refresh-cle" });
}

/** Validate navigation locally instead of waiting for a login readiness probe. */
export function academicLinkUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if ((url.origin === "https://koan.osaka-u.ac.jp" && url.pathname.startsWith("/campusweb/")) ||
        url.origin === "https://www.cle.osaka-u.ac.jp") return url.href;
  } catch { /* An invalid destination is not navigable. */ }
  return null;
}

export function openAuthenticatedUrl(url: string) {
  return sendAuthMessage({ type: "auth-open-url", url });
}

export async function claimStartupRefresh() {
  const response = await sendAuthMessage({ type: "auth-claim-startup-refresh" });
  return Boolean(response.shouldRefresh);
}

export async function claimDashboardRefresh() {
  const response = await sendAuthMessage({ type: "auth-claim-dashboard-refresh" });
  return {
    allowed: response.allowed !== false,
    retryAfterMs: Math.max(0, response.retryAfterMs || 0),
  };
}

export type MfaSecrets = {
  configured: boolean;
  totpSecret?: string;
  temporaryCancelCode?: string;
  error?: string;
};

export async function getSavedMfaSecrets(): Promise<MfaSecrets> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new Error("拡張機能のコンテキスト以外から呼び出されています。");
  }
  const response = requireRuntimeResponse(
    await chrome.runtime.sendMessage({ type: "auth-get-secrets" }) as
      | (MfaSecrets & { ok: boolean })
      | null
      | undefined,
  );
  if (!response.ok) throw new Error(response.error || "シークレットの取得に失敗しました。");
  return response;
}

export async function checkLoginStatus(): Promise<{ koanLoggedIn: boolean; cleLoggedIn: boolean }> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return { koanLoggedIn: false, cleLoggedIn: false };
  }
  const response = requireRuntimeResponse(
    await chrome.runtime.sendMessage({ type: "auth-check-login" }) as {
      ok: boolean;
      koanLoggedIn: boolean;
      cleLoggedIn: boolean;
      error?: string;
    } | null | undefined,
  );
  if (!response.ok) throw new Error(response.error || "ログイン状態の確認に失敗しました。");
  return { koanLoggedIn: response.koanLoggedIn, cleLoggedIn: response.cleLoggedIn };
}
