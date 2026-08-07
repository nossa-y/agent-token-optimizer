import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  STORE_KINDS,
  SqliteStore,
  estimateTextTokens,
} from "@agent-relay/agent-token-optimization-core";

import {
  MAX_USER_PROMPT_HOOK_INPUT_BYTES,
  parseUserPromptHookInput,
  runUserPromptHook,
} from "./user-prompt-hook";

const temporaryRoots: string[] = [];

describe("user-prompt hook", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((temporaryRoot) => rm(temporaryRoot, { force: true, recursive: true })),
    );
  });

  it("injects bounded redacted context and persists only content-free evidence", async () => {
    const rootPath = await createTemporaryRoot();
    const workspaceRoot = path.join(rootPath, "workspace");
    const outsideRoot = path.join(rootPath, "outside");
    const cachePath = path.join(rootPath, "cache.sqlite");
    const prompt =
      "Fix authentication token validation in src/auth.ts PRIVATE_PROMPT_MARKER";
    const sourceSecret = createFakeApiKey("abcdefghijklmnop1234");
    const outsideSecret = createFakeApiKey("outsideabcdefghijklmnop");
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "src", "auth.ts"),
      `export const bearerToken = "${sourceSecret}";\nexport function validateToken() { return false; }\n`,
    );
    await writeFile(path.join(outsideRoot, "secret.txt"), outsideSecret);
    await symlink(
      path.join(outsideRoot, "secret.txt"),
      path.join(workspaceRoot, "external-secret.txt"),
    );

    const result = await runUserPromptHook(
      {
        hook_event_name: "UserPromptSubmit",
        cwd: workspaceRoot,
        prompt,
      },
      {
        cachePath,
        operationId: "hook-operation-1",
        now: new Date("2026-08-06T22:00:00.000Z"),
      },
    );
    const additionalContext = result.output?.hookSpecificOutput.additionalContext;

    expect(result.evidence).toMatchObject({
      outcome: "context_injected",
      response: { budgetTokens: 1_200 },
      recommendation: { risk: "high" },
    });
    expect(additionalContext).toContain("src/auth.ts");
    expect(additionalContext).toContain("[REDACTED]");
    expect(additionalContext).not.toContain(sourceSecret);
    expect(additionalContext).not.toContain(outsideSecret);
    expect(additionalContext).not.toContain("expand_context");
    expect(additionalContext).not.toContain("expansion cursor");
    expect(estimateTextTokens(additionalContext ?? "")).toBeLessThanOrEqual(1_200);

    const store = new SqliteStore({ databasePath: cachePath });
    await store.initialize();
    try {
      const persisted = JSON.stringify({
        hookEvidence: await store.list(STORE_KINDS.userPromptHookEvidence),
        tokenLedgers: await store.list(STORE_KINDS.tokenLedger),
        workspaceIndexes: await store.list(STORE_KINDS.workspaceIndex),
        workspaceAnalyses: await store.list(STORE_KINDS.workspaceAnalysis),
      });

      expect(persisted).not.toContain(prompt);
      expect(persisted).not.toContain("PRIVATE_PROMPT_MARKER");
      expect(persisted).not.toContain(sourceSecret);
      expect(persisted).not.toContain(outsideSecret);
      expect(persisted).not.toContain("return false");
      expect(await store.list(STORE_KINDS.userPromptHookEvidence)).toHaveLength(1);
      const [tokenLedger] = await store.list(STORE_KINDS.tokenLedger);
      expect(tokenLedger?.value.taskId).toBe(result.evidence.taskHash);
      expect(tokenLedger?.value.entries).toEqual([
        expect.objectContaining({
          kind: "optimizer_call",
          status: "known",
          toolName: "user_prompt_hook",
        }),
      ]);
    } finally {
      await store.close();
    }
  });

  it("skips trivial prompts without emitting developer context", async () => {
    const workspaceRoot = await createTemporaryRoot();
    const cachePath = path.join(workspaceRoot, "cache.sqlite");
    const result = await runUserPromptHook(
      {
        hook_event_name: "UserPromptSubmit",
        cwd: workspaceRoot,
        prompt: "hello",
      },
      {
        cachePath,
        operationId: "hook-skip-1",
        now: new Date("2026-08-06T22:01:00.000Z"),
      },
    );

    expect(result.output).toBeUndefined();
    expect(result.evidence).toMatchObject({
      outcome: "skipped",
      recommendation: { mode: "skip" },
      selectedFiles: [],
      response: { usedTokens: 0 },
    });
  });

  it("reloads persisted workspace analysis on repeated prompts", async () => {
    const workspaceRoot = await createTemporaryRoot();
    const cachePath = path.join(workspaceRoot, "cache.sqlite");
    await mkdir(path.join(workspaceRoot, "src"));
    await writeFile(
      path.join(workspaceRoot, "src", "billing.ts"),
      "export function calculateInvoice() { return 0; }\n",
    );
    const input = {
      hook_event_name: "UserPromptSubmit" as const,
      cwd: workspaceRoot,
      prompt: "Fix billing calculation in src/billing.ts",
    };

    await runUserPromptHook(input, {
      cachePath,
      operationId: "hook-cache-1",
    });
    const warm = await runUserPromptHook(input, {
      cachePath,
      operationId: "hook-cache-2",
    });

    expect(warm.evidence.cache).toMatchObject({
      previousWorkspaceIndexFound: true,
      previousWorkspaceAnalysisFound: true,
      changedFiles: 0,
      deletedFiles: 0,
    });
    expect(warm.evidence.cache.reusedFiles).toBeGreaterThan(0);
  });

  it("rejects malformed, wrong-event, oversized, and over-budget inputs", async () => {
    expect(() => parseUserPromptHookInput("not-json")).toThrow("must be valid JSON");
    expect(() =>
      parseUserPromptHookInput(
        JSON.stringify({ hook_event_name: "SessionStart", cwd: "/tmp", prompt: "x" }),
      ),
    ).toThrow("must be UserPromptSubmit");
    expect(() =>
      parseUserPromptHookInput(
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          cwd: "",
          prompt: "fix something",
        }),
      ),
    ).toThrow("cwd must not be empty");
    expect(() =>
      parseUserPromptHookInput("x".repeat(MAX_USER_PROMPT_HOOK_INPUT_BYTES + 1)),
    ).toThrow("1 MiB safety limit");

    const workspaceRoot = await createTemporaryRoot();
    await expect(
      runUserPromptHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd: workspaceRoot,
          prompt: "Fix security authentication behavior",
        },
        {
          cachePath: path.join(workspaceRoot, "cache.sqlite"),
          responseTokenBudget: 2_001,
        },
      ),
    ).rejects.toThrow("between 1 and 2000 tokens");
  });
});

async function createTemporaryRoot(): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ato-user-prompt-hook-"));
  temporaryRoots.push(rootPath);
  return rootPath;
}

function createFakeApiKey(value: string): string {
  return `${"sk"}-${value}`;
}
