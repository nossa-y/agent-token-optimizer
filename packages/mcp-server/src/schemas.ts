import { z } from "zod";

import {
  ContextPackSchema,
  ContextExpansionPageSchema,
  HostNameSchema,
  OptimizerTokenOverheadSchema,
  RunOutcomeSchema,
  TokenLedgerSchema,
  TokenEstimateSchema,
  WarningSchema,
  WorkflowTokenAccountingSchema,
} from "@agent-relay/agent-token-optimization-core";

const AbsolutePathInputSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), "Path must not contain null bytes.");

const RelativeTargetPathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !value.startsWith("/"), "Path must be relative.")
  .refine((value) => !value.includes("\0"), "Path must not contain null bytes.")
  .refine(
    (value) => !value.split(/[\\/]+/u).includes(".."),
    "Path must not traverse outside the workspace.",
  );

const IsoDateTimeInputSchema = z.string().datetime();

const OptimizerCallLedgerInputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("known"),
    operationId: z.string().min(1).max(500),
    toolName: z.string().min(1).max(200),
    recordedAt: IsoDateTimeInputSchema.optional(),
    overhead: OptimizerTokenOverheadSchema,
  }),
  z.object({
    status: z.literal("unknown"),
    operationId: z.string().min(1).max(500),
    toolName: z.string().min(1).max(200),
    recordedAt: IsoDateTimeInputSchema.optional(),
    unknownReason: z.string().min(1).max(1000),
  }),
]);

export const AnalyzeTaskInputSchema = z.object({
  task: z.string().min(1).max(20000).describe("Task the agent is about to perform."),
  workspaceRoot: AbsolutePathInputSchema.optional(),
  cachePath: AbsolutePathInputSchema.optional(),
});

export const AnalyzeTaskOutputSchema = z.object({
  operationId: z.string().min(1),
  analysis: z.unknown(),
});

export const BuildContextPackInputSchema = z.object({
  task: z.string().min(1).max(20000),
  workspaceRoot: AbsolutePathInputSchema,
  cachePath: AbsolutePathInputSchema.optional(),
  includeSummaries: z.boolean().default(true),
  maxFileSizeBytes: z.number().int().positive().max(10_000_000).optional(),
  maxFiles: z.number().int().positive().max(100_000).optional(),
  maxTotalBytes: z.number().int().nonnegative().max(1_000_000_000).optional(),
  concurrency: z.number().int().positive().max(64).optional(),
  modelHint: z.string().min(1).max(200).optional(),
  rankingLimit: z.number().int().positive().max(200).optional(),
  recentlyChangedPaths: z.array(RelativeTargetPathSchema).max(200).default([]),
  fallbackLimit: z.number().int().nonnegative().max(50).optional(),
  responseTokenBudget: z.number().int().positive().max(100_000).optional(),
  recommendedContentTokenBudget: z.number().int().positive().max(10_000_000).optional(),
  selectionThreshold: z.number().min(0).max(100).optional(),
  summaryMaxChars: z.number().int().positive().max(12000).optional(),
  extraIgnorePatterns: z.array(z.string().min(1).max(500)).max(200).default([]),
});

export const ExpandContextInputSchema = z.object({
  packId: z.string().min(1).max(500),
  cursor: z.string().min(1).max(2048),
  limit: z.number().int().positive().max(50).default(10),
  cachePath: AbsolutePathInputSchema.optional(),
});

export const ExpandContextOutputSchema = z.object({
  operationId: z.string().min(1),
  page: ContextExpansionPageSchema.optional(),
  warnings: z.array(WarningSchema),
});

export const BuildContextPackOutputSchema = z.object({
  operationId: z.string().min(1),
  contextPack: ContextPackSchema,
  workspaceTotals: z.object({
    filesDiscovered: z.number().int().nonnegative(),
    filesIndexed: z.number().int().nonnegative(),
    filesIgnored: z.number().int().nonnegative(),
    bytesIndexed: z.number().int().nonnegative(),
  }),
  persisted: z.boolean(),
});

