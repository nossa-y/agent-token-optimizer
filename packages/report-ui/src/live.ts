export type LiveBenchmarkMode = "baseline" | "optimized";

export interface LiveBenchmarkReportUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface LiveBenchmarkReportCase {
  readonly scenarioId: string;
  readonly repetition: number;
  readonly mode: LiveBenchmarkMode;
  readonly order: number;
  readonly success: boolean;
  readonly durationMs: number;
  readonly providerUsage?: LiveBenchmarkReportUsage;
  readonly optimizer: {
    readonly overheadTokens: number;
    readonly expansionCount: number;
    readonly retryCount: number;
    readonly unknownEntryCount: number;
  };
  readonly optimizerEvidence?: {
    readonly hookCallCount: number;
    readonly maxHookResponseTokens: number | null;
    readonly responseBudgetTokens: number;
    readonly responseBudgetRequired: boolean;
    readonly responseBudgetAdhered: boolean;
  };
  readonly warmCache?: {
    readonly persistedCacheReloaded: boolean;
    readonly coldChangedFiles: number;
    readonly warmReusedFiles: number;
    readonly warmChangedFiles: number;
    readonly warmDeletedFiles: number;
    readonly unchangedWorkReused: boolean;
  };
  readonly validation: {
    readonly passed: boolean;
    readonly changedFiles: readonly string[];
    readonly details: readonly string[];
  };
  readonly diagnostics: readonly string[];
}

export interface LiveBenchmarkReport {
  readonly metadata: {
    readonly generatedAt: string;
    readonly packageVersion: string;
    readonly nodeVersion: string;
    readonly platform: string;
    readonly host: string;
    readonly hostVersion: string;
    readonly model: string;
    readonly reasoningEffort: string;
    readonly sandbox: string;
    readonly timeLimitMs: number;
    readonly repetitions: number;
    readonly orderSeed: number;
    readonly scenarioCount: number;
  };
  readonly cases: readonly LiveBenchmarkReportCase[];
}

export interface LiveBenchmarkReportPricing {
  readonly inputCostPerMillionTokens: number;
  readonly cachedInputCostPerMillionTokens: number;
  readonly outputCostPerMillionTokens: number;
  readonly currency: "USD";
}

export interface LiveBenchmarkDistribution {
  readonly count: number;
  readonly minimum: number | null;
  readonly p25: number | null;
  readonly median: number | null;
  readonly p75: number | null;
  readonly maximum: number | null;
}

export interface LiveBenchmarkModeSummary {
  readonly caseCount: number;
  readonly successes: number;
  readonly successRate: number;
  readonly providerUsageCoverage: number;
  readonly totalTokens: LiveBenchmarkDistribution;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly latency: LiveBenchmarkDistribution;
  readonly cost: number;
  readonly costPerSuccess: number | null;
}

export interface LiveBenchmarkReportSummary {
  readonly baseline: LiveBenchmarkModeSummary;
  readonly optimized: LiveBenchmarkModeSummary;
  readonly paired: {
    readonly comparedPairs: number;
    readonly improved: number;
    readonly regressed: number;
    readonly tied: number;
    readonly successRateDelta: number;
  };
  readonly optimizer: {
    readonly overheadTokens: number;
    readonly expansionCount: number;
    readonly retryCount: number;
    readonly unknownEntryCount: number;
    readonly hookCallCount: number;
    readonly maxHookResponseTokens: number | null;
    readonly responseBudgetAdhered: boolean;
    readonly warmCacheEvidenceCases: number;
    readonly warmCacheReusedCases: number;
  };
  readonly gates: {
    readonly providerUsageComplete: boolean;
    readonly allCasesSuccessful: boolean;
    readonly medianTokenReductionRate: number | null;
    readonly medianTokenReductionPassed: boolean;
    readonly costPerSuccessLower: boolean;
    readonly tokenRegressionCount: number;
    readonly noTokenRegressionsOverTenPercent: boolean;
    readonly hookBudgetPassed: boolean;
    readonly warmCacheReusePassed: boolean;
    readonly releasePassed: boolean;
  };
}

const DEFAULT_PRICING: LiveBenchmarkReportPricing = {
  inputCostPerMillionTokens: 1,
  cachedInputCostPerMillionTokens: 0.25,
  outputCostPerMillionTokens: 3,
  currency: "USD",
};

