import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { STORE_KINDS, SqliteStore } from "@agent-relay/agent-token-optimization-core";

import { runCli, type CliIo } from "./index";

const temporaryRoots: string[] = [];

describe("agent-token-optimizer CLI", () => {
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

  it("prints help", async () => {
    const output = createOutput();
    const exitCode = await runCli(["help"], {
      cwd: await createTemporaryWorkspace(),
      io: output.io,
    });

    expect(exitCode).toBe(0);
    expect(output.stdout.join("\n")).toContain("agent-token-optimizer <command>");
  });

  it("fails open without echoing malformed hook input", async () => {
    const output = createOutput();
    const secretInput = `not-json ${"sk"}-${"abcdefghijklmnop1234"}`;
    const exitCode = await runCli(["hook", "user-prompt"], {
      cwd: await createTemporaryWorkspace(),
      io: output.io,
      readStdin: () => Promise.resolve(secretInput),
    });

    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    expect(output.stdout[0]).not.toContain(secretInput);
    expect(JSON.parse(output.stdout[0] ?? "{}")).toEqual({
      continue: true,
      systemMessage:
        "Agent Token Optimizer skipped context injection because local hook processing failed.",
    });
  });

  it("runs the Codex user-prompt hook through the CLI stdin contract", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const cachePath = path.join(workspaceRoot, ".cache", "hook.sqlite");
    await mkdir(path.join(workspaceRoot, "src"));
    await writeFile(
      path.join(workspaceRoot, "src", "session.ts"),
      "export function validateSession() { return false; }\n",
    );
    const output = createOutput();
    const exitCode = await runCli(["hook", "user-prompt", "--cache-path", cachePath], {
      cwd: workspaceRoot,
      io: output.io,
      readStdin: () =>
        Promise.resolve(
          JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            cwd: workspaceRoot,
            prompt: "Fix authentication session validation in src/session.ts",
          }),
        ),
    });
    const hookOutput = JSON.parse(output.stdout[0] ?? "{}") as {
      readonly hookSpecificOutput?: {
        readonly hookEventName: string;
        readonly additionalContext: string;
      };
    };

    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(hookOutput.hookSpecificOutput).toMatchObject({
      hookEventName: "UserPromptSubmit",
    });
    expect(hookOutput.hookSpecificOutput?.additionalContext).toContain("src/session.ts");

    const store = new SqliteStore({ databasePath: cachePath });
    await store.initialize();
    try {
      await expect(store.list(STORE_KINDS.userPromptHookEvidence)).resolves.toHaveLength(
        1,
      );
    } finally {
      await store.close();
    }
  });

  it("runs the Kimi user-prompt hook and emits plain text context", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const cachePath = path.join(workspaceRoot, ".cache", "kimi-hook.sqlite");
    await mkdir(path.join(workspaceRoot, "src"));
    await writeFile(
      path.join(workspaceRoot, "src", "session.ts"),
      "export function validateSession() { return false; }\n",
    );
    const output = createOutput();
    const exitCode = await runCli(
      ["hook", "user-prompt", "--host", "kimi", "--cache-path", cachePath],
      {
        cwd: workspaceRoot,
        io: output.io,
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({
              hook_event_name: "UserPromptSubmit",
              session_id: "session_abc",
              client_type: "kimi_code_cli",
              cwd: workspaceRoot,
              prompt: [
                {
                  type: "text",
                  text: "Fix authentication session validation in src/session.ts",
                },
              ],
            }),
          ),
      },
    );

    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    expect(output.stdout[0]?.startsWith("# Agent Token Optimizer Context")).toBe(true);
    expect(output.stdout[0]).toContain("src/session.ts");
    expect(output.stdout[0]).not.toContain("hookSpecificOutput");
  });

  it("keeps Kimi hook failures silent to avoid polluting appended context", async () => {
    const output = createOutput();
    const exitCode = await runCli(["hook", "user-prompt", "--host", "kimi"], {
      cwd: await createTemporaryWorkspace(),
      io: output.io,
      readStdin: () => Promise.resolve("not-json"),
    });

    expect(exitCode).toBe(0);
    expect(output.stdout).toEqual([]);
  });

  it("installs and uninstalls the Kimi managed hook block", async () => {
    const fixture = await createCliFixture();
    const kimiConfigPath = path.join(fixture.homePath, ".kimi-code", "config.toml");
    const installArgs = [
      "install",
      "--hosts",
      "kimi",
      "--cache-path",
      fixture.cachePath,
      "--json",
    ];
    const installOutput = createOutput();
    const installExitCode = await runCli(installArgs, {
      cwd: fixture.workspaceRoot,
      env: { HOME: fixture.homePath },
      io: installOutput.io,
    });

    expect(installExitCode).toBe(0);
    expect(JSON.parse(installOutput.stdout[0] ?? "{}")).toEqual(
      expect.objectContaining({ status: "installed" }),
    );
    const installedContent = await readFile(kimiConfigPath, "utf8");
    expect(installedContent).toContain("agent-token-optimizer-managed-hook");
    expect(installedContent).toContain('event = "UserPromptSubmit"');
    expect(installedContent).toContain("--host");

    const repeatedOutput = createOutput();
    const repeatedExitCode = await runCli(installArgs, {
      cwd: fixture.workspaceRoot,
      env: { HOME: fixture.homePath },
      io: repeatedOutput.io,
    });
    expect(repeatedExitCode).toBe(0);
    expect(JSON.parse(repeatedOutput.stdout[0] ?? "{}")).toEqual(
      expect.objectContaining({ status: "unchanged" }),
    );

    const uninstallOutput = createOutput();
    const uninstallExitCode = await runCli(
      ["uninstall", "--hosts", "kimi", "--cache-path", fixture.cachePath, "--json"],
      {
        cwd: fixture.workspaceRoot,
        env: { HOME: fixture.homePath },
        io: uninstallOutput.io,
      },
    );
    expect(uninstallExitCode).toBe(0);
    await expect(readFile(kimiConfigPath, "utf8")).resolves.not.toContain(
      "agent-token-optimizer-managed-hook",
    );
  });

  it("initializes workspace config and cache", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const cachePath = path.join(workspaceRoot, ".cache", "ato.sqlite");
    const output = createOutput();
    const exitCode = await runCli(
      ["init", "--workspace", workspaceRoot, "--cache-path", cachePath, "--json"],
      {
        cwd: workspaceRoot,
        io: output.io,
      },
    );

    expect(exitCode).toBe(0);
    const result = JSON.parse(output.stdout[0] ?? "{}") as {
      readonly status: string;
      readonly workspaceRoot: string;
      readonly cachePath: string;
      readonly changes: {
        readonly planned: readonly {
          readonly target: string;
          readonly action: string;
        }[];
      };
    };

    expect(result.status).toBe("initialized");
    expect(result.workspaceRoot).toBe(workspaceRoot);
    expect(result.cachePath).toBe(cachePath);
    expect(
      result.changes.planned.some(
        (change) => change.target === "workspace-config" && change.action === "create",
      ),
    ).toBe(true);
    expect(
      result.changes.planned.some(
        (change) => change.target === "cache" && change.action === "create",
      ),
    ).toBe(true);
    await expect(
      readFile(path.join(workspaceRoot, ".agent-token-optimizer", "config.json"), "utf8"),
    ).resolves.not.toContain('"hostAdapters"');
    await expect(
      readFile(path.join(workspaceRoot, ".agent-token-optimizer", "config.json"), "utf8"),
    ).resolves.not.toContain('"mcp"');
  });

  it("installs Codex and Claude Code hooks idempotently", async () => {
    const fixture = await createCliFixture();
    const args = [
      "install",
      "--hosts",
      "codex,claude",
      "--cache-path",
      fixture.cachePath,
      "--json",
    ];
    const initialOutput = createOutput();
    const initialExitCode = await runCli(args, {
      cwd: fixture.workspaceRoot,
      env: { HOME: fixture.homePath },
      io: initialOutput.io,
    });
    const initial = JSON.parse(initialOutput.stdout[0] ?? "{}") as {
      readonly status: string;
      readonly changes: readonly { readonly host: string }[];
    };

    expect(initialExitCode).toBe(0);
    expect(initial.status).toBe("installed");
    expect(initial.changes.map((change) => change.host).sort()).toEqual([
      "claude-code",
      "codex",
    ]);
    const userPromptHooksPath = path.join(fixture.homePath, ".codex", "hooks.json");
    const claudeSettingsPath = path.join(fixture.homePath, ".claude", "settings.json");
    await expect(readFile(userPromptHooksPath, "utf8")).resolves.toContain(
      "agent-token-optimizer-managed-hook",
    );
    await expect(readFile(claudeSettingsPath, "utf8")).resolves.toContain(
      "agent-token-optimizer-managed-hook",
    );
    await expect(readFile(userPromptHooksPath, "utf8")).resolves.not.toContain("npx");

    const repeatedOutput = createOutput();
    const repeatedExitCode = await runCli(args, {
      cwd: fixture.workspaceRoot,
      env: { HOME: fixture.homePath },
      io: repeatedOutput.io,
    });
    expect(repeatedExitCode).toBe(0);
    expect(JSON.parse(repeatedOutput.stdout[0] ?? "{}")).toEqual(
      expect.objectContaining({ status: "unchanged" }),
    );
  });

  it("previews hook installation without writing host files", async () => {
    const fixture = await createCliFixture();
    const output = createOutput();
    const exitCode = await runCli(
      ["install", "--hosts", "codex,claude", "--dry-run", "--json"],
      {
        cwd: fixture.workspaceRoot,
        env: { HOME: fixture.homePath },
        io: output.io,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdout[0] ?? "{}")).toEqual(
      expect.objectContaining({ status: "planned" }),
    );
    await expect(
      readFile(path.join(fixture.homePath, ".codex", "hooks.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("diagnoses and uninstalls the managed hook without deleting user hooks", async () => {
    const fixture = await createCliFixture();
    const userPromptHooksPath = path.join(fixture.homePath, ".codex", "hooks.json");
    await mkdir(path.dirname(userPromptHooksPath), { recursive: true });
    await writeFile(
      userPromptHooksPath,
      `${JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "user-hook" }] }],
        },
      })}\n`,
    );
    const commonArgs = ["--hosts", "codex", "--cache-path", fixture.cachePath, "--json"];
    await runCli(["install", ...commonArgs], {
      cwd: fixture.workspaceRoot,
      env: { HOME: fixture.homePath },
      io: createOutput().io,
    });

    const doctorOutput = createOutput();
    const doctorExitCode = await runCli(["doctor", ...commonArgs], {
      cwd: fixture.workspaceRoot,
      env: { HOME: fixture.homePath },
      io: doctorOutput.io,
    });
    expect(doctorExitCode).toBe(0);
    expect(JSON.parse(doctorOutput.stdout[0] ?? "{}")).toEqual(
      expect.objectContaining({
        hosts: [expect.objectContaining({ host: "codex", status: "installed" })],
      }),
    );

    const uninstallOutput = createOutput();
    const uninstallExitCode = await runCli(["uninstall", ...commonArgs], {
      cwd: fixture.workspaceRoot,
      env: { HOME: fixture.homePath },
      io: uninstallOutput.io,
    });
    expect(uninstallExitCode).toBe(0);
    const finalConfig = await readFile(userPromptHooksPath, "utf8");
    expect(finalConfig).toContain("user-hook");
    expect(finalConfig).not.toContain("agent-token-optimizer-managed-hook");
  });

  it("runs doctor against a temporary workspace", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const output = createOutput();
    const exitCode = await runCli(
      [
        "doctor",
        "--workspace",
        workspaceRoot,
        "--cache-path",
        path.join(workspaceRoot, "cache.sqlite"),
        "--json",
      ],
      {
        cwd: workspaceRoot,
        io: output.io,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdout[0] ?? "{}")).toEqual(
      expect.objectContaining({
        status: "pass",
      }),
    );
  });

  it("optimizes a task into a context pack", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    await mkdir(path.join(workspaceRoot, "src"));
    await writeFile(
      path.join(workspaceRoot, "src", "feature.ts"),
      "export function featureFlag() { return true; }\n",
    );
    const output = createOutput();
    const exitCode = await runCli(
      [
        "optimize",
        "--workspace",
        workspaceRoot,
        "--task",
        "Update feature flag behavior",
        "--json",
      ],
      {
        cwd: workspaceRoot,
        io: output.io,
      },
    );
    const contextPack = JSON.parse(output.stdout[0] ?? "{}") as {
      readonly selected: readonly {
        readonly path: string;
      }[];
    };

    expect(exitCode).toBe(0);
    expect(contextPack.selected.map((candidate) => candidate.path)).toContain(
      "src/feature.ts",
    );
  });

  it("applies workspace optimization configuration to cached CLI runs", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const cachePath = path.join(workspaceRoot, ".cache", "optimizer.sqlite");
    await mkdir(path.join(workspaceRoot, "src"));
    await writeFile(
      path.join(workspaceRoot, "src", "feature.ts"),
      "export function featureFlag() { return true; }\n",
    );
    await writeFile(path.join(workspaceRoot, "script.py"), "print('ignore me')\n");
    await writeWorkspaceConfig(workspaceRoot, {
      cachePath,
      cache: { enabled: true },
      optimization: {
        rankingLimit: 1,
        responseTokenBudget: 1_200,
        recommendedContentTokenBudget: 300,
        supportedLanguages: ["typescript"],
      },
    });

    const output = createOutput();
    const exitCode = await runCli(
      [
        "optimize",
        "--workspace",
        workspaceRoot,
        "--task",
        "Update feature flag behavior",
        "--cache",
        "--json",
      ],
      { cwd: workspaceRoot, io: output.io },
    );
    const contextPack = JSON.parse(output.stdout[0] ?? "{}") as {
      readonly selected: readonly { readonly path: string }[];
      readonly budget: {
        readonly response: { readonly limitTokens: number };
        readonly recommendedContent: { readonly limitTokens: number };
      };
    };

    expect(exitCode).toBe(0);
    expect(contextPack.selected.map((candidate) => candidate.path)).toEqual([
      "src/feature.ts",
    ]);
    expect(contextPack.budget).toMatchObject({
      response: { limitTokens: 1_200 },
      recommendedContent: { limitTokens: 300 },
    });
    const store = new SqliteStore({ databasePath: cachePath });
    await store.initialize();
    try {
      await expect(store.list(STORE_KINDS.workspaceIndex)).resolves.toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("reports cache status", async () => {
    const workspaceRoot = await createTemporaryWorkspace();
    const cachePath = path.join(workspaceRoot, "cache.sqlite");
    const cacheOutput = createOutput();
    const cacheExitCode = await runCli(
      ["cache", "status", "--cache-path", cachePath, "--json"],
      {
        cwd: workspaceRoot,
        io: cacheOutput.io,
      },
    );
    expect(cacheExitCode).toBe(0);
    expect(JSON.parse(cacheOutput.stdout[0] ?? "{}")).toEqual(
      expect.objectContaining({
        databasePath: cachePath,
      }),
    );
  });
});

async function createTemporaryWorkspace(): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ato-cli-"));
  temporaryRoots.push(rootPath);

  return rootPath;
}

async function createCliFixture(): Promise<{
  readonly rootPath: string;
  readonly homePath: string;
  readonly workspaceRoot: string;
  readonly cachePath: string;
}> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ato-cli-fixture-"));
  const homePath = path.join(rootPath, "home");
  const workspaceRoot = path.join(rootPath, "workspace");
  const cachePath = path.join(rootPath, "cache.sqlite");
  await mkdir(homePath, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  temporaryRoots.push(rootPath);

  return {
    rootPath,
    homePath,
    workspaceRoot,
    cachePath,
  };
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

function createOutput(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly io: CliIo;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    io: {
      stdout(message) {
        stdout.push(message);
      },
      stderr(message) {
        stderr.push(message);
      },
    },
  };
}
