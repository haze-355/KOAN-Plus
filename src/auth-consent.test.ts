import { afterEach, expect, it, vi } from "vitest";
import { hasDataCollectionPermission, requestAuthenticationInfoPermission } from "./auth";

afterEach(() => vi.unstubAllGlobals());
it("requests Firefox consent synchronously within the user gesture, without a preliminary getAll", async () => {
  const request = vi.fn().mockResolvedValue(true);
  const getAll = vi.fn();
  vi.stubGlobal("chrome", { runtime: { getURL: () => "moz-extension://synthetic/" }, permissions: { request, getAll } });
  const pending = requestAuthenticationInfoPermission();
  expect(request).toHaveBeenCalledWith({ data_collection: ["authenticationInfo"] });
  expect(getAll).not.toHaveBeenCalled();
  expect(await pending).toBe(true);
});
it.each([undefined, {}, { data_collection: [] }, { data_collection: ["authenticationInfo"] }])("omits Firefox contact telemetry without its specific permission (%j)", async permissions => {
  vi.stubGlobal("chrome", { runtime: { getURL: () => "moz-extension://synthetic/" }, permissions: { getAll: async () => permissions } });
  expect(await hasDataCollectionPermission("technicalAndInteraction")).toBe(false);
});
it("handles a rejected consent prompt without saving and keeps Chrome consent-free", async () => {
  vi.stubGlobal("chrome", { runtime: { getURL: () => "moz-extension://synthetic/" }, permissions: { request: async () => { throw new Error("denied"); } } });
  expect(await requestAuthenticationInfoPermission()).toBe(false);
  vi.stubGlobal("chrome", { runtime: { getURL: () => "chrome-extension://synthetic/" } });
  expect(await requestAuthenticationInfoPermission()).toBe(true);
  expect(await hasDataCollectionPermission("technicalAndInteraction")).toBe(true);
});