export function summarizeLiveBenchmarkReport(
  result: LiveBenchmarkReport,
  pricing: LiveBenchmarkReportPricing = DEFAULT_PRICING,
): LiveBenchmarkReportSummary {
  const baselineCases = result.cases.filter(
    (benchmarkCase) => benchmarkCase.mode === "baseline",
  );
  const optimizedCases = result.cases.filter(
    (benchmarkCase) => benchmarkCase.mode === "optimized",
  );

  const baseline = summarizeMode(baselineCases, pricing);
  const optimized = summarizeMode(optimizedCases, pricing);
  const paired = summarizePairs(result.cases);
  const optimizer = {
    overheadTokens: sum(
      optimizedCases.map((benchmarkCase) => benchmarkCase.optimizer.overheadTokens),
    ),
    expansionCount: sum(
      optimizedCases.map((benchmarkCase) => benchmarkCase.optimizer.expansionCount),
    ),
    retryCount: sum(
      optimizedCases.map((benchmarkCase) => benchmarkCase.optimizer.retryCount),
    ),
    unknownEntryCount: sum(
      optimizedCases.map((benchmarkCase) => benchmarkCase.optimizer.unknownEntryCount),
    ),
    hookCallCount: sum(
      optimizedCases.map(
        (benchmarkCase) => benchmarkCase.optimizerEvidence?.hookCallCount ?? 0,
      ),
    ),
    maxHookResponseTokens: maximum(
      optimizedCases.flatMap((benchmarkCase) =>
        benchmarkCase.optimizerEvidence?.maxHookResponseTokens === null ||
        benchmarkCase.optimizerEvidence?.maxHookResponseTokens === undefined
          ? []
          : [benchmarkCase.optimizerEvidence.maxHookResponseTokens],
      ),
    ),
    responseBudgetAdhered:
      optimizedCases.length > 0 &&
      optimizedCases.every(
        (benchmarkCase) =>
          benchmarkCase.optimizerEvidence?.responseBudgetAdhered === true,
      ),
    warmCacheEvidenceCases: optimizedCases.filter(
      (benchmarkCase) => benchmarkCase.warmCache !== undefined,
    ).length,
    warmCacheReusedCases: optimizedCases.filter(
      (benchmarkCase) => benchmarkCase.warmCache?.unchangedWorkReused === true,
    ).length,
  };
  const gates = summarizeReleaseGates({
    cases: result.cases,
    baseline,
    optimized,
    optimizer,
  });

  return {
    baseline,
    optimized,
    paired,
    optimizer,
    gates,
  };
}

