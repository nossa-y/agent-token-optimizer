import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorkspacePathPolicy } from "../security";
import { discoverWorkspace } from "./discover";

const temporaryRoots: string[] = [];

describe("discoverWorkspace", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((temporaryRoot) =>
        rm(temporaryRoot, {
          force: true,
          recursive: true,
        }),
      ),
    );
  });

  it("indexes source metadata while respecting .gitignore files", async () => {
    const rootPath = await createTemporaryWorkspace();
    await writeFile(path.join(rootPath, ".gitignore"), "ignored.txt\n");
    await mkdir(path.join(rootPath, "src"));
    await writeFile(path.join(rootPath, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(path.join(rootPath, "ignored.txt"), "secret\n");

    const index = await discoverWorkspace({
      rootPath,
      operationId: "test-operation",
      packageVersion: "0.0.0-test",
    });

    expect(index.metadata.operationId).toBe("test-operation");
    expect(index.workspace.rootPath).toBe(path.resolve(rootPath));
    expect(index.totals.filesIndexed).toBe(2);
    expect(index.totals.filesIgnored).toBe(1);
    expect(index.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".gitignore",
          ignored: false,
          kind: "unknown",
        }),
        expect.objectContaining({
          path: "ignored.txt",
          ignored: true,
          ignoreReason: "gitignore",
        }),
        expect.objectContaining({
          path: "src/index.ts",
          ignored: false,
          kind: "source",
          language: "typescript",
        }),
      ]),
    );
  });

  it("skips built-in ignored directories and discovers nested packages", async () => {
    const rootPath = await createTemporaryWorkspace();
    await mkdir(path.join(rootPath, "node_modules", "ignored"), { recursive: true });
    await mkdir(path.join(rootPath, "packages", "app", "src"), { recursive: true });
    await writeFile(
      path.join(rootPath, "node_modules", "ignored", "index.js"),
      "ignored\n",
    );
    await writeFile(path.join(rootPath, "packages", "app", "package.json"), "{}\n");
    await writeFile(
      path.join(rootPath, "packages", "app", "src", "feature.test.ts"),
      "export const tested = true;\n",
    );

    const index = await discoverWorkspace({ rootPath });

    expect(index.files.map((file) => file.path)).not.toContain(
      "node_modules/ignored/index.js",
    );
    expect(index.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "packages/app/package.json",
          kind: "config",
          language: "json",
        }),
        expect.objectContaining({
          path: "packages/app/src/feature.test.ts",
          kind: "test",
          language: "typescript",
        }),
      ]),
    );
  });

  it("marks binary and oversized files as ignored without hashing contents", async () => {
    const rootPath = await createTemporaryWorkspace();
    await writeFile(path.join(rootPath, "image.png"), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(rootPath, "large.ts"), "x".repeat(128));

    const index = await discoverWorkspace({
      rootPath,
      maxFileSizeBytes: 32,
    });

    expect(index.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "image.png",
          kind: "binary",
          ignored: true,
          ignoreReason: "binary",
        }),
        expect.objectContaining({
          path: "large.ts",
          ignored: true,
          ignoreReason: "oversized",
        }),
      ]),
    );
    expect(index.files.find((file) => file.path === "large.ts")).not.toHaveProperty(
      "contentHash",
    );
  });

  it("marks configured unsupported languages as ignored", async () => {
    const rootPath = await createTemporaryWorkspace();
    await writeFile(path.join(rootPath, "service.ts"), "export const service = true;\n");
    await writeFile(path.join(rootPath, "script.py"), "print('hello')\n");

    const index = await discoverWorkspace({
      rootPath,
      supportedLanguages: ["typescript"],
    });

    expect(index.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "service.ts", ignored: false }),
        expect.objectContaining({
          path: "script.py",
          ignored: true,
          ignoreReason: "unsupported",
        }),
      ]),
    );
  });

  it("returns a partial index when file or byte limits are reached", async () => {
    const rootPath = await createTemporaryWorkspace();
    await writeFile(path.join(rootPath, "a.ts"), "a".repeat(32));
    await writeFile(path.join(rootPath, "b.ts"), "b".repeat(32));
    await writeFile(path.join(rootPath, "c.ts"), "c".repeat(32));

    const fileLimited = await discoverWorkspace({
      rootPath,
      maxFiles: 2,
      concurrency: 2,
    });
    const byteLimited = await discoverWorkspace({
      rootPath,
      maxTotalBytes: 40,
      concurrency: 2,
    });

    expect(fileLimited.files).toHaveLength(2);
    expect(fileLimited.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "workspace_file_limit_reached" }),
      ]),
    );
    expect(byteLimited.totals.bytesIndexed).toBeLessThanOrEqual(40);
    expect(byteLimited.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "workspace_byte_limit_reached" }),
      ]),
    );
  });

  it("returns a partial index when discovery is cancelled", async () => {
    const rootPath = await createTemporaryWorkspace();
    await writeFile(path.join(rootPath, "feature.ts"), "export const feature = true;\n");
    const controller = new AbortController();
    controller.abort();

    const index = await discoverWorkspace({
      rootPath,
      signal: controller.signal,
    });

    expect(index.files).toHaveLength(0);
    expect(index.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "workspace_discovery_cancelled" }),
      ]),
    );
  });

  it("reuses unchanged indexed file metadata and hashes from a previous index", async () => {
    const rootPath = await createTemporaryWorkspace();
    await mkdir(path.join(rootPath, "src"));
    await writeFile(path.join(rootPath, "src", "value.ts"), "export const value = 1;\n");
    const initialIndex = await discoverWorkspace({ rootPath });
    const cachedIndex = {
      ...initialIndex,
      files: initialIndex.files.map((file) =>
        file.path === "src/value.ts" ? { ...file, contentHash: "cached-hash" } : file,
      ),
    };

    const warmIndex = await discoverWorkspace({
      rootPath,
      previousIndex: cachedIndex,
    });

    expect(
      warmIndex.files.find((file) => file.path === "src/value.ts")?.contentHash,
    ).toBe("cached-hash");

    await writeFile(
      path.join(rootPath, "src", "value.ts"),
      "export const value = 200;\n",
    );
    const changedIndex = await discoverWorkspace({
      rootPath,
      previousIndex: cachedIndex,
    });

    expect(
      changedIndex.files.find((file) => file.path === "src/value.ts")?.contentHash,
    ).not.toBe("cached-hash");
  });

  it("warns and skips symlinks that resolve outside the workspace", async () => {
    const rootPath = await createTemporaryWorkspace();
    const outsideRoot = await createTemporaryWorkspace();
    const outsideFile = path.join(outsideRoot, "outside.txt");
    await writeFile(outsideFile, "outside\n");

    try {
      await symlink(outsideFile, path.join(rootPath, "outside-link.txt"));
    } catch (error) {
      if (isUnsupportedSymlinkError(error)) {
        return;
      }

      throw error;
    }

    const index = await discoverWorkspace({ rootPath });

    expect(index.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "outside-link.txt",
          ignored: true,
          ignoreReason: "outside_workspace",
        }),
      ]),
    );
    expect(index.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "outside_workspace_symlink",
          path: "outside-link.txt",
        }),
      ]),
    );
  });

  it("rejects path traversal through the path policy", async () => {
    const rootPath = await createTemporaryWorkspace();
    const policy = await createWorkspacePathPolicy(rootPath);

    expect(() => policy.resolveWorkspacePath("../outside.txt")).toThrow(
      "Workspace path must be a safe relative path",
    );
  });
});

async function createTemporaryWorkspace(): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ato-workspace-"));
  temporaryRoots.push(rootPath);

  return rootPath;
}

function isUnsupportedSymlinkError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES")
  );
}
