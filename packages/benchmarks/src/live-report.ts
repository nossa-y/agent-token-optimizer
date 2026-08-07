import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  renderLiveBenchmarkReportHtml,
  summarizeLiveBenchmarkReport,
  type LiveBenchmarkReport,
  type LiveBenchmarkReportPricing,
} from "@agent-relay/agent-token-optimization-report-ui";

import type { LiveBenchmarkRunResult } from "./live";

export interface LiveBenchmarkReportOptions {
  readonly outputDir: string;
  readonly result: LiveBenchmarkRunResult;
  readonly title?: string;
  readonly pricing?: LiveBenchmarkReportPricing;
}

export interface LiveBenchmarkReportArtifacts {
  readonly htmlPath: string;
  readonly markdownPath: string;
  readonly jsonPath: string;
  readonly report: LiveBenchmarkReport;
}

export async function generateLiveBenchmarkReports(
  options: LiveBenchmarkReportOptions,
): Promise<LiveBenchmarkReportArtifacts> {
  const report = createLiveBenchmarkReport(options.result);
  const htmlPath = path.join(options.outputDir, "index.html");
  const markdownPath = path.join(options.outputDir, "live-benchmark-report.md");
  const jsonPath = path.join(options.outputDir, "live-benchmark-result.json");

  await mkdir(options.outputDir, { recursive: true });
  await Promise.all([
    writeFile(
      htmlPath,
      renderLiveBenchmarkReportHtml(report, {
        rawDataHref: path.basename(jsonPath),
        ...(options.title ? { title: options.title } : {}),
        ...(options.pricing ? { pricing: options.pricing } : {}),
      }),
      "utf8",
    ),
    writeFile(
      markdownPath,
      renderLiveBenchmarkReportMarkdown(report, options.pricing),
      "utf8",
    ),
    writeFile(jsonPath, `${JSON.stringify(options.result, null, 2)}\n`, "utf8"),
  ]);

  return { htmlPath, markdownPath, jsonPath, report };
}

export function createLiveBenchmarkReport(
  result: LiveBenchmarkRunResult,
): LiveBenchmarkReport {
  return {
    metadata: result.metadata,
    cases: result.cases.map((benchmarkCase) => ({
      scenarioId: benchmarkCase.scenarioId,
      repetition: benchmarkCase.repetition,
      mode: benchmarkCase.mode,
      order: benchmarkCase.order,
      success: benchmarkCase.success,
      durationMs: benchmarkCase.durationMs,
      ...(benchmarkCase.providerUsage
        ? { providerUsage: benchmarkCase.providerUsage }
        : {}),
      optimizer: summarizeOptimizerLedgers(benchmarkCase.optimizerLedgers),
      ...(benchmarkCase.optimizerEvidence
        ? { optimizerEvidence: benchmarkCase.optimizerEvidence }
        : {}),
      ...(benchmarkCase.warmCache ? { warmCache: benchmarkCase.warmCache } : {}),
      validation: benchmarkCase.validation,
      diagnostics: benchmarkCase.diagnostics,
    })),
  };
}

