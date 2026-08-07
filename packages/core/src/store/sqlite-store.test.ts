import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ContextPack,
  RunMetric,
  TokenEstimate,
  TokenLedger,
  WorkspaceIndex,
} from "../contracts";
import { SqliteStore, STORE_KINDS, StoreCorruptionError } from "./index";

const temporaryRoots: string[] = [];

describe("SqliteStore", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((temporaryRoot) =>
        rm(temporaryRoot, {
          force: true,
          recursive: true,
        }),
      ),
    );
  });

  it("runs migrations and reports health", async () => {
    const databasePath = await createDatabasePath();
    const store = new SqliteStore({ databasePath });
    await store.initialize();

    await expect(store.health()).resolves.toMatchObject({
      ok: true,
      migrationsApplied: [1],
      records: 0,
    });

    if (process.platform !== "win32") {
      expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    }

    await store.close();
  });

  it("stores, lists, persists, and deletes supported cache records", async () => {
    const databasePath = await createDatabasePath();
    const store = new SqliteStore({ databasePath });
    await store.initialize();

    const workspaceIndex = createWorkspaceIndex();
    const contextPack = createContextPack();
    const tokenEstimate = createTokenEstimate();
    const runMetric = createRunMetric(tokenEstimate);
    const tokenLedger = createTokenLedger();

    await store.set(STORE_KINDS.workspaceIndex, "workspace", workspaceIndex, {
      now: new Date("2026-07-06T00:00:00.000Z"),
    });
    await store.set(STORE_KINDS.contextPack, "context", contextPack);
    await store.set(STORE_KINDS.tokenEstimate, "estimate", tokenEstimate);
    await store.set(STORE_KINDS.runMetric, "run", runMetric);
    await store.set(STORE_KINDS.tokenLedger, "run", tokenLedger);

    expect(await store.get(STORE_KINDS.workspaceIndex, "workspace")).toEqual(
      workspaceIndex,
    );
    expect(await store.list(STORE_KINDS.contextPack)).toMatchObject([
      {
        kind: STORE_KINDS.contextPack,
        key: "context",
        value: contextPack,
      },
    ]);
    expect(await store.health()).toMatchObject({
      records: 5,
    });
    await store.close();

    const reopenedStore = new SqliteStore({ databasePath });
    await reopenedStore.initialize();

    expect(await reopenedStore.get(STORE_KINDS.runMetric, "run")).toEqual(runMetric);
    expect(await reopenedStore.get(STORE_KINDS.tokenLedger, "run")).toEqual(tokenLedger);
    await expect(
      reopenedStore.delete(STORE_KINDS.tokenEstimate, "estimate"),
    ).resolves.toBe(true);
    await expect(
      reopenedStore.delete(STORE_KINDS.tokenEstimate, "missing"),
    ).resolves.toBe(false);
    await expect(reopenedStore.clear(STORE_KINDS.contextPack)).resolves.toBe(1);
    await expect(reopenedStore.clear()).resolves.toBe(3);
    await expect(reopenedStore.health()).resolves.toMatchObject({
      records: 0,
    });
    await reopenedStore.close();
  });

  it("surfaces corruption and can repair the local cache file", async () => {
    const databasePath = await createDatabasePath();
    await writeFile(databasePath, "not a sqlite database");

    const store = new SqliteStore({ databasePath });

    await expect(store.initialize()).rejects.toBeInstanceOf(StoreCorruptionError);
    await store.repair();
    await expect(store.health()).resolves.toMatchObject({
      ok: true,
      migrationsApplied: [1],
      records: 0,
    });
    await store.close();
  });
});

async function createDatabasePath(): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ato-store-"));
  temporaryRoots.push(rootPath);

  return path.join(rootPath, "cache.sqlite");
}

function createWorkspaceIndex(): WorkspaceIndex {
  return {
    metadata: createMetadata(),
    workspace: {
      rootPath: "/workspace/project",
      rootHash: "workspace-hash",
      name: "project",
    },
    files: [
      {
        path: "src/index.ts",
        kind: "source",
        language: "typescript",
        sizeBytes: 32,
        generated: false,
        ignored: false,
      },
    ],
    totals: {
      filesDiscovered: 1,
      filesIndexed: 1,
      filesIgnored: 0,
      bytesIndexed: 32,
    },
    warnings: [],
  };
}

function createContextPack(): ContextPack {
  return {
    metadata: createMetadata(),
    task: {
      description: "Fix auth session test",
    },
    selected: [
      {
        path: "src/auth/session.ts",
        score: 0.9,
        rank: 1,
        selected: true,
        reason: "Auth session file matched task terms.",
        signals: [],
        estimatedTokens: 10,
      },
    ],
    excluded: [],
    summaries: [],
    expansionRules: ["Start with selected files."],
    warnings: [],
  };
}

function createTokenEstimate(): TokenEstimate {
  return {
    inputTokens: 12,
    totalTokens: 12,
    method: "approximate",
    confidence: "medium",
  };
}

function createRunMetric(tokenEstimate: TokenEstimate): RunMetric {
  return {
    metadata: createMetadata(),
    host: "codex",
    startedAt: "2026-07-06T00:00:00.000Z",
    completedAt: "2026-07-06T00:00:01.000Z",
    durationMs: 1000,
    outcome: "succeeded",
    tokenEstimate,
    warnings: [],
  };
}

function createTokenLedger(): TokenLedger {
  return {
    metadata: createMetadata(),
    runId: "run",
    taskId: "task",
    entries: [
      {
        entryId: "agent:run",
        recordedAt: "2026-07-06T00:00:01.000Z",
        kind: "agent_run",
        status: "unknown",
        unknownReason: "Provider usage was unavailable.",
      },
    ],
  };
}

function createMetadata() {
  return {
    contractVersion: "1.0",
    generatedAt: "2026-07-06T00:00:00.000Z",
    generator: {
      name: "agent-token-optimizer",
      version: "0.0.0-test",
    },
  } as const;
}
