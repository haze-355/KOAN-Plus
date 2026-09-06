import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync("public/background.js", "utf8");
const origins = {
  koan: "https://koan.osaka-u.ac.jp",
  cle: "https://www.cle.osaka-u.ac.jp",
};
const otpUrl = "https://ou-idp.auth.osaka-u.ac.jp/idp/synthetic-otp";
const record = { enabled: true, payload: "synthetic-encrypted-record", mfaEnabled: false };
const sender = { tab: { id: 1000 } };
const duration = service => service === "koan" ? 90_000 : 45_000;

afterEach(() => { vi.useRealTimers(); });

// Run the complete production background. Only browser I/O is simulated;
// authentication polling, tab ownership, session recovery and cleanup are real.
function harness({ sessionAvailable = true, sessionRemoveFails = false } = {}) {
  const stored = {};
  const tabs = new Map();
  const ready = { koan: false, cle: false };
  let nextId = 1;
  const get = vi.fn(async id => {
    if (!tabs.has(id)) throw new Error("synthetic closed tab");
    return { ...tabs.get(id) };
  });
  const create = vi.fn(async options => {
    const service = options.url.startsWith(origins.koan) ? "koan" : "cle";
    const tab = { id: nextId++, url: otpUrl, active: options.active, status: "complete", service };
    tabs.set(tab.id, tab);
    return { ...tab };
  });
  const update = vi.fn(async (id, options) => {
    const tab = await get(id);
    Object.assign(tab, options);
    tabs.set(id, tab);
    return { ...tab };
  });
  const remove = vi.fn(async id => { tabs.delete(id); });
  const query = vi.fn(async ({ url }) => [...tabs.values()].filter(tab =>
    (Array.isArray(url) ? url : [url]).some(pattern => tab.url.startsWith(pattern.replace(/\*$/, ""))),
  ).map(tab => ({ ...tab })));
  const storage = { session: {
    get: async key => key ? { [key]: stored[key] } : { ...stored },
    set: async values => Object.assign(stored, values),
    remove: async key => {
      if (sessionRemoveFails) throw new Error("synthetic session storage failure");
      for (const item of Array.isArray(key) ? key : [key]) delete stored[item];
    },
  } };
  const fetch = vi.fn(async () => ({
    ok: true,
    url: ready.koan ? `${origins.koan}/campusweb/campusportal.do?page=main` : otpUrl,
    text: async () => ready.koan ? '<div id="portal-body">Synthetic portal</div>' : "Synthetic OTP form",
  }));
  const chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: { id: "synthetic", getURL: path => `chrome-extension://synthetic/${path}`, onMessage: { addListener() {} } },
    tabs: { get, create, update, remove, query, onRemoved: { addListener() {} } },
    windows: { update: vi.fn(async () => {}) },
    storage: sessionAvailable ? storage : {},
    scripting: { executeScript: vi.fn(async ({ target }) => [{ result: {
      ok: Boolean(ready.cle && tabs.get(target.tabId)?.url.startsWith(origins.cle)),
      contentType: "application/json",
    } }]) },
  };
  let context;
  const restart = () => {
    context = vm.createContext({ URL, TextEncoder, TextDecoder, Date, AbortController, setTimeout, clearTimeout, fetch, chrome });
    vm.runInContext(source, context);
  };
  restart();
  return {
    tabs, stored, create, update, remove, fetch, restart,
    login: (service, options = {}) => service === "koan"
      ? context.ensureKoanLogin(record, sender, options.requireTab || false)
      : context.ensureCleLogin(record, sender, options.force || false),
    finish(service) {
      ready[service] = true;
      for (const tab of tabs.values()) {
        if (tab.service === service) tab.url = `${origins[service]}/${service === "koan" ? "campusweb/campusportal.do?page=main" : "ultra"}`;
      }
    },
    expire(service) { ready[service] = false; },
  };
}

async function timeOut(h, service) {
  const attempt = h.login(service).catch(error => error);
  await vi.advanceTimersByTimeAsync(duration(service));
  expect((await attempt).message).toMatch(/完了していません|完了しませんでした/);
  expect(vi.getTimerCount()).toBe(0);
}

