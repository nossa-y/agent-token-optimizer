import { AgentTokenError } from "../errors";

export interface ResourceLimits {
  readonly maxTaskChars: number;
  readonly maxTextChars: number;
  readonly maxWorkspaceFileSizeBytes: number;
  readonly maxWorkspaceFiles: number;
  readonly maxWorkspaceTotalBytes: number;
  readonly maxWorkspaceConcurrency: number;
  readonly maxSummaryTargetFileSizeBytes: number;
  readonly maxSummaryTargets: number;
  readonly maxSummaryFiles: number;
  readonly maxSummaryChars: number;
  readonly maxExtraIgnorePatterns: number;
  readonly maxIgnorePatternChars: number;
  readonly maxRunValidationDetailsChars: number;
  readonly operationTimeoutMs: number;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxTaskChars: 20_000,
  maxTextChars: 500_000,
  maxWorkspaceFileSizeBytes: 10_000_000,
  maxWorkspaceFiles: 100_000,
  maxWorkspaceTotalBytes: 1_000_000_000,
  maxWorkspaceConcurrency: 64,
  maxSummaryTargetFileSizeBytes: 1_048_576,
  maxSummaryTargets: 50,
  maxSummaryFiles: 200,
  maxSummaryChars: 12_000,
  maxExtraIgnorePatterns: 200,
  maxIgnorePatternChars: 500,
  maxRunValidationDetailsChars: 12_000,
  operationTimeoutMs: 30_000,
};

export function mergeResourceLimits(
  overrides: Partial<ResourceLimits> = {},
): ResourceLimits {
  return {
    ...DEFAULT_RESOURCE_LIMITS,
    ...Object.fromEntries(
      Object.entries(overrides).filter((entry): entry is [string, number] => {
        const [, value] = entry;
        return Number.isFinite(value) && value > 0;
      }),
    ),
  };
}

export function assertMaxNumber(name: string, value: number, maxValue: number): void {
  if (value > maxValue) {
    throw new AgentTokenError(
      "invalid_input",
      `${name} exceeds the configured limit of ${maxValue}.`,
      true,
      "Reduce the request size or adjust the explicit security policy.",
    );
  }
}

export function assertMaxLength(name: string, value: string, maxLength: number): void {
  assertMaxNumber(name, value.length, maxLength);
}

export async function withOperationTimeout<TResult>(
  operation: Promise<TResult>,
  timeoutMs: number,
  operationName: string,
  onTimeout?: () => void,
): Promise<TResult> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout?.();
      reject(
        new AgentTokenError(
          "invalid_input",
          `${operationName} exceeded the configured timeout of ${timeoutMs}ms.`,
          true,
          "Reduce the request size or adjust the explicit security policy.",
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
