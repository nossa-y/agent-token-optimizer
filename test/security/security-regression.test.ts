import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RESOURCE_LIMITS,
  MemoryLogSink,
  createLogger,
  createWorkspacePathPolicy,
  mergeResourceLimits,
} from "../../packages/core/src/index";
import {
  createManagedHookJsonConfig,
  MANAGED_HOOK_MARKER,
  rollbackHostConfigChanges,
  type HostConfigChange,
} from "../../packages/host-adapters/src/index";
import { createMcpSecurityPolicy } from "../../packages/mcp-server/src/security";

const temporaryRoots: string[] = [];

describe("security regressions", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((temporaryRoot) => rm(temporaryRoot, { force: true, recursive: true })),
    );
  });

  it("rejects unsafe workspace target paths", async () => {
    const workspaceRoot = await createTemporaryRoot();
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });

    const policy = await createWorkspacePathPolicy(workspaceRoot);
    const workspaceRealPath = await realpath(workspaceRoot);

    expect(policy.resolveWorkspacePath("src/index.ts")).toBe(
      path.join(workspaceRealPath, "src", "index.ts"),
    );
    expect(() => policy.resolveWorkspacePath("../secret.txt")).toThrow(
      /safe relative path/u,
    );
    expect(() => policy.resolveWorkspacePath(path.join(workspaceRoot, "src"))).toThrow(
      /safe relative path/u,
    );
    expect(() => policy.resolveWorkspacePath("src/\0secret.ts")).toThrow(
      /safe relative path/u,
    );
  });

  it("keeps MCP command metadata disabled and resource overrides bounded", () => {
    const policy = createMcpSecurityPolicy();
    const limits = mergeResourceLimits({
      maxTaskChars: -1,
      maxTextChars: 1_000,
      operationTimeoutMs: Number.NaN,
    });

    expect(limits.maxTaskChars).toBe(DEFAULT_RESOURCE_LIMITS.maxTaskChars);
    expect(limits.maxTextChars).toBe(1_000);
    expect(limits.operationTimeoutMs).toBe(DEFAULT_RESOURCE_LIMITS.operationTimeoutMs);
    expect(() =>
      policy.validateRecordRun({
        host: "codex",
        outcome: "succeeded",
        validation: {
          command: "pnpm test",
          passed: true,
        },
        warnings: [],
      }),
    ).toThrow(/Command metadata is disabled/u);
  });

  it("redacts secret-like log context values", async () => {
    const fakeApiKey = createFakeOpenAiKey();
    const sink = new MemoryLogSink();
    const logger = createLogger({
      component: "security-regression",
      sink,
    });

    await logger.info("audit.context", {
      context: {
        apiToken: fakeApiKey,
        description: "safe metadata",
      },
    });

    expect(sink.events[0]?.context).toEqual({
      apiToken: "[REDACTED]",
      description: "safe metadata",
    });
    expect(JSON.stringify(sink.events)).not.toContain(fakeApiKey);
  });

  it("keeps managed hook writes idempotent and preserves user hooks", () => {
    const existingContent = JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "user-hook" }] },
          {
            hooks: [
              {
                type: "command",
                command: `old-hook --managed-by ${MANAGED_HOOK_MARKER}`,
              },
            ],
          },
        ],
      },
    });
    const config = createManagedHookJsonConfig({
      existingContent,
      command: [
        process.execPath,
        "/opt/agent-token-optimizer/index.js",
        "hook",
        "user-prompt",
        "--managed-by",
        MANAGED_HOOK_MARKER,
      ],
    });

    expect(config).toContain("user-hook");
    expect(config.match(new RegExp(MANAGED_HOOK_MARKER, "gu"))).toHaveLength(1);
    expect(config).toContain("user-prompt");
    expect(config).not.toContain("old-hook");
  });

  it("restores changed host files and removes newly created files on rollback", async () => {
    const workspaceRoot = await createTemporaryRoot();
    const existingPath = path.join(workspaceRoot, "config.toml");
    const backupPath = path.join(workspaceRoot, "config.toml.bak");
    const createdPath = path.join(workspaceRoot, "created.json");
    const changes: HostConfigChange[] = [
      {
        host: "codex",
        path: existingPath,
        description: "Update existing config",
        content: "after",
        existed: true,
        backupPath,
      },
      {
        host: "claude-code",
        path: createdPath,
        description: "Create new config",
        content: "created",
        existed: false,
      },
    ];

    await writeFile(existingPath, "after");
    await writeFile(backupPath, "before");
    await writeFile(createdPath, "created");

    await rollbackHostConfigChanges(changes);

    await expect(readFile(existingPath, "utf8")).resolves.toBe("before");
    await expect(readFile(createdPath, "utf8")).rejects.toThrow();
  });
});

async function createTemporaryRoot(): Promise<string> {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "agent-token-optimizer-security-"),
  );
  temporaryRoots.push(temporaryRoot);
  return temporaryRoot;
}

function createFakeOpenAiKey(): string {
  return `${"sk"}-${"testsecretvalue123456"}`;
}
