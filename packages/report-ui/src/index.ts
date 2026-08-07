export * from "./live";

export interface BenchmarkReportTokenEstimate {
  readonly inputTokens: number;
  readonly outputTokens?: number | undefined;
  readonly totalTokens: number;
}

export interface BenchmarkReportCase {
  readonly scenarioId: string;
  readonly mode: "baseline" | "optimized";
  readonly success: boolean;
  readonly durationMs: number;
  readonly tokenEstimate: BenchmarkReportTokenEstimate;
  readonly touchedFiles: readonly string[];
  readonly expectedFiles: readonly string[];
  readonly notes: readonly string[];
}

export interface BenchmarkReportResult {
  readonly metadata: {
    readonly generatedAt: string;
    readonly packageVersion: string;
    readonly nodeVersion: string;
    readonly platform: string;
    readonly scenarioCount: number;
    readonly reproducibility: readonly string[];
  };
  readonly cases: readonly BenchmarkReportCase[];
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

export interface BenchmarkReportPricing {
  readonly inputCostPerMillionTokens: number;
  readonly outputCostPerMillionTokens: number;
  readonly currency: "USD";
}

export interface BenchmarkReportRenderOptions {
  readonly title?: string;
  readonly rawDataHref?: string;
  readonly pricing?: BenchmarkReportPricing;
}

export interface BenchmarkReportSummary {
  readonly baselineCost: number;
  readonly optimizedCost: number;
  readonly costSavings: number;
  readonly baselineCostPerSuccess: number | null;
  readonly optimizedCostPerSuccess: number | null;
  readonly totalBaselineDurationMs: number;
  readonly totalOptimizedDurationMs: number;
  readonly averageBaselineDurationMs: number;
  readonly averageOptimizedDurationMs: number;
  readonly baselineSuccessRate: number;
  readonly optimizedSuccessRate: number;
}

const DEFAULT_PRICING: BenchmarkReportPricing = {
  inputCostPerMillionTokens: 1,
  outputCostPerMillionTokens: 3,
  currency: "USD",
};

export function summarizeBenchmarkReport(
  result: BenchmarkReportResult,
  pricing: BenchmarkReportPricing = DEFAULT_PRICING,
): BenchmarkReportSummary {
  const baselineCases = result.cases.filter((item) => item.mode === "baseline");
  const optimizedCases = result.cases.filter((item) => item.mode === "optimized");
  const baselineCost = estimateCaseCost(baselineCases, pricing);
  const optimizedCost = estimateCaseCost(optimizedCases, pricing);
  const baselineSuccessRate = rate(result.totals.baselineSuccesses, baselineCases.length);
  const optimizedSuccessRate = rate(
    result.totals.optimizedSuccesses,
    optimizedCases.length,
  );

  return {
    baselineCost,
    optimizedCost,
    costSavings: Math.max(0, baselineCost - optimizedCost),
    baselineCostPerSuccess: costPerSuccess(baselineCost, result.totals.baselineSuccesses),
    optimizedCostPerSuccess: costPerSuccess(
      optimizedCost,
      result.totals.optimizedSuccesses,
    ),
    totalBaselineDurationMs: sumDuration(baselineCases),
    totalOptimizedDurationMs: sumDuration(optimizedCases),
    averageBaselineDurationMs: averageDuration(baselineCases),
    averageOptimizedDurationMs: averageDuration(optimizedCases),
    baselineSuccessRate,
    optimizedSuccessRate,
  };
}

export function renderBenchmarkReportHtml(
  result: BenchmarkReportResult,
  options: BenchmarkReportRenderOptions = {},
): string {
  const title = options.title ?? "Agent Token Optimizer Benchmark Report";
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const summary = summarizeBenchmarkReport(result, pricing);
  const generatedAt = formatDateTime(result.metadata.generatedAt);
  const maxTokens = Math.max(
    result.totals.baselineTokens,
    result.totals.optimizedTokens,
    1,
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="data:,">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #171717;
        --muted: #626262;
        --paper: #f7f4ee;
        --panel: #fffdfa;
        --line: #d8d0c4;
        --steel: #20556b;
        --moss: #566b2f;
        --clay: #9b4d2e;
        --gold: #c18b2d;
        --success: #2f6d46;
        --danger: #a23838;
        --shadow: 0 16px 50px rgb(23 23 23 / 10%);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background:
          linear-gradient(90deg, rgb(23 23 23 / 4%) 1px, transparent 1px),
          linear-gradient(0deg, rgb(23 23 23 / 4%) 1px, transparent 1px),
          var(--paper);
        background-size: 48px 48px;
        color: var(--ink);
        font-family: Georgia, "Times New Roman", serif;
        line-height: 1.5;
      }

      a {
        color: var(--steel);
      }

      a:focus-visible,
      button:focus-visible {
        outline: 3px solid var(--gold);
        outline-offset: 3px;
      }

      .shell {
        width: min(1180px, calc(100% - 32px));
        margin: 0 auto;
      }

      .masthead {
        padding: 56px 0 28px;
        border-bottom: 1px solid var(--line);
      }

      .eyebrow {
        margin: 0 0 14px;
        color: var(--clay);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      h1 {
        max-width: 820px;
        margin: 0;
        font-size: clamp(2.4rem, 6vw, 5.4rem);
        line-height: 0.95;
        letter-spacing: 0;
      }

      .masthead-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);
        gap: 32px;
        align-items: end;
      }

