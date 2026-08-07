import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

import {
  StoreCorruptionError,
  type AgentTokenStore,
  type StoreHealth,
  type StoreRecord,
  type StoreRecordKind,
  type StoreSetOptions,
  type StoreValueByKind,
} from "./store";

interface StoreMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const require = createRequire(import.meta.url);

const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cache_records (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);

CREATE INDEX IF NOT EXISTS idx_cache_records_kind_updated
  ON cache_records (kind, updated_at);
`;

const MIGRATIONS: readonly StoreMigration[] = [
  {
    version: 1,
    name: "initial_store",
    sql: INITIAL_SCHEMA_SQL,
  },
];

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

export interface SqliteStoreOptions {
  readonly databasePath: string;
}

export class SqliteStore implements AgentTokenStore {
  readonly #databasePath: string;
  #database: Database | undefined;

  public constructor(options: SqliteStoreOptions) {
    this.#databasePath = path.resolve(options.databasePath);
  }

  public async initialize(): Promise<void> {
    if (this.#database) {
      return;
    }

    const SQL = await loadSqlJs();
    this.#database = await openDatabase(SQL, this.#databasePath);

    try {
      this.#database.exec("PRAGMA schema_version;");
      this.#ensureMigrationTable();
      this.#applyMigrations();
      await this.#persist();
    } catch (error) {
      this.#database.close();
      this.#database = undefined;
      throw new StoreCorruptionError(
        "Local cache database could not be opened or migrated.",
        this.#databasePath,
        { cause: error },
      );
    }
  }

  public close(): Promise<void> {
    this.#database?.close();
    this.#database = undefined;

    return Promise.resolve();
  }

  public async repair(): Promise<void> {
    await this.close();
    await rm(this.#databasePath, { force: true });
    await this.initialize();
  }

  public health(): Promise<StoreHealth> {
    this.#requireDatabase();

    return Promise.resolve({
      ok: true,
      databasePath: this.#databasePath,
      migrationsApplied: this.#listMigrationVersions(),
      records: this.#countRecords(),
    });
  }

  public get<TKind extends StoreRecordKind>(
    kind: TKind,
    key: string,
  ): Promise<StoreValueByKind[TKind] | undefined> {
    const record = this.#selectRecord<StoreValueByKind[TKind]>(kind, key);

    return Promise.resolve(record?.value);
  }

  public async set<TKind extends StoreRecordKind>(
    kind: TKind,
    key: string,
    value: StoreValueByKind[TKind],
    options: StoreSetOptions = {},
  ): Promise<StoreRecord<StoreValueByKind[TKind]>> {
    const database = this.#requireDatabase();
    const existingRecord = this.#selectRecord<StoreValueByKind[TKind]>(kind, key);
    const now = (options.now ?? new Date()).toISOString();
    const createdAt = existingRecord?.createdAt ?? now;
    const valueJson = JSON.stringify(value);
    const contentHash = options.contentHash ?? hashText(valueJson);

    database.run(
      `
      INSERT INTO cache_records (kind, key, value_json, content_hash, created_at, updated_at)
      VALUES ($kind, $key, $valueJson, $contentHash, $createdAt, $updatedAt)
      ON CONFLICT(kind, key) DO UPDATE SET
        value_json = excluded.value_json,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
      `,
      {
        $kind: kind,
        $key: key,
        $valueJson: valueJson,
        $contentHash: contentHash,
        $createdAt: createdAt,
        $updatedAt: now,
      },
    );
    await this.#persist();

    return {
      kind,
      key,
      value,
      contentHash,
      createdAt,
      updatedAt: now,
    };
  }

  public list<TKind extends StoreRecordKind>(
    kind: TKind,
  ): Promise<StoreRecord<StoreValueByKind[TKind]>[]> {
    const database = this.#requireDatabase();
    const statement = database.prepare(
      `
      SELECT kind, key, value_json, content_hash, created_at, updated_at
      FROM cache_records
      WHERE kind = $kind
      ORDER BY updated_at DESC, key ASC
      `,
      { $kind: kind },
    );

    try {
      const records: StoreRecord<StoreValueByKind[TKind]>[] = [];

      while (statement.step()) {
        records.push(rowToRecord<StoreValueByKind[TKind]>(statement.getAsObject()));
      }

      return Promise.resolve(records);
    } finally {
      statement.free();
    }
  }

  public async delete(kind: StoreRecordKind, key: string): Promise<boolean> {
    const database = this.#requireDatabase();
    const existingRecord = this.#selectRecord(kind, key);

    if (!existingRecord) {
      return false;
    }

    database.run("DELETE FROM cache_records WHERE kind = $kind AND key = $key", {
      $kind: kind,
      $key: key,
    });
    await this.#persist();

    return true;
  }

  public async clear(kind?: StoreRecordKind): Promise<number> {
    const database = this.#requireDatabase();
    const recordsBeforeClear = this.#countRecords(kind);

    if (kind) {
      database.run("DELETE FROM cache_records WHERE kind = $kind", { $kind: kind });
    } else {
      database.run("DELETE FROM cache_records");
    }

    await this.#persist();

    return recordsBeforeClear;
  }

  #ensureMigrationTable(): void {
    this.#requireDatabase().run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
  }

  #applyMigrations(): void {
    const database = this.#requireDatabase();
    const appliedVersions = new Set(this.#listMigrationVersions());

    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      database.exec("BEGIN TRANSACTION");
      try {
        database.exec(migration.sql);
        database.run(
          `
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES ($version, $name, $appliedAt)
          `,
          {
            $version: migration.version,
            $name: migration.name,
            $appliedAt: new Date().toISOString(),
          },
        );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  #selectRecord<TValue>(
    kind: StoreRecordKind,
    key: string,
  ): StoreRecord<TValue> | undefined {
    const database = this.#requireDatabase();
    const statement = database.prepare(
      `
      SELECT kind, key, value_json, content_hash, created_at, updated_at
      FROM cache_records
      WHERE kind = $kind AND key = $key
      `,
      {
        $kind: kind,
        $key: key,
      },
    );

    try {
      if (!statement.step()) {
        return undefined;
      }

      return rowToRecord<TValue>(statement.getAsObject());
    } finally {
      statement.free();
    }
  }

  #listMigrationVersions(): number[] {
    const database = this.#requireDatabase();
    const result = database.exec(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    );
    const values = result[0]?.values ?? [];

    return values
      .map((row) => row[0])
      .filter((value): value is number => typeof value === "number");
  }

  #countRecords(kind?: StoreRecordKind): number {
    const database = this.#requireDatabase();
    const statement = kind
      ? database.prepare(
          "SELECT COUNT(*) AS count FROM cache_records WHERE kind = $kind",
          {
            $kind: kind,
          },
        )
      : database.prepare("SELECT COUNT(*) AS count FROM cache_records");

    try {
      statement.step();
      const count = statement.getAsObject().count;

      return typeof count === "number" ? count : 0;
    } finally {
      statement.free();
    }
  }

  async #persist(): Promise<void> {
    const database = this.#requireDatabase();
    const databaseBytes = database.export();
    const temporaryPath = `${this.#databasePath}.${process.pid}.${Date.now()}.tmp`;

    await mkdir(path.dirname(this.#databasePath), { mode: 0o700, recursive: true });
    await writeFile(temporaryPath, databaseBytes, { mode: 0o600 });
    await rename(temporaryPath, this.#databasePath);
    await chmod(this.#databasePath, 0o600);
  }

  #requireDatabase(): Database {
    if (!this.#database) {
      throw new Error("Store has not been initialized.");
    }

    return this.#database;
  }
}

async function openDatabase(SQL: SqlJsStatic, databasePath: string): Promise<Database> {
  try {
    const databaseBytes = await readFile(databasePath);

    return new SQL.Database(databaseBytes);
  } catch (error) {
    if (isMissingFileError(error)) {
      return new SQL.Database();
    }

    throw error;
  }
}

async function loadSqlJs(): Promise<SqlJsStatic> {
  sqlJsPromise ??= initSqlJs({
    locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm"),
  });

  return sqlJsPromise;
}

function rowToRecord<TValue>(row: Record<string, unknown>): StoreRecord<TValue> {
  const contentHash = typeof row.content_hash === "string" ? row.content_hash : undefined;

  return {
    kind: parseStoreRecordKind(row.kind),
    key: parseString(row.key),
    value: JSON.parse(parseString(row.value_json)) as TValue,
    ...(contentHash ? { contentHash } : {}),
    createdAt: parseString(row.created_at),
    updatedAt: parseString(row.updated_at),
  };
}

function parseStoreRecordKind(value: unknown): StoreRecordKind {
  if (
    value === "benchmark_scenario" ||
    value === "user_prompt_hook_evidence" ||
    value === "context_pack" ||
    value === "context_ranking" ||
    value === "file_summary" ||
    value === "run_metric" ||
    value === "token_ledger" ||
    value === "token_estimate" ||
    value === "workspace_analysis" ||
    value === "workspace_index"
  ) {
    return value;
  }

  throw new Error(`Unexpected store record kind: ${String(value)}`);
}

function parseString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected SQLite row value to be a string.");
  }

  return value;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
