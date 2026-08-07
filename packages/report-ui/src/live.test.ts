import { describe, expect, it } from "vitest";

import {
  renderLiveBenchmarkReportHtml,
  summarizeLiveBenchmarkReport,
  type LiveBenchmarkReport,
} from "./live";

describe("live benchmark report UI", () => {
  it("renders paired provider evidence and escapes diagnostic content", () => {
    const report = fixture();
    const html = renderLiveBenchmarkReportHtml(report, {
      rawDataHref: "live-benchmark-result.json",
      pricing: {
        inputCostPerMillionTokens: 2,
        cachedInputCostPerMillionTokens: 0.5,
        outputCostPerMillionTokens: 4,
        currency: "USD",
      },
    });
    const summary = summarizeLiveBenchmarkReport(report);

    expect(summary.paired).toMatchObject({
      comparedPairs: 1,
      improved: 0,
      regressed: 0,
      tied: 1,
      successRateDelta: 0,
    });
    expect(summary.optimized.totalTokens.median).toBe(700);
    expect(summary.optimizer).toMatchObject({
      hookCallCount: 1,
      maxHookResponseTokens: 30,
      responseBudgetAdhered: true,
      warmCacheEvidenceCases: 1,
      warmCacheReusedCases: 1,
    });
    expect(summary.gates).toMatchObject({
      medianTokenReductionRate: 0.3,
      medianTokenReductionPassed: true,
      costPerSuccessLower: true,
      tokenRegressionCount: 0,
      releasePassed: true,
    });
    expect(html).toContain("Provider-backed benchmark evidence");
    expect(html).toContain("Download benchmark data");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});

function fixture(): LiveBenchmarkReport {
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
    cases: [benchmarkCase("baseline", 1_000), benchmarkCase("optimized", 700)],
  };
}

function benchmarkCase(
  mode: "baseline" | "optimized",
  totalTokens: number,
): LiveBenchmarkReport["cases"][number] {
  return {
    scenarioId: "typescript-api-change",
    repetition: 1,
    mode,
    order: mode === "baseline" ? 1 : 2,
    success: true,
    durationMs: 100,
    providerUsage: {
      inputTokens: totalTokens - 100,
      cachedInputTokens: 50,
      outputTokens: 100,
      totalTokens,
    },
    optimizer: {
      overheadTokens: mode === "optimized" ? 50 : 0,
      expansionCount: 0,
      retryCount: 0,
      unknownEntryCount: 0,
    },
    ...(mode === "optimized"
      ? {
          optimizerEvidence: {
            hookCallCount: 1,
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
    validation: {
      passed: true,
      changedFiles: ["src/user-api.ts"],
      details: ["<script>alert('unsafe')</script>"],
    },
    diagnostics: [],
  };
}
