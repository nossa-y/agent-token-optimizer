import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { validateLiveScenario } from "./validate-live-scenario";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryRoots: string[] = [];

const cases: readonly {
  readonly scenarioId: string;
  readonly fixture: string;
  readonly solution: Readonly<Record<string, string>>;
}[] = [
  {
    scenarioId: "typescript-api-change",
    fixture: "typescript-api",
    solution: {
      "src/user-api.ts": `export interface UserRecord {
  readonly id: string;
  readonly displayName: string;
  readonly active: boolean;
}

export function formatUserRecord(user: UserRecord): string {
  return \`${"${user.displayName}"} (${"${user.id}"}) — ${'${user.active ? "active" : "inactive"}'}\`;
}
`,
    },
  },
  {
    scenarioId: "cross-package-api-change",
    fixture: "monorepo-api",
    solution: {
      "packages/contracts/src/ledger.ts": `export interface LedgerEntry {
  readonly amount: number;
  readonly currency: string;
  readonly reference: string;
}
`,
      "packages/service/src/record-charge.ts": `import type { LedgerEntry } from "../../contracts/src/ledger";

export function recordCharge(amount: number, currency: string): LedgerEntry {
  return { amount, currency, reference: \`charge-${"${currency.toLowerCase()}"}\` };
}
`,
      "packages/service/src/record-charge.test.ts": `import { recordCharge } from "./record-charge";

export function recordsCurrency(): boolean {
  return recordCharge(20, "USD").currency === "USD";
}
`,
    },
  },
  {
    scenarioId: "terminology-symbol-mismatch",
    fixture: "onboarding-ui",
    solution: {
      "src/welcome-card.ts": `export function renderWelcomeCard(memberName: string): string {
  return \`Hello, ${"${memberName}"} — let's get started.\`;
}
`,
    },
  },
  {
    scenarioId: "stack-trace-bug",
    fixture: "session-service",
    solution: {
      "src/session/parser.ts": `export function parseSession(value: { readonly token?: string }): string {
  if (!value.token) {
    throw new TypeError("Session token is required.");
  }

  return value.token;
}
`,
    },
  },
  {
    scenarioId: "configuration-documentation-change",
    fixture: "release-config",
    solution: {
      "config/release.yml": `release:
  rolloutTimeoutSeconds: 180
  environments: [staging, production]
`,
      "docs/release.md": `# Release rollout

Staging uses a 180 seconds rollout timeout before production is considered.
`,
    },
  },
  {
    scenarioId: "security-auth-change",
    fixture: "auth-service",
    solution: {
      "src/auth/token.ts": `export interface BearerToken {
  readonly value: string;
  readonly expiresAt: number;
}

export function validateBearerToken(token: BearerToken, now: number): boolean {
  return token.value.length > 0 && token.expiresAt > now;
}
`,
    },
  },
  {
    scenarioId: "distracting-large-repository",
    fixture: "billing-repository",
    solution: {
      "src/billing/charge.ts": `export function calculateInvoiceCharge(subtotal: number, taxRate: number): number {
  return Math.round((subtotal + subtotal * taxRate) * 100) / 100;
}
`,
    },
  },
  {
    scenarioId: "skip-trivial-task",
    fixture: "trivial-maintenance",
    solution: {
      "src/label.ts": `export const receiveLabel = "Receive updates";
`,
    },
  },
];

describe("live scenario behavioral validation", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((temporaryRoot) => rm(temporaryRoot, { force: true, recursive: true })),
    );
  });

  for (const benchmarkCase of cases) {
    it(`rejects the initial ${benchmarkCase.scenarioId} fixture and accepts its behavior`, async () => {
      const workspaceRoot = await createFixtureCopy(benchmarkCase.fixture);

      await expect(
        validateLiveScenario(benchmarkCase.scenarioId, workspaceRoot),
      ).rejects.toThrow();

      await Promise.all(
        Object.entries(benchmarkCase.solution).map(async ([relativePath, contents]) => {
          await writeFile(path.join(workspaceRoot, relativePath), contents, "utf8");
        }),
      );

      await expect(
        validateLiveScenario(benchmarkCase.scenarioId, workspaceRoot),
      ).resolves.toBeUndefined();
    });
  }
});

async function createFixtureCopy(fixture: string): Promise<string> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ato-validator-test-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  temporaryRoots.push(temporaryRoot);
  await cp(path.join(repoRoot, "benchmarks", "fixtures", fixture), workspaceRoot, {
    recursive: true,
  });
  return workspaceRoot;
}
