import type {
  OptimizationMode,
  TaskAnalysis,
  TaskHints,
  TaskOperation,
  WorkspaceAnalysisIndex,
  WorkspaceIndex,
} from "../contracts";

export interface TaskAssessment {
  readonly complexity: TaskAnalysis["task"]["complexity"];
  readonly risk: TaskAnalysis["task"]["risk"];
  readonly hints: TaskHints;
  readonly mode: OptimizationMode;
  readonly reason: string;
  readonly tokenBudget: number;
}

export interface AssessTaskOptions {
  readonly task: string;
  readonly workspaceIndex?: WorkspaceIndex;
  readonly workspaceAnalysis?: WorkspaceAnalysisIndex;
}

const HIGH_RISK_TERMS = [
  "auth",
  "authorization",
  "security",
  "secret",
  "credential",
  "payment",
  "billing",
  "migration",
  "delete",
  "destructive",
  "production",
  "release",
  "deploy",
  "database",
  "permission",
  "privacy",
];

const MEDIUM_RISK_TERMS = [
  "api",
  "cache",
  "config",
  "performance",
  "concurrency",
  "refactor",
  "schema",
  "test",
  "dependency",
  "package",
];

export function assessTask(options: AssessTaskOptions): TaskAssessment {
  const task = options.task.trim();
  const hints = extractTaskHints(task, options.workspaceIndex, options.workspaceAnalysis);
  const scope = estimateWorkspaceScope(hints, options.workspaceAnalysis);
  const complexity = classifyComplexity(task, hints, scope);
  const risk = classifyRisk(task, hints, scope);
  const mode = recommendationMode(complexity, risk);

  return {
    complexity,
    risk,
    hints,
    mode,
    reason: createRecommendationReason(mode, scope, hints),
    tokenBudget: tokenBudgetForMode(mode),
  };
}

export function extractTaskHints(
  task: string,
  workspaceIndex?: WorkspaceIndex,
  workspaceAnalysis?: WorkspaceAnalysisIndex,
): TaskHints {
  const normalizedTask = task.trim();
  const knownPaths = workspaceIndex?.files.map((file) => file.path) ?? [];
  const paths = unique([
    ...extractPaths(normalizedTask),
    ...knownPaths.filter((filePath) =>
      normalizedTask.toLowerCase().includes(filePath.toLowerCase()),
    ),
  ]).filter((filePath) => !filePath.split(/[\\/]+/u).includes(".."));
  const symbols = unique([
    ...extractSymbolLikeTerms(normalizedTask),
    ...(workspaceAnalysis?.files ?? []).flatMap((file) =>
      file.symbols
        .filter((symbol) => taskMentionsSymbol(normalizedTask, symbol.name))
        .map((symbol) => symbol.name),
    ),
  ]).slice(0, 30);
  const packageNames = unique([
    ...extractPackageNames(normalizedTask),
    ...(workspaceAnalysis?.files ?? []).flatMap((file) => {
      const packageName = file.ownership.packageName;

      return packageName &&
        normalizedTask.toLowerCase().includes(packageName.toLowerCase())
        ? [packageName]
        : [];
    }),
  ]).slice(0, 20);

  return {
    paths: paths.slice(0, 30),
    symbols,
    testNames: extractTestNames(normalizedTask).slice(0, 20),
    errorMessages: extractErrorMessages(normalizedTask).slice(0, 10),
    stackFrames: extractStackFrames(normalizedTask).slice(0, 20),
    packageNames,
    operation: detectOperation(normalizedTask),
  };
}

function estimateWorkspaceScope(
  hints: TaskHints,
  workspaceAnalysis?: WorkspaceAnalysisIndex,
): number {
  if (!workspaceAnalysis) {
    return hints.paths.length + hints.symbols.length + hints.testNames.length;
  }

  const directPaths = new Set<string>(hints.paths);

  for (const file of workspaceAnalysis.files) {
    if (file.symbols.some((symbol) => hints.symbols.includes(symbol.name))) {
      directPaths.add(file.path);
    }
  }

  const linkedPaths = new Set<string>(directPaths);

  for (const file of workspaceAnalysis.files) {
    if (
      file.internalDependencies.some((dependency) => directPaths.has(dependency)) ||
      file.testTargets.some((target) => directPaths.has(target)) ||
      (directPaths.has(file.path) && file.internalDependencies.length > 0)
    ) {
      linkedPaths.add(file.path);
      for (const dependency of file.internalDependencies) {
        linkedPaths.add(dependency);
      }
    }
  }

  return linkedPaths.size;
}

function classifyComplexity(
  task: string,
  hints: TaskHints,
  workspaceScope: number,
): TaskAnalysis["task"]["complexity"] {
  if (
    hints.operation === "migrate" ||
    hints.operation === "refactor" ||
    workspaceScope >= 12
  ) {
    return "large";
  }

  if (workspaceScope >= 3 || hints.packageNames.length > 0 || hints.paths.length >= 2) {
    return "medium";
  }

  if (workspaceScope >= 1 || hints.operation !== "unknown") {
    return "small";
  }

  const words = task.split(/\s+/u).filter(Boolean).length;

  if (words <= 8) {
    return "trivial";
  }

  return words <= 45 ? "small" : words <= 180 ? "medium" : "large";
}

