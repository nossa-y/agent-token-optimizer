import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  BenchmarkScenarioSchema,
  STORE_KINDS,
  SqliteStore,
  assessTask,
  analyzeWorkspace,
  buildContextPack,
  createContextRankingEvidence,
  discoverWorkspace,
  estimateTextTokens,
  expandContextRanking,
  rankContext,
  type AgentTokenStore,
  type BenchmarkScenario,
  type ContextPack,
  type OptimizationMode,
  type RankedContext,
  type RunMetric,
  type TokenEstimate,
  type WorkspaceIndex,
} from "@agent-relay/agent-token-optimization-core";

export interface BenchmarkRunnerOptions {
  readonly scenariosRoot: string;
  readonly fixturesRoot: string;
  readonly scenarioIds?: readonly string[];
  readonly packageVersion?: string;
  readonly cachePath?: string;
  readonly now?: Date;
  readonly agent?: BenchmarkAgent;
}

export interface BenchmarkAgentInput {
  readonly scenario: BenchmarkScenario;
  readonly workspaceIndex: WorkspaceIndex;
  readonly mode: "baseline" | "optimized";
  readonly contextPack?: ContextPack;
}

export interface BenchmarkAgentResult {
  readonly success: boolean;
  readonly touchedFiles: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly notes: readonly string[];
}

export interface BenchmarkAgent {
  readonly run: (input: BenchmarkAgentInput) => Promise<BenchmarkAgentResult>;
}

export interface BenchmarkCaseResult {
  readonly scenarioId: string;
  readonly mode: "baseline" | "optimized";
  readonly success: boolean;
  readonly durationMs: number;
  readonly tokenEstimate: TokenEstimate;
  readonly touchedFiles: readonly string[];
  readonly expectedFiles: readonly string[];
  readonly responseTokens: number;
  readonly retrieval: BenchmarkRetrievalMetrics;
  readonly budget?: BenchmarkBudgetMetrics;
  readonly optimizationMode: OptimizationMode;
  readonly optimizationModeMatched: boolean;
  readonly notes: readonly string[];
}

export interface BenchmarkRetrievalMetrics {
  readonly expectedFiles: readonly string[];
  readonly retrievedExpectedFiles: readonly string[];
  readonly recall: number;
  readonly expansion: {
    readonly fallbackCandidateCount: number;
    readonly pageCount: number;
    readonly expandedCandidateCount: number;
    readonly expandedExpectedFiles: readonly string[];
  };
}

export interface BenchmarkBudgetMetrics {
  readonly response: {
    readonly limitTokens: number;
    readonly usedTokens: number;
    readonly adhered: boolean;
  };
  readonly recommendedContent: {
    readonly limitTokens: number;
    readonly usedTokens: number;
    readonly adhered: boolean;
  };
}

export interface BenchmarkRunResult {
  readonly metadata: {
    readonly generatedAt: string;
    readonly packageVersion: string;
    readonly nodeVersion: string;
    readonly platform: string;
    readonly scenarioCount: number;
    readonly reproducibility: readonly string[];
  };
  readonly cases: readonly BenchmarkCaseResult[];
  readonly totals: {
    readonly baselineTokens: number;
    readonly optimizedTokens: number;
    readonly tokenSavings: number;
    readonly tokenSavingsPercent: number;
    readonly baselineSuccesses: number;
    readonly optimizedSuccesses: number;
    readonly successRateDelta: number;
  };
}

export class DeterministicBenchmarkAgent implements BenchmarkAgent {
  public run(input: BenchmarkAgentInput): Promise<BenchmarkAgentResult> {
    const visibleFiles =
      input.mode === "optimized" && input.contextPack
        ? input.contextPack.selected.map((candidate) => candidate.path)
        : input.workspaceIndex.files
            .filter((file) => !file.ignored && file.kind !== "binary")
            .map((file) => file.path);
    const expectedFiles = input.scenario.validation.expectedFiles;
    const touchedFiles =
      expectedFiles.length > 0
        ? expectedFiles.filter((expectedFile) => visibleFiles.includes(expectedFile))
        : visibleFiles.slice(0, 1);
    const success =
      expectedFiles.length === 0 ||
      expectedFiles.every((expectedFile) => touchedFiles.includes(expectedFile));
    const contextTokens =
      input.mode === "optimized" && input.contextPack
        ? estimateConsumedContextPackTokens(input.contextPack)
        : estimateWorkspaceTokens(input.workspaceIndex);

    return Promise.resolve({
      success,
      touchedFiles,
      inputTokens: estimateTextTokens(input.scenario.task) + contextTokens,
      outputTokens: Math.max(100, touchedFiles.length * 120),
      notes: [
        input.mode === "optimized"
          ? "Deterministic agent used optimizer-selected context only."
          : "Deterministic agent used all indexed non-binary workspace files.",
      ],
    });
  }
}

