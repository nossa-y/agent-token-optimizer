export type AgentTokenErrorCode =
  | "cache_corrupt"
  | "config_invalid"
  | "dependency_unavailable"
  | "filesystem_error"
  | "internal_error"
  | "invalid_input"
  | "outside_workspace"
  | "store_uninitialized";

export interface NormalizedError {
  readonly name: string;
  readonly code: AgentTokenErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly recovery?: string;
  readonly causeName?: string;
}

export class AgentTokenError extends Error {
  public constructor(
    public readonly code: AgentTokenErrorCode,
    message: string,
    public readonly recoverable: boolean,
    public readonly recovery?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentTokenError";
  }
}

export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof AgentTokenError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
      ...(error.recovery ? { recovery: error.recovery } : {}),
      ...(error.cause instanceof Error ? { causeName: error.cause.name } : {}),
    };
  }

  if (error instanceof Error) {
    const code = inferErrorCode(error);
    const recovery = recoveryForCode(code);

    return {
      name: error.name,
      code,
      message: error.message,
      recoverable: code !== "internal_error",
      ...(recovery ? { recovery } : {}),
    };
  }

  return {
    name: "UnknownError",
    code: "internal_error",
    message: typeof error === "string" ? error : "An unknown error occurred.",
    recoverable: false,
  };
}

function inferErrorCode(error: Error): AgentTokenErrorCode {
  if (error.name === "StoreCorruptionError") {
    return "cache_corrupt";
  }

  if (error.message.includes("outside the workspace")) {
    return "outside_workspace";
  }

  if (error.message.includes("Store has not been initialized")) {
    return "store_uninitialized";
  }

  if ("code" in error && typeof error.code === "string") {
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) {
      return "filesystem_error";
    }
  }

  return "internal_error";
}

function recoveryForCode(code: AgentTokenErrorCode): string | undefined {
  switch (code) {
    case "cache_corrupt":
      return "Run cache repair or clear the local cache file.";
    case "filesystem_error":
      return "Check file permissions and retry.";
    case "outside_workspace":
      return "Use a path inside the configured workspace root.";
    case "store_uninitialized":
      return "Initialize the store before using it.";
    case "config_invalid":
      return "Review the configuration file and run diagnostics.";
    case "dependency_unavailable":
      return "Install dependencies and rerun diagnostics.";
    case "invalid_input":
      return "Validate the input and retry.";
    case "internal_error":
      return undefined;
  }
}
