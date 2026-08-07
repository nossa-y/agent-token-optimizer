import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  renderBenchmarkReportHtml,
  summarizeBenchmarkReport,
  type BenchmarkReportPricing,
} from "@agent-relay/agent-token-optimization-report-ui";

import {
  runBenchmarks,
  type BenchmarkRunResult,
  type BenchmarkRunnerOptions,
} from "./runner";

export interface BenchmarkReportOptions {
  readonly outputDir: string;
  readonly result?: BenchmarkRunResult;
  readonly runner?: BenchmarkRunnerOptions;
  readonly title?: string;
  readonly pricing?: BenchmarkReportPricing;
}

export interface BenchmarkReportArtifacts {
  readonly htmlPath: string;
  readonly markdownPath: string;
  readonly jsonPath: string;
  readonly result: BenchmarkRunResult;
}

export async function generateBenchmarkReports(
  options: BenchmarkReportOptions,
): Promise<BenchmarkReportArtifacts> {
  const result = options.result ?? (await runRequiredBenchmarks(options.runner));
  const htmlPath = path.join(options.outputDir, "index.html");
  const markdownPath = path.join(options.outputDir, "benchmark-report.md");
  const jsonPath = path.join(options.outputDir, "benchmark-result.json");

  await mkdir(options.outputDir, { recursive: true });
  await Promise.all([
    writeFile(
      htmlPath,
      renderBenchmarkReportHtml(result, {
        rawDataHref: path.basename(jsonPath),
        ...(options.title ? { title: options.title } : {}),
        ...(options.pricing ? { pricing: options.pricing } : {}),
      }),
      "utf8",
    ),
    writeFile(markdownPath, renderBenchmarkReportMarkdown(result, options), "utf8"),
    writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8"),
  ]);

  return {
    htmlPath,
    markdownPath,
    jsonPath,
    result,
  };
}

export function renderBenchmarkReportMarkdown(
  result: BenchmarkRunResult,
  options: Pick<BenchmarkReportOptions, "pricing" | "title"> = {},
): string {
  const title = options.title ?? "Agent Token Optimizer Benchmark Report";
  const summary = summarizeBenchmarkReport(
    result,
    options.pricing ?? {
      inputCostPerMillionTokens: 1,
      outputCostPerMillionTokens: 3,
      currency: "USD",
    },
  );
  const rows = result.cases
    .map(
      (item) =>
        `| ${escapeMarkdown(item.scenarioId)} | ${item.mode} | ${
          item.success ? "passed" : "failed"
        } | ${item.tokenEstimate.totalTokens} | ${item.durationMs}ms | ${escapeMarkdown(
          item.touchedFiles.join(", ") || "None",
        )} |`,
    )
    .join("\n");

  return `# ${escapeMarkdown(title)}

Generated: ${result.metadata.generatedAt}

## Summary

| Metric | Value |
| --- | ---: |
| Baseline tokens | ${result.totals.baselineTokens} |
| Optimized tokens | ${result.totals.optimizedTokens} |
| Token savings | ${result.totals.tokenSavings} (${result.totals.tokenSavingsPercent}%) |
| Baseline successes | ${result.totals.baselineSuccesses} |
| Optimized successes | ${result.totals.optimizedSuccesses} |
| Estimated baseline cost | ${formatCurrency(summary.baselineCost)} |
| Estimated optimized cost | ${formatCurrency(summary.optimizedCost)} |
| Estimated cost savings | ${formatCurrency(summary.costSavings)} |
| Baseline cost per success | ${formatNullableCurrency(summary.baselineCostPerSuccess)} |
| Optimized cost per success | ${formatNullableCurrency(summary.optimizedCostPerSuccess)} |
| Average baseline latency | ${Math.round(summary.averageBaselineDurationMs)}ms |
| Average optimized latency | ${Math.round(summary.averageOptimizedDurationMs)}ms |

## Scenario Results

| Scenario | Mode | Validation | Tokens | Latency | Files |
| --- | --- | --- | ---: | ---: | --- |
${rows}

## Methodology

Benchmarks run against local fixture repositories with a deterministic mock agent. The
baseline case sees every indexed non-binary file. The optimized case sees the generated
context pack. A lower token count only counts as an improvement when validation still
passes.

Cost values use configurable illustrative token pricing for relative comparison. They are
not provider billing statements.

## Reproducibility

${result.metadata.reproducibility.map((item) => `- ${escapeMarkdown(item)}`).join("\n")}
`;
}

async function runRequiredBenchmarks(
  runnerOptions: BenchmarkRunnerOptions | undefined,
): Promise<BenchmarkRunResult> {
  if (!runnerOptions) {
    throw new Error("runner options are required when no benchmark result is provided");
  }

  return runBenchmarks(runnerOptions);
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: value < 0.01 ? 4 : 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function formatNullableCurrency(value: number | null): string {
  return value === null ? "n/a" : formatCurrency(value);
}
