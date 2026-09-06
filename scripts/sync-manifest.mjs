import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// These fields intentionally differ because the root manifest is a development
// loader while public/manifest.json is the installable production extension.
// All other shared fields are checked after every sync so new manifest drift
// fails the build instead of waiting for a release review to notice it.
export const INTENTIONAL_MANIFEST_DIFFERENCE_PATHS = [
  "description",
  "icons",
  "action.default_title",
  "action.default_icon",
  "background.service_worker",
  "permissions",
  "host_permissions",
  "content_scripts",
  "minimum_chrome_version",
];

function flatten(value, prefix = "", output = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    output[prefix || "<root>"] = value;
    return output;
  }
  for (const key of Object.keys(value).sort()) {
    flatten(value[key], prefix ? `${prefix}.${key}` : key, output);
  }
  return output;
}

function isIntentionalPath(path) {
  return INTENTIONAL_MANIFEST_DIFFERENCE_PATHS.some((allowed) =>
    path === allowed || path.startsWith(`${allowed}.`)
  );
}

export function manifestParityDiff(devManifest, productionManifest) {
  const dev = flatten(devManifest);
  const production = flatten(productionManifest);
  const paths = [...new Set([...Object.keys(dev), ...Object.keys(production)])].sort();
  return paths
    .filter((path) => !isIntentionalPath(path))
    .filter((path) => JSON.stringify(dev[path]) !== JSON.stringify(production[path]))
    .map((path) => ({
      path,
      development: dev[path],
      production: production[path],
    }));
}

export function assertManifestParity(devManifest, productionManifest) {
  const differences = manifestParityDiff(devManifest, productionManifest);
  if (differences.length) {
    throw new Error(
      `Development and production manifests drifted in non-intentional fields:\n${
        differences.map((difference) => `- ${difference.path}`).join("\n")
      }`,
    );
  }
}

export function assertFirefoxManifestParity(chromeManifest, firefoxManifest) {
  const chromeShared = { ...chromeManifest };
  const firefoxShared = { ...firefoxManifest };
  for (const manifest of [chromeShared, firefoxShared]) {
    delete manifest.background;
    delete manifest.minimum_chrome_version;
    delete manifest.browser_specific_settings;
  }
  chromeShared.permissions = chromeManifest.permissions.filter(permission => permission !== "downloads.ui");
  const chromeFields = flatten(chromeShared);
  const firefoxFields = flatten(firefoxShared);
  const differences = [...new Set([...Object.keys(chromeFields), ...Object.keys(firefoxFields)])]
    .filter(path => JSON.stringify(chromeFields[path]) !== JSON.stringify(firefoxFields[path]));
  if (differences.length) throw new Error(`Chrome and Firefox manifests drifted: ${differences.join(", ")}`);
}

export async function syncManifests(root = projectRoot) {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const { version, description } = pkg;

  const devManifestPath = join(root, "manifest.json");
  const devManifest = JSON.parse(await readFile(devManifestPath, "utf8"));
  devManifest.version = version;
  await writeFile(devManifestPath, JSON.stringify(devManifest, null, 2) + "\n");

  const prodManifestPath = join(root, "public/manifest.json");
  const prodManifest = JSON.parse(await readFile(prodManifestPath, "utf8"));
  prodManifest.version = version;
  prodManifest.description = description;
  await writeFile(prodManifestPath, JSON.stringify(prodManifest, null, 2) + "\n");

  assertManifestParity(devManifest, prodManifest);
  const firefoxManifestPath = join(root, "public/manifest.firefox.json");
  const firefoxManifest = JSON.parse(await readFile(firefoxManifestPath, "utf8"));
  firefoxManifest.version = version;
  firefoxManifest.description = description;
  assertFirefoxManifestParity(prodManifest, firefoxManifest);
  await writeFile(firefoxManifestPath, JSON.stringify(firefoxManifest, null, 2) + "\n");
  console.log(`Synced version ${version} and description to manifest files.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await syncManifests();
}
