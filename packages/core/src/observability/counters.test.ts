import { describe, expect, it } from "vitest";

import { createLocalObservabilityCounters } from "./counters";

describe("createLocalObservabilityCounters", () => {
  it("keeps only aggregate workflow and validation counts in memory", () => {
    const counters = createLocalObservabilityCounters();

    counters.increment("contextPackAccepted");
    counters.increment("expansionRequested");
    counters.increment("fallbackScanPerformed");
    counters.increment("validationPassed");
    counters.increment("validationFailed");

    expect(counters.snapshot()).toEqual({
      contextPackAccepted: 1,
      expansionRequested: 1,
      fallbackScanPerformed: 1,
      validationPassed: 1,
      validationFailed: 1,
    });
  });
});
