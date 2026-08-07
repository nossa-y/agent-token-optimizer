import { describe, expect, it } from "vitest";

import { redactText } from "./redact";

describe("redactText", () => {
  it("redacts secret-like environment assignments and API keys", () => {
    const fakeApiKey = createFakeOpenAiKey();
    const result = redactText(
      `OPENAI_API_KEY=${fakeApiKey}\nSERVICE_TOKEN=abc123\nsafe=value`,
    );

    expect(result.text).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(result.text).toContain("SERVICE_TOKEN=[REDACTED]");
    expect(result.text).toContain("safe=value");
    expect(result.text).not.toContain(fakeApiKey);
    expect(result.redactions).toEqual([
      {
        redacted: true,
        reason: "secret_pattern",
        replacement: "[REDACTED]",
      },
    ]);
  });
});

function createFakeOpenAiKey(): string {
  return `${"sk"}-${"testsecretvalue123456"}`;
}