function classifyRisk(
  task: string,
  hints: TaskHints,
  workspaceScope: number,
): TaskAnalysis["task"]["risk"] {
  const taskTerms = extractTerms(task);

  if (
    HIGH_RISK_TERMS.some((term) => taskTerms.includes(term)) ||
    (hints.operation === "remove" && workspaceScope > 0)
  ) {
    return "high";
  }

  if (
    MEDIUM_RISK_TERMS.some((term) => taskTerms.includes(term)) ||
    hints.operation === "migrate" ||
    hints.operation === "refactor" ||
    hints.errorMessages.length > 0 ||
    workspaceScope >= 4
  ) {
    return "medium";
  }

  return "low";
}

function recommendationMode(
  complexity: TaskAnalysis["task"]["complexity"],
  risk: TaskAnalysis["task"]["risk"],
): OptimizationMode {
  if (risk === "high" || complexity === "large") {
    return "context_pack_with_summaries";
  }

  if (complexity === "medium") {
    return "context_pack";
  }

  return complexity === "small" ? "light" : "skip";
}

function createRecommendationReason(
  mode: OptimizationMode,
  workspaceScope: number,
  hints: TaskHints,
): string {
  const evidence = [
    hints.paths.length > 0 ? `${hints.paths.length} file hint(s)` : undefined,
    hints.symbols.length > 0 ? `${hints.symbols.length} symbol hint(s)` : undefined,
    workspaceScope > 0 ? `${workspaceScope} workspace file(s) in scope` : undefined,
  ].filter((item): item is string => Boolean(item));
  const suffix = evidence.length > 0 ? ` Evidence: ${evidence.join(", ")}.` : "";

  switch (mode) {
    case "skip":
      return `The task appears narrow enough that broad context optimization is unlikely to pay off.${suffix}`;
    case "light":
      return `Use lightweight ranking before broader exploration.${suffix}`;
    case "context_pack":
      return `Use a focused context pack before code exploration.${suffix}`;
    case "context_pack_with_summaries":
      return `Use selected file summaries before implementation because the task has elevated scope or risk.${suffix}`;
  }
}

function tokenBudgetForMode(mode: OptimizationMode): number {
  switch (mode) {
    case "skip":
      return 1_000;
    case "light":
      return 3_000;
    case "context_pack":
      return 8_000;
    case "context_pack_with_summaries":
      return 14_000;
  }
}

function detectOperation(task: string): TaskOperation {
  const normalized = task.toLowerCase();
  const operations: readonly [TaskOperation, RegExp][] = [
    ["migrate", /\bmigrat(?:e|ion)/u],
    ["refactor", /\brefactor|redesign|architect/u],
    ["remove", /\bremove|delete|decommission/u],
    ["configure", /\bconfigur|setup/u],
    ["document", /\bdocument|readme|docs/u],
    ["test", /\btest|spec|coverage/u],
    ["fix", /\bfix|repair|resolve|bug/u],
    ["add", /\badd|create|implement|introduce/u],
    ["investigate", /\binvestigate|diagnose|debug|trace/u],
  ];

  return operations.find(([, pattern]) => pattern.test(normalized))?.[0] ?? "unknown";
}

function extractPaths(task: string): string[] {
  return [...task.matchAll(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/gu)].map(
    (match) => match[0].replace(/[),.:;]+$/u, ""),
  );
}

function extractSymbolLikeTerms(task: string): string[] {
  return unique(task.match(/\b[A-Za-z_$][\w$]*(?:[A-Z][\w$]*)+\b/gu) ?? []).slice(0, 30);
}

function extractTestNames(task: string): string[] {
  return [...task.matchAll(/\b(?:it|test|describe)\s*\(\s*["'`]([^"'`]+)["'`]/gu)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
}

function extractErrorMessages(task: string): string[] {
  return unique(
    [
      ...task.matchAll(
        /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Error|ERR_[A-Z0-9_]+|TS\d{4})\b[^\n]*/gu,
      ),
    ].map((match) => match[0].trim()),
  );
}

function extractStackFrames(task: string): string[] {
  return unique(
    [
      ...task.matchAll(
        /\bat\s+[^\s(]+\s*\([^\n)]+\)|\b(?:[\w./-]+\.(?:ts|tsx|js|jsx)):\d+(?::\d+)?/gu,
      ),
    ].map((match) => match[0].trim()),
  );
}

function extractPackageNames(task: string): string[] {
  return unique(task.match(/@[a-z0-9_.-]+\/[a-z0-9_.-]+/giu) ?? []);
}

function taskMentionsSymbol(task: string, symbol: string): boolean {
  const normalizedTask = task.toLowerCase();
  const symbolTerms = extractTerms(symbol);

  return (
    normalizedTask.includes(symbol.toLowerCase()) ||
    (symbolTerms.length > 0 &&
      symbolTerms.every((term) => extractTerms(task).includes(term)))
  );
}

function extractTerms(value: string): string[] {
  return unique(
    value
      .replace(/([a-z])([A-Z])/gu, "$1 $2")
      .toLowerCase()
      .match(/[a-z][a-z0-9_$-]{1,}/gu) ?? [],
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
