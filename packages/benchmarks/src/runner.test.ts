import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { STORE_KINDS, SqliteStore } from "@agent-relay/agent-token-optimization-core";

import { loadBenchmarkScenarios, runBenchmarks } from "./runner";

const temporaryRoots: string[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("benchmark runner", () => {
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

  it("loads checked-in benchmark scenarios", async () => {
    const scenarios = await loadBenchmarkScenarios({
      scenariosRoot: scenarioRoot(),
    });

    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      "configuration-documentation-change",
      "cross-package-api-change",
      "distracting-large-repository",
      "security-auth-change",
      "skip-trivial-task",
      "stack-trace-bug",
      "terminology-symbol-mismatch",
      "typescript-api-change",
    ]);
  });

  it("runs baseline and optimized deterministic benchmark cases", async () => {
    const result = await runBenchmarks({
      scenariosRoot: scenarioRoot(),
      fixturesRoot: fixtureRoot(),
      scenarioIds: ["typescript-api-change"],
      packageVersion: "0.0.0-test",
      now: new Date("2026-07-07T00:00:00.000Z"),
    });

    expect(result.metadata).toEqual(
      expect.objectContaining({
        generatedAt: "2026-07-07T00:00:00.000Z",
        scenarioCount: 1,
      }),
    );
    expect(result.cases.map((benchmarkCase) => benchmarkCase.mode).sort()).toEqual([
      "baseline",
      "optimized",
    ]);
    expect(result.totals).toEqual(
      expect.objectContaining({
        baselineTokens: 743,
        optimizedTokens: 719,
        tokenSavings: 24,
        tokenSavingsPercent: 3.23,
        baselineSuccesses: 1,
        optimizedSuccesses: 1,
        successRateDelta: 0,
      }),
    );
    expect(
      result.cases.find((benchmarkCase) => benchmarkCase.mode === "optimized")
        ?.touchedFiles,
    ).toEqual(["src/user-api.ts", "src/user-api.test.ts"]);
    expect(result.totals.optimizedSuccesses).toBe(1);
  });

  it("measures retrieval, budgets, expansion, and skip recommendations across scenarios", async () => {
    const result = await runBenchmarks({
      scenariosRoot: scenarioRoot(),
      fixturesRoot: fixtureRoot(),
      packageVersion: "0.0.0-test",
      now: new Date("2026-07-13T00:00:00.000Z"),
    });
    const optimizedCases = result.cases.filter(
      (benchmarkCase) => benchmarkCase.mode === "optimized",
    );
    const skipCase = optimizedCases.find(
      (benchmarkCase) => benchmarkCase.scenarioId === "skip-trivial-task",
    );
    const distractingCase = optimizedCases.find(
      (benchmarkCase) => benchmarkCase.scenarioId === "distracting-large-repository",
    );

    expect(result.metadata.scenarioCount).toBe(8);
    expect(optimizedCases).toHaveLength(8);
    expect(
      optimizedCases
        .filter((benchmarkCase) => benchmarkCase.optimizationMode !== "skip")
        .every((benchmarkCase) => benchmarkCase.retrieval.recall === 1),
    ).toBe(true);
    expect(
      optimizedCases.every(
        (benchmarkCase) =>
          benchmarkCase.budget?.response.adhered &&
          benchmarkCase.budget.recommendedContent.adhered,
      ),
    ).toBe(true);
    expect(skipCase).toMatchObject({
      optimizationMode: "skip",
      optimizationModeMatched: true,
    });
    expect(distractingCase?.retrieval.expansion.fallbackCandidateCount).toBeGreaterThan(
      0,
    );
  });

  it("stores benchmark run metrics when a cache path is provided", async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), "ato-benchmarks-"));
    temporaryRoots.push(rootPath);
    const cachePath = path.join(rootPath, "benchmark.sqlite");
    await runBenchmarks({
      scenariosRoot: scenarioRoot(),
      fixturesRoot: fixtureRoot(),
      cachePath,
      now: new Date("2026-07-07T00:00:00.000Z"),
    });
    const store = new SqliteStore({ databasePath: cachePath });
    await store.initialize();

    try {
      const records = await store.list(STORE_KINDS.runMetric);
      expect(records).toHaveLength(16);
      expect(records.map((record) => record.key)).toEqual(
        expect.arrayContaining([
          "benchmark:cross-package-api-change:optimized",
          "benchmark:skip-trivial-task:baseline",
          "benchmark:typescript-api-change:optimized",
        ]),
      );
    } finally {
      await store.close();
    }
  });
});

function scenarioRoot(): string {
  return path.join(repoRoot, "benchmarks", "scenarios");
}

function fixtureRoot(): string {
  return path.join(repoRoot, "benchmarks", "fixtures");
}
