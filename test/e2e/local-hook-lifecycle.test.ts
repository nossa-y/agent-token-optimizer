import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../../packages/cli/src/index";

const temporaryRoots: string[] = [];

describe("local hook lifecycle", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("installs, diagnoses, runs, and uninstalls all supported host hooks", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "ato-e2e-"));
    temporaryRoots.push(rootPath);
    const homePath = path.join(rootPath, "home");
    const workspaceRoot = path.join(rootPath, "workspace");
    const cachePath = path.join(rootPath, "cache.sqlite");
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await mkdir(homePath, { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "src", "session.ts"),
      "export function validateSession() { return false; }\n",
    );
    const environment = {
      cwd: workspaceRoot,
      env: { HOME: homePath },
    };
    const installOutput = createOutput();

    await expect(
      runCli(
        [
          "install",
          "--hosts",
          "codex,claude-code,kimi",
          "--cache-path",
          cachePath,
          "--json",
        ],
        { ...environment, io: installOutput.io },
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(installOutput.stdout[0] ?? "{}")).toEqual(
      expect.objectContaining({ status: "installed" }),
    );
    await expect(
      readFile(path.join(homePath, ".codex", "hooks.json"), "utf8"),
    ).resolves.toContain("user-prompt");
    await expect(
      readFile(path.join(homePath, ".claude", "settings.json"), "utf8"),
    ).resolves.toContain("user-prompt");
    await expect(
      readFile(path.join(homePath, ".kimi-code", "config.toml"), "utf8"),
    ).resolves.toContain("user-prompt");

    const doctorOutput = createOutput();
    await expect(
      runCli(
        [
          "doctor",
          "--hosts",
          "codex,claude-code,kimi",
          "--cache-path",
          cachePath,
          "--json",
        ],
        { ...environment, io: doctorOutput.io },
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(doctorOutput.stdout[0] ?? "{}")).toEqual(
      expect.objectContaining({
        status: "pass",
        hosts: expect.arrayContaining([
          expect.objectContaining({ host: "codex", status: "installed" }),
          expect.objectContaining({ host: "claude-code", status: "installed" }),
          expect.objectContaining({ host: "kimi", status: "installed" }),
        ]),
      }),
    );

    const hookOutput = createOutput();
    await expect(
      runCli(["hook", "user-prompt", "--cache-path", cachePath], {
        ...environment,
        io: hookOutput.io,
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({
              hook_event_name: "UserPromptSubmit",
              cwd: workspaceRoot,
              prompt: "Fix session validation in src/session.ts",
            }),
          ),
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(hookOutput.stdout[0] ?? "{}")).toEqual(
      expect.objectContaining({
        hookSpecificOutput: expect.objectContaining({
          hookEventName: "UserPromptSubmit",
          additionalContext: expect.stringContaining("src/session.ts"),
        }),
      }),
    );

    const kimiHookOutput = createOutput();
    await expect(
      runCli(["hook", "user-prompt", "--host", "kimi", "--cache-path", cachePath], {
        ...environment,
        io: kimiHookOutput.io,
        readStdin: () =>
          Promise.resolve(
            JSON.stringify({
              hook_event_name: "UserPromptSubmit",
              session_id: "session_e2e",
              client_type: "kimi_code_cli",
              cwd: workspaceRoot,
              prompt: [
                { type: "text", text: "Fix session validation in src/session.ts" },
              ],
            }),
          ),
      }),
    ).resolves.toBe(0);
    expect(kimiHookOutput.stdout[0]?.startsWith("# Agent Token Optimizer Context")).toBe(
      true,
    );
    expect(kimiHookOutput.stdout[0]).toContain("src/session.ts");

    const uninstallOutput = createOutput();
    await expect(
      runCli(
        [
          "uninstall",
          "--hosts",
          "codex,claude-code,kimi",
          "--cache-path",
          cachePath,
          "--json",
        ],
        { ...environment, io: uninstallOutput.io },
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(uninstallOutput.stdout[0] ?? "{}")).toEqual(
      expect.objectContaining({ status: "uninstalled" }),
    );
    await expect(
      readFile(path.join(homePath, ".codex", "hooks.json"), "utf8"),
    ).resolves.not.toContain("agent-token-optimizer-managed-hook");
    await expect(
      readFile(path.join(homePath, ".claude", "settings.json"), "utf8"),
    ).resolves.not.toContain("agent-token-optimizer-managed-hook");
    await expect(
      readFile(path.join(homePath, ".kimi-code", "config.toml"), "utf8"),
    ).resolves.not.toContain("agent-token-optimizer-managed-hook");
  });
});

function createOutput(): { readonly stdout: string[]; readonly io: CliIo } {
  const stdout: string[] = [];
  return {
    stdout,
    io: {
      stdout(message) {
        stdout.push(message);
      },
      stderr(message) {
        throw new Error(message);
      },
    },
  };
}
