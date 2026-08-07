import path from "node:path";

import type {
  ContextCandidate,
  TaskHints,
  WorkspaceAnalysisIndex,
  WorkspaceFile,
  WorkspaceIndex,
} from "../contracts";
import {
  DEFAULT_CONTEXT_RANKING_LIMIT,
  DEFAULT_CONTEXT_SELECTION_THRESHOLD,
  DEFAULT_RECENT_FILE_WINDOW_DAYS,
} from "../config";
import { collectRankingSignals } from "./signals";

export interface RankContextOptions {
  readonly task: string;
  readonly workspaceIndex: WorkspaceIndex;
  readonly workspaceAnalysis?: WorkspaceAnalysisIndex;
  readonly taskHints?: TaskHints;
  readonly limit?: number;
  readonly selectionThreshold?: number;
  readonly recentlyChangedPaths?: readonly string[];
  readonly now?: Date;
  readonly recentFileWindowDays?: number;
}

export interface RankedContext {
  readonly selected: ContextCandidate[];
  readonly excluded: ContextCandidate[];
}

export function rankContext(options: RankContextOptions): RankedContext {
  const limit = options.limit ?? DEFAULT_CONTEXT_RANKING_LIMIT;
  const selectionThreshold =
    options.selectionThreshold ?? DEFAULT_CONTEXT_SELECTION_THRESHOLD;
  const rankableFiles = options.workspaceIndex.files.filter(isRankableFile);
  const workspaceAnalysis = isCompatibleAnalysis(
    options.workspaceAnalysis,
    options.workspaceIndex,
  )
    ? options.workspaceAnalysis
    : undefined;
  const analysisByPath = new Map(
    workspaceAnalysis?.files.map((file) => [file.path, file] as const),
  );
  const rankingContext = {
    task: options.task,
    ...(options.now ? { now: options.now } : {}),
    recentFileWindowDays: options.recentFileWindowDays ?? DEFAULT_RECENT_FILE_WINDOW_DAYS,
    ...(workspaceAnalysis ? { workspaceAnalysis } : {}),
    ...(options.taskHints ? { taskHints: options.taskHints } : {}),
    analysisByPath,
    ...(options.recentlyChangedPaths
      ? { recentlyChangedPaths: new Set(options.recentlyChangedPaths) }
      : {}),
  };
  const preliminaryCandidates = rankableFiles.map((file) =>
    createCandidate(file, rankableFiles, rankingContext),
  );
  const anchorPaths = new Set(
    preliminaryCandidates
      .filter(
        (candidate) =>
          candidate.signals.some(
            (signal) => signal.name === "lexical" && signal.score === 1,
          ) ||
          candidate.signals.some(
            (signal) => signal.name === "bm25" && signal.score >= 0.45,
          ),
      )
      .map((candidate) => candidate.path),
  );
  const candidates = rankableFiles.map((file) =>
    createCandidate(file, rankableFiles, { ...rankingContext, anchorPaths }),
  );
  const explicitPaths = new Set(
    options.taskHints?.paths.map((filePath) => filePath.replaceAll("\\", "/")) ?? [],
  );
  const selectedPaths = selectDiverseCandidates(
    candidates,
    limit,
    selectionThreshold,
    explicitPaths,
  );
  const orderedCandidates = [
    ...candidates
      .filter((candidate) => selectedPaths.has(candidate.path))
      .sort((left, right) => compareSelectedCandidates(left, right, explicitPaths)),
    ...candidates
      .filter((candidate) => !selectedPaths.has(candidate.path))
      .sort(compareCandidates),
  ].map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
    selected: selectedPaths.has(candidate.path),
  }));

  return {
    selected: orderedCandidates.filter((candidate) => candidate.selected),
    excluded: orderedCandidates.filter((candidate) => !candidate.selected),
  };
}

