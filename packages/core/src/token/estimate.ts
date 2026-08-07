import type { ContextCandidate, FileSummary, TokenEstimate } from "../contracts";

export interface EstimateContextTokensInput {
  readonly task: string;
  readonly selected: readonly ContextCandidate[];
  readonly excluded: readonly ContextCandidate[];
  readonly summaries: readonly FileSummary[];
  readonly modelHint?: string;
}

export function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

export function estimateSerializedTokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value));
}

export function estimateContextPackTokens(
  input: EstimateContextTokensInput,
): TokenEstimate {
  const candidateTokens = [...input.selected, ...input.excluded].reduce(
    (total, candidate) => total + estimateCandidateTokens(candidate),
    0,
  );
  const summaryTokens = input.summaries.reduce(
    (total, summary) => total + estimateTextTokens(summary.summary),
    0,
  );
  const inputTokens = estimateTextTokens(input.task) + candidateTokens + summaryTokens;

  return {
    ...(input.modelHint ? { modelHint: input.modelHint } : {}),
    inputTokens,
    totalTokens: inputTokens,
    method: "approximate",
    confidence: "medium",
  };
}

function estimateCandidateTokens(candidate: ContextCandidate): number {
  return (
    estimateTextTokens(candidate.path) +
    estimateTextTokens(candidate.reason) +
    (candidate.estimatedTokens ?? 0)
  );
}
