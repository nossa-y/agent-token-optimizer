import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyDetectedHostInstallPlan,
  createHostInstallPlan,
  createHostUninstallPlan,
  detectHostAdapters,
  inspectHostAdapters,
  parseSupportedHosts,
} from "./detect";
import { MANAGED_HOOK_MARKER, rollbackHostConfigChanges } from "./file-ops";

const temporaryRoots: string[] = [];
const hookCommand = [
  process.execPath,
  "/opt/agent-token-optimizer/packages/cli/dist/index.js",
  "hook",
  "user-prompt",
  "--managed-by",
  MANAGED_HOOK_MARKER,
  "--cache-path",
  "/tmp/agent-token-optimizer.sqlite",
];

describe("host adapters", () => {
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

  it("detects explicitly requested hook hosts", async () => {
    const { homePath, workspaceRoot } = await createFixture();
    const detections = await detectHostAdapters({
      homePath,
      workspaceRoot,
      requestedHosts: ["codex", "claude-code"],
    });

    expect(
      detections
        .filter((detection) => detection.detected)
        .map((detection) => detection.host)
        .sort(),
    ).toEqual(["claude-code", "codex"]);
  });

  it("installs hooks idempotently while preserving user configuration", async () => {
    const { homePath, workspaceRoot } = await createFixture();
    const codexPath = path.join(homePath, ".codex", "hooks.json");
    const claudePath = path.join(homePath, ".claude", "settings.json");
    await mkdir(path.dirname(codexPath), { recursive: true });
    await mkdir(path.dirname(claudePath), { recursive: true });
    await writeFile(
      codexPath,
      `${JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-hook" }] }],
        },
      })}\n`,
    );
    await writeFile(claudePath, `${JSON.stringify({ model: "sonnet" })}\n`);
    const context = {
      homePath,
      workspaceRoot,
      hookCommand,
      requestedHosts: ["codex", "claude-code"] as const,
    };
    const plan = await createHostInstallPlan(context);

    expect(plan.changes.map((change) => change.path).sort()).toEqual(
      [claudePath, codexPath].sort(),
    );

    const result = await applyDetectedHostInstallPlan(plan);
    expect(result.applied).toHaveLength(2);

    const codexConfig = JSON.parse(await readFile(codexPath, "utf8")) as {
      readonly hooks: {
        readonly UserPromptSubmit: readonly {
          readonly hooks: readonly { readonly command: string }[];
        }[];
      };
    };
    const claudeConfig = JSON.parse(await readFile(claudePath, "utf8")) as {
      readonly model: string;
      readonly hooks: {
        readonly UserPromptSubmit: readonly unknown[];
      };
    };

    expect(codexConfig.hooks.UserPromptSubmit).toHaveLength(2);
    expect(codexConfig.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toBe("user-hook");
    expect(codexConfig.hooks.UserPromptSubmit[1]?.hooks[0]?.command).toContain(
      MANAGED_HOOK_MARKER,
    );
    expect(claudeConfig.model).toBe("sonnet");
    expect(claudeConfig.hooks.UserPromptSubmit).toHaveLength(1);

    if (process.platform !== "win32") {
      expect((await stat(codexPath)).mode & 0o777).toBe(0o600);
      expect((await stat(result.applied[0]?.backupPath ?? "")).mode & 0o777).toBe(0o600);
    }

    const repeatedPlan = await createHostInstallPlan(context);
    const repeatedResult = await applyDetectedHostInstallPlan(repeatedPlan);
    expect(repeatedPlan.changes.every((change) => change.action === "unchanged")).toBe(
      true,
    );
    expect(repeatedResult.applied).toEqual([]);
    await expect(inspectHostAdapters(context)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "codex", status: "installed" }),
        expect.objectContaining({ host: "claude-code", status: "installed" }),
      ]),
    );
  });

  it("diagnoses command drift and uninstalls only managed hooks", async () => {
    const { homePath, workspaceRoot } = await createFixture();
    const codexPath = path.join(homePath, ".codex", "hooks.json");
    await mkdir(path.dirname(codexPath), { recursive: true });
    await writeFile(
      codexPath,
      `${JSON.stringify({
        custom: true,
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-hook" }] }],
        },
      })}\n`,
    );
    const context = {
      homePath,
      workspaceRoot,
      hookCommand,
      requestedHosts: ["codex"] as const,
    };
    await applyDetectedHostInstallPlan(await createHostInstallPlan(context));

    await expect(
      inspectHostAdapters({ ...context, hookCommand: [...hookCommand, "--changed"] }),
    ).resolves.toEqual([
      expect.objectContaining({ host: "codex", status: "version-mismatch" }),
    ]);

    const uninstallResult = await applyDetectedHostInstallPlan(
      await createHostUninstallPlan(context),
    );
    expect(uninstallResult.applied).toHaveLength(1);
    const config = JSON.parse(await readFile(codexPath, "utf8")) as {
      readonly custom: boolean;
      readonly hooks: {
        readonly UserPromptSubmit: readonly {
          readonly hooks: readonly { readonly command: string }[];
        }[];
      };
    };
    expect(config.custom).toBe(true);
    expect(config.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: "user-hook" }] },
    ]);
  });

  it("backs up changes and restores exact pre-install content on rollback", async () => {
    const { homePath, workspaceRoot } = await createFixture();
    const codexPath = path.join(homePath, ".codex", "hooks.json");
    const original = `${JSON.stringify({ custom: "value" }, null, 2)}\n`;
    await mkdir(path.dirname(codexPath), { recursive: true });
    await writeFile(codexPath, original);
    const plan = await createHostInstallPlan({
      homePath,
      workspaceRoot,
      hookCommand,
      requestedHosts: ["codex"],
    });
    const result = await applyDetectedHostInstallPlan(plan, {
      now: new Date("2026-07-07T00:00:00.000Z"),
    });

    expect(result.applied[0]?.backupPath).toBeDefined();
    await rollbackHostConfigChanges(result.applied);
    await expect(readFile(codexPath, "utf8")).resolves.toBe(original);
  });

  it("does not create host files when uninstalling an absent hook", async () => {
    const { homePath, workspaceRoot } = await createFixture();
    const codexPath = path.join(homePath, ".codex", "hooks.json");
    const plan = await createHostUninstallPlan({
      homePath,
      workspaceRoot,
      hookCommand,
      requestedHosts: ["codex"],
    });

    expect(plan.changes).toEqual([
      expect.objectContaining({ path: codexPath, action: "unchanged" }),
    ]);
    const result = await applyDetectedHostInstallPlan(plan);
    expect(result.applied).toEqual([]);
    await expect(readFile(codexPath, "utf8")).rejects.toThrow();
  });

  it("parses supported aliases and rejects deferred hosts", () => {
    expect(parseSupportedHosts("claude,codex")).toEqual(["claude-code", "codex"]);
    expect(() => parseSupportedHosts("cursor")).toThrow("Unsupported host adapter");
  });
});

async function createFixture(): Promise<{
  readonly homePath: string;
  readonly workspaceRoot: string;
}> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ato-hosts-"));
  const homePath = path.join(rootPath, "home");
  const workspaceRoot = path.join(rootPath, "workspace");
  await mkdir(homePath, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  temporaryRoots.push(rootPath);

  return { homePath, workspaceRoot };
}
