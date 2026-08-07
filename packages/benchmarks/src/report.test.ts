import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { generateBenchmarkReports, renderBenchmarkReportMarkdown } from "./report";
import type { BenchmarkRunResult } from "./runner";

const temporaryRoots: string[] = [];

describe("benchmark report generator", () => {
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

  it("writes HTML, Markdown, and raw JSON artifacts", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "ato-report-"));
    temporaryRoots.push(outputDir);

    const artifacts = await generateBenchmarkReports({
      outputDir,
      result: resultFixture(),
    });

    await expect(readFile(artifacts.htmlPath, "utf8")).resolves.toContain(
      "Agent Token Optimizer Benchmark Report",
    );
    await expect(readFile(artifacts.markdownPath, "utf8")).resolves.toContain(
      "## Scenario Results",
    );
    await expect(readFile(artifacts.jsonPath, "utf8")).resolves.toContain(
      '"scenarioId": "typescript-api-change"',
    );
  });

  it("can run benchmarks before generating artifacts", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "ato-report-runner-"));
    temporaryRoots.push(outputDir);

    const artifacts = await generateBenchmarkReports({
      outputDir,
      runner: {
        scenariosRoot: path.join(repoRoot(), "benchmarks", "scenarios"),
        fixturesRoot: path.join(repoRoot(), "benchmarks", "fixtures"),
        packageVersion: "0.0.0-test",
        now: new Date("2026-07-07T00:00:00.000Z"),
      },
    });

    expect(artifacts.result.totals.baselineTokens).toBeGreaterThan(
      artifacts.result.totals.optimizedTokens,
    );
  });

  it("renders Markdown with report methodology and cost per success", () => {
    const markdown = renderBenchmarkReportMarkdown(resultFixture());

    expect(markdown).toContain("Cost values use configurable illustrative token pricing");
    expect(markdown).toContain("Optimized cost per success");
  });

  it("fails explicitly when no result or runner options are provided", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "ato-report-invalid-"));
    temporaryRoots.push(outputDir);

    await expect(generateBenchmarkReports({ outputDir })).rejects.toThrow(
      "runner options are required",
    );
  });
});

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function resultFixture(): BenchmarkRunResult {
  return {
    metadata: {
      generatedAt: "2026-07-07T00:00:00.000Z",
      packageVersion: "0.0.0-test",
      nodeVersion: "v22.0.0",
      platform: "darwin/arm64",
      scenarioCount: 1,
      reproducibility: [
        "Scenarios are local fixture repositories.",
        "The default benchmark agent is deterministic and does not call external models.",
      ],
    },
    cases: [
      {
        scenarioId: "typescript-api-change",
        mode: "baseline",
        success: true,
        durationMs: 12,
        tokenEstimate: {
          inputTokens: 1000,
          outputTokens: 200,
          totalTokens: 1200,
          method: "approximate",
          confidence: "medium",
        },
        touchedFiles: ["src/user-api.ts", "src/user-api.test.ts"],
        expectedFiles: ["src/user-api.ts", "src/user-api.test.ts"],
        responseTokens: 200,
        retrieval: {
          expectedFiles: ["src/user-api.ts", "src/user-api.test.ts"],
          retrievedExpectedFiles: ["src/user-api.ts", "src/user-api.test.ts"],
          recall: 1,
          expansion: {
            fallbackCandidateCount: 0,
            pageCount: 0,
            expandedCandidateCount: 0,
            expandedExpectedFiles: [],
          },
        },
        optimizationMode: "context_pack",
        optimizationModeMatched: true,
        notes: ["Baseline fixture note."],
      },
      {
        scenarioId: "typescript-api-change",
        mode: "optimized",
        success: true,
        durationMs: 8,
        tokenEstimate: {
          inputTokens: 400,
          outputTokens: 200,
          totalTokens: 600,
          method: "approximate",
          confidence: "medium",
        },
        touchedFiles: ["src/user-api.ts", "src/user-api.test.ts"],
        expectedFiles: ["src/user-api.ts", "src/user-api.test.ts"],
        responseTokens: 200,
        retrieval: {
          expectedFiles: ["src/user-api.ts", "src/user-api.test.ts"],
          retrievedExpectedFiles: ["src/user-api.ts", "src/user-api.test.ts"],
          recall: 1,
          expansion: {
            fallbackCandidateCount: 0,
            pageCount: 0,
            expandedCandidateCount: 0,
            expandedExpectedFiles: [],
          },
        },
        optimizationMode: "context_pack",
        optimizationModeMatched: true,
        notes: ["Optimized fixture note."],
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