      .summary-copy {
        margin: 0;
        color: var(--muted);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        font-size: 1rem;
      }

      .meta-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        padding: 18px 0 0;
        color: var(--muted);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        font-size: 0.88rem;
      }

      .meta-strip span {
        border: 1px solid var(--line);
        background: rgb(255 253 250 / 72%);
        padding: 7px 10px;
      }

      main {
        padding: 34px 0 56px;
      }

      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
        margin-bottom: 28px;
      }

      .kpi {
        min-height: 150px;
        padding: 18px;
        background: var(--panel);
        border: 1px solid var(--line);
        box-shadow: var(--shadow);
      }

      .kpi-label {
        margin: 0 0 16px;
        color: var(--muted);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        font-size: 0.78rem;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      .kpi-value {
        margin: 0;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        font-size: clamp(1.7rem, 4vw, 3rem);
        font-weight: 800;
        line-height: 1;
      }

      .kpi-note {
        margin: 14px 0 0;
        color: var(--muted);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        font-size: 0.9rem;
      }

      .section {
        padding: 30px 0;
        border-top: 1px solid var(--line);
      }

      .section h2 {
        margin: 0 0 18px;
        font-size: clamp(1.6rem, 3vw, 2.4rem);
        line-height: 1;
      }

      .comparison {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
      }

      .mode-panel {
        background: var(--panel);
        border: 1px solid var(--line);
        padding: 18px;
      }

      .mode-panel h3 {
        margin: 0 0 18px;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        font-size: 1.05rem;
      }

      .bar-row {
        display: grid;
        grid-template-columns: 112px minmax(0, 1fr) minmax(124px, max-content);
        gap: 12px;
        align-items: center;
        margin: 12px 0;
        color: var(--muted);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        font-size: 0.9rem;
      }

      .bar-row strong {
        justify-self: end;
        text-align: right;
      }

      .bar-track {
        height: 14px;
        border: 1px solid var(--line);
        background: #ede6dc;
        overflow: hidden;
      }

      .bar-fill {
        display: block;
        height: 100%;
        min-width: 3px;
        background: var(--steel);
      }

      .bar-fill.optimized {
        background: var(--moss);
      }

      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--line);
        background: var(--panel);
      }

      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 780px;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        font-size: 0.92rem;
      }

      th,
      td {
        padding: 13px 14px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }

      th {
        color: var(--muted);
        font-size: 0.76rem;
        text-transform: uppercase;
      }

      tr:last-child td {
        border-bottom: 0;
      }

      .status {
        display: inline-flex;
        align-items: center;
        min-height: 26px;
        padding: 3px 9px;
        border: 1px solid currentColor;
        font-weight: 700;
      }

      .status.pass {
        color: var(--success);
      }

      .status.fail {
        color: var(--danger);
      }

      .notes {
        margin: 0;
        padding-left: 18px;
      }

      .methodology {
        display: grid;
        grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
        gap: 24px;
        color: var(--muted);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
      }

      .methodology p,
      .methodology ul {
        margin-top: 0;
      }

      .footer {
        padding: 24px 0 44px;
        color: var(--muted);
        border-top: 1px solid var(--line);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        font-size: 0.88rem;
      }

      @media (max-width: 860px) {
        .masthead-grid,
        .comparison,
        .methodology {
          grid-template-columns: 1fr;
        }

        .kpi-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 560px) {
        .shell {
          width: min(100% - 22px, 1180px);
        }

        .masthead {
          padding-top: 34px;
        }

        .kpi-grid {
          grid-template-columns: 1fr;
        }

        .bar-row {
          grid-template-columns: 1fr;
          gap: 6px;
        }
      }
    </style>
  </head>
  <body>
    <header class="masthead">
      <div class="shell masthead-grid">
        <div>
          <p class="eyebrow">Benchmark evidence</p>
          <h1>${escapeHtml(title)}</h1>
        </div>
        <p class="summary-copy">A deterministic comparison of broad baseline context against optimizer-selected context packs. Lower token use only counts when the validation still passes.</p>
      </div>
      <div class="shell meta-strip" aria-label="Report metadata">
        <span>Generated ${escapeHtml(generatedAt)}</span>
        <span>${escapeHtml(result.metadata.packageVersion)}</span>
        <span>${escapeHtml(result.metadata.nodeVersion)}</span>
        <span>${escapeHtml(result.metadata.platform)}</span>
      </div>
    </header>
    <main class="shell">
      <section class="kpi-grid" aria-label="Benchmark summary">
        ${renderKpi("Token savings", `${formatNumber(result.totals.tokenSavings)} tokens`, `${formatPercent(result.totals.tokenSavingsPercent)} less than baseline`)}
        ${renderKpi("Cost savings", formatCurrency(summary.costSavings), `Using ${formatCurrency(pricing.inputCostPerMillionTokens)} input / ${formatCurrency(pricing.outputCostPerMillionTokens)} output per 1M tokens`)}
        ${renderKpi("Optimized success", formatPercent(summary.optimizedSuccessRate), `${result.totals.optimizedSuccesses} successful optimized task${plural(result.totals.optimizedSuccesses)}`)}
        ${renderKpi("Latency delta", `${formatDuration(summary.totalOptimizedDurationMs - summary.totalBaselineDurationMs)}`, "Total optimized runtime minus baseline runtime")}
      </section>

      <section class="section" aria-labelledby="comparison-heading">
        <h2 id="comparison-heading">Baseline vs optimized</h2>
        <div class="comparison">
          ${renderModePanel("Baseline", result.totals.baselineTokens, maxTokens, summary.baselineCost, summary.baselineCostPerSuccess, summary.averageBaselineDurationMs, summary.baselineSuccessRate, false)}
          ${renderModePanel("Optimized", result.totals.optimizedTokens, maxTokens, summary.optimizedCost, summary.optimizedCostPerSuccess, summary.averageOptimizedDurationMs, summary.optimizedSuccessRate, true)}
        </div>
      </section>

      <section class="section" aria-labelledby="case-heading">
        <h2 id="case-heading">Scenario results</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Scenario</th>
                <th scope="col">Mode</th>
                <th scope="col">Validation</th>
                <th scope="col">Tokens</th>
                <th scope="col">Cost</th>
                <th scope="col">Latency</th>
                <th scope="col">Files</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              ${result.cases.map((item) => renderCaseRow(item, pricing)).join("\n")}
            </tbody>
          </table>
        </div>
      </section>

      <section class="section methodology" aria-labelledby="method-heading">
        <div>
          <h2 id="method-heading">Methodology</h2>
          <p>Benchmarks run against local fixture repositories with a deterministic mock agent. The baseline sees every indexed non-binary file. The optimized case sees only the generated context pack.</p>
          <p>Costs are estimates from configurable token pricing and are intended for relative comparison, not provider billing reconciliation.</p>
        </div>
        <div>
          <h2>Reproducibility</h2>
          <ul>
            ${result.metadata.reproducibility.map((item) => `<li>${escapeHtml(item)}</li>`).join("\n")}
          </ul>
          ${options.rawDataHref ? `<p><a href="${escapeAttribute(options.rawDataHref)}">Download raw benchmark data</a></p>` : ""}
        </div>
      </section>
    </main>
    <footer class="footer">
      <div class="shell">Agent Token Optimizer benchmark report. Scenario count: ${formatNumber(result.metadata.scenarioCount)}.</div>
    </footer>
  </body>
