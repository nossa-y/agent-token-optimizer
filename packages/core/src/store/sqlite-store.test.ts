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
      migrationsApplied: [1, 2],
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

  it("evicts every record attributed to one workspace atomically with a single persist", async () => {
    const databasePath = await createDatabasePath();
    const store = new SqliteStore({ databasePath });
    await store.initialize();

    const workspaceIndex = createWorkspaceIndex();
    const contextPack = createContextPack();
    const tokenLedger = createTokenLedger();
    const runMetric = createRunMetric(createTokenEstimate());

    // Workspace A: a large, mixed set so the implementation cannot regress to
    // per-record persistence and every workspace-derived kind is covered.
    const workspaceA = "workspace-a-hash";
    const attributionA = { workspaceRootHash: workspaceA };
    const expectedByKind = {
      [STORE_KINDS.workspaceIndex]: 40,
      [STORE_KINDS.contextPack]: 8,
      [STORE_KINDS.tokenLedger]: 6,
    } as const;
    for (let index = 0; index < expectedByKind[STORE_KINDS.workspaceIndex]; index += 1) {
      await store.set(
        STORE_KINDS.workspaceIndex,
        `a:index:${index}`,
        workspaceIndex,
        attributionA,
      );
    }
    for (let index = 0; index < expectedByKind[STORE_KINDS.contextPack]; index += 1) {
      await store.set(
        STORE_KINDS.contextPack,
        `a:pack:${index}`,
        contextPack,
        attributionA,
      );
    }
    for (let index = 0; index < expectedByKind[STORE_KINDS.tokenLedger]; index += 1) {
      await store.set(
        STORE_KINDS.tokenLedger,
        `a:ledger:${index}`,
        tokenLedger,
        attributionA,
      );
    }

    // Workspace B and a genuinely global record must survive.
    await store.set(STORE_KINDS.workspaceIndex, "b:index", workspaceIndex, {
      workspaceRootHash: "workspace-b-hash",
    });
    await store.set(STORE_KINDS.tokenLedger, "b:ledger", tokenLedger, {
      workspaceRootHash: "workspace-b-hash",
    });
    await store.set(STORE_KINDS.runMetric, "global:run", runMetric);

    const persistsBeforeEviction = store.persistCount;
    const result = await store.deleteByWorkspace(workspaceA);

    expect(result.workspaceRootHash).toBe(workspaceA);
    expect(result.evicted).toBe(54);
    expect(result.evictedByKind).toEqual(expectedByKind);
    // One database rewrite for the whole logical set, not one per record.
    expect(store.persistCount - persistsBeforeEviction).toBe(1);

    // Nothing attributable to A remains.
    await expect(store.list(STORE_KINDS.workspaceIndex)).resolves.toEqual([
      expect.objectContaining({ key: "b:index" }),
    ]);
    await expect(store.list(STORE_KINDS.contextPack)).resolves.toEqual([]);
    // B and the global record are untouched.
    await expect(store.list(STORE_KINDS.tokenLedger)).resolves.toEqual([
      expect.objectContaining({ key: "b:ledger" }),
    ]);
    await expect(store.list(STORE_KINDS.runMetric)).resolves.toEqual([
      expect.objectContaining({ key: "global:run" }),
    ]);

    // Evicting a workspace with no records is a no-op and does not rewrite the file.
    const persistsBeforeNoop = store.persistCount;
    const emptyResult = await store.deleteByWorkspace("workspace-none");
    expect(emptyResult).toEqual({
      workspaceRootHash: "workspace-none",
      evicted: 0,
      evictedByKind: {},
    });
    expect(store.persistCount).toBe(persistsBeforeNoop);

    await store.close();
  });

  it("surfaces corruption and can repair the local cache file", async () => {
    const databasePath = await createDatabasePath();
    await writeFile(databasePath, "not a sqlite database");

    const store = new SqliteStore({ databasePath });

    await expect(store.initialize()).rejects.toBeInstanceOf(StoreCorruptionError);
    await store.repair();
    await expect(store.health()).resolves.toMatchObject({
      ok: true,
      migrationsApplied: [1, 2],
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
