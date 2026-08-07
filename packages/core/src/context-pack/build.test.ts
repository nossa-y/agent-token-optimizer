import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverWorkspace } from "../workspace";
import type { ContextCandidate, FileSummary } from "../contracts";
import { estimateSerializedTokens } from "../token";
import { buildContextPack } from "./build";

const temporaryRoots: string[] = [];

describe("buildContextPack", () => {
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

  it("builds an agent-readable context pack with summaries, redaction, and token estimates", async () => {
    const rootPath = await createTemporaryWorkspace();
    const fakeApiKey = createFakeOpenAiKey();
    await mkdir(path.join(rootPath, "src", "auth"), { recursive: true });
    await mkdir(path.join(rootPath, "src", "billing"), { recursive: true });
    await writeFile(
      path.join(rootPath, "src", "auth", "session.ts"),
      [
        `const OPENAI_API_KEY=${fakeApiKey}`,
        "export function createSession() {",
        "  return true;",
        "}",
      ].join("\n"),
    );
    await writeFile(
      path.join(rootPath, "src", "auth", "session.test.ts"),
      "const shouldRedirect = true;\n",
    );
    await writeFile(
      path.join(rootPath, "src", "billing", "invoice.ts"),
      "export const invoice = true;\n",
    );

    const workspaceIndex = await discoverWorkspace({
      rootPath,
      includeContentHashes: false,
    });
    const contextPack = await buildContextPack({
      task: "Fix the failing auth session test",
      workspaceIndex,
      now: new Date("2026-07-06T00:00:00.000Z"),
      operationId: "context-pack-test",
      packageVersion: "0.0.0-test",
      modelHint: "test-model",
    });
    const stableContextPack = {
      metadata: contextPack.metadata,
      selected: contextPack.selected.map((candidate) => candidate.path),
      summaries: contextPack.summaries.map((summary) => ({
        path: summary.path,
        summary: summary.summary,
        symbols: summary.symbols,
        redactions: summary.redactions,
      })),
      tokenEstimate: contextPack.tokenEstimate,
      expansionRules: contextPack.expansionRules,
      warnings: contextPack.warnings,
    };

    expect(stableContextPack).toMatchInlineSnapshot(`
      {
        "expansionRules": [
          "Start with the selected files before reading broader repository context.",
          "Expand only when selected files do not explain the task or tests point elsewhere.",
          "Use the bounded fallback candidates before broad filesystem scans.",
        ],
        "metadata": {
          "contractVersion": "1.0",
          "generatedAt": "2026-07-06T00:00:00.000Z",
          "generator": {
            "name": "agent-token-optimizer",
            "version": "0.0.0-test",
          },
          "operationId": "context-pack-test",
        },
        "selected": [
          "src/auth/session.test.ts",
          "src/auth/session.ts",
        ],
        "summaries": [
          {
            "path": "src/auth/session.test.ts",
            "redactions": [],
            "summary": "Structural outline: 1 declaration(s).",
            "symbols": [],
          },
          {
            "path": "src/auth/session.ts",
            "redactions": [
              {
                "reason": "secret_pattern",
                "redacted": true,
                "replacement": "[REDACTED]",
              },
            ],
            "summary": "Structural outline: 1 export(s), 1 declaration(s), task-matched snippet included.",
            "symbols": [
              "export function createSession() {",
            ],
          },
        ],
        "tokenEstimate": {
          "confidence": "medium",
          "inputTokens": 511,
          "method": "approximate",
          "modelHint": "test-model",
          "totalTokens": 511,
        },
        "warnings": [],
      }
    `);
    expect(JSON.stringify(contextPack)).not.toContain(fakeApiKey);
  });

  it("returns warnings instead of failing when selected files cannot be summarized", async () => {
    const rootPath = await createTemporaryWorkspace();
    await mkdir(path.join(rootPath, "src"));
    await writeFile(
      path.join(rootPath, "src", "missing.ts"),
      "export const value = true;\n",
    );
    const workspaceIndex = await discoverWorkspace({ rootPath });
    await rm(path.join(rootPath, "src", "missing.ts"));

    const contextPack = await buildContextPack({
      task: "Update missing value",
      workspaceIndex,
    });

    expect(contextPack.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "summary_read_failed",
          path: "src/missing.ts",
        }),
      ]),
    );
  });

  it("returns compact selected files and a bounded fallback page", async () => {
    const rootPath = await createTemporaryWorkspace();
    const workspaceIndex = await discoverWorkspace({ rootPath });
    const selected = [candidate("src/selected.ts", 1, true)];
    const excluded = Array.from({ length: 10 }, (_, index) =>
      candidate(`src/fallback-${index + 1}.ts`, index + 2, false),
    );
    const contextPack = await buildContextPack({
      task: "Update feature behavior",
      workspaceIndex,
      rankedContext: { selected, excluded },
      fallbackLimit: 3,
      includeSummaries: false,
      operationId: "bounded-pack",
      now: new Date("2026-07-11T00:00:00.000Z"),
    });

    expect(contextPack.packId).toBe("bounded-pack");
    expect(contextPack.selected).toHaveLength(1);
    expect(contextPack.selected[0]?.signals).toEqual([]);
    expect(contextPack.excluded).toHaveLength(3);
    expect(contextPack.excluded.every((item) => item.signals.length === 0)).toBe(true);
    expect(contextPack.omittedCandidateCount).toBe(7);
    expect(contextPack.expansion).toMatchObject({ hasMore: true });
    expect(contextPack.expansion?.nextCursor).toBeTruthy();
  });

  it("enforces response and recommended-content budgets independently of candidate count", async () => {
    const rootPath = await createTemporaryWorkspace();
    const workspaceIndex = await discoverWorkspace({ rootPath });
    const selected = Array.from({ length: 200 }, (_, index) =>
      candidate(`src/feature-${String(index + 1).padStart(3, "0")}.ts`, index + 1, true),
    );
    const excluded = Array.from({ length: 300 }, (_, index) =>
      candidate(
        `src/fallback-${String(index + 1).padStart(3, "0")}.ts`,
        index + 201,
        false,
      ),
    );
    const contextPack = await buildContextPack({
      task: "Update feature behavior",
      workspaceIndex,
      rankedContext: { selected, excluded },
      responseTokenBudget: 1_000,
      recommendedContentTokenBudget: 300,
      includeSummaries: false,
      operationId: "budgeted-pack",
      now: new Date("2026-07-12T00:00:00.000Z"),
    });

    expect(contextPack.budget?.response.usedTokens).toBe(
      estimateSerializedTokens(contextPack),
    );
    expect(contextPack.budget?.response.usedTokens).toBeLessThanOrEqual(1_000);
    expect(contextPack.budget?.recommendedContent.usedTokens).toBeLessThanOrEqual(300);
    expect(contextPack.budget?.recommendedContent.exhausted).toBe(true);
    expect(contextPack.omittedCandidateCount).toBeGreaterThan(490);
    expect(contextPack.expansion?.nextCursor).toBeTruthy();
    expect(contextPack.warnings.map((warning) => warning.code)).toContain(
      "recommended_content_budget_exhausted",
    );
  });

  it("fails clearly when the mandatory response envelope cannot fit", async () => {
    const rootPath = await createTemporaryWorkspace();
    const workspaceIndex = await discoverWorkspace({ rootPath });

    await expect(
      buildContextPack({
        task: "Update feature behavior",
        workspaceIndex,
        rankedContext: { selected: [], excluded: [] },
        responseTokenBudget: 1,
        includeSummaries: false,
      }),
    ).rejects.toThrow("mandatory context pack envelope");
  });

  it("reuses a hash-valid cached summary without rereading the selected file", async () => {
    const rootPath = await createTemporaryWorkspace();
    await mkdir(path.join(rootPath, "src"));
    await writeFile(
      path.join(rootPath, "src", "cache.ts"),
      "export const cached = true;\n",
    );
    const workspaceIndex = await discoverWorkspace({ rootPath });
    const contentHash = workspaceIndex.files.find(
      (file) => file.path === "src/cache.ts",
    )?.contentHash;
    const cachedSummary: FileSummary = {
      path: "src/cache.ts",
      ...(contentHash ? { contentHash } : {}),
      summary: "Structural outline: cached summary.",
      symbols: ["export const cached = true;"],
      declarations: [],
      imports: [],
      testNames: [],
      warnings: [],
      redactions: [],
    };
    await rm(path.join(rootPath, "src", "cache.ts"));

    const contextPack = await buildContextPack({
      task: "Update cached behavior",
      workspaceIndex,
      rankedContext: {
        selected: [candidate("src/cache.ts", 1, true)],
        excluded: [],
      },
      cachedSummaries: new Map([[cachedSummary.path, cachedSummary]]),
    });

    expect(contextPack.summaries).toEqual([cachedSummary]);
    expect(contextPack.warnings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "summary_read_failed" })]),
    );
  });
});

async function createTemporaryWorkspace(): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ato-context-pack-"));
  temporaryRoots.push(rootPath);

  return rootPath;
}

function createFakeOpenAiKey(): string {
  return `${"sk"}-${"testsecretvalue123456"}`;
}

function candidate(path: string, rank: number, selected: boolean): ContextCandidate {
  return {
    path,
    score: 1 / rank,
    rank,
    selected,
    reason: `Ranked candidate ${rank}.`,
    signals: [
      {
        name: "lexical",
        score: 0.5,
        reason: "Matched a task term.",
      },
    ],
    estimatedTokens: 100,
  };
}
