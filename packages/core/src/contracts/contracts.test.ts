import { describe, expect, it } from "vitest";

import {
  ContextPackSchema,
  HostAdapterConfigSchema,
  RelativePathSchema,
  RunMetricSchema,
  WorkflowTokenAccountingSchema,
  WorkspaceIndexSchema,
} from "./index";

const metadata = {
  contractVersion: "1.0",
  generatedAt: "2026-07-05T00:00:00.000Z",
  generator: {
    name: "agent-token-optimizer",
    version: "0.0.0",
  },
} as const;

describe("core contracts", () => {
  it("parses a valid workspace index", () => {
    const parsed = WorkspaceIndexSchema.parse({
      metadata,
      workspace: {
        rootPath: "/workspace/project",
        rootHash: "workspace-hash",
        name: "project",
      },
      files: [
        {
          path: "src/index.ts",
          kind: "source",
          language: "typescript",
          sizeBytes: 128,
        },
      ],
      totals: {
        filesDiscovered: 1,
        filesIndexed: 1,
        filesIgnored: 0,
        bytesIndexed: 128,
      },
    });

    expect(parsed.files).toHaveLength(1);
    expect(parsed.warnings).toEqual([]);
  });

  it("rejects relative path traversal", () => {
    const result = RelativePathSchema.safeParse("../secrets.env");

    expect(result.success).toBe(false);
  });

  it("parses a valid context pack with selected candidates", () => {
    const parsed = ContextPackSchema.parse({
      metadata,
      task: {
        description: "Fix the auth redirect test.",
      },
      selected: [
        {
          path: "src/auth/session.ts",
          score: 0.91,
          rank: 1,
          selected: true,
          reason: "Auth session logic is directly named in the task.",
        },
      ],
      expansionRules: [
        "Search tests only if the selected file does not explain failure.",
      ],
    });

    expect(parsed.selected[0]?.path).toBe("src/auth/session.ts");
    expect(parsed.excluded).toEqual([]);
  });

  it("requires host adapter configs to include an MCP command", () => {
    const result = HostAdapterConfigSchema.safeParse({
      metadata,
      host: "codex",
      enabled: true,
      mcpServerCommand: [],
    });

    expect(result.success).toBe(false);
  });

  it("separates observed usage, estimated usage, and recommended content", () => {
    const parsed = WorkflowTokenAccountingSchema.parse({
      observed: {
        source: "provider",
        provider: "test-provider",
        model: "test-model",
        breakdown: {
          agentInputTokens: 1000,
          cachedInputTokens: 400,
          agentOutputTokens: 200,
        },
        totalTokens: 1200,
      },
      estimated: {
        source: "local_estimator",
        method: "approximate",
        confidence: "medium",
        breakdown: {
          agentInputTokens: 980,
          cachedInputTokens: 390,
          agentOutputTokens: 210,
        },
        totalTokens: 1190,
      },
      optimizerOverhead: {
        requestTokens: 20,
        responseTokens: 80,
        totalTokens: 100,
        method: "exact",
        confidence: "high",
      },
      recommendedContent: {
        tokens: 5000,
        method: "approximate",
        confidence: "medium",
      },
    });

    expect(parsed.observed?.totalTokens).toBe(1200);
    expect(parsed.estimated?.totalTokens).toBe(1190);
    expect(parsed.recommendedContent?.tokens).toBe(5000);
  });

  it("rejects cached input outside agent input and double-counted totals", () => {
    const cachedInputResult = WorkflowTokenAccountingSchema.safeParse({
      observed: {
        source: "provider",
        breakdown: {
          agentInputTokens: 100,
          cachedInputTokens: 101,
          agentOutputTokens: 20,
        },
        totalTokens: 120,
      },
    });
    const doubleCountedTotalResult = WorkflowTokenAccountingSchema.safeParse({
      observed: {
        source: "provider",
        breakdown: {
          agentInputTokens: 100,
          cachedInputTokens: 40,
          agentOutputTokens: 20,
        },
        totalTokens: 200,
      },
      optimizerOverhead: {
        requestTokens: 10,
        responseTokens: 30,
        totalTokens: 40,
        method: "exact",
        confidence: "high",
      },
      recommendedContent: {
        tokens: 500,
        method: "approximate",
        confidence: "medium",
      },
    });

    expect(cachedInputResult.success).toBe(false);
    expect(doubleCountedTotalResult.success).toBe(false);
  });

  it("keeps legacy run metrics compatible while accepting workflow accounting", () => {
    const legacyRun = RunMetricSchema.parse({
      metadata,
      host: "codex",
      startedAt: "2026-07-05T00:00:00.000Z",
      outcome: "succeeded",
      tokenEstimate: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        method: "approximate",
        confidence: "medium",
      },
    });
    const workflowRun = RunMetricSchema.parse({
      metadata,
      host: "codex",
      startedAt: "2026-07-05T00:00:00.000Z",
      outcome: "succeeded",
      tokenAccounting: {
        observed: {
          source: "host",
          breakdown: {
            agentInputTokens: 100,
            agentOutputTokens: 20,
          },
          totalTokens: 120,
        },
      },
    });

    expect(legacyRun.tokenEstimate?.totalTokens).toBe(120);
    expect(legacyRun.tokenAccounting).toBeUndefined();
    expect(workflowRun.tokenAccounting?.observed?.totalTokens).toBe(120);
  });
});
