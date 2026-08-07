import path from "node:path";

import type {
  RankingSignal,
  TaskHints,
  WorkspaceAnalysisIndex,
  WorkspaceFile,
  WorkspaceFileAnalysis,
} from "../contracts";
import {
  DEFAULT_RANKING_WEIGHTS,
  DEFAULT_RECENT_FILE_WINDOW_DAYS,
  type RankingSignalName,
} from "../config";

export interface RankingSignalInput {
  readonly task: string;
  readonly file: WorkspaceFile;
  readonly allFiles: readonly WorkspaceFile[];
  readonly workspaceAnalysis?: WorkspaceAnalysisIndex;
  readonly analysisByPath?: ReadonlyMap<string, WorkspaceFileAnalysis>;
  readonly anchorPaths?: ReadonlySet<string>;
  readonly recentlyChangedPaths?: ReadonlySet<string>;
  readonly taskHints?: TaskHints;
  readonly now?: Date;
  readonly recentFileWindowDays?: number;
}

export interface WeightedRankingSignal extends RankingSignal {
  readonly weightedScore: number;
}

const TOKEN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

export function collectRankingSignals(
  input: RankingSignalInput,
): WeightedRankingSignal[] {
  return [
    lexicalSignal(input),
    bm25Signal(input),
    dependencySignal(input),
    testRelationSignal(input),
    ownershipSignal(input),
    kindSignal(input),
    recencySignal(input),
    costSignal(input),
  ].filter((signal) => signal.score > 0);
}

export function extractSearchTokens(value: string): string[] {
  const tokens = value
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= 2 && !TOKEN_STOP_WORDS.has(token));

  return [...new Set(tokens)];
}

function lexicalSignal(input: RankingSignalInput): WeightedRankingSignal {
  const taskTokens = extractSearchTokens(input.task);
  const pathTokens = extractSearchTokens(input.file.path);
  const analysis = input.analysisByPath?.get(input.file.path);
  const normalizedTask = input.task.toLowerCase();
  const hintedPath = input.taskHints?.paths.includes(input.file.path) ?? false;
  const symbolMatches = (analysis?.symbols ?? []).filter((symbol) => {
    const symbolTokens = extractSearchTokens(symbol.name);

    return (
      normalizedTask.includes(symbol.name.toLowerCase()) ||
      (symbolTokens.length > 0 &&
        symbolTokens.every((token) => taskTokens.includes(token)))
    );
  });
  const pathMatches = taskTokens.filter((token) => pathTokens.includes(token));
  const score =
    hintedPath ||
    symbolMatches.length > 0 ||
    taskMentionsPath(input.task, input.file.path) ||
    (input.taskHints?.symbols.some((symbol) =>
      analysis?.symbols.some((candidate) => candidate.name === symbol),
    ) ??
      false)
      ? 1
      : taskTokens.length === 0
        ? 0
        : pathMatches.length / taskTokens.length;
  const matches = [
    ...pathMatches,
    ...symbolMatches.map((symbol) => symbol.name),
    ...(hintedPath ? [input.file.path] : []),
  ];

  return createWeightedSignal(
    "lexical",
    score,
    matches.length > 0
      ? score === 1
        ? `Exact path or symbol match: ${matches.join(", ")}.`
        : `Matched task terms: ${matches.join(", ")}.`
      : "No direct task terms matched the path or indexed symbols.",
  );
}

function bm25Signal(input: RankingSignalInput): WeightedRankingSignal {
  const analysis = input.analysisByPath?.get(input.file.path);
  const index = input.workspaceAnalysis;

  if (!analysis || !index || index.workspace.rootHash === "") {
    return createWeightedSignal(
      "bm25",
      0,
      "No compatible workspace analysis is available.",
    );
  }

  const taskTokens = extractSearchTokens(input.task);
  const pathScore = bm25Score(taskTokens, extractSearchTokens(analysis.path), index);
  const symbolScore = bm25Score(
    taskTokens,
    analysis.symbols.flatMap((symbol) => extractSearchTokens(symbol.name)),
    index,
  );
  const contentScore = bm25Score(taskTokens, analysis.lexicalTerms, index);
  const score = 0.25 * pathScore + 0.4 * symbolScore + 0.35 * contentScore;

  return createWeightedSignal(
    "bm25",
    score,
    score > 0
      ? "Indexed path, symbols, or content terms matched the task."
      : "No indexed BM25-style terms matched the task.",
  );
}

