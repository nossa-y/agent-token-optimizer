import type { WorkflowTokenAccounting } from "../contracts";

export interface WorkflowTokenTotal {
  readonly tokens: number;
  readonly kind: "observed" | "estimated";
  readonly source: "provider" | "host" | "local_estimator" | "optimizer";
}

export function getWorkflowTokenTotal(
  accounting: WorkflowTokenAccounting,
): WorkflowTokenTotal {
  if (accounting.observed) {
    return {
      tokens: accounting.observed.totalTokens,
      kind: "observed",
      source: accounting.observed.source,
    };
  }

  if (accounting.estimated) {
    return {
      tokens: accounting.estimated.totalTokens,
      kind: "estimated",
      source: accounting.estimated.source,
    };
  }

  throw new TypeError("Workflow token accounting has no consumed usage total.");
}