export async function runBenchmarks(
  options: BenchmarkRunnerOptions,
): Promise<BenchmarkRunResult> {
  const packageVersion = options.packageVersion ?? "0.1.0";
  const generatedAt = (options.now ?? new Date()).toISOString();
  const agent = options.agent ?? new DeterministicBenchmarkAgent();
  const scenarios = await loadBenchmarkScenarios(options);
  const cases: BenchmarkCaseResult[] = [];
  const store = options.cachePath
    ? new SqliteStore({ databasePath: options.cachePath })
    : undefined;

  if (store) {
    await store.initialize();
  }

  try {
    for (const scenario of scenarios) {
      const workspaceRoot = path.join(options.fixturesRoot, scenario.workspaceFixture);
      const workspaceIndex = await discoverWorkspace({
        rootPath: workspaceRoot,
        packageVersion,
        operationId: `benchmark:${scenario.id}`,
      });
      const benchmarkNow = options.now ?? new Date(scenario.metadata.generatedAt);
      const workspaceAnalysis = await analyzeWorkspace({
        workspaceIndex,
        packageVersion,
        now: benchmarkNow,
      });
      const taskAnalysis = assessTask({
        task: scenario.task,
        workspaceIndex,
        workspaceAnalysis,
      });
      const rankedContext = rankContext({
        task: scenario.task,
        workspaceIndex,
        workspaceAnalysis,
        taskHints: taskAnalysis.hints,
        now: benchmarkNow,
      });
      const contextPack = await buildContextPack({
        task: scenario.task,
        workspaceIndex,
        rankedContext,
        packageVersion,
        operationId: `benchmark:${scenario.id}:optimized`,
        now: benchmarkNow,
      });
      const expansion = measureExpansion({
        contextPack,
        rankedContext,
        workspaceIndex,
        expectedFiles: scenario.evaluation.expansionExpectedFiles,
      });
      const optimizationMode = taskAnalysis.mode;
      const optimizationModeMatched =
        scenario.evaluation.expectedOptimizationMode === undefined ||
        scenario.evaluation.expectedOptimizationMode === optimizationMode;

      if (scenario.baseline.enabled) {
        cases.push(
          await runBenchmarkCase({
            scenario,
            workspaceIndex,
            mode: "baseline",
            agent,
            packageVersion,
            generatedAt,
            optimizationMode,
            optimizationModeMatched: true,
            ...(store ? { store } : {}),
          }),
        );
      }

      cases.push(
        await runBenchmarkCase({
          scenario: {
            ...scenario,
            optimized: {
              contextPack,
            },
          },
          workspaceIndex,
          mode: "optimized",
          contextPack,
          agent,
          packageVersion,
          generatedAt,
          optimizationMode,
          optimizationModeMatched,
          expansion,
          ...(store ? { store } : {}),
        }),
      );
    }
  } finally {
    await store?.close();
  }

  return {
    metadata: {
      generatedAt,
      packageVersion,
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      scenarioCount: scenarios.length,
      reproducibility: [
        "Scenarios are local fixture repositories.",
        "The default benchmark agent is deterministic and does not call external models.",
        "Token counts use the core approximate token estimator.",
      ],
    },
    cases,
    totals: summarizeCases(cases),
  };
}

