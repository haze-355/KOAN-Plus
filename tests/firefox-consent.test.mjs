import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const backgroundSource = readFileSync("public/background.js", "utf8");
const contentSource = readFileSync("public/auth-content.js", "utf8");
const mfaSender = { id: "@synthetic-extension", url: "https://auth-mfa.auth.osaka-u.ac.jp/AttributeRegistSite/MfaInfoServlet", tab: { id: 7 } };
const idpSender = { ...mfaSender, url: "https://ou-idp.auth.osaka-u.ac.jp/idp/login" };

async function backgroundHarness(protocol = "moz-extension:") {
  const session = {};
  const executeScript = vi.fn(async () => [{ result: { started: true } }]);
  const getAll = vi.fn(async () => ({ data_collection: ["authenticationInfo"] }));
  const context = vm.createContext({
    URL, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, btoa, atob, console,
    chrome: {
      action: { onClicked: { addListener() {} } },
      tabs: { onRemoved: { addListener() {} } },
      runtime: { id: "@synthetic-extension", getURL: () => `${protocol}//synthetic-uuid/`, onMessage: { addListener() {} } },
      permissions: { getAll },
      scripting: { executeScript },
      storage: { session: {
        get: async key => key ? { [key]: session[key] } : { ...session },
        set: async values => Object.assign(session, values),
        remove: async key => { delete session[key]; },
      } },
    },
  });
  vm.runInContext(backgroundSource, context);
  // Replace the database boundary only; permission, encryption, dispatch and flow code remain real.
  vm.runInContext("readAuthRecord = async () => fixtureRecord; writeAuthRecord = async value => { fixtureRecord = value; };", context);
  const key = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  context.fixtureRecord = { enabled: true, mfaEnabled: true, key, payload: await context.encryptCredentials({
    id: "synthetic-student", password: "synthetic-password", totpSecret: "JBSWY3DPEHPK3PXP", mfaConsent: true,
  }, key) };
  return { context, session, executeScript, getAll };
}

describe("Firefox authentication consent", () => {
  it("blocks credentials, OTPs and registration navigation after revocation, and recovers after regrant", async () => {
    const { context, getAll, executeScript } = await backgroundHarness();
    expect((await context.authResponse({ type: "auth-credentials" }, idpSender)).credentials.id).toBe("synthetic-student");
    expect((await context.authResponse({ type: "auth-totp" }, mfaSender)).code).toMatch(/^\d{6}$/);
    const saved = context.fixtureRecord;
    getAll.mockResolvedValue({ data_collection: [] });
    for (const [type, sender] of [["auth-credentials", idpSender], ["auth-totp", mfaSender], ["auth-submit-idp", idpSender], ["auth-mfa-click-proceed", mfaSender], ["auth-mfa-check-auto-tab", mfaSender]]) {
      await expect(context.authResponse({ type }, sender)).rejects.toMatchObject({ permissionRequired: true });
    }
    expect(executeScript).not.toHaveBeenCalled();
    expect(context.fixtureRecord).toBe(saved);
    getAll.mockResolvedValue({ data_collection: ["authenticationInfo"] });
    expect((await context.authResponse({ type: "auth-credentials" }, idpSender)).credentials.id).toBe("synthetic-student");
  });

  it("cancels unfinished registrations without deleting saved secrets or reviving the flow on regrant", async () => {
    const { context, session, getAll } = await backgroundHarness();
    await context.authResponse({ type: "auth-mfa-register-auto-tab" }, mfaSender);
    await context.savePendingMfa({ tabId: 7, createdAt: Date.now(), secret: "JBSWY3DPEHPK3PXP" });
    const saved = context.fixtureRecord;
    getAll.mockResolvedValue({ data_collection: [] });
    await context.handleAuthenticationPermissionRemoved({ data_collection: ["authenticationInfo"] });
    expect(session.authAutoCollectTabIds).toEqual([]);
    expect(session["authMfaAutoFlow:7"].status).toBe("cancelled");
    expect(await context.readPendingMfa()).toBeNull();
    expect(context.fixtureRecord).toBe(saved);
    getAll.mockResolvedValue({ data_collection: ["authenticationInfo"] });
    expect(await context.authResponse({ type: "auth-mfa-check-auto-tab" }, mfaSender)).toMatchObject({ isAutoCollect: false });
  });

  it("fails closed on unavailable Firefox permission APIs but keeps Chrome behavior", async () => {
    const firefox = await backgroundHarness();
    firefox.getAll.mockRejectedValue(new Error("synthetic API failure"));
    await expect(firefox.context.authResponse({ type: "auth-credentials" }, idpSender)).rejects.toMatchObject({ permissionRequired: true });
    const chrome = await backgroundHarness("chrome-extension:");
    chrome.getAll.mockResolvedValue({ permissions: [] });
    expect((await chrome.context.authResponse({ type: "auth-credentials" }, idpSender)).credentials.id).toBe("synthetic-student");
  });

  it("allows disabling saved auto-login while Firefox permission is absent", async () => {
    const { context, getAll } = await backgroundHarness();
    getAll.mockResolvedValue({ data_collection: [] });
    const sender = { id: "@synthetic-extension", url: "moz-extension://synthetic-uuid/index.html" };
    expect(await context.authResponse({ type: "auth-save", values: { enabled: false } }, sender)).toMatchObject({ enabled: false, configured: true });
    expect(await context.decryptCredentials(context.fixtureRecord)).toMatchObject({ password: "synthetic-password" });
    expect(context.isExtensionPageSender({ ...sender, url: "moz-extension://another-uuid/index.html" })).toBe(false);
  });
});

