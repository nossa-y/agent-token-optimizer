import { createHash } from "node:crypto";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { Warning, WorkspaceFile, WorkspaceIndex } from "../contracts";
import type { IgnoreReason } from "../contracts/workspace";
import { createWorkspacePathPolicy } from "../security";
import { loadWorkspaceIgnoreMatcher } from "./ignore";

export interface DiscoverWorkspaceOptions {
  readonly rootPath: string;
  readonly previousIndex?: WorkspaceIndex;
  readonly packageVersion?: string;
  readonly operationId?: string;
  readonly maxFileSizeBytes?: number;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly concurrency?: number;
  readonly extraIgnorePatterns?: readonly string[];
  readonly supportedLanguages?: readonly string[];
  readonly includeContentHashes?: boolean;
  readonly signal?: AbortSignal;
}

export interface WorkspaceIdentity {
  readonly rootPath: string;
  readonly rootHash: string;
  readonly name: string;
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 1_048_576;
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1_024 * 1_024;
const DEFAULT_DISCOVERY_CONCURRENCY = 8;
const BINARY_SAMPLE_SIZE_BYTES = 8_192;

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".cjs", "javascript"],
  [".css", "css"],
  [".cts", "typescript"],
  [".html", "html"],
  [".js", "javascript"],
  [".json", "json"],
  [".jsx", "javascript"],
  [".md", "markdown"],
  [".mjs", "javascript"],
  [".mts", "typescript"],
  [".py", "python"],
  [".scss", "scss"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
]);

const BINARY_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".webp",
  ".zip",
]);

