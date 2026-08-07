import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  ContextCandidate,
  ContextPack,
  FileSummary,
  TaskAnalysis,
  Warning,
  WorkspaceIndex,
} from "../contracts";
import {
  DEFAULT_CONTEXT_FALLBACK_LIMIT,
  DEFAULT_CONTEXT_RESPONSE_TOKEN_BUDGET,
  DEFAULT_CONTEXT_SUMMARY_MAX_CHARS,
  DEFAULT_RECOMMENDED_CONTENT_TOKEN_BUDGET,
} from "../config";
import { rankContext, type RankedContext } from "../ranking";
import { redactText } from "../redaction";
import { createWorkspacePathPolicy } from "../security";
import { estimateSerializedTokens } from "../token";
import { compactContextCandidate, createExpansionCursor } from "./expansion";
import { buildStructuralSummary } from "./summary";

export interface BuildContextPackOptions {
  readonly task: string;
  readonly workspaceIndex: WorkspaceIndex;
  readonly rankedContext?: RankedContext;
  readonly packageVersion?: string;
  readonly taskAnalysis?: TaskAnalysis;
  readonly cachedSummaries?: ReadonlyMap<string, FileSummary>;
  readonly operationId?: string;
  readonly modelHint?: string;
  readonly summaryMaxChars?: number;
  readonly fallbackLimit?: number;
  readonly responseTokenBudget?: number;
  readonly recommendedContentTokenBudget?: number;
  readonly includeSummaries?: boolean;
  readonly now?: Date;
}

export async function buildContextPack(
  options: BuildContextPackOptions,
): Promise<ContextPack> {
  const rankedContext =
    options.rankedContext ??
    rankContext({
      task: options.task,
      workspaceIndex: options.workspaceIndex,
      ...(options.now ? { now: options.now } : {}),
    });
  const warnings: Warning[] = [];
  const generatedAt = (options.now ?? new Date()).toISOString();
  const packId = createPackId(options, generatedAt);
  const fallbackLimit = options.fallbackLimit ?? DEFAULT_CONTEXT_FALLBACK_LIMIT;
  const responseTokenBudget =
    options.responseTokenBudget ?? DEFAULT_CONTEXT_RESPONSE_TOKEN_BUDGET;
  const recommendedContentTokenBudget =
    options.recommendedContentTokenBudget ?? DEFAULT_RECOMMENDED_CONTENT_TOKEN_BUDGET;
  assertPositiveBudget(responseTokenBudget, "responseTokenBudget");
  assertPositiveBudget(recommendedContentTokenBudget, "recommendedContentTokenBudget");
  const contentSelection = selectWithinContentBudget(
    rankedContext.selected,
    recommendedContentTokenBudget,
  );
  const selected = contentSelection.selected.map(compactContextCandidate);
  const responseDeferred: ContextCandidate[] = [];
  const contentDeferred = contentSelection.deferred.map(asExcludedCandidate);
  const rankedExcluded = rankedContext.excluded.map(asExcludedCandidate);
  let expansionCandidates = [...contentDeferred, ...rankedExcluded];
  const excluded = expansionCandidates
    .slice(0, fallbackLimit)
    .map(compactContextCandidate);
  const summaries =
    options.includeSummaries === false
      ? []
      : await buildSummaries({
          workspaceIndex: options.workspaceIndex,
          selected: contentSelection.selected,
          task: options.task,
          ...(options.cachedSummaries
            ? { cachedSummaries: options.cachedSummaries }
            : {}),
          summaryMaxChars: options.summaryMaxChars ?? DEFAULT_CONTEXT_SUMMARY_MAX_CHARS,
          warnings,
        });
  if (contentDeferred.length > 0) {
    warnings.push({
      code: "recommended_content_budget_exhausted",
      message:
        "Some ranked files were deferred to keep recommended content within budget.",
      severity: "warn",
      recoverable: true,
    });
  }

  const contextPack: ContextPack = {
    metadata: {
      contractVersion: "1.0",
      generatedAt,
      generator: {
        name: "agent-token-optimizer",
        version: options.packageVersion ?? "0.1.0",
      },
      ...(options.operationId ? { operationId: options.operationId } : {}),
    },
    packId,
    task: {
      description: options.task,
      ...(options.taskAnalysis ? { analysis: options.taskAnalysis } : {}),
    },
    selected,
    excluded,
    omittedCandidateCount: 0,
    expansion: { hasMore: false },
    summaries,
    budget: {
      response: {
        limitTokens: responseTokenBudget,
        usedTokens: 0,
        exhausted: false,
      },
      recommendedContent: {
        limitTokens: recommendedContentTokenBudget,
        usedTokens: selectedContentTokens(selected),
        exhausted: contentDeferred.length > 0,
      },
    },
    expansionRules: [],
    warnings,
  };
  const budget = contextPack.budget!;

  finalizeContextPack(contextPack, expansionCandidates, options.modelHint);

  if (budget.response.usedTokens > responseTokenBudget) {
    contextPack.warnings.push({
      code: "response_budget_exhausted",
      message: "Context pack detail was reduced to fit the response budget.",
      severity: "warn",
      recoverable: true,
    });
    budget.response.exhausted = true;

    while (budget.response.usedTokens > responseTokenBudget) {
      if (contextPack.excluded.length > 0) {
        contextPack.excluded.pop();
      } else if (contextPack.summaries.length > 0) {
        contextPack.summaries.pop();
      } else if (contextPack.selected.length > 0) {
        const deferred = contextPack.selected.pop();

        if (deferred) {
          responseDeferred.unshift(asExcludedCandidate(deferred));
          expansionCandidates = [
            ...responseDeferred,
            ...contentDeferred,
            ...rankedExcluded,
          ];
          budget.recommendedContent.usedTokens = selectedContentTokens(
            contextPack.selected,
          );
        }
      } else {
        throw new RangeError(
          `responseTokenBudget is too small for the mandatory context pack envelope; requires ${budget.response.usedTokens} tokens.`,
        );
      }

      finalizeContextPack(contextPack, expansionCandidates, options.modelHint);
    }
  }

  return contextPack;
}

