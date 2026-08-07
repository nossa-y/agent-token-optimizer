import { describe, expect, it } from "vitest";

import type { WorkspaceAnalysisIndex, WorkspaceIndex } from "../contracts";
import { assessTask, extractTaskHints } from "./index";

const workspaceIndex: WorkspaceIndex = {
  metadata: {
    contractVersion: "1.0",
    generatedAt: "2026-07-12T00:00:00.000Z",
    generator: { name: "agent-token-optimizer", version: "0.0.0-test" },
  },
  workspace: {
    rootPath: "/workspace/project",
    rootHash: "workspace-hash",
    name: "project",
  },
  files: [
    file("src/auth/session.ts", "source"),
    file("src/auth/session.test.ts", "test"),
    file("src/auth/token.ts", "source"),
  ],
  totals: { filesDiscovered: 3, filesIndexed: 3, filesIgnored: 0, bytesIndexed: 300 },
  warnings: [],
};

const workspaceAnalysis: WorkspaceAnalysisIndex = {
  metadata: workspaceIndex.metadata,
  indexVersion: 1,
  workspace: { rootHash: "workspace-hash", name: "project" },
  files: [
    analysis("src/auth/session.ts", {
      symbols: [
        {
          name: "createSession",
          kind: "function",
          exported: true,
          signature: "export function createSession(): Session",
        },
      ],
      internalDependencies: ["src/auth/token.ts"],
    }),
    analysis("src/auth/session.test.ts", { testTargets: ["src/auth/session.ts"] }),
    analysis("src/auth/token.ts"),
  ],
  documentFrequencies: {},
  statistics: {
    analyzedFiles: 3,
    fallbackFiles: 0,
    skippedFiles: 0,
    reusedFiles: 0,
    changedFiles: 3,
    deletedFiles: 0,
  },
};

describe("task analysis", () => {
  it("extracts workspace paths, symbols, errors, stack frames, and operation hints", () => {
    const hints = extractTaskHints(
      "Fix TypeError: bad token in src/auth/session.ts:42 using createSession and add a test",
      workspaceIndex,
      workspaceAnalysis,
    );

    expect(hints.paths).toContain("src/auth/session.ts");
    expect(hints.symbols).toContain("createSession");
    expect(hints.errorMessages[0]).toContain("TypeError");
    expect(hints.stackFrames).toContain("src/auth/session.ts:42");
    expect(hints.operation).toBe("test");
  });

  it("uses linked workspace scope rather than only word count", () => {
    const assessment = assessTask({
      task: "Fix createSession in src/auth/session.ts",
      workspaceIndex,
      workspaceAnalysis,
    });

    expect(assessment.complexity).toBe("medium");
    expect(assessment.risk).toBe("high");
    expect(assessment.mode).toBe("context_pack_with_summaries");
    expect(assessment.reason).toContain("workspace file(s) in scope");
  });
});

function file(path: string, kind: "source" | "test"): WorkspaceIndex["files"][number] {
  return {
    path,
    kind,
    language: "typescript",
    sizeBytes: 100,
    generated: false,
    ignored: false,
  };
}

function analysis(
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
    ownership: { workspaceName: "project", packagePath: "." },
    policy: {
      kind: path.endsWith(".test.ts") ? "test" : "source",
      generated: false,
      ignored: false,
    },
    ...input,
  };
}
