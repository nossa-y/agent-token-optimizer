import {
  TokenLedgerSchema,
  type ContractMetadata,
  type TokenLedger,
  type TokenLedgerEntry,
} from "../contracts";

export interface TokenLedgerSummary {
  readonly complete: boolean;
  readonly knownEntries: number;
  readonly unknownEntries: number;
  readonly agentRuns: number;
  readonly optimizerCalls: number;
  readonly observedConsumedTokens?: number;
  readonly estimatedConsumedTokens?: number;
  readonly optimizerOverheadTokens?: number;
}

export function mergeTokenLedger(input: {
  readonly metadata: ContractMetadata;
  readonly runId: string;
  readonly taskId?: string;
  readonly existing?: TokenLedger;
  readonly entries: readonly TokenLedgerEntry[];
}): TokenLedger {
  if (input.existing && input.existing.runId !== input.runId) {
    throw new TypeError("Cannot merge token ledgers with different run identifiers.");
  }

  if (input.existing?.taskId && input.taskId && input.existing.taskId !== input.taskId) {
    throw new TypeError("Cannot merge token ledgers with different task identifiers.");
  }

  const entriesById = new Map(
    input.existing?.entries.map((entry) => [entry.entryId, entry] as const) ?? [],
  );

  for (const entry of input.entries) {
    const existingEntry = entriesById.get(entry.entryId);

    if (existingEntry && existingEntry.kind !== entry.kind) {
      throw new TypeError("Cannot merge token ledger entries with conflicting kinds.");
    }

    if (existingEntry?.status === "known" && entry.status === "unknown") {
      continue;
    }

    entriesById.set(entry.entryId, entry);
  }

  return TokenLedgerSchema.parse({
    metadata: input.metadata,
    runId: input.runId,
    ...((input.taskId ?? input.existing?.taskId)
      ? { taskId: input.taskId ?? input.existing?.taskId }
      : {}),
    entries: [...entriesById.values()].sort(compareLedgerEntries),
  });
}

export function summarizeTokenLedger(ledger: TokenLedger): TokenLedgerSummary {
  let knownEntries = 0;
  let unknownEntries = 0;
  let agentRuns = 0;
  let optimizerCalls = 0;
  const observedTotals: number[] = [];
  const estimatedTotals: number[] = [];
  const optimizerTotals: number[] = [];

  for (const entry of ledger.entries) {
    if (entry.kind === "agent_run") {
      agentRuns += 1;
    } else {
      optimizerCalls += 1;
    }

    if (entry.status === "unknown") {
      unknownEntries += 1;
      continue;
    }

    knownEntries += 1;

    if (entry.kind === "optimizer_call") {
      optimizerTotals.push(entry.overhead.totalTokens);
      continue;
    }

    if (entry.accounting.observed) {
      observedTotals.push(entry.accounting.observed.totalTokens);
    } else if (entry.accounting.estimated) {
      estimatedTotals.push(entry.accounting.estimated.totalTokens);
    }
  }

  return {
    complete: unknownEntries === 0,
    knownEntries,
    unknownEntries,
    agentRuns,
    optimizerCalls,
    ...optionalSum("observedConsumedTokens", observedTotals),
    ...optionalSum("estimatedConsumedTokens", estimatedTotals),
    ...optionalSum("optimizerOverheadTokens", optimizerTotals),
  };
}

function compareLedgerEntries(left: TokenLedgerEntry, right: TokenLedgerEntry): number {
  const timestampOrder = left.recordedAt.localeCompare(right.recordedAt);
  return timestampOrder !== 0
    ? timestampOrder
    : left.entryId.localeCompare(right.entryId);
}

function optionalSum<TKey extends string>(
  key: TKey,
  values: readonly number[],
): Record<TKey, number> | Record<string, never> {
  if (values.length === 0) {
    return {};
  }

  return { [key]: values.reduce((total, value) => total + value, 0) } as Record<
    TKey,
    number
  >;
}