function bm25Score(
  taskTokens: readonly string[],
  documentTerms: readonly string[],
  index: WorkspaceAnalysisIndex,
): number {
  if (taskTokens.length === 0 || documentTerms.length === 0) {
    return 0;
  }

  const terms = new Set(documentTerms);
  const documentCount = Math.max(1, index.files.length);
  const maximum = taskTokens.reduce(
    (total, term) => total + inverseDocumentFrequency(term, documentCount, index),
    0,
  );
  const matched = taskTokens.reduce(
    (total, term) =>
      terms.has(term)
        ? total + inverseDocumentFrequency(term, documentCount, index)
        : total,
    0,
  );

  return maximum === 0 ? 0 : matched / maximum;
}

function inverseDocumentFrequency(
  term: string,
  documentCount: number,
  index: WorkspaceAnalysisIndex,
): number {
  const frequency = index.documentFrequencies[term] ?? 0;

  return Math.log(1 + (documentCount - frequency + 0.5) / (frequency + 0.5));
}

function kindSignal(input: RankingSignalInput): WeightedRankingSignal {
  const taskTokens = new Set(extractSearchTokens(input.task));

  if (
    input.file.kind === "test" &&
    hasAnyToken(taskTokens, ["test", "tests", "spec", "failing"])
  ) {
    return createWeightedSignal("kind", 1, "Task mentions tests and file is a test.");
  }

  if (input.file.kind === "source") {
    return createWeightedSignal(
      "kind",
      0.65,
      "Source files are likely implementation context.",
    );
  }

  if (
    input.file.kind === "config" &&
    hasAnyToken(taskTokens, ["config", "setup", "build"])
  ) {
    return createWeightedSignal(
      "kind",
      0.8,
      "Task mentions configuration and file is config.",
    );
  }

  if (
    input.file.kind === "documentation" &&
    hasAnyToken(taskTokens, ["doc", "docs", "readme"])
  ) {
    return createWeightedSignal(
      "kind",
      0.8,
      "Task mentions documentation and file is documentation.",
    );
  }

  return createWeightedSignal("kind", 0, "File kind did not match task intent.");
}

function dependencySignal(input: RankingSignalInput): WeightedRankingSignal {
  const analysis = input.analysisByPath?.get(input.file.path);
  const anchors = input.anchorPaths;

  if (!analysis || !anchors || anchors.size === 0) {
    return createWeightedSignal(
      "dependency",
      0,
      "No indexed dependency anchor is available.",
    );
  }

  const importsAnchor = analysis.internalDependencies.some((dependency) =>
    anchors.has(dependency),
  );
  const importedByAnchor = [...anchors].some((anchorPath) =>
    input.analysisByPath?.get(anchorPath)?.internalDependencies.includes(input.file.path),
  );

  return createWeightedSignal(
    "dependency",
    importsAnchor || importedByAnchor ? 1 : 0,
    importsAnchor
      ? "Imports a directly task-matched file."
      : importedByAnchor
        ? "Is imported by a directly task-matched file."
        : "No direct import relationship to task-matched files.",
  );
}

function testRelationSignal(input: RankingSignalInput): WeightedRankingSignal {
  const analysis = input.analysisByPath?.get(input.file.path);
  const anchors = input.anchorPaths;

  if (!analysis || !anchors || anchors.size === 0) {
    const hasPairedSource =
      input.file.kind === "test" &&
      input.allFiles.some(
        (file) =>
          !file.ignored &&
          file.kind === "source" &&
          normalizeSourceStem(file.path) === normalizeTestStem(input.file.path),
      );
    const hasPairedTest =
      input.file.kind === "source" &&
      input.allFiles.some(
        (file) =>
          !file.ignored &&
          file.kind === "test" &&
          normalizeTestStem(file.path) === normalizeSourceStem(input.file.path),
      );
    const hasFallbackPair = hasPairedSource || hasPairedTest;

    return createWeightedSignal(
      "testRelation",
      hasFallbackPair ? 0.8 : 0,
      hasPairedSource
        ? "Test file has a colocated source-file stem match."
        : hasPairedTest
          ? "Source file has a colocated test-file stem match."
          : "No indexed test relationship anchor is available.",
    );
  }

  const testsAnchor = analysis.testTargets.some((target) => anchors.has(target));
  const testedByAnchor = [...(input.analysisByPath?.values() ?? [])].some(
    (candidate) =>
      candidate.testTargets.includes(input.file.path) && anchors.has(candidate.path),
  );

  return createWeightedSignal(
    "testRelation",
    testsAnchor || testedByAnchor ? 1 : 0,
    testsAnchor
      ? "Test directly covers a task-matched source file."
      : testedByAnchor
        ? "Source file is directly covered by a task-matched test."
        : "No direct indexed test relationship to task-matched files.",
  );
}

