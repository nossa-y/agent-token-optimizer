export const LOCAL_OBSERVABILITY_COUNTERS = [
  "contextPackAccepted",
  "expansionRequested",
  "fallbackScanPerformed",
  "validationPassed",
  "validationFailed",
] as const;

export type LocalObservabilityCounter = (typeof LOCAL_OBSERVABILITY_COUNTERS)[number];

export interface LocalObservabilitySnapshot {
  readonly contextPackAccepted: number;
  readonly expansionRequested: number;
  readonly fallbackScanPerformed: number;
  readonly validationPassed: number;
  readonly validationFailed: number;
}

export interface LocalObservabilityCounters {
  increment(counter: LocalObservabilityCounter): void;
  snapshot(): LocalObservabilitySnapshot;
}

export function createLocalObservabilityCounters(): LocalObservabilityCounters {
  const counts: Record<LocalObservabilityCounter, number> = {
    contextPackAccepted: 0,
    expansionRequested: 0,
    fallbackScanPerformed: 0,
    validationPassed: 0,
    validationFailed: 0,
  };

  return {
    increment(counter) {
      counts[counter] += 1;
    },
    snapshot() {
      return {
        contextPackAccepted: counts.contextPackAccepted,
        expansionRequested: counts.expansionRequested,
        fallbackScanPerformed: counts.fallbackScanPerformed,
        validationPassed: counts.validationPassed,
        validationFailed: counts.validationFailed,
      };
    },
  };
}