export const EstimateTokensInputSchema = z
  .object({
    text: z.string().min(1).max(500000).optional(),
    contextPack: ContextPackSchema.optional(),
    modelHint: z.string().min(1).max(200).optional(),
  })
  .refine(
    (value) => Boolean(value.text) || Boolean(value.contextPack),
    "Provide either text or a context pack.",
  );

export const EstimateTokensOutputSchema = z.object({
  operationId: z.string().min(1),
  tokenEstimate: TokenEstimateSchema,
});

export const SummarizeTargetsInputSchema = z.object({
  workspaceRoot: AbsolutePathInputSchema,
  targets: z.array(RelativeTargetPathSchema).min(1).max(50),
  task: z.string().min(1).max(20000).optional(),
  maxChars: z.number().int().positive().max(1200).default(600),
  maxFiles: z.number().int().positive().max(200).default(25),
});

export const SummarizeTargetsOutputSchema = z.object({
  operationId: z.string().min(1),
  summaries: z.array(z.unknown()),
  warnings: z.array(WarningSchema),
});

export const RecordRunInputSchema = z
  .object({
    cachePath: AbsolutePathInputSchema.optional(),
    host: HostNameSchema.default("unknown"),
    runId: z.string().min(1).max(500).optional(),
    taskId: z.string().min(1).max(500).optional(),
    startedAt: IsoDateTimeInputSchema.optional(),
    completedAt: IsoDateTimeInputSchema.optional(),
    durationMs: z.number().int().nonnegative().optional(),
    outcome: RunOutcomeSchema.default("unknown"),
    tokenEstimate: TokenEstimateSchema.optional(),
    tokenAccounting: WorkflowTokenAccountingSchema.optional(),
    optimizerCalls: z.array(OptimizerCallLedgerInputSchema).max(200).default([]),
    validation: z
      .object({
        command: z.string().min(1).max(1000).optional(),
        passed: z.boolean(),
        details: z.string().max(12000).optional(),
      })
      .optional(),
    workflow: z
      .object({
        contextPackAccepted: z.boolean().optional(),
        fallbackScanPerformed: z.boolean().optional(),
      })
      .optional(),
    warnings: z.array(WarningSchema).default([]),
  })
  .refine((value) => value.optimizerCalls.length === 0 || value.runId !== undefined, {
    message: "A runId is required when optimizer calls are recorded.",
    path: ["runId"],
  });

export const RecordRunOutputSchema = z.object({
  operationId: z.string().min(1),
  runMetric: z.unknown(),
  tokenLedger: TokenLedgerSchema.optional(),
  persisted: z.boolean(),
  warnings: z.array(WarningSchema),
});

export const HealthInputSchema = z.object({
  workspaceRoot: AbsolutePathInputSchema.optional(),
  cachePath: AbsolutePathInputSchema.optional(),
});

export const HealthOutputSchema = z.object({
  operationId: z.string().min(1),
  diagnostic: z.unknown(),
  observability: z.object({
    contextPackAccepted: z.number().int().nonnegative(),
    expansionRequested: z.number().int().nonnegative(),
    fallbackScanPerformed: z.number().int().nonnegative(),
    validationPassed: z.number().int().nonnegative(),
    validationFailed: z.number().int().nonnegative(),
  }),
});

export type AnalyzeTaskInput = z.infer<typeof AnalyzeTaskInputSchema>;
export type BuildContextPackInput = z.infer<typeof BuildContextPackInputSchema>;
export type ExpandContextInput = z.infer<typeof ExpandContextInputSchema>;
export type EstimateTokensInput = z.infer<typeof EstimateTokensInputSchema>;
export type SummarizeTargetsInput = z.infer<typeof SummarizeTargetsInputSchema>;
export type RecordRunInput = z.infer<typeof RecordRunInputSchema>;
export type HealthInput = z.infer<typeof HealthInputSchema>;