async function registrationPage({ protocol = "moz-extension:", state = { ok: true, isAutoCollect: false }, transportFailure = false } = {}) {
  const timers = [];
  const click = vi.fn();
  class Element { closest() { return null; } }
  class Input extends Element {}
  const viewId = Object.assign(new Input(), { value: "MfaInfoDisplay.jsp" });
  const button = Object.assign(new Element(), { value: "MFA登録に進む", click });
  const stored = new Map([["koan-plus-mfa-auto-collect", "true"]]);
  const sendMessage = vi.fn(async ({ type }) => {
    if (type === "auth-mfa-check-auto-tab") return state;
    if (transportFailure) throw new Error("synthetic disconnected background");
    return { ok: false, permissionRequired: true };
  });
  const window = { addEventListener() {}, setTimeout: fn => timers.push(fn) }; window.top = window;
  const context = vm.createContext({
    URL, window, HTMLElement: Element, HTMLInputElement: Input,
    location: { origin: "https://auth-mfa.auth.osaka-u.ac.jp", hash: "" },
    sessionStorage: { getItem: key => stored.get(key), removeItem: key => stored.delete(key) },
    document: { title: "fixture", body: { textContent: "MFA情報表示", innerText: "MFA情報表示" }, getElementById: () => null,
      querySelector: selector => selector === 'input[name="viewId"]' ? viewId : null,
      querySelectorAll: () => [button], contains: () => true },
    chrome: { runtime: { getURL: () => `${protocol}//synthetic-uuid/`, sendMessage } },
  });
  vm.runInContext(contentSource, context);
  for (let i = 0; i < 12; i++) await Promise.resolve();
  for (const timer of timers) timer();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  return { click, sendMessage, stored };
}

describe("MFA content script recovery", () => {
  it.each([{ ok: false, permissionRequired: true }, { ok: true, isAutoCollect: false }])("does not resume a stale session flag when background returns %j", async state => {
    const { sendMessage, click } = await registrationPage({ state });
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual(["auth-mfa-check-auto-tab"]);
    expect(click).not.toHaveBeenCalled();
  });
  it.each([false, true])("never falls back to direct Firefox submission after permission denial or transport failure (%s)", async transportFailure => {
    const { click } = await registrationPage({ state: { ok: true, isAutoCollect: true }, transportFailure });
    expect(click).not.toHaveBeenCalled();
  });
  it("retains the Chrome direct fallback for the same transport failure", async () => {
    const { click } = await registrationPage({ protocol: "chrome-extension:", state: { ok: true, isAutoCollect: true }, transportFailure: true });
    expect(click).toHaveBeenCalled();
  });
});
