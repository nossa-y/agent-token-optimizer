import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const outputDir = path.join(repoRoot, "artifacts", "security");
const rootManifest = await readJson(path.join(repoRoot, "package.json"));
const packageManifests = await readWorkspacePackageManifests();
const productionGraphs = await readProductionGraphs();
const workspaceVersions = new Map(
  packageManifests.map(({ manifest }) => [manifest.name, manifest.version]),
);
const generatedAt = new Date().toISOString();
const components = [];
const dependencyGraph = new Map();

for (const { manifest } of packageManifests) {
  const bomRef = `${manifest.name}@${manifest.version}`;
  components.push({
    "bom-ref": bomRef,
    type: "library",
    name: manifest.name,
    version: manifest.version,
    scope: "required",
    purl: `pkg:npm/${encodePackageName(manifest.name)}@${manifest.version}`,
    properties: [
      {
        name: "agent-token-optimizer:workspace-package",
        value: String(manifest.private === true),
      },
    ],
  });
  mergeDependencyEdges(bomRef, []);
}

for (const graph of productionGraphs) {
  const workspaceVersion = workspaceVersions.get(graph.name);
  if (!workspaceVersion) {
    continue;
  }
  addResolvedDependencies(`${graph.name}@${workspaceVersion}`, graph.dependencies ?? {});
}

const sbom = {
  $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: generatedAt,
    tools: [
      {
        vendor: "agent-relay",
        name: "workspace-sbom-script",
        version: rootManifest.version,
      },
    ],
    component: {
      "bom-ref": `${rootManifest.name}@${rootManifest.version}`,
      type: "application",
      name: rootManifest.name,
      version: rootManifest.version,
    },
  },
  components: dedupeComponents(components).sort((left, right) =>
    left["bom-ref"].localeCompare(right["bom-ref"]),
  ),
  dependencies: [...dependencyGraph.entries()]
    .map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort() }))
    .sort((left, right) => left.ref.localeCompare(right.ref)),
};

const inventory = {
  generatedAt,
  packageManager: rootManifest.packageManager,
  node: process.version,
  workspacePackages: packageManifests.map(({ manifest }) => ({
    name: manifest.name,
    version: manifest.version,
    private: manifest.private === true,
  })),
};

await mkdir(outputDir, { recursive: true });
await writeFile(
  path.join(outputDir, "sbom.cyclonedx.json"),
  `${JSON.stringify(sbom, null, 2)}\n`,
  "utf8",
);
await writeFile(
  path.join(outputDir, "workspace-inventory.json"),
  `${JSON.stringify(inventory, null, 2)}\n`,
  "utf8",
);

console.log(`Wrote security inventory to ${path.relative(repoRoot, outputDir)}.`);

async function readWorkspacePackageManifests() {
  const packageRoot = path.join(repoRoot, "packages");
  const entries = await readdir(packageRoot, { withFileTypes: true });
  const manifests = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    manifests.push({
      manifest: await readJson(path.join(packageRoot, entry.name, "package.json")),
    });
  }

  return manifests.sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  );
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readProductionGraphs() {
  const { stdout } = await execFileAsync(
    "pnpm",
    ["list", "--prod", "--recursive", "--depth", "Infinity", "--json"],
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

function addResolvedDependencies(parentRef, dependencyNodes) {
  const childRefs = [];

  for (const [dependencyName, dependencyNode] of Object.entries(dependencyNodes).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (!dependencyNode || typeof dependencyNode !== "object") {
      continue;
    }

    const workspaceVersion = workspaceVersions.get(dependencyName);
    const resolvedVersion = workspaceVersion ?? dependencyNode.version;
    if (typeof resolvedVersion !== "string" || resolvedVersion.length === 0) {
      throw new Error(`Missing resolved version for ${dependencyName}.`);
    }

    const dependencyRef = `${dependencyName}@${resolvedVersion}`;
    childRefs.push(dependencyRef);
    if (!workspaceVersion) {
      components.push({
        "bom-ref": dependencyRef,
        type: "library",
        name: dependencyName,
        version: resolvedVersion,
        scope: "required",
        purl: `pkg:npm/${encodePackageName(dependencyName)}@${resolvedVersion}`,
      });
    }

    addResolvedDependencies(dependencyRef, dependencyNode.dependencies ?? {});
  }

  mergeDependencyEdges(parentRef, childRefs);
}

function mergeDependencyEdges(ref, childRefs) {
  const existing = dependencyGraph.get(ref) ?? new Set();
  for (const childRef of childRefs) {
    existing.add(childRef);
  }
  dependencyGraph.set(ref, existing);
}

function encodePackageName(name) {
  return name.replace("/", "%2F");
}

function dedupeComponents(input) {
  const byRef = new Map();

  for (const component of input) {
    if (!byRef.has(component["bom-ref"])) {
      byRef.set(component["bom-ref"], removeUndefined(component));
    }
  }

  return [...byRef.values()];
}

function removeUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}
