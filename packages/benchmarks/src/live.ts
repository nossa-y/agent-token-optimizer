import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  STORE_KINDS,
  SqliteStore,
  analyzeWorkspace,
  discoverWorkspace,
  redactText,
  type BenchmarkScenario,
  type TokenLedger,
} from "@agent-relay/agent-token-optimization-core";
import {
  applyDetectedHostInstallPlan,
  createHostInstallPlan,
} from "@agent-relay/agent-token-optimization-host-adapters";

import { loadBenchmarkScenarios } from "./runner";

const DEFAULT_TIME_LIMIT_MS = 10 * 60 * 1000;
const MAX_CAPTURED_OUTPUT_BYTES = 2 * 1024 * 1024;
const HOOK_RESPONSE_BUDGET_TOKENS = 1_200;

export type LiveBenchmarkMode = "baseline" | "optimized";

export interface LiveBenchmarkSettings {
  readonly model: string;
  readonly reasoningEffort: "low" | "medium" | "high" | "xhigh";
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  readonly timeLimitMs: number;
}

export interface LiveBenchmarkAdapterInput {
  readonly scenario: BenchmarkScenario;
  readonly mode: LiveBenchmarkMode;
  readonly workspaceRoot: string;
  readonly codexHomePath: string;
  readonly optimizerCachePath: string;
  readonly settings: LiveBenchmarkSettings;
  readonly optimizerCommand: readonly string[];
}

export interface LiveBenchmarkAdapterResult {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly providerUsage?: LiveProviderUsage;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LiveProviderUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface LiveBenchmarkAdapter {
  readonly host: "codex";
  readonly run: (input: LiveBenchmarkAdapterInput) => Promise<LiveBenchmarkAdapterResult>;
}

export interface LiveBenchmarkRunnerOptions {
  readonly scenariosRoot: string;
  readonly fixturesRoot: string;
  readonly settings: Omit<LiveBenchmarkSettings, "timeLimitMs"> & {
    readonly timeLimitMs?: number;
  };
  readonly repetitions?: number;
  readonly orderSeed?: number;
  readonly scenarioIds?: readonly string[];
  readonly workingDirectory?: string;
  readonly retainWorkspaces?: boolean;
  readonly optimizerCommand?: readonly string[];
  readonly adapter?: LiveBenchmarkAdapter;
  readonly validationCommandEnvironment?: NodeJS.ProcessEnv;
  readonly validationExecutor?: LiveProcessExecutor;
  readonly packageVersion?: string;
  readonly hostVersion?: string;
  readonly now?: Date;
}

export interface LiveBenchmarkCaseResult {
  readonly scenarioId: string;
  readonly repetition: number;
  readonly mode: LiveBenchmarkMode;
  readonly order: number;
  readonly success: boolean;
  readonly durationMs: number;
  readonly providerUsage?: LiveProviderUsage;
  readonly validation: LiveBenchmarkValidation;
  readonly optimizerLedgers: readonly TokenLedger[];
  readonly optimizerEvidence?: LiveOptimizerEvidence;
  readonly warmCache?: LiveWarmCacheEvidence;
  readonly rawResult: LiveBenchmarkRawResult;
  readonly diagnostics: readonly string[];
}

export interface LiveBenchmarkRawResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly redactionCount: number;
}

export interface LiveOptimizerEvidence {
  readonly hookCallCount: number;
  readonly maxHookResponseTokens: number | null;
  readonly responseBudgetTokens: number;
  readonly responseBudgetRequired: boolean;
  readonly responseBudgetAdhered: boolean;
}

export interface LiveWarmCacheEvidence {
  readonly persistedCacheReloaded: boolean;
  readonly coldChangedFiles: number;
  readonly warmReusedFiles: number;
  readonly warmChangedFiles: number;
  readonly warmDeletedFiles: number;
  readonly unchangedWorkReused: boolean;
}

