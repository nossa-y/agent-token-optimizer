import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLiveBenchmarkReport,
  generateLiveBenchmarkReports,
  renderLiveBenchmarkReportMarkdown,
} from "./live-report";
import type { LiveBenchmarkRunResult } from "./live";

const temporaryRoots: string[] = [];

describe("live benchmark report generator", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((temporaryRoot) => rm(temporaryRoot, { force: true, recursive: true })),
    );
  });

  it("writes safe benchmark data with HTML and Markdown live evidence reports", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "ato-live-report-"));
    temporaryRoots.push(outputDir);
    const artifacts = await generateLiveBenchmarkReports({
      outputDir,
      result: liveResultFixture(),
    });

    await expect(readFile(artifacts.htmlPath, "utf8")).resolves.toContain(
      "Provider-backed benchmark evidence",
    );
    await expect(readFile(artifacts.htmlPath, "utf8")).resolves.toContain(
      "Download benchmark data",
    );
    await expect(readFile(artifacts.markdownPath, "utf8")).resolves.toContain(
      "Cached-input tokens",
    );
    await expect(readFile(artifacts.jsonPath, "utf8")).resolves.toContain(
      "host stdout is not retained",
    );
  });

  it("summarizes paired success, distributions, and optimizer overhead", () => {
    const report = createLiveBenchmarkReport(liveResultFixture());
    const markdown = renderLiveBenchmarkReportMarkdown(report);

    expect(report.cases[1]?.optimizer).toEqual({
      overheadTokens: 50,
      expansionCount: 1,
      retryCount: 1,
      unknownEntryCount: 0,
    });
    expect(markdown).toContain("Paired success delta: 0%");
    expect(markdown).toContain("Optimizer overhead: 50 tokens, 1 expansions, 1 retries");
    expect(markdown).toContain("Overall: PASSED");
    expect(markdown).toContain("Median successful-task token reduction >= 15%");
  });
});

function liveResultFixture(): LiveBenchmarkRunResult {
  return {
    metadata: {
      generatedAt: "2026-07-14T00:00:00.000Z",
      packageVersion: "0.0.0-test",
      nodeVersion: "v22.0.0",
      platform: "darwin/arm64",
      host: "codex",
      hostVersion: "0.144.1",
      model: "gpt-5",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      timeLimitMs: 60_000,
      repetitions: 1,
      orderSeed: 1,
      scenarioCount: 1,
    },
    cases: [
      liveCase("baseline", 1, 1, 1_000, 100, []),
      liveCase("optimized", 2, 1, 700, 120, [optimizerLedger()]),
    ],
  };
}

function liveCase(
  mode: "baseline" | "optimized",
  order: number,
  repetition: number,
  inputTokens: number,
  outputTokens: number,
  optimizerLedgers: LiveBenchmarkRunResult["cases"][number]["optimizerLedgers"],
): LiveBenchmarkRunResult["cases"][number] {
  return {
    scenarioId: "typescript-api-change",
    repetition,
    mode,
    order,
    success: true,
    durationMs: mode === "baseline" ? 1_000 : 900,
    providerUsage: {
      inputTokens,
      cachedInputTokens: 100,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    validation: {
      passed: true,
      changedFiles: ["src/user-api.ts"],
      details: ["All scenario-expected files were changed."],
    },
    optimizerLedgers,
    ...(mode === "optimized"
      ? {
          optimizerEvidence: {
            hookCallCount: 2,
            maxHookResponseTokens: 30,
            responseBudgetTokens: 1_200,
            responseBudgetRequired: true,
            responseBudgetAdhered: true,
          },
          warmCache: {
            persistedCacheReloaded: true,
            coldChangedFiles: 2,
            warmReusedFiles: 2,
            warmChangedFiles: 0,
            warmDeletedFiles: 0,
            unchangedWorkReused: true,
          },
        }
      : {}),
    rawResult: {
      stdout: "[OMITTED: host stdout is not retained in benchmark artifacts]",
      stderr: "",
      redactionCount: 1,
    },
    diagnostics: [],
  };
}

function optimizerLedger(): LiveBenchmarkRunResult["cases"][number]["optimizerLedgers"][number] {
  return {
    metadata: {
      contractVersion: "1.0",
      generatedAt: "2026-07-14T00:00:00.000Z",
      generator: { name: "agent-token-optimizer", version: "0.0.0-test" },
    },
    runId: "live-run",
    entries: [
      {
        entryId: "optimizer:build-one",
        recordedAt: "2026-07-14T00:00:00.000Z",
        kind: "optimizer_call",
        status: "known",
        toolName: "user_prompt_hook",
        overhead: {
          requestTokens: 20,
          responseTokens: 30,
          totalTokens: 50,
          method: "exact",
          confidence: "high",
        },
      },
      {
        entryId: "optimizer:build-two",
        recordedAt: "2026-07-14T00:00:01.000Z",
        kind: "optimizer_call",
        status: "known",
        toolName: "user_prompt_hook",
        overhead: {
          requestTokens: 0,
          responseTokens: 0,
          totalTokens: 0,
          method: "exact",
          confidence: "high",
        },
      },
      {
        entryId: "optimizer:expand",
        recordedAt: "2026-07-14T00:00:02.000Z",
        kind: "optimizer_call",
        status: "known",
        toolName: "expand_context",
        overhead: {
          requestTokens: 0,
          responseTokens: 0,
          totalTokens: 0,
          method: "exact",
          confidence: "high",
        },
      },
    ],
  };
}
