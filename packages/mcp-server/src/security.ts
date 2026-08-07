import {
  AgentTokenError,
  assertMaxLength,
  assertMaxNumber,
  mergeResourceLimits,
  type ResourceLimits,
} from "@agent-relay/agent-token-optimization-core";

import type {
  AnalyzeTaskInput,
  BuildContextPackInput,
  EstimateTokensInput,
  ExpandContextInput,
  HealthInput,
  RecordRunInput,
  SummarizeTargetsInput,
} from "./schemas";

export interface McpSecurityPolicyOptions {
  readonly allowCommandMetadata?: boolean;
  readonly resourceLimits?: Partial<ResourceLimits>;
}

export interface McpSecurityPolicy {
  readonly limits: ResourceLimits;
  readonly validateAnalyzeTask: (input: AnalyzeTaskInput) => void;
  readonly validateBuildContextPack: (input: BuildContextPackInput) => void;
  readonly validateExpandContext: (input: ExpandContextInput) => void;
  readonly validateEstimateTokens: (input: EstimateTokensInput) => void;
  readonly validateSummarizeTargets: (input: SummarizeTargetsInput) => void;
  readonly validateRecordRun: (input: RecordRunInput) => void;
  readonly validateHealth: (input: HealthInput) => void;
}

export function createMcpSecurityPolicy(
  options: McpSecurityPolicyOptions = {},
): McpSecurityPolicy {
  const limits = mergeResourceLimits(options.resourceLimits);
  const allowCommandMetadata = options.allowCommandMetadata ?? false;

  return {
    limits,
    validateAnalyzeTask(input) {
      assertMaxLength("task", input.task, limits.maxTaskChars);
    },
    validateBuildContextPack(input) {
      assertMaxLength("task", input.task, limits.maxTaskChars);
      assertMaxNumber(
        "maxFileSizeBytes",
        input.maxFileSizeBytes ?? limits.maxWorkspaceFileSizeBytes,
        limits.maxWorkspaceFileSizeBytes,
      );
      assertMaxNumber(
        "maxFiles",
        input.maxFiles ?? limits.maxWorkspaceFiles,
        limits.maxWorkspaceFiles,
      );
      assertMaxNumber(
        "maxTotalBytes",
        input.maxTotalBytes ?? limits.maxWorkspaceTotalBytes,
        limits.maxWorkspaceTotalBytes,
      );
      assertMaxNumber(
        "concurrency",
        input.concurrency ?? limits.maxWorkspaceConcurrency,
        limits.maxWorkspaceConcurrency,
      );
      assertMaxNumber(
        "extraIgnorePatterns",
        input.extraIgnorePatterns.length,
        limits.maxExtraIgnorePatterns,
      );

      for (const pattern of input.extraIgnorePatterns) {
        assertMaxLength("extraIgnorePattern", pattern, limits.maxIgnorePatternChars);
      }
    },
    validateExpandContext() {
      return undefined;
    },
    validateEstimateTokens(input) {
      if (input.text) {
        assertMaxLength("text", input.text, limits.maxTextChars);
      }
    },
    validateSummarizeTargets(input) {
      assertMaxNumber("targets", input.targets.length, limits.maxSummaryTargets);
      assertMaxNumber("maxFiles", input.maxFiles, limits.maxSummaryFiles);
      assertMaxNumber("maxChars", input.maxChars, limits.maxSummaryChars);
    },
    validateRecordRun(input) {
      if (input.validation?.command && !allowCommandMetadata) {
        throw new AgentTokenError(
          "invalid_input",
          "Command metadata is disabled for MCP record_run by default.",
          true,
          "Record pass/fail details without command text, or explicitly enable command metadata.",
        );
      }

      if (input.validation?.details) {
        assertMaxLength(
          "validation.details",
          input.validation.details,
          limits.maxRunValidationDetailsChars,
        );
      }
    },
    validateHealth() {
      return undefined;
    },
  };
}
