import { describe, expect, it } from "vitest";

import type {
  ContextCandidate,
  ContextPack,
  ContextRankingEvidence,
  WorkspaceIndex,
} from "../contracts";
import type { RankedContext } from "../ranking";
import {
  createContextRankingEvidence,
  createExpansionCursor,
  expandContextRanking,
} from "./expansion";

const metadata = {
  contractVersion: "1.0",
  generatedAt: "2026-07-11T00:00:00.000Z",
  generator: {
    name: "agent-token-optimizer",
    version: "0.0.0-test",
  },
  operationId: "pack-one",
} as const;

describe("context expansion", () => {
  it("stores full evidence while returning compact bounded pages", () => {
    const rankedContext: RankedContext = {
      selected: [candidate("src/selected.ts", 1, true)],
      excluded: Array.from({ length: 7 }, (_, index) =>
        candidate(`src/fallback-${index + 1}.ts`, index + 2, false),
      ),
    };
    const evidence = createContextRankingEvidence({
      contextPack: contextPack(),
      rankedContext,
      workspaceIndex: workspaceIndex(),
    });
    const firstPage = expandContextRanking({
      evidence,
      cursor: createExpansionCursor("pack-one", 2),
      limit: 3,
    });

    expect(evidence.excluded).toHaveLength(7);
    expect(evidence.excluded[0]?.signals).toHaveLength(1);
    expect(firstPage.candidates.map((item) => item.path)).toEqual([
      "src/fallback-3.ts",
      "src/fallback-4.ts",
      "src/fallback-5.ts",
    ]);
    expect(firstPage.candidates.every((item) => item.signals.length === 0)).toBe(true);
    expect(firstPage).toMatchObject({
      packId: "pack-one",
      hasMore: true,
      remainingCandidateCount: 2,
    });

    const finalPage = expandContextRanking({
      evidence,
      cursor: firstPage.nextCursor ?? "",
      limit: 3,
    });
    expect(finalPage.candidates.map((item) => item.path)).toEqual([
      "src/fallback-6.ts",
      "src/fallback-7.ts",
    ]);
    expect(finalPage).toMatchObject({
      hasMore: false,
      remainingCandidateCount: 0,
    });
    expect(finalPage.nextCursor).toBeUndefined();
  });

  it("rejects cursors from a different pack", () => {
    const evidence: ContextRankingEvidence = {
      metadata,
      packId: "pack-one",
      taskDescription: "Update feature behavior",
      workspaceRootHash: "workspace-hash",
      selected: [],
      excluded: [candidate("src/fallback.ts", 1, false)],
    };

    expect(() =>
      expandContextRanking({
        evidence,
        cursor: createExpansionCursor("pack-two", 0),
        limit: 1,
      }),
    ).toThrow("does not belong");
  });
});

function candidate(path: string, rank: number, selected: boolean): ContextCandidate {
  return {
    path,
    score: 1 / rank,
    rank,
    selected,
    reason: `Ranked candidate ${rank}.`,
    signals: [
      {
        name: "lexical",
        score: 0.5,
        reason: "Matched a task term.",
      },
    ],
    estimatedTokens: 100,
  };
}

function contextPack(): ContextPack {
  return {
    metadata,
    packId: "pack-one",
    task: { description: "Update feature behavior" },
    selected: [],
    excluded: [],
    omittedCandidateCount: 0,
    summaries: [],
    expansionRules: [],
    warnings: [],
  };
}

function workspaceIndex(): WorkspaceIndex {
  return {
    metadata,
    workspace: {
      rootPath: "/workspace/project",
      rootHash: "workspace-hash",
      name: "project",
    },
    files: [],
    totals: {
      filesDiscovered: 0,
      filesIndexed: 0,
      filesIgnored: 0,
      bytesIndexed: 0,
    },
    warnings: [],
  };
}
