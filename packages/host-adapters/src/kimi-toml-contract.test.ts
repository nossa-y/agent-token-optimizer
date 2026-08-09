import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";

import { applyDetectedHostInstallPlan, createHostInstallPlan } from "./detect";
import { MANAGED_HOOK_MARKER } from "./file-ops";

// Kimi Code loads hooks from a TOML config. These tests parse the config we
// generate with a standard TOML parser and assert the hook is discoverable in
// the exact shape Kimi documents (a `[[hooks]]` entry with a UserPromptSubmit
// event and a command string), without requiring a live Kimi install.
// Contract: https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/hooks.md

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

interface KimiHooksConfig {
  readonly hooks?: readonly {
    readonly event?: string;
    readonly command?: string;
    readonly timeout?: number;
  }[];
}

describe("generated Kimi config contract", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("produces a valid TOML UserPromptSubmit hook Kimi can load", async () => {
    const { homePath, workspaceRoot } = await createFixture();
    await applyDetectedHostInstallPlan(
      await createHostInstallPlan({
        homePath,
        workspaceRoot,
        hookCommand,
        requestedHosts: ["kimi"],
      }),
    );

    const configText = await readFile(
      path.join(homePath, ".kimi-code", "config.toml"),
      "utf8",
    );
    const parsed = parseToml(configText) as KimiHooksConfig;

    expect(Array.isArray(parsed.hooks)).toBe(true);
    const managed = parsed.hooks?.find((hook) =>
      hook.command?.includes(MANAGED_HOOK_MARKER),
    );
    expect(managed).toBeDefined();
    expect(managed?.event).toBe("UserPromptSubmit");
    expect(managed?.timeout).toBe(30);
    // The command carries the Kimi plain-text output mode so the hook renders
    // correctly when Kimi appends its stdout to the turn context.
    expect(managed?.command).toContain("--host");
    expect(managed?.command).toContain("kimi");
  });

  it("merges the managed hook alongside a user's existing TOML hook", async () => {
    const { homePath, workspaceRoot } = await createFixture();
    const configPath = path.join(homePath, ".kimi-code", "config.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    const userConfig = [
      'model = "kimi-k2"',
      "",
      "[[hooks]]",
      'event = "PreToolUse"',
      'matcher = "Bash"',
      'command = "node ~/.kimi-code/hooks/guard.mjs"',
      "timeout = 5",
      "",
    ].join("\n");
    await writeFile(configPath, userConfig);

    await applyDetectedHostInstallPlan(
      await createHostInstallPlan({
        homePath,
        workspaceRoot,
        hookCommand,
        requestedHosts: ["kimi"],
      }),
    );

    const parsed = parseToml(await readFile(configPath, "utf8")) as KimiHooksConfig & {
      readonly model?: string;
    };
    expect(parsed.model).toBe("kimi-k2");
    const events = (parsed.hooks ?? []).map((hook) => hook.event).sort();
    expect(events).toEqual(["PreToolUse", "UserPromptSubmit"]);
  });
});

async function createFixture(): Promise<{
  readonly homePath: string;
  readonly workspaceRoot: string;
}> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ato-kimi-contract-"));
  const homePath = path.join(rootPath, "home");
  const workspaceRoot = path.join(rootPath, "workspace");
  await mkdir(homePath, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  temporaryRoots.push(rootPath);

  return { homePath, workspaceRoot };
}
