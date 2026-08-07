import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  STORE_KINDS,
  SqliteStore,
  type TokenLedger,
} from "@agent-relay/agent-token-optimization-core";

import {
  CodexLiveBenchmarkAdapter,
  parseCodexUsage,
  runLiveBenchmarks,
  type LiveBenchmarkAdapter,
  type LiveBenchmarkAdapterInput,
  type LiveProcessExecutor,
} from "./live";
import { loadBenchmarkScenarios } from "./runner";

const temporaryRoots: string[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("live benchmark runner", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((temporaryRoot) => rm(temporaryRoot, { force: true, recursive: true })),
    );
  });

  it("runs isolated baseline and optimized pairs with provider and ledger capture", async () => {
    const workingDirectory = await createTemporaryRoot();
    const fixtureContents = await readFile(
      path.join(fixtureRoot(), "typescript-api", "src", "user-api.ts"),
      "utf8",
    );
    const adapter = new RecordingAdapter();
    const result = await runLiveBenchmarks({
      scenariosRoot: scenarioRoot(),
      fixturesRoot: fixtureRoot(),
      scenarioIds: ["typescript-api-change"],
      workingDirectory,
      repetitions: 2,
      orderSeed: 7,
      adapter,
      validationExecutor: passingValidationExecutor,
      optimizerCommand: ["node", "optimizer-mcp.js"],
      hostVersion: "0.144.1",
      packageVersion: "0.0.0-test",
      now: new Date("2026-07-14T00:00:00.000Z"),
      settings: {
        model: "gpt-5",
        reasoningEffort: "high",
        sandbox: "workspace-write",
        timeLimitMs: 45_000,
      },
    });

    expect(result.metadata).toEqual({
      generatedAt: "2026-07-14T00:00:00.000Z",
      packageVersion: "0.0.0-test",
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      host: "codex",
      hostVersion: "0.144.1",
      model: "gpt-5",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      timeLimitMs: 45_000,
      repetitions: 2,
      orderSeed: 7,
      scenarioCount: 1,
    });
    expect(result.cases).toHaveLength(4);
    expect(result.cases.every((benchmarkCase) => benchmarkCase.success)).toBe(true);
    expect(result.cases.map((benchmarkCase) => benchmarkCase.order).sort()).toEqual([
      1, 1, 2, 2,
    ]);
    expect(
      result.cases
        .filter((benchmarkCase) => benchmarkCase.mode === "optimized")
        .map((benchmarkCase) => benchmarkCase.optimizerLedgers.length),
    ).toEqual([1, 1]);
    expect(
      result.cases
        .filter((benchmarkCase) => benchmarkCase.mode === "baseline")
        .map((benchmarkCase) => benchmarkCase.optimizerLedgers.length),
    ).toEqual([0, 0]);
    expect(new Set(adapter.calls.map((call) => call.workspaceRoot)).size).toBe(4);
    expect(adapter.calls.every((call) => call.settings.model === "gpt-5")).toBe(true);
    expect(adapter.calls.every((call) => call.settings.reasoningEffort === "high")).toBe(
      true,
    );
    expect(result.cases[0]?.rawResult).toEqual({
      stdout: "[OMITTED: host stdout is not retained in benchmark artifacts]",
      stderr: "",
      redactionCount: 1,
    });
    expect(
      result.cases
        .filter((benchmarkCase) => benchmarkCase.mode === "optimized")
        .every(
          (benchmarkCase) =>
            benchmarkCase.optimizerEvidence?.responseBudgetAdhered === true &&
            benchmarkCase.warmCache?.unchangedWorkReused === true,
        ),
    ).toBe(true);
    await expect(
      readFile(path.join(fixtureRoot(), "typescript-api", "src", "user-api.ts"), "utf8"),
    ).resolves.toBe(fixtureContents);
  });

  it("fails a live case when Codex does not report provider usage", async () => {
    const workingDirectory = await createTemporaryRoot();
    const result = await runLiveBenchmarks({
      scenariosRoot: scenarioRoot(),
      fixturesRoot: fixtureRoot(),
      scenarioIds: ["typescript-api-change"],
      workingDirectory,
      repetitions: 1,
      adapter: new RecordingAdapter({ omitProviderUsage: true }),
      settings: {
        model: "gpt-5",
        reasoningEffort: "medium",
        sandbox: "workspace-write",
      },
    });

    expect(result.cases.every((benchmarkCase) => !benchmarkCase.success)).toBe(true);
    expect(
      result.cases.every((benchmarkCase) =>
        benchmarkCase.diagnostics.some((diagnostic) =>
          diagnostic.includes("Provider-reported"),
        ),
      ),
    ).toBe(true);
  });

  it("records host launch failures without aborting the remaining paired run", async () => {
    const workingDirectory = await createTemporaryRoot();
    const adapter: LiveBenchmarkAdapter = {
      host: "codex",
      run: () => Promise.reject(new Error("codex executable was not found")),
    };
    const result = await runLiveBenchmarks({
      scenariosRoot: scenarioRoot(),
      fixturesRoot: fixtureRoot(),
      scenarioIds: ["typescript-api-change"],
      workingDirectory,
      repetitions: 1,
      adapter,
      settings: {
        model: "gpt-5",
        reasoningEffort: "medium",
        sandbox: "workspace-write",
      },
    });

    expect(result.cases).toHaveLength(2);
    expect(result.cases.every((benchmarkCase) => !benchmarkCase.success)).toBe(true);
    expect(
      result.cases.every((benchmarkCase) =>
        benchmarkCase.diagnostics.some((diagnostic) =>
          diagnostic.includes("Host command exited with code 1"),
        ),
      ),
    ).toBe(true);
  });

  it("fails optimized evidence when hook output exceeds the response budget", async () => {
    const workingDirectory = await createTemporaryRoot();
    const result = await runLiveBenchmarks({
      scenariosRoot: scenarioRoot(),
      fixturesRoot: fixtureRoot(),
      scenarioIds: ["typescript-api-change"],
      workingDirectory,
      repetitions: 1,
      adapter: new RecordingAdapter({ hookResponseTokens: 1_201 }),
      validationExecutor: passingValidationExecutor,
      settings: {
        model: "gpt-5",
        reasoningEffort: "medium",
        sandbox: "workspace-write",
      },
    });

    expect(
      result.cases.find((benchmarkCase) => benchmarkCase.mode === "baseline")?.success,
    ).toBe(true);
    const optimized = result.cases.find(
      (benchmarkCase) => benchmarkCase.mode === "optimized",
    );
    expect(optimized?.success).toBe(false);
    expect(optimized?.optimizerEvidence).toMatchObject({
      hookCallCount: 1,
      maxHookResponseTokens: 1_201,
      responseBudgetRequired: true,
      responseBudgetAdhered: false,
    });
  });

  it("requires a skip scenario to record a zero-output hook activation", async () => {
    const workingDirectory = await createTemporaryRoot();
    const result = await runLiveBenchmarks({
      scenariosRoot: scenarioRoot(),
      fixturesRoot: fixtureRoot(),
      scenarioIds: ["skip-trivial-task"],
      workingDirectory,
      repetitions: 1,
      adapter: new RecordingAdapter({ hookResponseTokens: 0 }),
      validationExecutor: passingValidationExecutor,
      settings: {
        model: "gpt-5",
        reasoningEffort: "medium",
        sandbox: "workspace-write",
      },
    });
    const optimized = result.cases.find(
      (benchmarkCase) => benchmarkCase.mode === "optimized",
    );

    expect(optimized?.success).toBe(true);
    expect(optimized?.optimizerEvidence).toMatchObject({
      hookCallCount: 1,
      maxHookResponseTokens: 0,
      responseBudgetRequired: false,
      responseBudgetAdhered: true,
    });
  });

  it("configures only optimized Codex cases with the released host installation", async () => {
    const rootPath = await createTemporaryRoot();
    const workspaceRoot = path.join(rootPath, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "source.ts"),
      "export const value = 1;\n",
      "utf8",
    );
    const calls: Array<{ readonly args: readonly string[]; readonly homePath: string }> =
      [];
    const adapter = new CodexLiveBenchmarkAdapter({
      execute: (input) => {
        calls.push({ args: input.args, homePath: input.env.CODEX_HOME ?? "" });
        return Promise.resolve({
          exitCode: 0,
          durationMs: 12,
          stdout:
            '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":20,"output_tokens":30}}\n',
          stderr: "",
        });
      },
    });
    const scenario = await loadScenario();

    await adapter.run(
      createCodexInput({
        scenario,
        mode: "baseline",
        workspaceRoot,
        codexHomePath: path.join(rootPath, "baseline-home"),
      }),
    );
    const optimizedHome = path.join(rootPath, "optimized", ".codex");
    const optimized = await adapter.run(
      createCodexInput({
        scenario,
        mode: "optimized",
        workspaceRoot,
        codexHomePath: optimizedHome,
      }),
    );

    expect(calls[0]?.args).toContain("--ignore-user-config");
    expect(calls[1]?.args).not.toContain("--ignore-user-config");
    expect(calls.every((call) => call.args.includes("gpt-5"))).toBe(true);
    await expect(
      readFile(path.join(optimizedHome, "hooks.json"), "utf8"),
    ).resolves.toContain("agent-token-optimizer-managed-hook");
    expect(optimized.providerUsage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      totalTokens: 150,
    });
  });

  it("parses the last complete usage event from Codex JSONL", () => {
    expect(
      parseCodexUsage(
        [
          "not-json",
          '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}',
          '{"type":"turn.completed","usage":{"inputTokens":300,"cachedInputTokens":100,"outputTokens":40}}',
        ].join("\n"),
      ),
    ).toEqual({
      inputTokens: 300,
      cachedInputTokens: 100,
      outputTokens: 40,
      totalTokens: 340,
    });
  });
});