export function renderLiveBenchmarkReportHtml(
  result: LiveBenchmarkReport,
  options: {
    readonly title?: string;
    readonly rawDataHref?: string;
    readonly pricing?: LiveBenchmarkReportPricing;
  } = {},
): string {
  const title = options.title ?? "Agent Token Optimizer Live Benchmark Report";
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const summary = summarizeLiveBenchmarkReport(result, pricing);
  const metrics = [
    ["Paired success delta", formatPercent(summary.paired.successRateDelta)],
    [
      "Median total tokens",
      `${formatNullable(summary.baseline.totalTokens.median)} / ${formatNullable(summary.optimized.totalTokens.median)}`,
    ],
    [
      "Cost per success",
      `${formatCurrency(summary.baseline.costPerSuccess)} / ${formatCurrency(summary.optimized.costPerSuccess)}`,
    ],
    ["Optimizer overhead", `${formatNumber(summary.optimizer.overheadTokens)} tokens`],
    [
      "Hook activation / budget",
      summary.optimizer.responseBudgetAdhered
        ? `Passed (max ${formatNullable(summary.optimizer.maxHookResponseTokens)})`
        : "Failed",
    ],
  ];
  const metadata = [
    `Host / version / model: ${result.metadata.host} / ${result.metadata.hostVersion} / ${result.metadata.model}`,
    `Reasoning / sandbox: ${result.metadata.reasoningEffort} / ${result.metadata.sandbox}`,
    `Repetitions / seed: ${result.metadata.repetitions} / ${result.metadata.orderSeed}`,
    `Generated: ${formatDate(result.metadata.generatedAt)}`,
    `Pricing per million: $${pricing.inputCostPerMillionTokens} / $${pricing.cachedInputCostPerMillionTokens} / $${pricing.outputCostPerMillionTokens}`,
  ];

  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>:root{--ink:#142326;--muted:#596568;--paper:#f4f5f1;--panel:#fff;--line:#cbd2cf;--accent:#176b72;--good:#237049;--bad:#a03636}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,sans-serif;line-height:1.5}.shell{width:min(1200px,calc(100% - 32px));margin:0 auto}header{padding:44px 0 28px;border-bottom:1px solid var(--line)}main{padding:28px 0 48px}section{padding:28px 0;border-top:1px solid var(--line)}section:first-child{border-top:0;padding-top:0}h1{margin:0;font-size:2.5rem;line-height:1.1}h2{margin:0 0 16px;font-size:1.35rem}.eyebrow{margin:0 0 8px;color:var(--accent);font-size:.8rem;font-weight:700;text-transform:uppercase}.meta,.metrics,.modes{display:grid;gap:12px}.meta,.metrics{grid-template-columns:repeat(4,minmax(0,1fr))}.metric,.mode{padding:16px;border:1px solid var(--line);background:var(--panel)}.label{margin:0;color:var(--muted);font-size:.8rem;font-weight:700;text-transform:uppercase}.value{margin:8px 0 0;font-size:1.4rem;font-weight:700}.modes{grid-template-columns:repeat(2,minmax(0,1fr))}dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px;margin:0}dt{color:var(--muted)}dd{margin:0;font-weight:600}.table{overflow-x:auto;border:1px solid var(--line);background:var(--panel)}table{width:100%;min-width:900px;border-collapse:collapse;font-size:.9rem}th,td{padding:12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-size:.76rem;text-transform:uppercase}tr:last-child td{border-bottom:0}.pass{color:var(--good);font-weight:700}.fail{color:var(--bad);font-weight:700}details{margin-top:6px}summary{cursor:pointer;color:var(--accent)}pre{max-width:100%;overflow:auto;padding:12px;background:#edf1ef;white-space:pre-wrap}a{color:var(--accent)}footer{padding:20px 0 40px;border-top:1px solid var(--line);color:var(--muted);font-size:.9rem}@media(max-width:840px){.meta,.metrics,.modes{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.shell{width:min(100% - 24px,1200px)}h1{font-size:2rem}.meta,.metrics,.modes{grid-template-columns:1fr}}</style></head><body>",
    '<header><div class="shell"><p class="eyebrow">Provider-backed benchmark evidence</p>',
    `<h1>${escapeHtml(title)}</h1><div class="meta">${metadata.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div></div></header>`,
    '<main class="shell">',
    `<section class="metrics" aria-label="Live benchmark summary">${metrics.map(([label, value]) => `<article class="metric"><p class="label">${escapeHtml(label ?? "")}</p><p class="value">${escapeHtml(value ?? "")}</p></article>`).join("")}</section>`,
    `<section><h2>Provider usage distribution</h2><div class="modes">${renderMode("Baseline", summary.baseline)}${renderMode("Optimized", summary.optimized)}</div></section>`,
    `<section><h2>Paired outcomes</h2><p>${summary.paired.improved} optimized wins, ${summary.paired.regressed} regressions, and ${summary.paired.tied} ties across ${summary.paired.comparedPairs} comparable pairs.</p></section>`,
    `<section><h2>Release gates</h2><dl><dt>Overall</dt><dd class="${summary.gates.releasePassed ? "pass" : "fail"}">${summary.gates.releasePassed ? "Passed" : "Failed"}</dd><dt>Provider usage / successful cases</dt><dd>${gateLabel(summary.gates.providerUsageComplete)} / ${gateLabel(summary.gates.allCasesSuccessful)}</dd><dt>Median successful-task token reduction</dt><dd>${formatNullablePercent(summary.gates.medianTokenReductionRate)} (${gateLabel(summary.gates.medianTokenReductionPassed)})</dd><dt>Lower cost per successful task</dt><dd>${gateLabel(summary.gates.costPerSuccessLower)}</dd><dt>Pairs over 10% token regression</dt><dd>${summary.gates.tokenRegressionCount} (${gateLabel(summary.gates.noTokenRegressionsOverTenPercent)})</dd><dt>Hook activation / warm-cache reuse</dt><dd>${gateLabel(summary.gates.hookBudgetPassed)} / ${gateLabel(summary.gates.warmCacheReusePassed)}</dd></dl></section>`,
    `<section><h2>Case results and safe diagnostics</h2><p>Host stdout and stderr are omitted. The raw JSON artifact retains provider usage, behavioral validation, optimizer evidence, safe diagnostics, and redaction counts only. ${options.rawDataHref ? `<a href="${escapeAttribute(options.rawDataHref)}">Download benchmark data</a>.` : ""}</p><div class="table"><table><thead><tr><th>Scenario</th><th>Rep.</th><th>Mode</th><th>Result</th><th>Total</th><th>Input / cached / output</th><th>Latency</th><th>Optimizer</th><th>Details</th></tr></thead><tbody>${result.cases.map(renderCase).join("")}</tbody></table></div></section>`,
    `<section><h2>Reproducibility</h2><dl><dt>Package version</dt><dd>${escapeHtml(result.metadata.packageVersion)}</dd><dt>Node / platform</dt><dd>${escapeHtml(result.metadata.nodeVersion)} / ${escapeHtml(result.metadata.platform)}</dd><dt>Scenario count</dt><dd>${result.metadata.scenarioCount}</dd><dt>Time limit</dt><dd>${formatDuration(result.metadata.timeLimitMs)}</dd><dt>Unknown optimizer ledger entries</dt><dd>${summary.optimizer.unknownEntryCount}</dd><dt>User-prompt hook calls / max response</dt><dd>${summary.optimizer.hookCallCount} / ${formatNullable(summary.optimizer.maxHookResponseTokens)} tokens</dd><dt>Warm-cache reuse</dt><dd>${summary.optimizer.warmCacheReusedCases} / ${summary.optimizer.warmCacheEvidenceCases} optimized cases</dd></dl></section>`,
    '</main><footer><div class="shell">Provider-reported usage is the source of truth. Missing usage or failed validation is not a successful task.</div></footer></body></html>',
  ].join("\n");
}

