import { describe, expect, it } from "vitest";

import { StoreCorruptionError } from "../store";
import { AgentTokenError, normalizeError } from "./errors";

describe("normalizeError", () => {
  it("preserves explicit agent token error metadata", () => {
    expect(
      normalizeError(
        new AgentTokenError("invalid_input", "Bad request.", true, "Fix the input."),
      ),
    ).toEqual({
      name: "AgentTokenError",
      code: "invalid_input",
      message: "Bad request.",
      recoverable: true,
      recovery: "Fix the input.",
    });
  });

  it("maps known infrastructure errors to recoverable codes", () => {
    expect(
      normalizeError(new StoreCorruptionError("Broken cache.", "/tmp/cache.sqlite")),
    ).toEqual({
      name: "StoreCorruptionError",
      code: "cache_corrupt",
      message: "Broken cache.",
      recoverable: true,
      recovery: "Run cache repair or clear the local cache file.",
    });
  });

  it("normalizes unknown thrown values", () => {
    expect(normalizeError("plain failure")).toEqual({
      name: "UnknownError",
      code: "internal_error",
      message: "plain failure",
      recoverable: false,
    });
  });
});