function selectWithinContentBudget(
  candidates: readonly ContextCandidate[],
  limitTokens: number,
): { selected: ContextCandidate[]; deferred: ContextCandidate[] } {
  const selected: ContextCandidate[] = [];
  const deferred: ContextCandidate[] = [];
  let usedTokens = 0;

  for (const candidate of candidates) {
    const candidateTokens = candidate.estimatedTokens ?? 0;

    if (usedTokens + candidateTokens <= limitTokens) {
      selected.push(candidate);
      usedTokens += candidateTokens;
    } else {
      deferred.push(candidate);
    }
  }

  return { selected, deferred };
}

function asExcludedCandidate(candidate: ContextCandidate): ContextCandidate {
  return { ...candidate, selected: false };
}

function selectedContentTokens(candidates: readonly ContextCandidate[]): number {
  return candidates.reduce(
    (total, candidate) => total + (candidate.estimatedTokens ?? 0),
    0,
  );
}

function assertPositiveBudget(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function finalizeContextPack(
  contextPack: ContextPack,
  expansionCandidates: readonly ContextCandidate[],
  modelHint?: string,
): void {
  const omittedCandidateCount = Math.max(
    0,
    expansionCandidates.length - contextPack.excluded.length,
  );
  contextPack.omittedCandidateCount = omittedCandidateCount;
  contextPack.expansion = {
    hasMore: omittedCandidateCount > 0,
    ...(omittedCandidateCount > 0 && contextPack.packId
      ? {
          nextCursor: createExpansionCursor(
            contextPack.packId,
            contextPack.excluded.length,
          ),
        }
      : {}),
  };
  contextPack.expansionRules = createExpansionRules(
    contextPack.selected,
    expansionCandidates,
    omittedCandidateCount,
  );

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const usedTokens = estimateSerializedTokens(contextPack);
    contextPack.budget!.response.usedTokens = usedTokens;
    contextPack.tokenEstimate = {
      ...(modelHint ? { modelHint } : {}),
      inputTokens: usedTokens,
      totalTokens: usedTokens,
      method: "approximate",
      confidence: "medium",
    };
  }

  contextPack.budget!.response.usedTokens = estimateSerializedTokens(contextPack);
  contextPack.tokenEstimate!.inputTokens = contextPack.budget!.response.usedTokens;
  contextPack.tokenEstimate!.totalTokens = contextPack.budget!.response.usedTokens;
}

