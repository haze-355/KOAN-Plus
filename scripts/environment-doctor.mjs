// Shared template copied into each package so a checkout is self-contained.
// Read-only: no install, login, network, or environment value output.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function result(ok, label) {
  console.log(`${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok) failures++;
}
function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}
const manifest = readJson(join(root, "package.json"));
if (!manifest) {
  console.error("FAIL package.json is missing or invalid");
  process.exit(1);
}
const pinPath = join(root, ".nvmrc");
const pin = existsSync(pinPath) ? readFileSync(pinPath, "utf8").trim().replace(/^v/, "") : null;
result(pin === process.versions.node, `Node ${process.versions.node}; expected ${pin ?? "missing .nvmrc"}`);
const manager = manifest.packageManager;
let npmVersion;
try { npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
catch { npmVersion = "unavailable"; }
result(manager === `npm@${npmVersion}`, `npm ${npmVersion}; expected ${manager ?? "missing packageManager"}`);
const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
if (Object.keys(dependencies).length) {
  result(existsSync(join(root, "node_modules")), "node_modules exists (install with npm ci)");
  const lock = readJson(join(root, "package-lock.json"));
  const entry = lock?.packages?.[""];
  const canonical = (value) => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  result(Boolean(entry) && ["dependencies", "devDependencies"].every(
    (key) => canonical(manifest[key]) === canonical(entry[key])), "manifest and lockfile agree");
}
for (const tool of ["supabase", "wrangler"]) {
  if (!(tool in dependencies)) continue;
  const installed = readJson(join(root, "node_modules", tool, "package.json"));
  result(installed?.version === dependencies[tool], `${tool}: installed ${installed?.version ?? "missing"}, pinned ${dependencies[tool]}`);
}
console.log(`${failures} failure(s). Authentication and application behavior require separate checks.`);
process.exitCode = failures ? 1 : 0;