export async function discoverWorkspace(
  options: DiscoverWorkspaceOptions,
): Promise<WorkspaceIndex> {
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const concurrency = options.concurrency ?? DEFAULT_DISCOVERY_CONCURRENCY;
  assertDiscoveryLimits({ maxFileSizeBytes, maxFiles, maxTotalBytes, concurrency });
  const includeContentHashes = options.includeContentHashes ?? true;
  const supportedLanguages = options.supportedLanguages
    ? new Set(options.supportedLanguages.map((language) => language.toLowerCase()))
    : undefined;
  const pathPolicy = await createWorkspacePathPolicy(options.rootPath);
  const workspace = createWorkspaceIdentity(pathPolicy.rootPath, pathPolicy.rootRealPath);
  const previousFiles = isCompatiblePreviousIndex(
    options.previousIndex,
    workspace.rootHash,
  )
    ? new Map(options.previousIndex.files.map((file) => [file.path, file] as const))
    : new Map<string, WorkspaceFile>();
  const ignoreMatcher = await loadWorkspaceIgnoreMatcher(
    pathPolicy.rootRealPath,
    options.extraIgnorePatterns,
  );
  const files: WorkspaceFile[] = [];
  const warnings: Warning[] = [];
  const inspectionTasks: Array<() => Promise<void>> = [];
  let scheduledFiles = 0;
  let indexedBytes = 0;
  let fileLimitReached = false;
  let byteLimitReached = false;
  let cancelled = false;

  await walkDirectory(pathPolicy.rootRealPath);
  await runBounded(inspectionTasks, concurrency, options.signal);
  isCancelled();

  const indexedFiles = files.filter((file) => !file.ignored);

  return {
    metadata: {
      contractVersion: "1.0",
      generatedAt: new Date().toISOString(),
      generator: {
        name: "agent-token-optimizer",
        version: options.packageVersion ?? "0.1.0",
      },
      ...(options.operationId ? { operationId: options.operationId } : {}),
    },
    workspace,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    totals: {
      filesDiscovered: files.length,
      filesIndexed: indexedFiles.length,
      filesIgnored: files.length - indexedFiles.length,
      bytesIndexed: indexedFiles.reduce((total, file) => total + file.sizeBytes, 0),
    },
    warnings,
  };

  async function walkDirectory(directoryPath: string): Promise<void> {
    if (isCancelled()) {
      return;
    }

    const entries = await readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (isCancelled() || fileLimitReached) {
        return;
      }

      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = pathPolicy.toWorkspaceRelativePath(absolutePath);
      const isDirectory = entry.isDirectory();
      const ignoreMatch = ignoreMatcher.match(relativePath, isDirectory);

      if (isDirectory) {
        if (!ignoreMatch.ignored) {
          await walkDirectory(absolutePath);
        }

        continue;
      }

      if (entry.isSymbolicLink()) {
        scheduleInspection(() =>
          inspectSymbolicLink(absolutePath, relativePath, ignoreMatch.ignored),
        );
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      scheduleInspection(() =>
        inspectFile(
          absolutePath,
          relativePath,
          ignoreMatch.ignored ? originToIgnoreReason(ignoreMatch.origin) : undefined,
        ),
      );
    }
  }

  function scheduleInspection(task: () => Promise<void>): void {
    if (isCancelled() || fileLimitReached) {
      return;
    }

    if (scheduledFiles >= maxFiles) {
      fileLimitReached = true;
      warnings.push({
        code: "workspace_file_limit_reached",
        message: `Stopped discovery after reaching the configured ${maxFiles}-file limit.`,
        severity: "warn",
        recoverable: true,
      });
      return;
    }

    scheduledFiles += 1;
    inspectionTasks.push(task);
  }

  async function inspectSymbolicLink(
    absolutePath: string,
    relativePath: string,
    ignoredByRule: boolean,
  ): Promise<void> {
    if (isCancelled()) {
      return;
    }

    const linkStat = await lstat(absolutePath);
    const resolvedPath = await realpath(absolutePath);

    if (!pathPolicy.isInsideWorkspace(resolvedPath)) {
      files.push(
        createIgnoredFile(
          relativePath,
          linkStat.size,
          "outside_workspace",
          "unknown",
          linkStat.mtime,
        ),
      );
      warnings.push({
        code: "outside_workspace_symlink",
        message: "Skipped a symlink that resolves outside the workspace.",
        severity: "warn",
        path: relativePath,
        recoverable: true,
      });
      return;
    }

    const resolvedStat = await stat(resolvedPath);

    if (resolvedStat.isDirectory()) {
      warnings.push({
        code: "symlink_directory_skipped",
        message: "Skipped a symlinked directory to avoid duplicate traversal.",
        severity: "warn",
        path: relativePath,
        recoverable: true,
      });
      return;
    }

    await inspectFile(
      resolvedPath,
      relativePath,
      ignoredByRule ? "optimizer_config" : undefined,
      resolvedStat.size,
      resolvedStat.mtime,
    );
  }

  async function inspectFile(
    absolutePath: string,
    relativePath: string,
    ignoreReason?: IgnoreReason,
    knownSizeBytes?: number,
    knownModifiedAt?: Date,
  ): Promise<void> {
    if (isCancelled()) {
      return;
    }

    const fileStat =
      knownSizeBytes === undefined || knownModifiedAt === undefined
        ? await stat(absolutePath)
        : undefined;
    const sizeBytes = knownSizeBytes ?? fileStat?.size ?? 0;
    const modifiedAt = knownModifiedAt ?? fileStat?.mtime;
    const previousFile = previousFiles.get(relativePath);

    if (ignoreReason) {
      if (
        canReuseIgnoredFile(
          previousFile,
          sizeBytes,
          modifiedAt,
          ignoreReason,
          relativePath,
        )
      ) {
        files.push(previousFile);
        return;
      }
      files.push(
        createIgnoredFile(relativePath, sizeBytes, ignoreReason, undefined, modifiedAt),
      );
      return;
    }

    if (sizeBytes > maxFileSizeBytes) {
      if (
        canReuseIgnoredFile(
          previousFile,
          sizeBytes,
          modifiedAt,
          "oversized",
          relativePath,
        )
      ) {
        files.push(previousFile);
        return;
      }
      files.push(
        createIgnoredFile(relativePath, sizeBytes, "oversized", undefined, modifiedAt),
      );
      return;
    }

    const language = languageForPath(relativePath);

    if (language && supportedLanguages && !supportedLanguages.has(language)) {
      if (
        canReuseIgnoredFile(
          previousFile,
          sizeBytes,
          modifiedAt,
          "unsupported",
          relativePath,
        )
      ) {
        files.push(previousFile);
        return;
      }
      files.push(
        createIgnoredFile(relativePath, sizeBytes, "unsupported", undefined, modifiedAt),
      );
      return;
    }

    if (
      canReuseIndexedFile(
        previousFile,
        sizeBytes,
        modifiedAt,
        relativePath,
        includeContentHashes,
      )
    ) {
      if (!reserveIndexedBytes(sizeBytes, relativePath)) {
        return;
      }
      files.push(previousFile);
      return;
    }

    if (
      canReuseIgnoredFile(previousFile, sizeBytes, modifiedAt, "binary", relativePath)
    ) {
      files.push(previousFile);
      return;
    }

    if (await isBinaryFile(absolutePath, relativePath)) {
      files.push(
        createIgnoredFile(relativePath, sizeBytes, "binary", "binary", modifiedAt),
      );
      return;
    }

    if (!reserveIndexedBytes(sizeBytes, relativePath) || isCancelled()) {
      return;
    }

    const contentHash = includeContentHashes
      ? hashBuffer(await readFile(absolutePath))
      : undefined;

    files.push({
      path: relativePath,
      kind: classifyFileKind(relativePath),
      ...(language ? { language } : {}),
      sizeBytes,
      ...(contentHash ? { contentHash } : {}),
      ...(modifiedAt ? { modifiedAt: modifiedAt.toISOString() } : {}),
      generated: isGeneratedFile(relativePath),
      ignored: false,
    });
  }

  function reserveIndexedBytes(sizeBytes: number, relativePath: string): boolean {
    if (indexedBytes + sizeBytes <= maxTotalBytes) {
      indexedBytes += sizeBytes;
      return true;
    }

    if (!byteLimitReached) {
      byteLimitReached = true;
      warnings.push({
        code: "workspace_byte_limit_reached",
        message: `Skipped files after reaching the configured ${maxTotalBytes}-byte indexing limit.`,
        severity: "warn",
        path: relativePath,
        recoverable: true,
      });
    }

    return false;
  }

  function isCancelled(): boolean {
    if (!options.signal?.aborted) {
      return false;
    }

    if (!cancelled) {
      cancelled = true;
      warnings.push({
        code: "workspace_discovery_cancelled",
        message: "Workspace discovery was cancelled and returned a partial index.",
        severity: "warn",
        recoverable: true,
      });
    }

    return true;
  }
}