function ownershipSignal(input: RankingSignalInput): WeightedRankingSignal {
  const analysis = input.analysisByPath?.get(input.file.path);

  if (!analysis) {
    return createWeightedSignal(
      "ownership",
      0,
      "No package ownership metadata is available.",
    );
  }

  const taskTokens = extractSearchTokens(input.task);
  const packageTokens = extractSearchTokens(
    `${analysis.ownership.packageName ?? ""} ${analysis.ownership.packagePath ?? ""}`,
  );
  const packageMatches = taskTokens.filter((token) => packageTokens.includes(token));
  const configForAnchor =
    input.file.kind === "config" &&
    [...(input.anchorPaths ?? [])].some(
      (anchorPath) =>
        input.analysisByPath?.get(anchorPath)?.ownership.packagePath ===
        analysis.ownership.packagePath,
    );

  return createWeightedSignal(
    "ownership",
    packageMatches.length > 0 ? 1 : configForAnchor ? 0.7 : 0,
    packageMatches.length > 0
      ? `Task matches package ownership: ${packageMatches.join(", ")}.`
      : configForAnchor
        ? "Configuration belongs to a task-matched package."
        : "Package ownership did not match the task.",
  );
}

function recencySignal(input: RankingSignalInput): WeightedRankingSignal {
  if (input.recentlyChangedPaths?.has(input.file.path)) {
    return createWeightedSignal(
      "recency",
      1,
      "File is listed as recently changed by the trusted host input.",
    );
  }

  if (!input.file.modifiedAt) {
    return createWeightedSignal("recency", 0, "No modified timestamp available.");
  }

  const now = input.now ?? new Date();
  const modifiedAt = new Date(input.file.modifiedAt);
  const windowMs =
    (input.recentFileWindowDays ?? DEFAULT_RECENT_FILE_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
  const ageMs = now.getTime() - modifiedAt.getTime();

  if (Number.isNaN(modifiedAt.getTime()) || ageMs < 0 || ageMs > windowMs) {
    return createWeightedSignal("recency", 0, "File is not recently modified.");
  }

  const score = 1 - ageMs / windowMs;

  return createWeightedSignal("recency", score, "File was modified recently.");
}

function costSignal(input: RankingSignalInput): WeightedRankingSignal {
  const estimatedTokens = Math.ceil(input.file.sizeBytes / 4);
  const score = 1 / (1 + estimatedTokens / 1_000);

  return createWeightedSignal(
    "cost",
    score,
    `Estimated file cost is ${estimatedTokens} tokens.`,
  );
}

function createWeightedSignal(
  name: RankingSignalName,
  score: number,
  reason: string,
): WeightedRankingSignal {
  const boundedScore = Math.max(0, Math.min(1, score));

  return {
    name,
    score: boundedScore,
    weightedScore: boundedScore * DEFAULT_RANKING_WEIGHTS[name],
    reason,
  };
}

function hasAnyToken(tokens: ReadonlySet<string>, values: readonly string[]): boolean {
  return values.some((value) => tokens.has(value));
}

function taskMentionsPath(task: string, filePath: string): boolean {
  const normalizedTask = task.toLowerCase().replace(/\\/gu, "/");
  const normalizedPath = filePath.toLowerCase();
  const basename = path.basename(normalizedPath);

  return normalizedTask.includes(normalizedPath) || normalizedTask.includes(basename);
}

function normalizeTestStem(relativePath: string): string {
  return normalizeSourceStem(
    relativePath.replace(/\.(test|spec)\.[^.]+$/u, "").replace(/(^|\/)tests?\//u, "$1"),
  );
}

function normalizeSourceStem(relativePath: string): string {
  const parsedPath = path.posix.parse(relativePath);

  return path.posix.join(parsedPath.dir, parsedPath.name).replace(/^src\//u, "");
}