function summarizeMode(
  cases: readonly LiveBenchmarkReportCase[],
  pricing: LiveBenchmarkReportPricing,
): LiveBenchmarkModeSummary {
  const usages = cases.flatMap((benchmarkCase) =>
    benchmarkCase.providerUsage ? [benchmarkCase.providerUsage] : [],
  );
  const successes = cases.filter((benchmarkCase) => benchmarkCase.success).length;
  const cost = sum(usages.map((usage) => estimateCost(usage, pricing)));
  return {
    caseCount: cases.length,
    successes,
    successRate: rate(successes, cases.length),
    providerUsageCoverage: rate(usages.length, cases.length),
    totalTokens: distribution(usages.map((usage) => usage.totalTokens)),
    inputTokens: sum(usages.map((usage) => usage.inputTokens)),
    cachedInputTokens: sum(usages.map((usage) => usage.cachedInputTokens)),
    outputTokens: sum(usages.map((usage) => usage.outputTokens)),
    latency: distribution(cases.map((benchmarkCase) => benchmarkCase.durationMs)),
    cost,
    costPerSuccess: successes > 0 ? cost / successes : null,
  };
}

function summarizePairs(
  cases: readonly LiveBenchmarkReportCase[],
): LiveBenchmarkReportSummary["paired"] {
  const pairs = new Map<
    string,
    Partial<Record<LiveBenchmarkMode, LiveBenchmarkReportCase>>
  >();
  for (const benchmarkCase of cases) {
    const key = `${benchmarkCase.scenarioId}:${benchmarkCase.repetition}`;
    const pair = pairs.get(key) ?? {};
    pair[benchmarkCase.mode] = benchmarkCase;
    pairs.set(key, pair);
  }
  let comparedPairs = 0;
  let improved = 0;
  let regressed = 0;
  let tied = 0;
  let baselineSuccesses = 0;
  let optimizedSuccesses = 0;
  for (const pair of pairs.values()) {
    if (!pair.baseline || !pair.optimized) continue;
    comparedPairs += 1;
    baselineSuccesses += Number(pair.baseline.success);
    optimizedSuccesses += Number(pair.optimized.success);
    if (pair.optimized.success && !pair.baseline.success) improved += 1;
    else if (!pair.optimized.success && pair.baseline.success) regressed += 1;
    else tied += 1;
  }
  return {
    comparedPairs,
    improved,
    regressed,
    tied,
    successRateDelta:
      rate(optimizedSuccesses, comparedPairs) - rate(baselineSuccesses, comparedPairs),
  };
}

