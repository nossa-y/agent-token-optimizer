import {
  ContextExpansionPageSchema,
  ContextRankingEvidenceSchema,
  type ContextCandidate,
  type ContextExpansionPage,
  type ContextPack,
  type ContextRankingEvidence,
  type WorkspaceIndex,
} from "../contracts";
import type { RankedContext } from "../ranking";

interface ExpansionCursorPayload {
  readonly packId: string;
  readonly offset: number;
}

export function compactContextCandidate(candidate: ContextCandidate): ContextCandidate {
  return {
    path: candidate.path,
    score: candidate.score,
    rank: candidate.rank,
    selected: candidate.selected,
    reason: candidate.reason,
    signals: [],
    ...(candidate.estimatedTokens !== undefined
      ? { estimatedTokens: candidate.estimatedTokens }
      : {}),
  };
}

export function createContextRankingEvidence(input: {
  readonly contextPack: ContextPack;
  readonly rankedContext: RankedContext;
  readonly workspaceIndex: WorkspaceIndex;
}): ContextRankingEvidence {
  if (!input.contextPack.packId) {
    throw new TypeError("Context pack must include a pack identifier.");
  }

  const selectedPaths = new Set(
    (input.contextPack.budget
      ? input.contextPack.selected
      : input.rankedContext.selected
    ).map((candidate) => candidate.path),
  );
  const candidates = [
    ...input.rankedContext.selected,
    ...input.rankedContext.excluded,
  ].sort((left, right) => left.rank - right.rank);

  return ContextRankingEvidenceSchema.parse({
    metadata: input.contextPack.metadata,
    packId: input.contextPack.packId,
    taskDescription: input.contextPack.task.description,
    workspaceRootHash: input.workspaceIndex.workspace.rootHash,
    selected: candidates
      .filter((candidate) => selectedPaths.has(candidate.path))
      .map((candidate) => ({ ...candidate, selected: true })),
    excluded: candidates
      .filter((candidate) => !selectedPaths.has(candidate.path))
      .map((candidate) => ({ ...candidate, selected: false })),
  });
}

export function createExpansionCursor(packId: string, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("Expansion cursor offset must be a non-negative safe integer.");
  }

  return Buffer.from(JSON.stringify({ packId, offset }), "utf8").toString("base64url");
}

export function expandContextRanking(input: {
  readonly evidence: ContextRankingEvidence;
  readonly cursor: string;
  readonly limit: number;
}): ContextExpansionPage {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new TypeError("Expansion limit must be a positive safe integer.");
  }

  const cursor = parseExpansionCursor(input.cursor);

  if (cursor.packId !== input.evidence.packId) {
    throw new TypeError("Expansion cursor does not belong to this context pack.");
  }

  if (cursor.offset > input.evidence.excluded.length) {
    throw new TypeError("Expansion cursor is outside the candidate range.");
  }

  const endOffset = Math.min(cursor.offset + input.limit, input.evidence.excluded.length);
  const candidates = input.evidence.excluded
    .slice(cursor.offset, endOffset)
    .map(compactContextCandidate);
  const remainingCandidateCount = input.evidence.excluded.length - endOffset;
  const hasMore = remainingCandidateCount > 0;

  return ContextExpansionPageSchema.parse({
    packId: input.evidence.packId,
    candidates,
    hasMore,
    ...(hasMore
      ? { nextCursor: createExpansionCursor(input.evidence.packId, endOffset) }
      : {}),
    remainingCandidateCount,
  });
}

function parseExpansionCursor(cursor: string): ExpansionCursorPayload {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("packId" in parsed) ||
      typeof parsed.packId !== "string" ||
      !("offset" in parsed) ||
      typeof parsed.offset !== "number" ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new TypeError("Invalid expansion cursor payload.");
    }

    return { packId: parsed.packId, offset: parsed.offset };
  } catch (error) {
    throw new TypeError("Expansion cursor is invalid.", { cause: error });
  }
}