export function renderLiveBenchmarkReportMarkdown(
  report: LiveBenchmarkReport,
  pricing: LiveBenchmarkReportPricing | undefined = undefined,
): string {
  const summary = summarizeLiveBenchmarkReport(report, pricing);
  const pricingLabel = pricing
    ? `${pricing.inputCostPerMillionTokens} / ${pricing.cachedInputCostPerMillionTokens} / ${pricing.outputCostPerMillionTokens} USD per million tokens`
    : "illustrative defaults (1 / 0.25 / 3 USD per million tokens)";
  const rows = report.cases.map((benchmarkCase) =>
    [
      "|",
      escapeMarkdown(benchmarkCase.scenarioId),
      "|",
      benchmarkCase.repetition,
      "|",
      benchmarkCase.mode,
      "|",
      benchmarkCase.success ? "passed" : "failed",
      "|",
      benchmarkCase.providerUsage?.totalTokens ?? "missing",
      "|",
      `${benchmarkCase.durationMs}ms`,
      "|",
      benchmarkCase.optimizer.overheadTokens,
      "|",
      benchmarkCase.optimizer.expansionCount,
      "|",
      benchmarkCase.optimizer.retryCount,
      "|",
      benchmarkCase.optimizerEvidence?.responseBudgetAdhered === undefined
        ? "n/a"
        : benchmarkCase.optimizerEvidence.responseBudgetAdhered
          ? "passed"
          : "failed",
      "|",
      benchmarkCase.warmCache?.unchangedWorkReused === undefined
        ? "n/a"
        : benchmarkCase.warmCache.unchangedWorkReused
          ? "passed"
          : "failed",
      "|",
    ].join(" "),
  );

  return [
    "# Agent Token Optimizer Live Benchmark Report",
    "",
    `Generated: ${report.metadata.generatedAt}`,
    "",
    "## Run Metadata",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Host | ${escapeMarkdown(report.metadata.host)} |`,
    `| Host version | ${escapeMarkdown(report.metadata.hostVersion)} |`,
    `| Model | ${escapeMarkdown(report.metadata.model)} |`,
    `| Reasoning effort | ${escapeMarkdown(report.metadata.reasoningEffort)} |`,
    `| Sandbox | ${escapeMarkdown(report.metadata.sandbox)} |`,
    `| Package version | ${escapeMarkdown(report.metadata.packageVersion)} |`,
    `| Node / platform | ${escapeMarkdown(report.metadata.nodeVersion)} / ${escapeMarkdown(report.metadata.platform)} |`,
    `| Repetitions / order seed | ${report.metadata.repetitions} / ${report.metadata.orderSeed} |`,
    `| Scenario count | ${report.metadata.scenarioCount} |`,
    `| Input / cached-input / output pricing | ${pricingLabel} |`,
    "",
    "## Summary",
    "",
    "| Metric | Baseline | Optimized |",
    "| --- | ---: | ---: |",
    `| Success rate | ${formatPercent(summary.baseline.successRate)} | ${formatPercent(summary.optimized.successRate)} |`,
    `| Provider usage coverage | ${formatPercent(summary.baseline.providerUsageCoverage)} | ${formatPercent(summary.optimized.providerUsageCoverage)} |`,
    `| Total token median | ${formatNullable(summary.baseline.totalTokens.median)} | ${formatNullable(summary.optimized.totalTokens.median)} |`,
    `| Total token p25 / p75 | ${formatDistribution(summary.baseline.totalTokens)} | ${formatDistribution(summary.optimized.totalTokens)} |`,
    `| Input tokens | ${summary.baseline.inputTokens} | ${summary.optimized.inputTokens} |`,
    `| Cached-input tokens | ${summary.baseline.cachedInputTokens} | ${summary.optimized.cachedInputTokens} |`,
    `| Output tokens | ${summary.baseline.outputTokens} | ${summary.optimized.outputTokens} |`,
    `| Cost per successful task | ${formatNullableCurrency(summary.baseline.costPerSuccess)} | ${formatNullableCurrency(summary.optimized.costPerSuccess)} |`,
    `| Latency median | ${formatNullable(summary.baseline.latency.median)}ms | ${formatNullable(summary.optimized.latency.median)}ms |`,
    "",
    `Paired success delta: ${formatPercent(summary.paired.successRateDelta)} across ${summary.paired.comparedPairs} comparable pairs (${summary.paired.improved} improved, ${summary.paired.regressed} regressed, ${summary.paired.tied} tied).`,
    "",
    `Optimizer overhead: ${summary.optimizer.overheadTokens} tokens, ${summary.optimizer.expansionCount} expansions, ${summary.optimizer.retryCount} retries, and ${summary.optimizer.unknownEntryCount} unknown ledger entries.`,
    `Optimizer evidence: ${summary.optimizer.hookCallCount} user-prompt hook calls; maximum injected response ${formatNullable(summary.optimizer.maxHookResponseTokens)} tokens; response budget and skip behavior ${summary.optimizer.responseBudgetAdhered ? "passed" : "failed"}; warm-cache reuse ${summary.optimizer.warmCacheReusedCases}/${summary.optimizer.warmCacheEvidenceCases} optimized cases.`,
    "",
    "## Release Gates",
    "",
    `Overall: ${summary.gates.releasePassed ? "PASSED" : "FAILED"}.`,
    "",
    "| Gate | Result |",
    "| --- | --- |",
    `| Complete provider usage | ${gateLabel(summary.gates.providerUsageComplete)} |`,
    `| Every paired case successful | ${gateLabel(summary.gates.allCasesSuccessful)} |`,
    `| Median successful-task token reduction >= 15% | ${gateLabel(summary.gates.medianTokenReductionPassed)} (${formatNullablePercent(summary.gates.medianTokenReductionRate)}) |`,
    `| Lower cost per successful task | ${gateLabel(summary.gates.costPerSuccessLower)} |`,
    `| No paired token regression over 10% | ${gateLabel(summary.gates.noTokenRegressionsOverTenPercent)} (${summary.gates.tokenRegressionCount} regressions) |`,
    `| Hook activation and 1,200-token response budget | ${gateLabel(summary.gates.hookBudgetPassed)} |`,
    `| Persisted warm-cache reuse | ${gateLabel(summary.gates.warmCacheReusePassed)} |`,
    "",
    "## Case Results",
    "",
    "| Scenario | Rep. | Mode | Result | Total tokens | Latency | Overhead | Expansions | Retries | Hook budget | Warm cache |",
    "| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ...rows,
    "",
    "## Methodology",
    "",
    "Provider-reported usage is the source of truth. Baseline and optimized runs use separate fixture copies and fixed host, model, reasoning, sandbox, task, and time-limit settings. Optimized cases install the built candidate user-prompt hook into an isolated host home. A baseline task counts as successful only when the host exits successfully, reports provider usage, and passes behavioral validation. Every optimized task must also record hook activation; non-trivial tasks must inject a positive response within 1,200 tokens, while trivial tasks must record zero response tokens. Host stdout and stderr are omitted from artifacts; the companion JSON retains only safe diagnostics and redaction counts.",
    "",
  ].join("\n");
}

function summarizeOptimizerLedgers(
  ledgers: LiveBenchmarkRunResult["cases"][number]["optimizerLedgers"],
) {
  const entries = ledgers.flatMap((ledger) => ledger.entries);
  const knownCalls = entries.filter(
    (
      entry,
    ): entry is Extract<
      (typeof entries)[number],
      { readonly kind: "optimizer_call"; readonly status: "known" }
    > => entry.kind === "optimizer_call" && entry.status === "known",
  );
  const hookCalls = knownCalls.filter(
    (entry) => entry.toolName === "user_prompt_hook",
  ).length;

  return {
    overheadTokens: knownCalls.reduce(
      (total, entry) => total + entry.overhead.totalTokens,
      0,
    ),
    expansionCount: knownCalls.filter((entry) => entry.toolName === "expand_context")
      .length,
    retryCount: Math.max(0, hookCalls - 1),
    unknownEntryCount: entries.filter((entry) => entry.status === "unknown").length,
  };
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed((value * 100) % 1 === 0 ? 0 : 2)}%`;
}

function formatNullablePercent(value: number | null): string {
  return value === null ? "n/a" : formatPercent(value);
}

function gateLabel(passed: boolean): string {
  return passed ? "passed" : "failed";
}

function formatNullable(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function formatDistribution(value: {
  readonly p25: number | null;
  readonly p75: number | null;
}): string {
  return value.p25 === null || value.p75 === null ? "n/a" : `${value.p25} / ${value.p75}`;
}

function formatNullableCurrency(value: number | null): string {
  return value === null
    ? "n/a"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(value);
}