class RecordingAdapter implements LiveBenchmarkAdapter {
  public readonly host = "codex" as const;
  public readonly calls: LiveBenchmarkAdapterInput[] = [];

  public constructor(
    private readonly options: {
      readonly omitProviderUsage?: boolean;
      readonly omitOptimizerLedger?: boolean;
      readonly hookResponseTokens?: number;
    } = {},
  ) {}

  public async run(input: LiveBenchmarkAdapterInput) {
    this.calls.push(input);

    for (const expectedFile of input.scenario.validation.expectedFiles) {
      await writeFile(
        path.join(input.workspaceRoot, expectedFile),
        "\n// live benchmark change\n",
        { encoding: "utf8", flag: "a" },
      );
    }

    if (input.mode === "optimized" && !this.options.omitOptimizerLedger) {
      await writeLedger(input.optimizerCachePath, this.options.hookResponseTokens);
    }

    return {
      exitCode: 0,
      durationMs: 25,
      stdout: "API_TOKEN=live-benchmark-secret",
      stderr: "",
      ...(this.options.omitProviderUsage
        ? {}
        : {
            providerUsage: {
              inputTokens: 400,
              cachedInputTokens: 80,
              outputTokens: 120,
              totalTokens: 520,
            },
          }),
    };
  }
}

