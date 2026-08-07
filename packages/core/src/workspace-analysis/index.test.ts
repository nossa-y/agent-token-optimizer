import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverWorkspace } from "../workspace";
import { analyzeWorkspace, type WorkspaceAnalyzer } from "./index";

const temporaryRoots: string[] = [];

describe("analyzeWorkspace", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((rootPath) => rm(rootPath, { force: true, recursive: true })),
    );
  });

  it("builds a versioned semantic index with dependencies, test relationships, ownership, and lexical fallback", async () => {
    const rootPath = await createWorkspace();
    const workspaceIndex = await discoverWorkspace({ rootPath });
    const analysisIndex = await analyzeWorkspace({
      workspaceIndex,
      operationId: "workspace-analysis-test",
      packageVersion: "0.0.0-test",
      now: new Date("2026-07-12T00:00:00.000Z"),
    });
    const userFile = analysisIndex.files.find((file) => file.path === "src/user.ts");
    const userTest = analysisIndex.files.find((file) => file.path === "src/user.test.ts");
    const pythonFile = analysisIndex.files.find(
      (file) => file.path === "scripts/helper.py",
    );
    const generatedFile = analysisIndex.files.find(
      (file) => file.path === "src/client.generated.ts",
    );

    expect(analysisIndex.indexVersion).toBe(1);
    expect(userFile).toMatchObject({
      analysisMethod: "typescript_ast",
      imports: ["./helper"],
      internalDependencies: ["src/helper.ts"],
      ownership: { packagePath: ".", packageName: "@test/workspace" },
    });
    expect(
      userFile?.symbols.some(
        (symbol) =>
          symbol.name === "createUser" &&
          symbol.kind === "function" &&
          symbol.exported &&
          symbol.signature.includes("createUser"),
      ),
    ).toBe(true);
    expect(userTest?.testTargets).toEqual(["src/user.ts"]);
    expect(pythonFile?.analysisMethod).toBe("lexical_fallback");
    expect(pythonFile?.lexicalTerms).toContain("helper");
    expect(generatedFile).toMatchObject({
      analysisMethod: "skipped",
      policy: { generated: true, kind: "generated" },
    });
    expect(analysisIndex.documentFrequencies.user).toBeGreaterThanOrEqual(2);
  });

  it("reuses unchanged analyses and records changed and deleted files", async () => {
    const rootPath = await createWorkspace();
    const initialWorkspaceIndex = await discoverWorkspace({ rootPath });
    let analyzerCalls = 0;
    const analyzer: WorkspaceAnalyzer = {
      id: "counting-typescript",
      supports: (language) => language === "typescript",
      analyze: ({ content, file }) => {
        analyzerCalls += 1;

        return {
          path: file.path,
          ...(file.language ? { language: file.language } : {}),
          ...(file.contentHash ? { contentHash: file.contentHash } : {}),
          analysisMethod: "typescript_ast",
          symbols: [],
          imports: [],
          testTargets: [],
          lexicalTerms: content.includes("export") ? ["export"] : [],
        };
      },
    };
    const initialIndex = await analyzeWorkspace({
      workspaceIndex: initialWorkspaceIndex,
      analyzers: [analyzer],
    });
    const initialAnalyzerCalls = analyzerCalls;
    const unchangedIndex = await analyzeWorkspace({
      workspaceIndex: await discoverWorkspace({ rootPath }),
      previousIndex: initialIndex,
      analyzers: [analyzer],
    });

    expect(unchangedIndex.statistics.reusedFiles).toBe(initialIndex.files.length);
    expect(unchangedIndex.statistics.changedFiles).toBe(0);
    expect(analyzerCalls).toBe(initialAnalyzerCalls);

    await writeFile(
      path.join(rootPath, "src", "helper.ts"),
      "export function normalizeName(name: string): string { return name.trim().toLowerCase(); }\n",
    );
    const changedIndex = await analyzeWorkspace({
      workspaceIndex: await discoverWorkspace({ rootPath }),
      previousIndex: unchangedIndex,
      analyzers: [analyzer],
    });

    expect(changedIndex.statistics.changedFiles).toBe(1);
    expect(changedIndex.statistics.reusedFiles).toBe(initialIndex.files.length - 1);

    await rm(path.join(rootPath, "scripts", "helper.py"));
    const deletedIndex = await analyzeWorkspace({
      workspaceIndex: await discoverWorkspace({ rootPath }),
      previousIndex: changedIndex,
      analyzers: [analyzer],
    });

    expect(deletedIndex.statistics.deletedFiles).toBe(1);
    expect(deletedIndex.files.map((file) => file.path)).not.toContain(
      "scripts/helper.py",
    );
  });
});

async function createWorkspace(): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ato-workspace-analysis-"));
  temporaryRoots.push(rootPath);
  await mkdir(path.join(rootPath, "scripts"), { recursive: true });
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "@test/workspace" }),
  );
  await writeFile(
    path.join(rootPath, "src", "helper.ts"),
    "export function normalizeName(name: string): string { return name.trim(); }\n",
  );
  await writeFile(
    path.join(rootPath, "src", "user.ts"),
    [
      'import { normalizeName } from "./helper";',
      "export function createUser(name: string): string {",
      "  return normalizeName(name);",
      "}",
    ].join("\n"),
  );
  await writeFile(
    path.join(rootPath, "src", "user.test.ts"),
    [
      'import { createUser } from "./user";',
      'it("creates a user", () => {',
      '  expect(createUser("Ada")).toBe("Ada");',
      "});",
    ].join("\n"),
  );
  await writeFile(
    path.join(rootPath, "scripts", "helper.py"),
    "def helper(value):\n    return value\n",
  );
  await writeFile(
    path.join(rootPath, "src", "client.generated.ts"),
    "export const generatedClient = true;\n",
  );

  return rootPath;
}
