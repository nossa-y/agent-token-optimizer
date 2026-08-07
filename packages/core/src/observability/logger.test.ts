import { describe, expect, it } from "vitest";

import { AgentTokenError } from "../errors";
import { createLogger, MemoryLogSink } from "./logger";

describe("createLogger", () => {
  it("writes structured events with inherited context", async () => {
    const fakeApiKey = createFakeOpenAiKey();
    const sink = new MemoryLogSink();
    const logger = createLogger({
      component: "core",
      sink,
      operationId: "op-1",
      workspaceHash: "workspace-hash",
    });

    await logger.info("workspace.discovered", {
      elapsedMs: 12,
      context: {
        files: 3,
        apiKey: fakeApiKey,
      },
    });

    expect(sink.events[0]).toMatchObject({
      level: "info",
      component: "core",
      event: "workspace.discovered",
      operationId: "op-1",
      workspaceHash: "workspace-hash",
      elapsedMs: 12,
      context: {
        files: 3,
        apiKey: "[REDACTED]",
      },
    });
  });

  it("normalizes errors on error events", async () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ component: "mcp", sink });

    await logger.error(
      "tool.failed",
      new AgentTokenError("invalid_input", "Invalid tool input.", true),
    );

    expect(sink.events[0]).toMatchObject({
      level: "error",
      component: "mcp",
      event: "tool.failed",
      error: {
        code: "invalid_input",
        message: "Invalid tool input.",
        recoverable: true,
      },
    });
  });

  it("creates child loggers with overridden metadata and shared sink", async () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ component: "core", sink });
    const child = logger.child({ component: "store", host: "codex" });

    await child.warn("cache.repaired");

    expect(sink.events[0]).toMatchObject({
      level: "warn",
      component: "store",
      host: "codex",
      event: "cache.repaired",
    });
  });
});

function createFakeOpenAiKey(): string {
  return `${"sk"}-${"testsecretvalue123456"}`;
}
