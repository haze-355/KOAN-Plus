import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync("public/background.js", "utf8");
const portalUrl = "https://koan.osaka-u.ac.jp/campusweb/campusportal.do?page=main";
const koanSource = source.slice(source.indexOf("let koanProbeTask;"), source.indexOf("function wait(milliseconds)"));
const cleSource = source.slice(source.indexOf("const cleProbeTasks ="), source.indexOf("async function findCleTab("));
const koanProbe = () => new Function("KOAN_PORTAL_URL", `${koanSource}; return probeKoanLogin;`)(portalUrl);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function loginHarness(ready = false) {
  const probe = vi.fn(async () => ({ ok: ready, text: "synthetic portal", url: portalUrl }));
  const open = vi.fn(async () => ({ manual: true, tab: { id: 1 } }));
  const exists = vi.fn(async () => true);
  const ensureTab = vi.fn(async () => ({ id: 1 }));
  const noop = async () => {};
  const loginSource = source.slice(source.indexOf("const KOAN_LOGIN_POLL_INTERVAL_MS"), source.indexOf("const cleProbeTasks ="));
  const login = new Function("probeKoanLogin", "openLoginTab", "wait", "tabExists", "ensureKoanTab", "readManualFlow", "clearManualFlow", "focusTab", "waitForTabComplete", "returnToDashboard", "chrome", "KOAN_PORTAL_URL", "rememberLoginTab", `let koanLoginTask; ${loginSource}; return ensureKoanLogin;`)(
    probe, open, ms => new Promise(resolve => setTimeout(resolve, ms)), exists, ensureTab,
    async () => null, noop, noop, noop, noop, { tabs: { remove: noop } }, portalUrl, noop,
  );
  return { login, probe, open, exists };
}

describe("KOAN authentication polling", () => {
  it("limits a 90-second login wait to 19 portal checks", async () => {
    vi.useFakeTimers();
    const { login, probe } = loginHarness();
    const result = login(null, {}).catch(error => error);
    await vi.advanceTimersByTimeAsync(4999);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(85_000);
    expect(await result).toBeInstanceOf(Error);
    expect(probe).toHaveBeenCalledTimes(19);
  });

  it("returns a ready session immediately without delaying or opening a login tab", async () => {
    vi.useFakeTimers();
    const { login, probe, open } = loginHarness(true);
    expect(await login(null, {})).toMatchObject({ ok: true, loginStarted: false });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detects completion on the next five-second probe and then stops polling", async () => {
    vi.useFakeTimers();
    const { login, probe } = loginHarness();
    probe.mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true, text: "fixture", url: portalUrl });
    const result = login(null, {});
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toMatchObject({ ok: true, loginStarted: true });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("still detects a closed login tab within one second without another network request", async () => {
    vi.useFakeTimers();
    const { login, probe, exists } = loginHarness();
    exists.mockResolvedValue(false);
    const result = login(null, {}).catch(error => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).message).toContain("閉じられた");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("authentication request sharing without a result cache", () => {
  it("twenty simultaneous KOAN checks send one request and a later check observes logout", async () => {
    const response = deferred();
    const fetch = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue({
      ok: true, url: portalUrl, text: async () => "<p>Login</p>",
    });
    vi.stubGlobal("fetch", fetch);
    const probe = koanProbe();
    const checks = Array.from({ length: 20 }, () => probe());
    expect(fetch).toHaveBeenCalledTimes(1);
    response.resolve({ ok: true, url: portalUrl, text: async () => '<div id="portal-body"></div>' });
    expect((await Promise.all(checks)).every(result => result.ok)).toBe(true);
    expect((await probe()).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("clears the shared KOAN request after a network failure so recovery is immediate", async () => {
    const response = deferred();
    const fetch = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue({
      ok: true, url: portalUrl, text: async () => '<div id="portal-body"></div>',
    });
    vi.stubGlobal("fetch", fetch);
    const probe = koanProbe();
    const first = probe();
    const second = probe();
    response.resolve(Promise.reject(new Error("synthetic network failure")));
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(false);
    expect((await probe()).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares CLE checks per tab and rechecks each completed or failed request", async () => {
    const pending = new Map();
    const executeScript = vi.fn(({ target }) => {
      const request = deferred();
      pending.set(target.tabId, request);
      return request.promise;
    });
    const probe = new Function("chrome", "withTimeout", "CLE_PROBE_URL", `${cleSource}; return cleApiReady;`)(
      { scripting: { executeScript } }, task => task, "https://example.invalid/summary",
    );
    const checks = [probe(1), probe(1), probe(2), probe(2)];
    expect(executeScript).toHaveBeenCalledTimes(2);
    pending.get(1).resolve([{ result: { ok: true, contentType: "application/json" } }]);
    pending.get(2).resolve(Promise.reject(new Error("synthetic unavailable tab")));
    expect(await Promise.all(checks)).toEqual([true, true, false, false]);
    const later = probe(2);
    pending.get(2).resolve([{ result: { ok: true, contentType: "application/json" } }]);
    expect(await later).toBe(true);
    expect(executeScript).toHaveBeenCalledTimes(3);
  });
});
