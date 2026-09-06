import { copyFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(projectRoot, "dist-firefox");
const srcManifest = join(distDir, "manifest.firefox.json");
const dstManifest = join(distDir, "manifest.json");

await copyFile(srcManifest, dstManifest);

for (const name of ["manifest.firefox.json", "manifest.chrome.json"]) {
  await rm(join(distDir, name), { force: true });
}

console.log(`Prepared Firefox build: ${dstManifest}`);
