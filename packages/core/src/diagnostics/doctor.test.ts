import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteStore } from "../store";
import { runDoctor } from "./doctor";

const temporaryRoots: string[] = [];

describe("runDoctor", () => {
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

  it("returns passing diagnostics for node, workspace, and store health", async () => {
    const rootPath = await createTemporaryRoot();
    const store = new SqliteStore({ databasePath: path.join(rootPath, "cache.sqlite") });
    await store.initialize();

    const result = await runDoctor({
      workspacePath: rootPath,
      store,
      now: new Date("2026-07-06T00:00:00.000Z"),
      operationId: "doctor-test",
      packageVersion: "0.0.0-test",
    });

    expect(result).toMatchObject({
      metadata: {
        operationId: "doctor-test",
        generator: {
          version: "0.0.0-test",
        },
      },
      status: "pass",
      checks: [
        expect.objectContaining({ name: "node_version", status: "pass" }),
        expect.objectContaining({ name: "workspace_access", status: "pass" }),
        expect.objectContaining({ name: "store_health", status: "pass" }),
      ],
    });
    await store.close();
  });

  it("returns fail when workspace and store checks fail", async () => {
    const result = await runDoctor({
      minimumNodeMajor: 999,
      workspacePath: "/definitely/not/a/workspace",
      store: new SqliteStore({ databasePath: "/tmp/not-initialized.sqlite" }),
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "node_version",
          status: "fail",
          recovery: "Install Node 999.0.0 or newer.",
        }),
        expect.objectContaining({
          name: "workspace_access",
          status: "fail",
        }),
        expect.objectContaining({
          name: "store_health",
          status: "fail",
          recovery: "Initialize or repair the local cache store.",
        }),
      ]),
    );
  });

  it("enforces the configured Node minor version", async () => {
    const currentMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    const result = await runDoctor({
      minimumNodeVersion: `${currentMajor}.999.0`,
    });

    expect(result).toMatchObject({
      status: "fail",
      checks: [
        expect.objectContaining({
          name: "node_version",
          status: "fail",
          recovery: `Install Node ${currentMajor}.999.0 or newer.`,
        }),
      ],
    });
  });

  it("returns skip when no checks are configured", async () => {
    await expect(runDoctor({ minimumNodeMajor: 0 })).resolves.toMatchObject({
      status: "pass",
      checks: [expect.objectContaining({ name: "node_version" })],
    });
  });
});

async function createTemporaryRoot(): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ato-doctor-"));
  temporaryRoots.push(rootPath);

  return rootPath;
}