export async function loadBenchmarkScenarios(
  options: Pick<BenchmarkRunnerOptions, "scenariosRoot" | "scenarioIds">,
): Promise<BenchmarkScenario[]> {
  const scenarioIds = options.scenarioIds;
  const scenarioFiles =
    scenarioIds && scenarioIds.length > 0
      ? scenarioIds.map((scenarioId) => `${scenarioId}.yaml`)
      : (await readdir(options.scenariosRoot, { withFileTypes: true }))
          .filter(
            (entry) =>
              entry.isFile() &&
              (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")),
          )
          .map((entry) => entry.name)
          .sort((left, right) => left.localeCompare(right));
  const scenarios = await Promise.all(
    scenarioFiles.map(async (scenarioFile) => {
      const scenarioPath = path.join(options.scenariosRoot, scenarioFile);
      const rawScenario = JSON.parse(await readFile(scenarioPath, "utf8")) as unknown;
      return BenchmarkScenarioSchema.parse(rawScenario);
    }),
  );

  return scenarios.sort((left, right) => left.id.localeCompare(right.id));
}

async function runBenchmarkCase(input: {
  readonly scenario: BenchmarkScenario;
  readonly workspaceIndex: WorkspaceIndex;
  readonly mode: "baseline" | "optimized";
  readonly contextPack?: ContextPack;
  readonly agent: BenchmarkAgent;
  readonly packageVersion: string;
  readonly generatedAt: string;
  readonly optimizationMode: OptimizationMode;
  readonly optimizationModeMatched: boolean;
  readonly expansion?: BenchmarkRetrievalMetrics["expansion"];
  readonly store?: AgentTokenStore;
}): Promise<BenchmarkCaseResult> {
  const startedAt = performance.now();
  const agentResult = await input.agent.run({
    scenario: input.scenario,
    workspaceIndex: input.workspaceIndex,
    mode: input.mode,
    ...(input.contextPack ? { contextPack: input.contextPack } : {}),
  });
  const durationMs = Math.round(performance.now() - startedAt);
  const tokenEstimate: TokenEstimate = {
    inputTokens: agentResult.inputTokens,
    outputTokens: agentResult.outputTokens,
    totalTokens: agentResult.inputTokens + agentResult.outputTokens,
    method: "approximate",
    confidence: "medium",
  };
  const budget = input.contextPack ? createBudgetMetrics(input.contextPack) : undefined;
  const result: BenchmarkCaseResult = {
    scenarioId: input.scenario.id,
    mode: input.mode,
    success: agentResult.success && input.optimizationModeMatched,
    durationMs,
    tokenEstimate,
    touchedFiles: agentResult.touchedFiles,
    expectedFiles: input.scenario.validation.expectedFiles,
    responseTokens: agentResult.outputTokens,
    retrieval: createRetrievalMetrics(
      input.scenario.validation.expectedFiles,
      input.mode === "optimized" && input.contextPack
        ? input.contextPack.selected.map((candidate) => candidate.path)
        : agentResult.touchedFiles,
      input.expansion,
    ),
    ...(budget ? { budget } : {}),
    optimizationMode: input.optimizationMode,
    optimizationModeMatched: input.optimizationModeMatched,
    notes: agentResult.notes,
  };

  await input.store?.set(
    STORE_KINDS.runMetric,
    `benchmark:${input.scenario.id}:${input.mode}`,
    createRunMetric({
      scenario: input.scenario,
      mode: input.mode,
      tokenEstimate,
      success: agentResult.success,
      durationMs,
      packageVersion: input.packageVersion,
      generatedAt: input.generatedAt,
    }),
  );

  return result;
}

function createRetrievalMetrics(
  expectedFiles: readonly string[],
  retrievedPaths: readonly string[],
  expansion: BenchmarkRetrievalMetrics["expansion"] | undefined,
): BenchmarkRetrievalMetrics {
  const retrievedExpectedFiles = expectedFiles.filter((expectedFile) =>
    retrievedPaths.includes(expectedFile),
  );

  return {
    expectedFiles,
    retrievedExpectedFiles,
    recall:
      expectedFiles.length === 0
        ? 1
        : Number((retrievedExpectedFiles.length / expectedFiles.length).toFixed(4)),
    expansion: expansion ?? {
      fallbackCandidateCount: 0,
      pageCount: 0,
      expandedCandidateCount: 0,
      expandedExpectedFiles: [],
    },
  };
}

function createBudgetMetrics(
  contextPack: ContextPack,
): BenchmarkBudgetMetrics | undefined {
  const budget = contextPack.budget;

  if (!budget) {
    return undefined;
  }

  return {
    response: {
      limitTokens: budget.response.limitTokens,
      usedTokens: budget.response.usedTokens,
      adhered: budget.response.usedTokens <= budget.response.limitTokens,
    },
    recommendedContent: {
      limitTokens: budget.recommendedContent.limitTokens,
      usedTokens: budget.recommendedContent.usedTokens,
      adhered:
        budget.recommendedContent.usedTokens <= budget.recommendedContent.limitTokens,
    },
  };
}

function measureExpansion(input: {
  readonly contextPack: ContextPack;
  readonly rankedContext: RankedContext;
  readonly workspaceIndex: WorkspaceIndex;
  readonly expectedFiles: readonly string[];
}): BenchmarkRetrievalMetrics["expansion"] {
  const cursor = input.contextPack.expansion?.nextCursor;

  if (!cursor) {
    return {
      fallbackCandidateCount: input.contextPack.excluded.length,
      pageCount: 0,
      expandedCandidateCount: 0,
      expandedExpectedFiles: [],
    };
  }

  const evidence = createContextRankingEvidence({
    contextPack: input.contextPack,
    rankedContext: input.rankedContext,
    workspaceIndex: input.workspaceIndex,
  });
  const expandedPaths: string[] = [];
  let nextCursor: string | undefined = cursor;
  let pageCount = 0;

  while (nextCursor) {
    const page = expandContextRanking({
      evidence,
      cursor: nextCursor,
      limit: 10,
    });
    pageCount += 1;
    expandedPaths.push(...page.candidates.map((candidate) => candidate.path));
    nextCursor = page.nextCursor;
  }

  return {
    fallbackCandidateCount: input.contextPack.excluded.length,
    pageCount,
    expandedCandidateCount: expandedPaths.length,
    expandedExpectedFiles: input.expectedFiles.filter((expectedFile) =>
      [
        ...input.contextPack.excluded.map((candidate) => candidate.path),
        ...expandedPaths,
      ].includes(expectedFile),
    ),
  };
}

function createRunMetric(input: {
  readonly scenario: BenchmarkScenario;
  readonly mode: "baseline" | "optimized";
  readonly tokenEstimate: TokenEstimate;
  readonly success: boolean;
  readonly durationMs: number;
  readonly packageVersion: string;
  readonly generatedAt: string;
}): RunMetric {
  return {
    metadata: {
      contractVersion: "1.0",
      generatedAt: input.generatedAt,
      generator: {
        name: "agent-token-optimizer",
        version: input.packageVersion,
      },
      operationId: `benchmark:${input.scenario.id}:${input.mode}`,
    },
    host: "unknown",
    taskId: input.scenario.id,
    startedAt: input.generatedAt,
    completedAt: input.generatedAt,
    durationMs: input.durationMs,
    outcome: input.success ? "succeeded" : "failed",
    tokenEstimate: input.tokenEstimate,
    validation: {
      passed: input.success,
      details: `${input.mode} benchmark validation for ${input.scenario.id}.`,
    },
    warnings: [],
  };
}

function summarizeCases(cases: readonly BenchmarkCaseResult[]) {
  const baselineCases = cases.filter(
    (benchmarkCase) => benchmarkCase.mode === "baseline",
  );
  const optimizedCases = cases.filter(
    (benchmarkCase) => benchmarkCase.mode === "optimized",
  );
  const baselineTokens = sumTokens(baselineCases);
  const optimizedTokens = sumTokens(optimizedCases);
  const tokenSavings = Math.max(0, baselineTokens - optimizedTokens);
  const tokenSavingsPercent =
    baselineTokens > 0 ? Number(((tokenSavings / baselineTokens) * 100).toFixed(2)) : 0;
  const baselineSuccesses = baselineCases.filter(
    (benchmarkCase) => benchmarkCase.success,
  ).length;
  const optimizedSuccesses = optimizedCases.filter(
    (benchmarkCase) => benchmarkCase.success,
  ).length;
  const baselineSuccessRate =
    baselineCases.length > 0 ? baselineSuccesses / baselineCases.length : 0;
  const optimizedSuccessRate =
    optimizedCases.length > 0 ? optimizedSuccesses / optimizedCases.length : 0;

  return {
    baselineTokens,
    optimizedTokens,
    tokenSavings,
    tokenSavingsPercent,
    baselineSuccesses,
    optimizedSuccesses,
    successRateDelta: Number((optimizedSuccessRate - baselineSuccessRate).toFixed(4)),
  };
}

function sumTokens(cases: readonly BenchmarkCaseResult[]): number {
  return cases.reduce(
    (total, benchmarkCase) => total + benchmarkCase.tokenEstimate.totalTokens,
    0,
  );
}

function estimateWorkspaceTokens(workspaceIndex: WorkspaceIndex): number {
  const rawWorkspaceTokens = workspaceIndex.files
    .filter((file) => !file.ignored && file.kind !== "binary")
    .reduce(
      (total, file) => total + estimateTextTokens(file.path) + file.sizeBytes / 4,
      0,
    );

  return Math.ceil(rawWorkspaceTokens * 2);
}

function estimateConsumedContextPackTokens(contextPack: ContextPack): number {
  const selectedTokens = contextPack.selected.reduce(
    (total, candidate) =>
      total +
      estimateTextTokens(candidate.path) +
      estimateTextTokens(candidate.reason) +
      (candidate.estimatedTokens ?? 0),
    0,
  );
  const summaryTokens = contextPack.summaries.reduce(
    (total, summary) =>
      total +
      estimateTextTokens(
        [
          summary.summary,
          ...summary.symbols,
          ...summary.declarations,
          ...summary.imports,
          ...summary.testNames,
          ...(summary.snippet ? [summary.snippet] : []),
        ].join("\n"),
      ),
    0,
  );

  return selectedTokens + summaryTokens;
}

export async function ensureBenchmarkDirectories(input: {
  readonly scenariosRoot: string;
  readonly fixturesRoot: string;
}): Promise<void> {
  await Promise.all([
    mkdir(input.scenariosRoot, { recursive: true }),
    mkdir(input.fixturesRoot, { recursive: true }),
  ]);
}
