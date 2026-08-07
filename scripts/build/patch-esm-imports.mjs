import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const packagesRoot = path.join(repoRoot, "packages");

for (const packageName of await readdir(packagesRoot)) {
  const distRoot = path.join(packagesRoot, packageName, "dist");

  if (!(await pathExists(distRoot))) {
    continue;
  }

  for (const filePath of await listJavaScriptFiles(distRoot)) {
    const source = await readFile(filePath, "utf8");
    const patched = source.replace(
      /(from\s+["']|import\s+["']|import\s*\(\s*["'])(\.{1,2}\/[^"']+)(["'])/gu,
      (match, prefix, specifier, suffix) => {
        if (hasExplicitExtension(specifier)) {
          return match;
        }

        return `${prefix}${resolveRelativeSpecifier(filePath, specifier)}${suffix}`;
      },
    );

    if (patched !== source) {
      await writeFile(filePath, patched, "utf8");
    }
  }
}

async function listJavaScriptFiles(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listJavaScriptFiles(entryPath)));
      continue;
    }

    if (
      entry.isFile() &&
      entry.name.endsWith(".js") &&
      !entry.name.endsWith(".test.js")
    ) {
      files.push(entryPath);
    }
  }

  return files;
}

function hasExplicitExtension(specifier) {
  return path.extname(specifier) !== "";
}

function resolveRelativeSpecifier(importerPath, specifier) {
  const absoluteTarget = path.resolve(path.dirname(importerPath), specifier);

  if (fileExistsSyncLike(absoluteTarget, ".js")) {
    return `${specifier}.js`;
  }

  if (fileExistsSyncLike(path.join(absoluteTarget, "index"), ".js")) {
    return `${specifier}/index.js`;
  }

  throw new Error(
    `Unable to resolve emitted ESM specifier ${JSON.stringify(specifier)} from ${path.relative(repoRoot, importerPath)}.`,
  );
}

function fileExistsSyncLike(filePath, extension) {
  return existsSync(`${filePath}${extension}`);
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