export interface LiveBenchmarkValidation {
  readonly passed: boolean;
  readonly changedFiles: readonly string[];
  readonly details: readonly string[];
}

export interface LiveBenchmarkRunResult {
  readonly metadata: {
    readonly generatedAt: string;
    readonly packageVersion: string;
    readonly nodeVersion: string;
    readonly platform: string;
    readonly host: "codex";
    readonly hostVersion: string;
    readonly model: string;
    readonly reasoningEffort: LiveBenchmarkSettings["reasoningEffort"];
    readonly sandbox: LiveBenchmarkSettings["sandbox"];
    readonly timeLimitMs: number;
    readonly repetitions: number;
    readonly orderSeed: number;
    readonly scenarioCount: number;
  };
  readonly cases: readonly LiveBenchmarkCaseResult[];
}

export interface LiveProcessExecutor {
  readonly execute: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeLimitMs: number;
  }) => Promise<LiveProcessResult>;
}

export interface LiveProcessResult {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class CodexLiveBenchmarkAdapter implements LiveBenchmarkAdapter {
  public readonly host = "codex" as const;

  public constructor(
    private readonly executor: LiveProcessExecutor = createLiveProcessExecutor(),
  ) {}

  public async run(
    input: LiveBenchmarkAdapterInput,
  ): Promise<LiveBenchmarkAdapterResult> {
    if (input.mode === "optimized") {
      const plan = await createHostInstallPlan({
        // Host adapters receive a user home, while Codex receives its .codex directory.
        homePath: path.dirname(input.codexHomePath),
        workspaceRoot: input.workspaceRoot,
        hookCommand: [
          ...(input.optimizerCommand.at(-1) === "mcp"
            ? input.optimizerCommand.slice(0, -1)
            : input.optimizerCommand),
          "hook",
          "user-prompt",
          "--managed-by",
          "agent-token-optimizer-managed-hook",
          "--cache-path",
          input.optimizerCachePath,
        ],
        requestedHosts: ["codex"],
      });
      await applyDetectedHostInstallPlan(plan);
    }

    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-rules",
      "--sandbox",
      input.settings.sandbox,
      "--cd",
      input.workspaceRoot,
      "--model",
      input.settings.model,
      "--config",
      `model_reasoning_effort=${JSON.stringify(input.settings.reasoningEffort)}`,
      "--skip-git-repo-check",
      createTaskPrompt(input.scenario),
    ];

    if (input.mode === "baseline") {
      args.splice(3, 0, "--ignore-user-config");
    }

    const result = await this.executor.execute({
      command: "codex",
      args,
      cwd: input.workspaceRoot,
      env: {
        ...process.env,
        CODEX_HOME: input.codexHomePath,
      },
      timeLimitMs: input.settings.timeLimitMs,
    });

    const providerUsage = parseCodexUsage(result.stdout);

    return {
      ...result,
      ...(providerUsage ? { providerUsage } : {}),
    };
  }
}