export async function getWorkspaceIdentity(rootPath: string): Promise<WorkspaceIdentity> {
  const pathPolicy = await createWorkspacePathPolicy(rootPath);

  return createWorkspaceIdentity(pathPolicy.rootPath, pathPolicy.rootRealPath);
}

export function createWorkspaceContentFingerprint(
  workspaceIndex: WorkspaceIndex,
): string {
  return hashText(
    JSON.stringify(
      workspaceIndex.files.map((file) => ({
        path: file.path,
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
        ignored: file.ignored,
        ignoreReason: file.ignoreReason,
      })),
    ),
  );
}

function createWorkspaceIdentity(
  rootPath: string,
  rootRealPath: string,
): WorkspaceIdentity {
  return {
    rootPath,
    rootHash: hashText(rootRealPath),
    name: path.basename(rootRealPath),
  };
}

function isCompatiblePreviousIndex(
  previousIndex: WorkspaceIndex | undefined,
  workspaceRootHash: string,
): previousIndex is WorkspaceIndex {
  return previousIndex?.workspace.rootHash === workspaceRootHash;
}

function canReuseIndexedFile(
  previousFile: WorkspaceFile | undefined,
  sizeBytes: number,
  modifiedAt: Date | undefined,
  relativePath: string,
  includeContentHashes: boolean,
): previousFile is WorkspaceFile {
  return Boolean(
    previousFile &&
    !previousFile.ignored &&
    previousFile.sizeBytes === sizeBytes &&
    previousFile.modifiedAt === modifiedAt?.toISOString() &&
    previousFile.generated === isGeneratedFile(relativePath) &&
    (!includeContentHashes || previousFile.contentHash),
  );
}

function canReuseIgnoredFile(
  previousFile: WorkspaceFile | undefined,
  sizeBytes: number,
  modifiedAt: Date | undefined,
  ignoreReason: IgnoreReason,
  relativePath: string,
): previousFile is WorkspaceFile {
  return Boolean(
    previousFile &&
    previousFile.ignored &&
    previousFile.ignoreReason === ignoreReason &&
    previousFile.sizeBytes === sizeBytes &&
    previousFile.modifiedAt === modifiedAt?.toISOString() &&
    previousFile.generated === isGeneratedFile(relativePath),
  );
}

