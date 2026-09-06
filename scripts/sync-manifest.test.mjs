import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertManifestParity,
  assertFirefoxManifestParity,
  manifestParityDiff,
} from "./sync-manifest.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("manifest parity", () => {
  it("keeps non-intentional development/production fields aligned", async () => {
    const development = JSON.parse(await readFile(join(projectRoot, "manifest.json"), "utf8"));
    const production = JSON.parse(await readFile(join(projectRoot, "public/manifest.json"), "utf8"));

    expect(manifestParityDiff(development, production)).toEqual([]);
    expect(() => assertManifestParity(development, production)).not.toThrow();
  });

  it("reports a shared field drift while ignoring documented differences", () => {
    const development = {
      manifest_version: 3,
      name: "KOAN Plus",
      version: "1.0.0",
      description: "development",
      action: { default_title: "dev" },
    };
    const production = {
      manifest_version: 3,
      name: "KOAN Plus",
      version: "1.0.0",
      description: "production",
      action: { default_title: "prod" },
    };

    expect(manifestParityDiff(development, production)).toEqual([]);
    expect(() => assertManifestParity(
      development,
      { ...production, name: "Drifted" },
    )).toThrow("name");
  });
});

it("keeps Firefox shared fields and permissions in sync while allowing browser-specific metadata", async () => {
  const chrome = JSON.parse(await readFile(join(projectRoot, "public/manifest.json"), "utf8"));
  const firefox = JSON.parse(await readFile(join(projectRoot, "public/manifest.firefox.json"), "utf8"));
  expect(() => assertFirefoxManifestParity(chrome, firefox)).not.toThrow();
  expect(() => assertFirefoxManifestParity(chrome, { ...firefox, host_permissions: [] })).toThrow("host_permissions");
  expect(() => assertFirefoxManifestParity(chrome, { ...firefox, permissions: chrome.permissions })).toThrow("permissions");
});