export async function runLiveBenchmarks(
  options: LiveBenchmarkRunnerOptions,
): Promise<LiveBenchmarkRunResult> {
  const settings: LiveBenchmarkSettings = {
    ...options.settings,
    timeLimitMs: options.settings.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS,
  };
  validateSettings(settings);
  const repetitions = options.repetitions ?? 2;
  const generatedAt = (options.now ?? new Date()).toISOString();
  const packageVersion = options.packageVersion ?? "0.1.0";
  const hostVersion = options.hostVersion ?? "unknown";

  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new TypeError("Live benchmark repetitions must be a positive integer.");
  }

  const orderSeed = options.orderSeed ?? 1;
  const scenarios = await loadBenchmarkScenarios({
    scenariosRoot: options.scenariosRoot,
    ...(options.scenarioIds ? { scenarioIds: options.scenarioIds } : {}),
  });
  const rootDirectory = options.workingDirectory ?? os.tmpdir();
  const runRoot = await mkdtemp(path.join(rootDirectory, "agent-token-optimizer-live-"));
  const adapter = options.adapter ?? new CodexLiveBenchmarkAdapter();
  const optimizerCommand = options.optimizerCommand ?? [
    process.execPath,
    path.join(process.cwd(), "packages", "cli", "dist", "index.js"),
    "mcp",
  ];
  const random = createSeededRandom(orderSeed);
  const cases: LiveBenchmarkCaseResult[] = [];

  try {
    for (const scenario of scenarios) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const modes: readonly LiveBenchmarkMode[] =
          random() < 0.5 ? ["baseline", "optimized"] : ["optimized", "baseline"];

        for (const [order, mode] of modes.entries()) {
          cases.push(
            await runLiveBenchmarkCase({
              adapter,
              fixturesRoot: options.fixturesRoot,
              optimizerCommand,
              mode,
              order: order + 1,
              repetition,
              runRoot,
              scenario,
              settings,
              ...(options.validationCommandEnvironment
                ? {
                    validationCommandEnvironment: options.validationCommandEnvironment,
                  }
                : {}),
              ...(options.validationExecutor
                ? { validationExecutor: options.validationExecutor }
                : {}),
            }),
          );
        }
      }
    }
  } finally {
    if (!options.retainWorkspaces) {
      await rm(runRoot, { force: true, recursive: true });
    }
  }

  return {
    metadata: {
      host: adapter.host,
      hostVersion,
      generatedAt,
      packageVersion,
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      sandbox: settings.sandbox,
      timeLimitMs: settings.timeLimitMs,
      repetitions,
      orderSeed,
      scenarioCount: scenarios.length,
    },
    cases,
  };
}

export function parseCodexUsage(output: string): LiveProviderUsage | undefined {
  let usage: LiveProviderUsage | undefined;

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      const candidate = findUsage(parsed);

      if (candidate) {
        usage = candidate;
      }
    } catch {
      // Codex JSONL can contain diagnostic lines from wrappers. They are not usage events.
    }
  }

  return usage;
}

function createTaskPrompt(scenario: BenchmarkScenario): string {
  return [
    "Work only on the requested task in this repository.",
    "Make the implementation change and run the scenario's relevant validation when available.",
    "Do not modify files outside the repository workspace.",
    "Task:",
    scenario.task,
  ].join("\n\n");
}

