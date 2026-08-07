import { z } from "zod";
import {
  AbsolutePathSchema,
  ContractMetadataSchema,
  HostNameSchema,
  IsoDateTimeSchema,
  RelativePathSchema,
  WarningSchema,
} from "./common";
import {
  ContextPackSchema,
  OptimizationModeSchema,
  TokenEstimateSchema,
  WorkflowTokenAccountingSchema,
} from "./optimization";

export const RunOutcomeSchema = z.enum([
  "unknown",
  "succeeded",
  "failed",
  "cancelled",
  "degraded",
]);

export const RunMetricSchema = z.object({
  metadata: ContractMetadataSchema,
  host: HostNameSchema,
  runId: z.string().min(1).max(500).optional(),
  taskId: z.string().min(1).optional(),
  startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  outcome: RunOutcomeSchema,
  tokenEstimate: TokenEstimateSchema.optional(),
  tokenAccounting: WorkflowTokenAccountingSchema.optional(),
  validation: z
    .object({
      command: z.string().min(1).optional(),
      passed: z.boolean(),
      details: z.string().max(12000).optional(),
    })
    .optional(),
  warnings: z.array(WarningSchema).default([]),
});

export const BenchmarkScenarioSchema = z.object({
  metadata: ContractMetadataSchema,
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  workspaceFixture: RelativePathSchema,
  task: z.string().min(1).max(20000),
  validation: z.object({
    type: z.enum(["command", "snapshot", "manual"]),
    command: z.string().min(1).optional(),
    expectedFiles: z.array(RelativePathSchema).default([]),
  }),
  baseline: z.object({
    enabled: z.boolean().default(true),
  }),
  optimized: z.object({
    contextPack: ContextPackSchema.optional(),
  }),
  evaluation: z
    .object({
      expectedOptimizationMode: OptimizationModeSchema.optional(),
      expansionExpectedFiles: z.array(RelativePathSchema).default([]),
    })
    .default({ expansionExpectedFiles: [] }),
});

export const HostAdapterConfigSchema = z.object({
  metadata: ContractMetadataSchema,
  host: HostNameSchema,
  enabled: z.boolean(),
  configPath: AbsolutePathSchema.optional(),
  instructionPath: AbsolutePathSchema.optional(),
  mcpServerCommand: z.array(z.string().min(1)).min(1),
  environment: z.record(z.string(), z.string()).default({}),
  backupPath: AbsolutePathSchema.optional(),
});

export const DiagnosticStatusSchema = z.enum(["pass", "warn", "fail", "skip"]);

export const DiagnosticResultSchema = z.object({
  metadata: ContractMetadataSchema,
  status: DiagnosticStatusSchema,
  checks: z.array(
    z.object({
      name: z.string().min(1),
      status: DiagnosticStatusSchema,
      message: z.string().min(1),
      recovery: z.string().min(1).optional(),
    }),
  ),
  warnings: z.array(WarningSchema).default([]),
});

export type RunOutcome = z.infer<typeof RunOutcomeSchema>;
export type RunMetric = z.infer<typeof RunMetricSchema>;
export type BenchmarkScenario = z.infer<typeof BenchmarkScenarioSchema>;
export type HostAdapterConfig = z.infer<typeof HostAdapterConfigSchema>;
export type DiagnosticStatus = z.infer<typeof DiagnosticStatusSchema>;
export type DiagnosticResult = z.infer<typeof DiagnosticResultSchema>;
