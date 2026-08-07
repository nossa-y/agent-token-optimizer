import { describe, expect, it } from "vitest";

import type { WorkflowTokenAccounting } from "../contracts";
import { getWorkflowTokenTotal } from "./accounting";

describe("getWorkflowTokenTotal", () => {
  it("prefers the provider-observed total without adding diagnostic subsets", () => {
    const accounting: WorkflowTokenAccounting = {
      observed: {
        source: "provider",
        breakdown: {
          agentInputTokens: 2000,
          cachedInputTokens: 800,
          agentOutputTokens: 500,
        },
        totalTokens: 2500,
      },
      estimated: {
        source: "local_estimator",
        method: "approximate",
        confidence: "medium",
        breakdown: {
          agentInputTokens: 2100,
          cachedInputTokens: 850,
          agentOutputTokens: 550,
        },
        totalTokens: 2650,
      },
      optimizerOverhead: {
        requestTokens: 100,
        responseTokens: 300,
        totalTokens: 400,
        method: "exact",
        confidence: "high",
      },
      recommendedContent: {
        tokens: 10_000,
        method: "approximate",
        confidence: "medium",
      },
    };

    expect(getWorkflowTokenTotal(accounting)).toEqual({
      tokens: 2500,
      kind: "observed",
      source: "provider",
    });
  });

  it("uses estimated consumed usage when observed usage is unavailable", () => {
    const accounting: WorkflowTokenAccounting = {
      estimated: {
        source: "optimizer",
        method: "exact",
        confidence: "high",
        breakdown: {
          agentInputTokens: 400,
          agentOutputTokens: 100,
        },
        totalTokens: 500,
      },
    };

    expect(getWorkflowTokenTotal(accounting)).toEqual({
      tokens: 500,
      kind: "estimated",
      source: "optimizer",
    });
  });
});