function createCandidate(
  file: WorkspaceFile,
  allFiles: readonly WorkspaceFile[],
  context: {
    readonly task: string;
    readonly now?: Date;
    readonly recentFileWindowDays: number;
    readonly workspaceAnalysis?: WorkspaceAnalysisIndex;
    readonly taskHints?: TaskHints;
    readonly analysisByPath: ReadonlyMap<string, WorkspaceAnalysisIndex["files"][number]>;
    readonly anchorPaths?: ReadonlySet<string>;
    readonly recentlyChangedPaths?: ReadonlySet<string>;
  },
): ContextCandidate {
  const signals = collectRankingSignals({
    task: context.task,
    file,
    allFiles,
    ...(context.now ? { now: context.now } : {}),
    recentFileWindowDays: context.recentFileWindowDays,
    ...(context.workspaceAnalysis
      ? { workspaceAnalysis: context.workspaceAnalysis }
      : {}),
    ...(context.taskHints ? { taskHints: context.taskHints } : {}),
    analysisByPath: context.analysisByPath,
    ...(context.anchorPaths ? { anchorPaths: context.anchorPaths } : {}),
    ...(context.recentlyChangedPaths
      ? { recentlyChangedPaths: context.recentlyChangedPaths }
      : {}),
  });
  const score = Number(
    signals.reduce((total, signal) => total + signal.weightedScore, 0).toFixed(6),
  );
  const dominantSignal = signals.at(0);

  return {
    path: file.path,
    score,
    rank: 1,
    selected: false,
    reason: dominantSignal?.reason ?? "No relevance signal matched this file.",
    signals: signals.map(({ name, score: signalScore, reason }) => ({
      name,
      score: signalScore,
      reason,
    })),
    estimatedTokens: estimateFileTokens(file),
  };
}

function isRankableFile(file: WorkspaceFile): boolean {
  return !file.ignored && file.kind !== "binary" && file.kind !== "generated";
}

function compareCandidates(left: ContextCandidate, right: ContextCandidate): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  return left.path.localeCompare(right.path);
}

function selectDiverseCandidates(
  candidates: readonly ContextCandidate[],
  limit: number,
  selectionThreshold: number,
  explicitPaths: ReadonlySet<string> = new Set(),
): Set<string> {
  const selectedPaths = new Set(
    candidates
      .filter((candidate) => explicitPaths.has(candidate.path))
      .sort(compareCandidates)
      .slice(0, limit)
      .map((candidate) => candidate.path),
  );
  const directoryCounts = new Map<string, number>();

  for (const selectedPath of selectedPaths) {
    const directory = path.posix.dirname(selectedPath);
    directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
  }

  while (selectedPaths.size < limit) {
    const nextCandidate = candidates
      .filter(
        (candidate) =>
          !selectedPaths.has(candidate.path) && candidate.score >= selectionThreshold,
      )
      .sort((left, right) => compareSelectionCandidates(left, right, directoryCounts))[0];

    if (!nextCandidate) {
      break;
    }

    selectedPaths.add(nextCandidate.path);
    const directory = path.posix.dirname(nextCandidate.path);
    directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
  }

  return selectedPaths;
}

function compareSelectionCandidates(
  left: ContextCandidate,
  right: ContextCandidate,
  directoryCounts: ReadonlyMap<string, number> = new Map(),
): number {
  const difference =
    selectionValue(right, directoryCounts) - selectionValue(left, directoryCounts);

  return difference !== 0 ? difference : compareCandidates(left, right);
}

function compareSelectedCandidates(
  left: ContextCandidate,
  right: ContextCandidate,
  explicitPaths: ReadonlySet<string>,
): number {
  const explicitPathDifference =
    Number(explicitPaths.has(right.path)) - Number(explicitPaths.has(left.path));

  return explicitPathDifference !== 0
    ? explicitPathDifference
    : compareSelectionCandidates(left, right);
}

function selectionValue(
  candidate: ContextCandidate,
  directoryCounts: ReadonlyMap<string, number>,
): number {
  const estimatedTokens = candidate.estimatedTokens ?? 0;
  const tokenAdjustedScore = candidate.score / (1 + estimatedTokens / 1_000);
  const directoryCount = directoryCounts.get(path.posix.dirname(candidate.path)) ?? 0;
  const diversityPenalty = 1 / (1 + directoryCount * 0.35);

  return tokenAdjustedScore * diversityPenalty;
}

function isCompatibleAnalysis(
  workspaceAnalysis: WorkspaceAnalysisIndex | undefined,
  workspaceIndex: WorkspaceIndex,
): workspaceAnalysis is WorkspaceAnalysisIndex {
  return workspaceAnalysis?.workspace.rootHash === workspaceIndex.workspace.rootHash;
}

function estimateFileTokens(file: WorkspaceFile): number {
  return Math.ceil(file.sizeBytes / 4);
}