async function runLiveBenchmarkCase(input: {
  readonly adapter: LiveBenchmarkAdapter;
  readonly fixturesRoot: string;
  readonly optimizerCommand: readonly string[];
  readonly mode: LiveBenchmarkMode;
  readonly order: number;
  readonly repetition: number;
  readonly runRoot: string;
  readonly scenario: BenchmarkScenario;
  readonly settings: LiveBenchmarkSettings;
  readonly validationCommandEnvironment?: NodeJS.ProcessEnv;
  readonly validationExecutor?: LiveProcessExecutor;
}): Promise<LiveBenchmarkCaseResult> {
  const caseRoot = path.join(
    input.runRoot,
    input.scenario.id,
    `repetition-${input.repetition}`,
    input.mode,
  );
  const workspaceRoot = path.join(caseRoot, "workspace");
  const codexHomePath = path.join(caseRoot, ".codex");
  const optimizerCachePath = path.join(caseRoot, "optimizer.sqlite");
  const fixtureRoot = path.join(input.fixturesRoot, input.scenario.workspaceFixture);

  await mkdir(caseRoot, { recursive: true });
  await cp(fixtureRoot, workspaceRoot, { recursive: true, force: false });
  await prepareIsolatedCodexHome(codexHomePath);
  const before = await createWorkspaceManifest(workspaceRoot);
  const startedAt = performance.now();
  let adapterResult: LiveBenchmarkAdapterResult;

  try {
    adapterResult = await input.adapter.run({
      scenario: input.scenario,
      mode: input.mode,
      workspaceRoot,
      codexHomePath,
      optimizerCachePath,
      settings: input.settings,
      optimizerCommand: input.optimizerCommand,
    });
  } catch (error) {
    adapterResult = {
      exitCode: 1,
      durationMs: Math.round(performance.now() - startedAt),
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  const after = await createWorkspaceManifest(workspaceRoot);
  const validation = await validateLivePatch({
    scenario: input.scenario,
    workspaceRoot,
    before,
    after,
    ...(input.validationCommandEnvironment
      ? { validationCommandEnvironment: input.validationCommandEnvironment }
      : {}),
    ...(input.validationExecutor ? { validationExecutor: input.validationExecutor } : {}),
  });
  const optimizerLedgers =
    input.mode === "optimized" ? await readOptimizerLedgers(optimizerCachePath) : [];
  const contextInjectionRequired =
    input.scenario.evaluation.expectedOptimizationMode !== "skip";
  const optimizerEvidence =
    input.mode === "optimized"
      ? evaluateHookBudget(optimizerLedgers, contextInjectionRequired)
      : undefined;
  let warmCache: LiveWarmCacheEvidence | undefined;

  if (input.mode === "optimized") {
    try {
      warmCache = await measureWarmCacheReuse(
        workspaceRoot,
        path.join(caseRoot, "warm-cache.sqlite"),
      );
    } catch {
      warmCache = {
        persistedCacheReloaded: false,
        coldChangedFiles: 0,
        warmReusedFiles: 0,
        warmChangedFiles: 0,
        warmDeletedFiles: 0,
        unchangedWorkReused: false,
      };
    }
  }
  const diagnostics = [
    ...createDiagnostics(adapterResult),
    ...(input.mode === "optimized" && optimizerLedgers.length === 0
      ? ["No optimizer token ledger was recorded by the host run."]
      : []),
    ...(optimizerEvidence && optimizerEvidence.hookCallCount === 0
      ? ["No user-prompt hook activation was recorded."]
      : []),
    ...(optimizerEvidence && !optimizerEvidence.responseBudgetAdhered
      ? [
          `User-prompt hook output did not match the expected skip/inject behavior within the ${optimizerEvidence.responseBudgetTokens}-token budget.`,
        ]
      : []),
    ...(warmCache && !warmCache.unchangedWorkReused
      ? ["Persisted warm-cache validation did not reuse all unchanged analyses."]
      : []),
  ];
  const rawResult = createRedactedRawResult(adapterResult);

  return {
    scenarioId: input.scenario.id,
    repetition: input.repetition,
    mode: input.mode,
    order: input.order,
    success:
      adapterResult.exitCode === 0 &&
      validation.passed &&
      adapterResult.providerUsage !== undefined &&
      (input.mode === "baseline" ||
        (optimizerEvidence !== undefined &&
          optimizerEvidence.hookCallCount > 0 &&
          optimizerEvidence.responseBudgetAdhered &&
          warmCache?.unchangedWorkReused === true)),
    durationMs: adapterResult.durationMs,
    ...(adapterResult.providerUsage
      ? { providerUsage: adapterResult.providerUsage }
      : {}),
    validation,
    optimizerLedgers,
    ...(optimizerEvidence ? { optimizerEvidence } : {}),
    ...(warmCache ? { warmCache } : {}),
    rawResult,
    diagnostics,
  };
}

function createRedactedRawResult(
  result: LiveBenchmarkAdapterResult,
): LiveBenchmarkRawResult {
  const stdout = redactText(result.stdout);
  const stderr = redactText(result.stderr);

  return {
    stdout: result.stdout.trim()
      ? "[OMITTED: host stdout is not retained in benchmark artifacts]"
      : "",
    stderr: result.stderr.trim()
      ? "[OMITTED: host stderr is not retained in benchmark artifacts]"
      : "",
    redactionCount: stdout.redactions.length + stderr.redactions.length,
  };
}

async function prepareIsolatedCodexHome(codexHomePath: string): Promise<void> {
  await mkdir(codexHomePath, { recursive: true });
  const sourceHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const sourceAuthPath = path.join(sourceHome, "auth.json");

  try {
    await copyFile(sourceAuthPath, path.join(codexHomePath, "auth.json"));
  } catch {
    // The host reports a clear authentication failure when a maintainer has not logged in.
  }
}

async function validateLivePatch(input: {
  readonly scenario: BenchmarkScenario;
  readonly workspaceRoot: string;
  readonly before: ReadonlyMap<string, string>;
  readonly after: ReadonlyMap<string, string>;
  readonly validationCommandEnvironment?: NodeJS.ProcessEnv;
  readonly validationExecutor?: LiveProcessExecutor;
}): Promise<LiveBenchmarkValidation> {
  const changedFiles = [...new Set([...input.before.keys(), ...input.after.keys()])]
    .filter((filePath) => input.before.get(filePath) !== input.after.get(filePath))
    .sort((left, right) => left.localeCompare(right));
  const details: string[] = [];
  let passed = true;

  if (input.scenario.validation.type === "command") {
    if (!input.scenario.validation.command) {
      return {
        passed: false,
        changedFiles,
        details: ["Scenario validation type is command but no command was supplied."],
      };
    }

    const expectedCommand = `node "$AGENT_TOKEN_OPTIMIZER_BENCHMARK_VALIDATOR" ${input.scenario.id}`;

    if (input.scenario.validation.command !== expectedCommand) {
      return {
        passed: false,
        changedFiles,
        details: ["Scenario validation command is outside the fixed validator contract."],
      };
    }

    const validatorPath =
      input.validationCommandEnvironment?.AGENT_TOKEN_OPTIMIZER_BENCHMARK_VALIDATOR;

    if (!validatorPath && !input.validationExecutor) {
      return {
        passed: false,
        changedFiles,
        details: ["The benchmark validator path is not configured."],
      };
    }

    const result = await executeValidationCommand({
      validatorPath: validatorPath ?? "test-validator",
      scenarioId: input.scenario.id,
      cwd: input.workspaceRoot,
      ...(input.validationCommandEnvironment
        ? { environment: input.validationCommandEnvironment }
        : {}),
      ...(input.validationExecutor ? { executor: input.validationExecutor } : {}),
    });
    passed = result.exitCode === 0;
    details.push(
      passed
        ? `Validation command passed: ${input.scenario.validation.command}`
        : `Validation command failed: ${input.scenario.validation.command}`,
    );
  }

  const expectedFiles = input.scenario.validation.expectedFiles;
  const missingExpectedFiles = expectedFiles.filter(
    (expectedFile) => !changedFiles.includes(expectedFile),
  );

  if (expectedFiles.length > 0 && missingExpectedFiles.length > 0) {
    passed = false;
    details.push(`Expected files were not changed: ${missingExpectedFiles.join(", ")}.`);
  } else if (expectedFiles.length > 0) {
    details.push("All scenario-expected files were changed.");
  }

  if (expectedFiles.length === 0) {
    passed = changedFiles.length === 0;
    details.push(
      passed
        ? "No workspace changes were required by this scenario."
        : `Unexpected workspace changes: ${changedFiles.join(", ")}.`,
    );
  }

  return { passed, changedFiles, details };
}

async function createWorkspaceManifest(
  workspaceRoot: string,
): Promise<ReadonlyMap<string, string>> {
  const manifest = new Map<string, string>();
  const paths = await listFiles(workspaceRoot);

  await Promise.all(
    paths.map(async (relativePath) => {
      const contents = await readFile(path.join(workspaceRoot, relativePath));
      manifest.set(relativePath, createHash("sha256").update(contents).digest("hex"));
    }),
  );

  return manifest;
}

async function listFiles(rootPath: string, currentPath = ""): Promise<string[]> {
  const directoryPath = path.join(rootPath, currentPath);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        return await listFiles(rootPath, relativePath);
      }

      return entry.isFile() ? [relativePath] : [];
    }),
  );

  return paths.flat().sort((left, right) => left.localeCompare(right));
}

