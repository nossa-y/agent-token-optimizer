import { describe, expect, it } from "vitest";

import {
  renderBenchmarkReportHtml,
  summarizeBenchmarkReport,
  type BenchmarkReportResult,
} from "./index";

describe("benchmark report UI", () => {
  it("renders accessible static benchmark HTML", () => {
    const html = renderBenchmarkReportHtml(reportFixture(), {
      rawDataHref: "benchmark-result.json",
    });

    expect(html).toContain("<main");
    expect(html).toContain('aria-label="Benchmark summary"');
    expect(html).toContain("Baseline vs optimized");
    expect(html).toContain("Download raw benchmark data");
  });

  it("escapes untrusted benchmark content", () => {
    const fixture = reportFixture({
      note: '<script>alert("x")</script>',
      scenarioId: "dangerous<scenario>",
    });
    const html = renderBenchmarkReportHtml(fixture);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("dangerous&lt;scenario&gt;");
  });

  it("summarizes cost, latency, and success rates", () => {
    const summary = summarizeBenchmarkReport(reportFixture());

    expect(summary.baselineCost).toBeGreaterThan(summary.optimizedCost);
    expect(summary.optimizedCostPerSuccess).not.toBeNull();
    expect(summary.optimizedSuccessRate).toBe(100);
    expect(summary.averageOptimizedDurationMs).toBe(8);
  });
});

function reportFixture(
  overrides: {
    readonly note?: string;
    readonly scenarioId?: string;
  } = {},
): BenchmarkReportResult {
  const scenarioId = overrides.scenarioId ?? "typescript-api-change";
  const note = overrides.note ?? "Deterministic benchmark note.";

  return {
    metadata: {
      generatedAt: "2026-07-07T00:00:00.000Z",
      packageVersion: "0.0.0-test",
      nodeVersion: "v22.0.0",
      platform: "darwin/arm64",
      scenarioCount: 1,
      reproducibility: ["Local fixtures only.", "No external model calls."],
    },
    cases: [
      {
        scenarioId,
        mode: "baseline",
        success: true,
        durationMs: 12,
        tokenEstimate: {
          inputTokens: 1000,
          outputTokens: 200,
          totalTokens: 1200,
        },
        touchedFiles: ["src/user-api.ts", "src/user-api.test.ts"],
        expectedFiles: ["src/user-api.ts", "src/user-api.test.ts"],
        notes: [note],
      },
      {
        scenarioId,
        mode: "optimized",
        success: true,
        durationMs: 8,
        tokenEstimate: {
          inputTokens: 400,
          outputTokens: 200,
          totalTokens: 600,
        },
        touchedFiles: ["src/user-api.ts", "src/user-api.test.ts"],
        expectedFiles: ["src/user-api.ts", "src/user-api.test.ts"],
        notes: [note],
      },
    ],
    totals: {
      baselineTokens: 1200,
      optimizedTokens: 600,
      tokenSavings: 600,
      tokenSavingsPercent: 50,
      baselineSuccesses: 1,
      optimizedSuccesses: 1,
      successRateDelta: 0,
    },
  };
}