function createPackId(options: BuildContextPackOptions, generatedAt: string): string {
  if (options.operationId) {
    return options.operationId;
  }

  return createHash("sha256")
    .update(options.workspaceIndex.workspace.rootHash)
    .update("\0")
    .update(options.task)
    .update("\0")
    .update(generatedAt)
    .digest("hex");
}

async function buildSummaries(input: {
  readonly workspaceIndex: WorkspaceIndex;
  readonly selected: readonly ContextCandidate[];
  readonly task: string;
  readonly cachedSummaries?: ReadonlyMap<string, FileSummary>;
  readonly summaryMaxChars: number;
  readonly warnings: Warning[];
}): Promise<FileSummary[]> {
  const pathPolicy = await createWorkspacePathPolicy(
    input.workspaceIndex.workspace.rootPath,
  );
  const fileByPath = new Map(
    input.workspaceIndex.files.map((file) => [file.path, file] as const),
  );
  const summaries: FileSummary[] = [];

  for (const candidate of input.selected) {
    const file = fileByPath.get(candidate.path);

    if (!file || file.ignored) {
      input.warnings.push({
        code: "summary_file_unavailable",
        message: "Skipped summary because the selected file is unavailable.",
        severity: "warn",
        path: candidate.path,
        recoverable: true,
      });
      continue;
    }

    const cachedSummary = input.cachedSummaries?.get(candidate.path);

    if (
      cachedSummary &&
      file.contentHash !== undefined &&
      cachedSummary.contentHash === file.contentHash
    ) {
      summaries.push(cachedSummary);
      continue;
    }

    try {
      const absolutePath = pathPolicy.resolveWorkspacePath(candidate.path);
      const content = await readFile(absolutePath, "utf8");
      const redacted = redactText(content);
      const structuralSummary = buildStructuralSummary({
        content: redacted.text,
        file,
        task: input.task,
        maxChars: input.summaryMaxChars,
      });

      summaries.push({
        path: candidate.path,
        ...(file.contentHash ? { contentHash: file.contentHash } : {}),
        ...structuralSummary,
        warnings: [],
        redactions: redacted.redactions,
      });
    } catch {
      input.warnings.push({
        code: "summary_read_failed",
        message: "Skipped summary because the selected file could not be read as text.",
        severity: "warn",
        path: candidate.path,
        recoverable: true,
      });
    }
  }

  return summaries;
}

function createExpansionRules(
  selected: readonly ContextCandidate[],
  excluded: readonly ContextCandidate[],
  omittedCandidateCount: number,
): string[] {
  const rules = [
    "Start with the selected files before reading broader repository context.",
    "Expand only when selected files do not explain the task or tests point elsewhere.",
  ];

  if (selected.length === 0 && excluded.length > 0) {
    rules.push(
      "No files met the selection threshold; inspect the highest-ranked excluded files first.",
    );
  }

  if (excluded.length > 0) {
    rules.push("Use the bounded fallback candidates before broad filesystem scans.");
  }

  if (omittedCandidateCount > 0) {
    rules.push(
      "Use expand_context with expansion.nextCursor when the selected and fallback candidates are insufficient.",
    );
  }

  return rules;
}
