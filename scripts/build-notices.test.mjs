import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNotices } from "./build-notices.mjs";

const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture({ license = true, version = "1.0.0" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "koan-notices-"));
  temporary.push(root);
  const dependency = join(root, "node_modules/fixture-dependency");
  await mkdir(dependency, { recursive: true });
  await mkdir(join(root, "licenses"));
  await Promise.all([
    writeFile(join(root, "LICENSE"), "Project license fixture"),
    writeFile(join(root, "THIRD_PARTY_NOTICES.md"), "Third-party source fixture"),
    writeFile(join(root, "licenses/lucide.txt"), "Icon license fixture"),
    writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: {
      "": { version: "1.5.0" },
      "node_modules/fixture-dependency": { version: "1.0.0", license: "MIT" },
      "node_modules/dev-tool-not-installed": { version: "1.0.0", dev: true },
    } })),
    writeFile(join(dependency, "package.json"), JSON.stringify({ name: "fixture-dependency", version, license: "MIT" })),
    ...(license ? [writeFile(join(dependency, "LICENSE"), "Dependency copyright and permission fixture")] : []),
  ]);
  return root;
}

describe("distribution notices", () => {
  it.each(["dist", "dist-firefox"])("includes project, dependency, and inline icon notices in %s", async outputDirectory => {
    const root = await fixture();
    await buildNotices(root, outputDirectory);
    expect(await readFile(join(root, outputDirectory, "LICENSE"), "utf8")).toBe("Project license fixture");
    const notices = await readFile(join(root, outputDirectory, "THIRD_PARTY_NOTICES.txt"), "utf8");
    expect(notices).toContain("fixture-dependency 1.0.0");
    expect(notices).toContain("Dependency copyright and permission fixture");
    expect(notices).toContain("Icon license fixture");
    expect(notices).not.toContain("dev-tool-not-installed");
  });
  it("fails before creating notices if license text is missing", async () => {
    const root = await fixture({ license: false });
    await expect(buildNotices(root)).rejects.toThrow("Missing license text");
    await expect(readFile(join(root, "dist/THIRD_PARTY_NOTICES.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects dependency versions that differ from the lockfile", async () => {
    await expect(buildNotices(await fixture({ version: "2.0.0" }))).rejects.toThrow("Run npm ci");
  });
});
