#!/usr/bin/env node

import path from "node:path";

import { runLiveBenchmarks } from "./live.js";
import { generateLiveBenchmarkReports } from "./live-report.js";

if (process.env.AGENT_TOKEN_OPTIMIZER_LIVE_BENCHMARK !== "1") {
  throw new Error(
    "Live benchmarks can call Codex and edit disposable fixture copies. Set AGENT_TOKEN_OPTIMIZER_LIVE_BENCHMARK=1 to continue.",
  );
}

const model = process.env.AGENT_TOKEN_OPTIMIZER_BENCHMARK_MODEL;
const pricing = parsePricing(process.env);

if (!model) {
  throw new Error(
    "Set AGENT_TOKEN_OPTIMIZER_BENCHMARK_MODEL to the exact Codex model to benchmark.",
  );
}

const result = await runLiveBenchmarks({
  scenariosRoot: path.resolve("benchmarks", "scenarios"),
  fixturesRoot: path.resolve("benchmarks", "fixtures"),
  optimizerCommand: [
    process.execPath,
    path.resolve("packages", "cli", "dist", "index.js"),
    "mcp",
  ],
  validationCommandEnvironment: {
    AGENT_TOKEN_OPTIMIZER_BENCHMARK_VALIDATOR: path.resolve(
      "packages",
      "benchmarks",
      "dist",
      "validate-live-scenario.js",
    ),
  },
  hostVersion: process.env.AGENT_TOKEN_OPTIMIZER_BENCHMARK_HOST_VERSION ?? "unknown",
  settings: {
    model,
    reasoningEffort: parseReasoningEffort(
      process.env.AGENT_TOKEN_OPTIMIZER_BENCHMARK_REASONING,
    ),
    sandbox: "workspace-write",
    ...(process.env.AGENT_TOKEN_OPTIMIZER_BENCHMARK_TIMEOUT_MS
      ? { timeLimitMs: Number(process.env.AGENT_TOKEN_OPTIMIZER_BENCHMARK_TIMEOUT_MS) }
      : {}),
  },
  ...(process.env.AGENT_TOKEN_OPTIMIZER_BENCHMARK_REPETITIONS
    ? { repetitions: Number(process.env.AGENT_TOKEN_OPTIMIZER_BENCHMARK_REPETITIONS) }
    : {}),
  ...(process.env.AGENT_TOKEN_OPTIMIZER_BENCHMARK_ORDER_SEED
    ? { orderSeed: Number(process.env.AGENT_TOKEN_OPTIMIZER_BENCHMARK_ORDER_SEED) }
    : {}),
  retainWorkspaces: process.env.AGENT_TOKEN_OPTIMIZER_BENCHMARK_RETAIN_WORKSPACES === "1",
});
const artifacts = await generateLiveBenchmarkReports({
  outputDir: path.resolve(
    process.env.AGENT_TOKEN_OPTIMIZER_LIVE_BENCHMARK_OUTPUT ??
      path.join("artifacts", "benchmarks", "live"),
  ),
  result,
  ...(pricing ? { pricing } : {}),
});

console.log(
  JSON.stringify(
    {
      artifacts: {
        htmlPath: artifacts.htmlPath,
        jsonPath: artifacts.jsonPath,
        markdownPath: artifacts.markdownPath,
      },
      metadata: result.metadata,
      successfulCases: result.cases.filter((benchmarkCase) => benchmarkCase.success)
        .length,
      totalCases: result.cases.length,
    },
    null,
    2,
  ),
);

function parseReasoningEffort(
  value: string | undefined,
): "low" | "medium" | "high" | "xhigh" {
  switch (value ?? "medium") {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      throw new Error(
        "AGENT_TOKEN_OPTIMIZER_BENCHMARK_REASONING must be low, medium, high, or xhigh.",
      );
  }
}

function parsePricing(environment: NodeJS.ProcessEnv):
  | {
      readonly inputCostPerMillionTokens: number;
      readonly cachedInputCostPerMillionTokens: number;
      readonly outputCostPerMillionTokens: number;
      readonly currency: "USD";
    }
  | undefined {
  const values = [
    environment.AGENT_TOKEN_OPTIMIZER_BENCHMARK_INPUT_COST_PER_MILLION,
    environment.AGENT_TOKEN_OPTIMIZER_BENCHMARK_CACHED_INPUT_COST_PER_MILLION,
    environment.AGENT_TOKEN_OPTIMIZER_BENCHMARK_OUTPUT_COST_PER_MILLION,
  ];

  if (values.every((value) => value === undefined)) {
    return undefined;
  }

  if (values.some((value) => value === undefined)) {
    throw new Error(
      "Set input, cached-input, and output cost-per-million environment variables together.",
    );
  }

  const input = Number(values[0] ?? Number.NaN);
  const cachedInput = Number(values[1] ?? Number.NaN);
  const output = Number(values[2] ?? Number.NaN);

  if (
    [input, cachedInput, output].some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new Error("Live benchmark pricing values must be nonnegative numbers.");
  }

  return {
    inputCostPerMillionTokens: input,
    cachedInputCostPerMillionTokens: cachedInput,
    outputCostPerMillionTokens: output,
    currency: "USD",
  };
}