async function readOptimizerLedgers(cachePath: string): Promise<TokenLedger[]> {
  try {
    await stat(cachePath);
  } catch {
    return [];
  }

  const store = new SqliteStore({ databasePath: cachePath });
  await store.initialize();

  try {
    const records = await store.list(STORE_KINDS.tokenLedger);
    return records.map((record) => record.value);
  } finally {
    await store.close();
  }
}

function evaluateHookBudget(
  ledgers: readonly TokenLedger[],
  responseBudgetRequired: boolean,
): LiveOptimizerEvidence {
  const responseTokens = ledgers
    .flatMap((ledger) => ledger.entries)
    .flatMap((entry) =>
      entry.kind === "optimizer_call" &&
      entry.status === "known" &&
      entry.toolName === "user_prompt_hook"
        ? [entry.overhead.responseTokens]
        : [],
    );
  const maxHookResponseTokens =
    responseTokens.length > 0 ? Math.max(...responseTokens) : null;

  return {
    hookCallCount: responseTokens.length,
    maxHookResponseTokens,
    responseBudgetTokens: HOOK_RESPONSE_BUDGET_TOKENS,
    responseBudgetRequired,
    responseBudgetAdhered:
      maxHookResponseTokens !== null &&
      maxHookResponseTokens <= HOOK_RESPONSE_BUDGET_TOKENS &&
      (responseBudgetRequired ? maxHookResponseTokens > 0 : maxHookResponseTokens === 0),
  };
}

