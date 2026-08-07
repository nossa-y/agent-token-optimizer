import { describe, expect, it } from "vitest";

import type { ContractMetadata, TokenLedger, TokenLedgerEntry } from "../contracts";
import { mergeTokenLedger, summarizeTokenLedger } from "./ledger";

const metadata: ContractMetadata = {
  contractVersion: "1.0",
  generatedAt: "2026-07-11T00:00:00.000Z",
  generator: {
    name: "agent-token-optimizer",
    version: "0.0.0-test",
  },
  operationId: "ledger-test",
};

describe("token ledger", () => {
  it("merges entries by stable ID and keeps deterministic ordering", () => {
    const firstEntry = knownOptimizerEntry(
      "optimizer:one",
      "2026-07-11T00:00:01.000Z",
      40,
    );
    const replacementEntry = knownOptimizerEntry(
      "optimizer:one",
      "2026-07-11T00:00:01.000Z",
      50,
    );
    const earlierEntry: TokenLedgerEntry = {
      entryId: "agent:one",
      recordedAt: "2026-07-11T00:00:00.000Z",
      kind: "agent_run",
      status: "unknown",
      unknownReason: "Provider usage was unavailable.",
    };
    const initial = mergeTokenLedger({
      metadata,
      runId: "run-one",
      taskId: "task-one",
      entries: [firstEntry],
    });
    const merged = mergeTokenLedger({
      metadata,
      runId: "run-one",
      existing: initial,
      entries: [
        replacementEntry,
        {
          entryId: "optimizer:one",
          recordedAt: "2026-07-11T00:00:02.000Z",
          kind: "optimizer_call",
          status: "unknown",
          toolName: "build_context_pack",
          unknownReason: "A later duplicate omitted usage.",
        },
        earlierEntry,
      ],
    });

    expect(merged.entries.map((entry) => entry.entryId)).toEqual([
      "agent:one",
      "optimizer:one",
    ]);
    expect(merged.entries[1]).toMatchObject({
      status: "known",
      overhead: { totalTokens: 50 },
    });
    expect(merged.taskId).toBe("task-one");
  });

  it("rejects reuse of a run identifier for a different task", () => {
    const existing = mergeTokenLedger({
      metadata,
      runId: "shared-run",
      taskId: "task-one",
      entries: [
        {
          entryId: "agent:one",
          recordedAt: "2026-07-11T00:00:00.000Z",
          kind: "agent_run",
          status: "unknown",
          unknownReason: "Provider usage was unavailable.",
        },
      ],
    });

    expect(() =>
      mergeTokenLedger({
        metadata,
        runId: "shared-run",
        taskId: "task-two",
        existing,
        entries: [],
      }),
    ).toThrow("different task identifiers");
  });

  it("keeps observed, estimated, overhead, and unknown usage separate", () => {
    const ledger: TokenLedger = {
      metadata,
      runId: "run-summary",
      entries: [
        knownOptimizerEntry("optimizer:known", "2026-07-11T00:00:00.000Z", 100),
        {
          entryId: "optimizer:unknown",
          recordedAt: "2026-07-11T00:00:01.000Z",
          kind: "optimizer_call",
          status: "unknown",
          toolName: "build_context_pack",
          unknownReason: "Tool response usage was not captured.",
        },
        {
          entryId: "agent:observed",
          recordedAt: "2026-07-11T00:00:02.000Z",
          kind: "agent_run",
          status: "known",
          accounting: {
            observed: {
              source: "provider",
              breakdown: {
                agentInputTokens: 1000,
                cachedInputTokens: 400,
                agentOutputTokens: 200,
              },
              totalTokens: 1200,
            },
          },
        },
        {
          entryId: "agent:estimated",
          recordedAt: "2026-07-11T00:00:03.000Z",
          kind: "agent_run",
          status: "known",
          accounting: {
            estimated: {
              source: "local_estimator",
              method: "approximate",
              confidence: "medium",
              breakdown: {
                agentInputTokens: 500,
                agentOutputTokens: 100,
              },
              totalTokens: 600,
            },
          },
        },
        {
          entryId: "agent:unknown",
          recordedAt: "2026-07-11T00:00:04.000Z",
          kind: "agent_run",
          status: "unknown",
          unknownReason: "Agent usage was not reported.",
        },
      ],
    };

    expect(summarizeTokenLedger(ledger)).toEqual({
      complete: false,
      knownEntries: 3,
      unknownEntries: 2,
      agentRuns: 3,
      optimizerCalls: 2,
      observedConsumedTokens: 1200,
      estimatedConsumedTokens: 600,
      optimizerOverheadTokens: 100,
    });
  });

  it("does not report zero usage when every entry is unknown", () => {
    const ledger: TokenLedger = {
      metadata,
      runId: "run-unknown",
      entries: [
        {
          entryId: "agent:unknown",
          recordedAt: "2026-07-11T00:00:00.000Z",
          kind: "agent_run",
          status: "unknown",
          unknownReason: "Provider usage was unavailable.",
        },
      ],
    };

    expect(summarizeTokenLedger(ledger)).toEqual({
      complete: false,
      knownEntries: 0,
      unknownEntries: 1,
      agentRuns: 1,
      optimizerCalls: 0,
    });
  });
});

function knownOptimizerEntry(
  entryId: string,
  recordedAt: string,
  totalTokens: number,
): TokenLedgerEntry {
  return {
    entryId,
    recordedAt,
    kind: "optimizer_call",
    status: "known",
    toolName: "build_context_pack",
    overhead: {
      requestTokens: 10,
      responseTokens: totalTokens - 10,
      totalTokens,
      method: "exact",
      confidence: "high",
    },
  };
}