function summarizeReleaseGates(input: {
  readonly cases: readonly LiveBenchmarkReportCase[];
  readonly baseline: LiveBenchmarkModeSummary;
  readonly optimized: LiveBenchmarkModeSummary;
  readonly optimizer: LiveBenchmarkReportSummary["optimizer"];
}): LiveBenchmarkReportSummary["gates"] {
  const baselineSuccessfulMedian = distribution(
    input.cases.flatMap((benchmarkCase) =>
      benchmarkCase.mode === "baseline" &&
      benchmarkCase.success &&
      benchmarkCase.providerUsage
        ? [benchmarkCase.providerUsage.totalTokens]
        : [],
    ),
  ).median;
  const optimizedSuccessfulMedian = distribution(
    input.cases.flatMap((benchmarkCase) =>
      benchmarkCase.mode === "optimized" &&
      benchmarkCase.success &&
      benchmarkCase.providerUsage
        ? [benchmarkCase.providerUsage.totalTokens]
        : [],
    ),
  ).median;
  const medianTokenReductionRate =
    baselineSuccessfulMedian !== null &&
    baselineSuccessfulMedian > 0 &&
    optimizedSuccessfulMedian !== null
      ? (baselineSuccessfulMedian - optimizedSuccessfulMedian) / baselineSuccessfulMedian
      : null;
  const tokenRegressionCount = countTokenRegressions(input.cases);
  const providerUsageComplete =
    input.cases.length > 0 &&
    input.cases.every((benchmarkCase) => benchmarkCase.providerUsage !== undefined);
  const allCasesSuccessful =
    input.cases.length > 0 && input.cases.every((benchmarkCase) => benchmarkCase.success);
  const medianTokenReductionPassed =
    medianTokenReductionRate !== null && medianTokenReductionRate >= 0.15;
  const costPerSuccessLower =
    input.baseline.costPerSuccess !== null &&
    input.optimized.costPerSuccess !== null &&
    input.optimized.costPerSuccess < input.baseline.costPerSuccess;
  const noTokenRegressionsOverTenPercent = tokenRegressionCount === 0;
  const hookBudgetPassed = input.optimizer.responseBudgetAdhered;
  const warmCacheReusePassed =
    input.optimizer.warmCacheEvidenceCases > 0 &&
    input.optimizer.warmCacheReusedCases === input.optimizer.warmCacheEvidenceCases;
  const releasePassed =
    providerUsageComplete &&
    allCasesSuccessful &&
    medianTokenReductionPassed &&
    costPerSuccessLower &&
    noTokenRegressionsOverTenPercent &&
    hookBudgetPassed &&
    warmCacheReusePassed;

  return {
    providerUsageComplete,
    allCasesSuccessful,
    medianTokenReductionRate,
    medianTokenReductionPassed,
    costPerSuccessLower,
    tokenRegressionCount,
    noTokenRegressionsOverTenPercent,
    hookBudgetPassed,
    warmCacheReusePassed,
    releasePassed,
  };
}

function countTokenRegressions(cases: readonly LiveBenchmarkReportCase[]): number {
  const pairs = new Map<
    string,
    Partial<Record<LiveBenchmarkMode, LiveBenchmarkReportCase>>
  >();
  for (const benchmarkCase of cases) {
    const key = `${benchmarkCase.scenarioId}:${benchmarkCase.repetition}`;
    const pair = pairs.get(key) ?? {};
    pair[benchmarkCase.mode] = benchmarkCase;
    pairs.set(key, pair);
  }

  return [...pairs.values()].filter((pair) => {
    const baselineTokens = pair.baseline?.providerUsage?.totalTokens;
    const optimizedTokens = pair.optimized?.providerUsage?.totalTokens;
    return (
      baselineTokens !== undefined &&
      optimizedTokens !== undefined &&
      optimizedTokens > baselineTokens * 1.1
    );
  }).length;
}