function createIgnoredFile(
  relativePath: string,
  sizeBytes: number,
  ignoreReason: IgnoreReason,
  kind: WorkspaceFile["kind"] = classifyFileKind(relativePath),
  modifiedAt?: Date,
): WorkspaceFile {
  return {
    path: relativePath,
    kind,
    ...(languageForPath(relativePath) ? { language: languageForPath(relativePath) } : {}),
    sizeBytes,
    ...(modifiedAt ? { modifiedAt: modifiedAt.toISOString() } : {}),
    generated: isGeneratedFile(relativePath),
    ignored: true,
    ignoreReason,
  };
}

async function isBinaryFile(
  absolutePath: string,
  relativePath: string,
): Promise<boolean> {
  if (BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    return true;
  }

  const handle = await open(absolutePath, "r");
  const sample = Buffer.alloc(BINARY_SAMPLE_SIZE_BYTES);

  try {
    const { bytesRead } = await handle.read(sample, 0, BINARY_SAMPLE_SIZE_BYTES, 0);

    return sample.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function runBounded(
  tasks: readonly (() => Promise<void>)[],
  concurrency: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  let nextTaskIndex = 0;
  const workerCount = Math.min(concurrency, tasks.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (!signal?.aborted) {
        const task = tasks[nextTaskIndex];
        nextTaskIndex += 1;

        if (!task) {
          return;
        }

        await task();
      }
    }),
  );
}

function assertDiscoveryLimits(input: {
  readonly maxFileSizeBytes: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly concurrency: number;
}): void {
  if (
    !Number.isInteger(input.maxFileSizeBytes) ||
    input.maxFileSizeBytes <= 0 ||
    !Number.isInteger(input.maxFiles) ||
    input.maxFiles <= 0 ||
    !Number.isInteger(input.maxTotalBytes) ||
    input.maxTotalBytes < 0 ||
    !Number.isInteger(input.concurrency) ||
    input.concurrency <= 0
  ) {
    throw new Error("Workspace discovery limits must be valid non-negative integers.");
  }
}

function classifyFileKind(relativePath: string): WorkspaceFile["kind"] {
  const normalizedPath = relativePath.toLowerCase();
  const extension = path.extname(normalizedPath);

  if (BINARY_EXTENSIONS.has(extension)) {
    return "binary";
  }

  if (isGeneratedFile(relativePath)) {
    return "generated";
  }

  if (
    normalizedPath.includes(".test.") ||
    normalizedPath.includes(".spec.") ||
    normalizedPath.startsWith("test/") ||
    normalizedPath.startsWith("tests/") ||
    normalizedPath.includes("/test/") ||
    normalizedPath.includes("/tests/")
  ) {
    return "test";
  }

  if (
    normalizedPath.endsWith(".md") ||
    normalizedPath.startsWith("docs/") ||
    normalizedPath.includes("/docs/")
  ) {
    return "documentation";
  }

  if (
    normalizedPath.endsWith(".json") ||
    normalizedPath.endsWith(".yml") ||
    normalizedPath.endsWith(".yaml") ||
    normalizedPath.includes("config")
  ) {
    return "config";
  }

  if (LANGUAGE_BY_EXTENSION.has(extension)) {
    return "source";
  }

  return "unknown";
}

function languageForPath(relativePath: string): string | undefined {
  return LANGUAGE_BY_EXTENSION.get(path.extname(relativePath).toLowerCase());
}

function isGeneratedFile(relativePath: string): boolean {
  const normalizedPath = relativePath.toLowerCase();

  return (
    normalizedPath.includes("/generated/") ||
    normalizedPath.includes(".generated.") ||
    normalizedPath.endsWith(".lock")
  );
}

function originToIgnoreReason(
  origin: "gitignore" | "optimizer_config" | undefined,
): IgnoreReason {
  return origin === "gitignore" ? "gitignore" : "optimizer_config";
}

function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashText(value: string): string {
  return hashBuffer(Buffer.from(value, "utf8"));
}