async function measureWarmCacheReuse(
  workspaceRoot: string,
  cachePath: string,
): Promise<LiveWarmCacheEvidence> {
  const coldWorkspace = await discoverWorkspace({ rootPath: workspaceRoot });
  const coldAnalysis = await analyzeWorkspace({ workspaceIndex: coldWorkspace });
  const cacheKey = `${coldWorkspace.workspace.rootHash}:latest`;
  const writer = new SqliteStore({ databasePath: cachePath });
  await writer.initialize();
  try {
    await writer.set(STORE_KINDS.workspaceIndex, cacheKey, coldWorkspace);
    await writer.set(STORE_KINDS.workspaceAnalysis, cacheKey, coldAnalysis);
  } finally {
    await writer.close();
  }

  const reader = new SqliteStore({ databasePath: cachePath });
  await reader.initialize();
  try {
    const [persistedWorkspace, persistedAnalysis] = await Promise.all([
      reader.get(STORE_KINDS.workspaceIndex, cacheKey),
      reader.get(STORE_KINDS.workspaceAnalysis, cacheKey),
    ]);
    if (!persistedWorkspace || !persistedAnalysis) {
      throw new Error("Persisted workspace cache records could not be reloaded.");
    }

    const warmWorkspace = await discoverWorkspace({
      rootPath: workspaceRoot,
      previousIndex: persistedWorkspace,
    });
    const warmAnalysis = await analyzeWorkspace({
      workspaceIndex: warmWorkspace,
      previousIndex: persistedAnalysis,
    });
    const eligibleFiles = persistedAnalysis.files.length;
    const unchangedWorkReused =
      eligibleFiles > 0 &&
      warmAnalysis.statistics.reusedFiles === eligibleFiles &&
      warmAnalysis.statistics.changedFiles === 0 &&
      warmAnalysis.statistics.deletedFiles === 0;

    return {
      persistedCacheReloaded: true,
      coldChangedFiles: coldAnalysis.statistics.changedFiles,
      warmReusedFiles: warmAnalysis.statistics.reusedFiles,
      warmChangedFiles: warmAnalysis.statistics.changedFiles,
      warmDeletedFiles: warmAnalysis.statistics.deletedFiles,
      unchangedWorkReused,
    };
  } finally {
    await reader.close();
  }
}

