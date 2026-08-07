import { describe, expect, it } from "vitest";

import type { WorkspaceAnalysisIndex, WorkspaceIndex } from "../contracts";
import { rankContext } from "./rank-context";

const workspaceIndex: WorkspaceIndex = {
  metadata: {
    contractVersion: "1.0",
    generatedAt: "2026-07-05T00:00:00.000Z",
    generator: {
      name: "agent-token-optimizer",
      version: "0.0.0",
    },
  },
  workspace: {
    rootPath: "/workspace/project",
    rootHash: "workspace-hash",
    name: "project",
  },
  files: [
    {
      path: "src/auth/session.ts",
      kind: "source",
      language: "typescript",
      sizeBytes: 400,
      modifiedAt: "2026-07-04T00:00:00.000Z",
      generated: false,
      ignored: false,
    },
    {
      path: "src/auth/session.test.ts",
      kind: "test",
      language: "typescript",
      sizeBytes: 300,
      modifiedAt: "2026-07-04T00:00:00.000Z",
      generated: false,
      ignored: false,
    },
    {
      path: "src/billing/invoice.ts",
      kind: "source",
      language: "typescript",
      sizeBytes: 500,
      modifiedAt: "2026-01-01T00:00:00.000Z",
      generated: false,
      ignored: false,
    },
    {
      path: "README.md",
      kind: "documentation",
      language: "markdown",
      sizeBytes: 200,
      generated: false,
      ignored: false,
    },
    {
      path: "dist/generated.js",
      kind: "generated",
      language: "javascript",
      sizeBytes: 100,
      generated: true,
      ignored: false,
    },
    {
      path: "secrets.env",
      kind: "unknown",
      sizeBytes: 50,
      generated: false,
      ignored: true,
      ignoreReason: "gitignore",
    },
  ],
  totals: {
    filesDiscovered: 6,
    filesIndexed: 4,
    filesIgnored: 2,
    bytesIndexed: 1400,
  },
  warnings: [],
};

describe("rankContext", () => {
  it("selects and ranks relevant source and test files deterministically", () => {
    const result = rankContext({
      task: "Fix the failing auth session test",
      workspaceIndex,
      now: new Date("2026-07-05T00:00:00.000Z"),
      limit: 2,
    });

    expect(result.selected.map((candidate) => candidate.path)).toEqual([
      "src/auth/session.test.ts",
      "src/auth/session.ts",
    ]);
    expect(result.selected[0]?.rank).toBe(1);
    expect(result.selected[0]?.signals.map((signal) => signal.name)).toContain("lexical");
    expect(result.selected[0]?.reason).toContain("Matched task terms");
  });

  it("excludes generated and ignored files from ranking", () => {
    const result = rankContext({
      task: "Fix generated secret handling",
      workspaceIndex,
    });
    const allCandidatePaths = [...result.selected, ...result.excluded].map(
      (candidate) => candidate.path,
    );

    expect(allCandidatePaths).not.toContain("dist/generated.js");
    expect(allCandidatePaths).not.toContain("secrets.env");
  });

  it("keeps low-scoring files excluded when below threshold", () => {
    const result = rankContext({
      task: "Update auth session behavior",
      workspaceIndex,
      selectionThreshold: 0.5,
      now: new Date("2026-07-05T00:00:00.000Z"),
    });

    expect(result.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "README.md",
          selected: false,
        }),
      ]),
    );
  });

  it("always selects an explicitly named workspace path within the limit", () => {
    const result = rankContext({
      task: "Fix packages/billing/src/invoice-format.ts",
      workspaceIndex: hybridWorkspaceIndex,
      workspaceAnalysis: hybridWorkspaceAnalysis,
      taskHints: {
        paths: ["packages/billing/src/invoice-format.ts"],
        symbols: [],
        testNames: [],
        errorMessages: [],
        stackFrames: [],
        packageNames: [],
        operation: "fix",
      },
      limit: 2,
      selectionThreshold: 0,
    });

    expect(result.selected[0]?.path).toBe("packages/billing/src/invoice-format.ts");
    expect(result.selected).toHaveLength(2);
  });

  it("retrieves exact symbols plus dependency-linked and test-linked files from the analysis index", () => {
    const result = rankContext({
      task: "Fix create invoice calculation test",
      workspaceIndex: hybridWorkspaceIndex,
      workspaceAnalysis: hybridWorkspaceAnalysis,
      limit: 3,
      selectionThreshold: 0.05,
    });

    expect(result.selected.map((candidate) => candidate.path)).toEqual(
      expect.arrayContaining([
        "packages/billing/src/invoice.ts",
        "packages/billing/src/invoice.test.ts",
        "packages/shared/src/currency.ts",
      ]),
    );
    expect(
      result.selected
        .find((candidate) => candidate.path === "packages/billing/src/invoice.ts")
        ?.signals.some(
          (signal) =>
            signal.name === "lexical" && signal.reason.includes("Exact path or symbol"),
        ),
    ).toBe(true);
    expect(
      result.selected
        .find((candidate) => candidate.path === "packages/shared/src/currency.ts")
        ?.signals.some((signal) => signal.name === "dependency" && signal.score === 1),
    ).toBe(true);
  });
});

