import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadWorkspaceConfiguration } from "./workspace";

const temporaryRoots: string[] = [];

describe("loadWorkspaceConfiguration", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((temporaryRoot) => rm(temporaryRoot, { force: true, recursive: true })),
    );
  });

  it("returns no configuration when the workspace has not been initialized", async () => {
    const workspaceRoot = await createTemporaryWorkspace();

    await expect(loadWorkspaceConfiguration(workspaceRoot)).resolves.toEqual({
      configPath: path.join(workspaceRoot, ".agent-token-optimizer", "config.json"),
    });
  });

  it("parses versioned optimization and cache settings", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    await writeWorkspaceConfig(workspaceRoot, {
      cache: { enabled: false },
      optimization: {
        concurrency: 4,
        extraIgnorePatterns: ["fixtures/**"],
        maxFiles: 500,
        maxTotalBytes: 2_000_000,
        responseTokenBudget: 1_200,
        supportedLanguages: ["typescript"],
      },
    });

    const loaded = await loadWorkspaceConfiguration(workspaceRoot);

    expect(loaded.config).toMatchObject({
      version: 1,
      cache: { enabled: false },
      optimization: {
        concurrency: 4,
        extraIgnorePatterns: ["fixtures/**"],
        maxFiles: 500,
        maxTotalBytes: 2_000_000,
        responseTokenBudget: 1_200,
        supportedLanguages: ["typescript"],
      },
    });
  });

  it("rejects unsupported configuration versions", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    await writeWorkspaceConfig(workspaceRoot, { version: 2 });

    await expect(loadWorkspaceConfiguration(workspaceRoot)).rejects.toThrow(
      "Invalid workspace configuration",
    );
  });
});

async function createTemporaryWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "ato-config-"));
  temporaryRoots.push(workspaceRoot);
  return workspaceRoot;
}

async function writeWorkspaceConfig(
  workspaceRoot: string,
  overrides: Record<string, unknown>,
): Promise<void> {
  const configPath = path.join(workspaceRoot, ".agent-token-optimizer", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        workspaceRoot,
        mcp: { command: "agent-token-optimizer mcp" },
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
}