async function writeLedger(cachePath: string, hookResponseTokens = 30): Promise<void> {
  const store = new SqliteStore({ databasePath: cachePath });
  await store.initialize();

  try {
    await store.set(STORE_KINDS.tokenLedger, "live-run", liveLedger(hookResponseTokens));
  } finally {
    await store.close();
  }
}

function liveLedger(hookResponseTokens: number): TokenLedger {
  return {
    metadata: {
      contractVersion: "1.0",
      generatedAt: "2026-07-13T00:00:00.000Z",
      generator: { name: "agent-token-optimizer", version: "0.0.0-test" },
    },
    runId: "live-run",
    entries: [
      {
        entryId: "optimizer:one",
        recordedAt: "2026-07-13T00:00:00.000Z",
        kind: "optimizer_call",
        status: "known",
        toolName: "user_prompt_hook",
        overhead: {
          requestTokens: 20,
          responseTokens: hookResponseTokens,
          totalTokens: 20 + hookResponseTokens,
          method: "exact",
          confidence: "high",
        },
      },
    ],
  };
}

const passingValidationExecutor: LiveProcessExecutor = {
  execute: () =>
    Promise.resolve({
      exitCode: 0,
      durationMs: 1,
      stdout: "",
      stderr: "",
    }),
};

async function loadScenario() {
  const scenarios = await loadBenchmarkScenarios({
    scenariosRoot: scenarioRoot(),
    scenarioIds: ["typescript-api-change"],
  });
  const scenario = scenarios[0];

  if (!scenario) {
    throw new Error("Expected the TypeScript API benchmark scenario.");
  }

  return scenario;
}

function createCodexInput(input: {
  readonly scenario: Awaited<ReturnType<typeof loadScenario>>;
  readonly mode: "baseline" | "optimized";
  readonly workspaceRoot: string;
  readonly codexHomePath: string;
}): LiveBenchmarkAdapterInput {
  return {
    scenario: input.scenario,
    mode: input.mode,
    workspaceRoot: input.workspaceRoot,
    codexHomePath: input.codexHomePath,
    optimizerCachePath: path.join(input.codexHomePath, "optimizer.sqlite"),
    settings: {
      model: "gpt-5",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      timeLimitMs: 30_000,
    },
    optimizerCommand: ["node", "optimizer-mcp.js"],
  };
}

async function createTemporaryRoot(): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "ato-live-benchmark-"));
  temporaryRoots.push(rootPath);
  return rootPath;
}

function scenarioRoot(): string {
  return path.join(repoRoot, "benchmarks", "scenarios");
}

function fixtureRoot(): string {
  return path.join(repoRoot, "benchmarks", "fixtures");
}
