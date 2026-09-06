import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export async function createThirdPartyNotices(root = projectRoot) {
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const sections = [
    "KOAN Plus — Third-party notices",
    "Includes all locked production dependencies, including transitive packages that may be omitted from the browser bundle. Development-only tools are excluded.",
    await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
    await readFile(join(root, "licenses/lucide.txt"), "utf8"),
  ];
  for (const [packagePath, metadata] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (!packagePath || metadata.dev) continue;
    if (!packagePath.startsWith("node_modules/") || packagePath.split("/").includes("..") || metadata.link) {
      throw new Error(`Review the dependency license source: ${packagePath}`);
    }
    const directory = join(root, packagePath);
    const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (pkg.version !== metadata.version) throw new Error(`Run npm ci: installed version differs from lockfile for ${pkg.name}`);
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^(licen[sc]e|copying|notice)([._-]|$)/i.test(entry.name))
      .map(entry => entry.name).sort();
    if (!files.length) throw new Error(`Missing license text for ${pkg.name}; review before distribution.`);
    sections.push(`${pkg.name} ${pkg.version}\nDeclared license: ${pkg.license || metadata.license || "See license text"}`);
    for (const file of files) sections.push(`${file}\n\n${await readFile(join(directory, file), "utf8")}`);
  }
  return sections.join("\n\n----------------------------------------\n\n") + "\n";
}

export async function buildNotices(root = projectRoot, outputDirectory = "dist") {
  // Validate every notice before writing a distributable file.
  const notices = await createThirdPartyNotices(root);
  const destination = join(root, outputDirectory);
  await mkdir(destination, { recursive: true });
  await copyFile(join(root, "LICENSE"), join(destination, "LICENSE"));
  await writeFile(join(destination, "THIRD_PARTY_NOTICES.txt"), notices);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDirectory = process.argv[2] || "dist";
  await buildNotices(projectRoot, outputDirectory);
  console.log(`Included project license and third-party notices in ${outputDirectory}.`);
}