describe("pending authentication tab reuse", () => {
  it.each(["koan", "cle"])("%s keeps the OTP form through repeated polling timeouts and completes in the same tab", async service => {
    vi.useFakeTimers();
    const h = harness();
    // A user's unrelated login tab must never be claimed or navigated.
    h.tabs.set(99, { id: 99, url: otpUrl, status: "complete" });
    await timeOut(h, service);
    h.tabs.get(1).draft = "synthetic-unsubmitted-otp";
    await timeOut(h, service);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.tabs.get(1)).toMatchObject({ url: otpUrl, draft: "synthetic-unsubmitted-otp" });
    expect(h.update.mock.calls.filter(([, options]) => options.url)).toEqual([]);
    const completion = h.login(service);
    await vi.advanceTimersByTimeAsync(0);
    h.finish(service);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await completion).toMatchObject({ ok: true, loginStarted: true });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.stored[`authLoginTab:${service}`]).toBeUndefined();
    expect(h.tabs.get(99).url).toBe(otpUrl);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["koan", "cle"])("%s restores its pending tab after the background restarts", async service => {
    vi.useFakeTimers();
    const h = harness();
    await timeOut(h, service);
    // A long wait must not turn into a new tab when the five-minute UI flow expires.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    h.restart();
    await timeOut(h, service);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.tabs.size).toBe(1);
  });

  it.each(["closed", "navigated"])("creates a replacement when the owned tab was %s, without modifying unrelated tabs", async state => {
    vi.useFakeTimers();
    const h = harness();
    await timeOut(h, "koan");
    if (state === "closed") h.tabs.delete(1);
    else h.tabs.get(1).url = "https://example.invalid/user-navigation";
    await timeOut(h, "koan");
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.stored["authLoginTab:koan"]).toBe(2);
    if (state === "navigated") expect(h.tabs.get(1).url).toBe("https://example.invalid/user-navigation");
  });

  it.each(["koan", "cle"])("shares concurrent %s attempts and recovers when initial tab creation fails", async service => {
    vi.useFakeTimers();
    const h = harness();
    h.create.mockRejectedValueOnce(new Error("synthetic tab creation failure"));
    await expect(h.login(service)).rejects.toThrow("synthetic tab creation failure");
    const requests = Array.from({ length: 10 }, () => h.login(service).catch(error => error));
    await vi.advanceTimersByTimeAsync(duration(service));
    expect((await Promise.all(requests)).every(result => /完了/.test(result.message))).toBe(true);
    expect(h.create).toHaveBeenCalledTimes(2); // One failed creation, one shared replacement.
    expect(h.tabs.size).toBe(1);
  });

  it("keeps KOAN and CLE ownership separate even when both tabs show the same identity provider", async () => {
    vi.useFakeTimers();
    const h = harness();
    await timeOut(h, "koan");
    await timeOut(h, "cle");
    await timeOut(h, "koan");
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.stored["authLoginTab:koan"]).not.toBe(h.stored["authLoginTab:cle"]);
  });

  it("does not restart a pending CLE form on forced refresh when another CLE tab exists", async () => {
    vi.useFakeTimers();
    const h = harness();
    await timeOut(h, "cle");
    h.tabs.set(99, { id: 99, url: `${origins.cle}/ultra`, status: "complete", service: "cle" });
    const attempt = h.login("cle", { force: true }).catch(error => error);
    await vi.advanceTimersByTimeAsync(duration("cle"));
    expect((await attempt).message).toContain("完了しませんでした");
    expect(h.update.mock.calls.filter(([, options]) => options.url)).toEqual([]);
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it.each(["koan", "cle"])("releases %s ownership when authentication finishes after the polling timeout", async service => {
    vi.useFakeTimers();
    const h = harness();
    await timeOut(h, service);
    h.finish(service);
    expect(await h.login(service)).toMatchObject({ ok: true, loginStarted: false });
    expect(h.stored[`authLoginTab:${service}`]).toBeUndefined();
    h.tabs.delete(1);
    h.expire(service);
    await timeOut(h, service);
    expect(h.create).toHaveBeenCalledTimes(2);
  });

  it("retains in-memory ownership when session storage is unavailable", async () => {
    vi.useFakeTimers();
    const h = harness({ sessionAvailable: false });
    await timeOut(h, "koan");
    await timeOut(h, "koan");
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("does not revive completed ownership when clearing session storage fails", async () => {
    vi.useFakeTimers();
    const h = harness({ sessionRemoveFails: true });
    const completion = h.login("koan", { requireTab: true });
    await vi.advanceTimersByTimeAsync(0);
    h.finish("koan");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await completion).toMatchObject({ ok: true, tabId: 1 });
    h.expire("koan");
    await timeOut(h, "koan");
    expect(h.create).toHaveBeenCalledTimes(2);
  });
});