function createDiagnostics(result: LiveBenchmarkAdapterResult): string[] {
  const diagnostics: string[] = [];

  if (result.exitCode !== 0) {
    diagnostics.push(`Host command exited with code ${result.exitCode}.`);
  }

  if (!result.providerUsage) {
    diagnostics.push(
      "Provider-reported token usage was not found in Codex JSONL output.",
    );
  }

  for (const [label, output] of [
    ["stderr", result.stderr],
    ["stdout", result.stdout],
  ] as const) {
    if (!output.trim()) continue;
    const redacted = redactText(output);
    diagnostics.push(
      `Host ${label} omitted (${Buffer.byteLength(output)} bytes; ${redacted.redactions.length} secret-like value(s) redacted before disposal).`,
    );
  }

  return diagnostics;
}

function validateSettings(settings: LiveBenchmarkSettings): void {
  if (!settings.model.trim()) {
    throw new TypeError("Live benchmarks require an explicit model.");
  }

  if (!Number.isInteger(settings.timeLimitMs) || settings.timeLimitMs <= 0) {
    throw new TypeError("Live benchmark timeLimitMs must be a positive integer.");
  }

  if (settings.sandbox !== "workspace-write") {
    throw new TypeError(
      "Live benchmarks require workspace-write sandboxing for patch validation.",
    );
  }
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function findUsage(value: unknown): LiveProviderUsage | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const usage = findUsage(item);

      if (usage) {
        return usage;
      }
    }

    return undefined;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const usage = parseUsageRecord(record.usage);

  if (usage) {
    return usage;
  }

  for (const nestedValue of Object.values(record)) {
    const nestedUsage = findUsage(nestedValue);

    if (nestedUsage) {
      return nestedUsage;
    }
  }

  return undefined;
}

function parseUsageRecord(value: unknown): LiveProviderUsage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const inputTokens = readUsageNumber(record, "input_tokens", "inputTokens");
  const cachedInputTokens =
    readUsageNumber(record, "cached_input_tokens", "cachedInputTokens") ?? 0;
  const outputTokens = readUsageNumber(record, "output_tokens", "outputTokens");

  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cachedInputTokens > inputTokens
  ) {
    return undefined;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function readUsageNumber(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      return value;
    }
  }

  return undefined;
}

function createLiveProcessExecutor(): LiveProcessExecutor {
  return {
    execute: async (input) =>
      await new Promise<LiveProcessResult>((resolve, reject) => {
        const startedAt = performance.now();
        const child = spawn(input.command, input.args, {
          cwd: input.cwd,
          env: input.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, input.timeLimitMs);

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout = appendOutput(stdout, chunk);
        });
        child.stderr.on("data", (chunk: string) => {
          stderr = appendOutput(stderr, chunk);
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({
            exitCode: timedOut ? 124 : (code ?? 1),
            durationMs: Math.round(performance.now() - startedAt),
            stdout,
            stderr: timedOut
              ? `${stderr}\nHost command exceeded ${input.timeLimitMs}ms.`
              : stderr,
          });
        });
      }),
  };
}

function appendOutput(current: string, next: string): string {
  const available = MAX_CAPTURED_OUTPUT_BYTES - Buffer.byteLength(current);

  return available > 0 ? `${current}${next.slice(0, available)}` : current;
}

async function executeValidationCommand(input: {
  readonly validatorPath: string;
  readonly scenarioId: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly executor?: LiveProcessExecutor;
}): Promise<LiveProcessResult> {
  return await (input.executor ?? createLiveProcessExecutor()).execute({
    command: process.execPath,
    args: [path.resolve(input.validatorPath), input.scenarioId],
    cwd: input.cwd,
    env: { ...process.env, ...input.environment },
    timeLimitMs: DEFAULT_TIME_LIMIT_MS,
  });
}