function distribution(values: readonly number[]): LiveBenchmarkDistribution {
  if (values.length === 0)
    return { count: 0, minimum: null, p25: null, median: null, p75: null, maximum: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    minimum: sorted[0] ?? null,
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    maximum: sorted.at(-1) ?? null,
  };
}

function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const index = (values.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = values[lower] ?? 0;
  const upperValue = values[upper] ?? lowerValue;
  return Math.round(lowerValue + (upperValue - lowerValue) * (index - lower));
}

function estimateCost(
  usage: LiveBenchmarkReportUsage,
  pricing: LiveBenchmarkReportPricing,
): number {
  const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (uncachedInputTokens / 1_000_000) * pricing.inputCostPerMillionTokens +
    (usage.cachedInputTokens / 1_000_000) * pricing.cachedInputCostPerMillionTokens +
    (usage.outputTokens / 1_000_000) * pricing.outputCostPerMillionTokens
  );
}

function renderMode(label: string, summary: LiveBenchmarkModeSummary): string {
  return `<article class="mode"><h3>${escapeHtml(label)}</h3><dl><dt>Success rate</dt><dd>${formatPercent(summary.successRate)}</dd><dt>Usage coverage</dt><dd>${formatPercent(summary.providerUsageCoverage)}</dd><dt>Total tokens p25 / median / p75</dt><dd>${formatDistribution(summary.totalTokens)}</dd><dt>Input / cached / output</dt><dd>${formatNumber(summary.inputTokens)} / ${formatNumber(summary.cachedInputTokens)} / ${formatNumber(summary.outputTokens)}</dd><dt>Latency p25 / median / p75</dt><dd>${formatDurationDistribution(summary.latency)}</dd><dt>Cost per success</dt><dd>${formatCurrency(summary.costPerSuccess)}</dd></dl></article>`;
}

function renderCase(benchmarkCase: LiveBenchmarkReportCase): string {
  const usage = benchmarkCase.providerUsage;
  const details =
    [...benchmarkCase.validation.details, ...benchmarkCase.diagnostics].join("\n") ||
    "None";
  const evidence = benchmarkCase.optimizerEvidence
    ? `; budget ${benchmarkCase.optimizerEvidence.responseBudgetAdhered ? "passed" : "failed"} (${formatNullable(benchmarkCase.optimizerEvidence.maxHookResponseTokens)} max)`
    : "";
  const warmCache = benchmarkCase.warmCache
    ? `; warm cache ${benchmarkCase.warmCache.unchangedWorkReused ? "passed" : "failed"}`
    : "";
  return `<tr><td>${escapeHtml(benchmarkCase.scenarioId)}</td><td>${benchmarkCase.repetition}</td><td>${benchmarkCase.mode}</td><td class="${benchmarkCase.success ? "pass" : "fail"}">${benchmarkCase.success ? "Passed" : "Failed"}</td><td>${usage ? formatNumber(usage.totalTokens) : "missing"}</td><td>${usage ? `${formatNumber(usage.inputTokens)} / ${formatNumber(usage.cachedInputTokens)} / ${formatNumber(usage.outputTokens)}` : "missing"}</td><td>${formatDuration(benchmarkCase.durationMs)}</td><td>${formatNumber(benchmarkCase.optimizer.overheadTokens)} overhead; ${benchmarkCase.optimizer.expansionCount} expansions; ${benchmarkCase.optimizer.retryCount} retries${evidence}${warmCache}</td><td><details><summary>Details</summary><pre>${escapeHtml(details)}</pre></details></td></tr>`;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
function maximum(values: readonly number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}
function rate(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}
function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
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
  return value === null ? "n/a" : formatNumber(value);
}
function formatCurrency(value: number | null): string {
  return value === null
    ? "n/a"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(value);
}
function formatDuration(value: number): string {
  return `${Math.round(value)}ms`;
}
function formatDistribution(value: LiveBenchmarkDistribution): string {
  return value.median === null
    ? "n/a"
    : `${formatNumber(value.p25 ?? 0)} / ${formatNumber(value.median)} / ${formatNumber(value.p75 ?? 0)}`;
}
function formatDurationDistribution(value: LiveBenchmarkDistribution): string {
  return value.median === null
    ? "n/a"
    : `${formatDuration(value.p25 ?? 0)} / ${formatDuration(value.median)} / ${formatDuration(value.p75 ?? 0)}`;
}
function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