const hybridWorkspaceIndex: WorkspaceIndex = {
  ...workspaceIndex,
  workspace: {
    rootPath: "/workspace/hybrid",
    rootHash: "hybrid-workspace-hash",
    name: "hybrid",
  },
  files: [
    workspaceFile("packages/billing/src/invoice.ts", "source", 900),
    workspaceFile("packages/billing/src/invoice.test.ts", "test", 400),
    workspaceFile("packages/shared/src/currency.ts", "source", 250),
    workspaceFile("packages/billing/src/invoice-format.ts", "source", 1_600),
  ],
  totals: {
    filesDiscovered: 4,
    filesIndexed: 4,
    filesIgnored: 0,
    bytesIndexed: 3_150,
  },
};

const hybridWorkspaceAnalysis: WorkspaceAnalysisIndex = {
  metadata: workspaceIndex.metadata,
  indexVersion: 1,
  workspace: { rootHash: "hybrid-workspace-hash", name: "hybrid" },
  files: [
    analysisFile("packages/billing/src/invoice.ts", {
      symbols: [
        {
          name: "createInvoice",
          kind: "function",
          exported: true,
          signature: "export function createInvoice(): Invoice",
        },
      ],
      lexicalTerms: ["create", "invoice", "calculation"],
      internalDependencies: ["packages/shared/src/currency.ts"],
    }),
    analysisFile("packages/billing/src/invoice.test.ts", {
      lexicalTerms: ["invoice", "test", "calculation"],
      testTargets: ["packages/billing/src/invoice.ts"],
    }),
    analysisFile("packages/shared/src/currency.ts", {
      lexicalTerms: ["currency", "rounding"],
    }),
    analysisFile("packages/billing/src/invoice-format.ts", {
      lexicalTerms: ["invoice", "format"],
    }),
  ],
  documentFrequencies: {
    calculation: 2,
    create: 1,
    currency: 1,
    format: 1,
    invoice: 3,
    rounding: 1,
    test: 1,
  },
  statistics: {
    analyzedFiles: 4,
    fallbackFiles: 0,
    skippedFiles: 0,
    reusedFiles: 0,
    changedFiles: 4,
    deletedFiles: 0,
  },
};

function workspaceFile(
  path: string,
  kind: "source" | "test",
  sizeBytes: number,
): WorkspaceIndex["files"][number] {
  return {
    path,
    kind,
    language: "typescript",
    sizeBytes,
    generated: false,
    ignored: false,
  };
}

function analysisFile(
  path: string,
  input: Partial<WorkspaceAnalysisIndex["files"][number]> = {},
): WorkspaceAnalysisIndex["files"][number] {
  return {
    path,
    language: "typescript",
    analysisMethod: "typescript_ast",
    symbols: [],
    imports: [],
    internalDependencies: [],
    testTargets: [],
    lexicalTerms: [],
    ownership: { workspaceName: "hybrid", packagePath: "packages/billing" },
    policy: {
      kind: path.endsWith(".test.ts") ? "test" : "source",
      generated: false,
      ignored: false,
    },
    ...input,
  };
}