</html>`;
}

function renderKpi(label: string, value: string, note: string): string {
  return `<article class="kpi">
    <p class="kpi-label">${escapeHtml(label)}</p>
    <p class="kpi-value">${escapeHtml(value)}</p>
    <p class="kpi-note">${escapeHtml(note)}</p>
  </article>`;
}

function renderModePanel(
  label: string,
  tokens: number,
  maxTokens: number,
  cost: number,
  costPerSuccess: number | null,
  averageDurationMs: number,
  successRate: number,
  optimized: boolean,
): string {
  const width = Math.max(2, Math.round((tokens / maxTokens) * 100));

  return `<article class="mode-panel">
    <h3>${escapeHtml(label)}</h3>
    <div class="bar-row">
      <span>Tokens</span>
      <span class="bar-track" aria-hidden="true"><span class="bar-fill ${optimized ? "optimized" : ""}" style="width: ${width}%"></span></span>
      <strong>${formatNumber(tokens)}</strong>
    </div>
    <div class="bar-row">
      <span>Cost</span>
      <span>${formatCurrency(cost)}</span>
      <strong>${costPerSuccess === null ? "n/a" : `${formatCurrency(costPerSuccess)}/success`}</strong>
    </div>
    <div class="bar-row">
      <span>Success</span>
      <span>${formatPercent(successRate)}</span>
      <strong>${formatDuration(averageDurationMs)} avg</strong>
    </div>
  </article>`;
}

function renderCaseRow(
  item: BenchmarkReportCase,
  pricing: BenchmarkReportPricing,
): string {
  return `<tr>
    <td>${escapeHtml(item.scenarioId)}</td>
    <td>${escapeHtml(item.mode)}</td>
    <td><span class="status ${item.success ? "pass" : "fail"}">${item.success ? "Passed" : "Failed"}</span></td>
    <td>${formatNumber(item.tokenEstimate.totalTokens)}</td>
    <td>${formatCurrency(estimateCaseCost([item], pricing))}</td>
    <td>${formatDuration(item.durationMs)}</td>
    <td>${escapeHtml(item.touchedFiles.join(", ") || "None")}</td>
    <td><ul class="notes">${item.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul></td>
  </tr>`;
}

function estimateCaseCost(
  cases: readonly BenchmarkReportCase[],
  pricing: BenchmarkReportPricing,
): number {
  return cases.reduce(
    (total, item) =>
      total +
      (item.tokenEstimate.inputTokens / 1_000_000) * pricing.inputCostPerMillionTokens +
      ((item.tokenEstimate.outputTokens ?? 0) / 1_000_000) *
        pricing.outputCostPerMillionTokens,
    0,
  );
}

function costPerSuccess(cost: number, successes: number): number | null {
  return successes > 0 ? cost / successes : null;
}

function sumDuration(cases: readonly BenchmarkReportCase[]): number {
  return cases.reduce((total, item) => total + item.durationMs, 0);
}

function averageDuration(cases: readonly BenchmarkReportCase[]): number {
  return cases.length > 0 ? sumDuration(cases) / cases.length : 0;
}

function rate(count: number, total: number): number {
  return total > 0 ? (count / total) * 100 : 0;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: value < 0.01 ? 4 : 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(value % 1 === 0 ? 0 : 2)}%`;
}

function formatDuration(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absoluteValue = Math.abs(value);
  return `${sign}${Math.round(absoluteValue)}ms`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function plural(value: number): string {
  return value === 1 ? "" : "s";
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
