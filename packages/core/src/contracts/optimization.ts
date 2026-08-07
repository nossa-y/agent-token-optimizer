import { z } from "zod";
import {
  ContractMetadataSchema,
  RedactionSchema,
  RelativePathSchema,
  WarningSchema,
} from "./common";

export const TaskComplexitySchema = z.enum(["trivial", "small", "medium", "large"]);

export const OptimizationModeSchema = z.enum([
  "skip",
  "light",
  "context_pack",
  "context_pack_with_summaries",
]);

export const TaskOperationSchema = z.enum([
  "add",
  "configure",
  "document",
  "fix",
  "investigate",
  "migrate",
  "refactor",
  "remove",
  "test",
  "unknown",
]);

export const TaskHintsSchema = z.object({
  paths: z.array(RelativePathSchema).default([]),
  symbols: z.array(z.string().min(1).max(500)).default([]),
  testNames: z.array(z.string().min(1).max(500)).default([]),
  errorMessages: z.array(z.string().min(1).max(1000)).default([]),
  stackFrames: z.array(z.string().min(1).max(2048)).default([]),
  packageNames: z.array(z.string().min(1).max(500)).default([]),
  operation: TaskOperationSchema,
});

export const TaskAnalysisSchema = z.object({
  metadata: ContractMetadataSchema,
  task: z.object({
    description: z.string().min(1).max(20000),
    complexity: TaskComplexitySchema,
    risk: z.enum(["low", "medium", "high"]),
    hints: TaskHintsSchema.optional(),
  }),
  recommendation: z.object({
    mode: OptimizationModeSchema,
    reason: z.string().min(1),
    tokenBudget: z.number().int().positive().optional(),
  }),
  warnings: z.array(WarningSchema).default([]),
});

export const RankingSignalSchema = z.object({
  name: z.string().min(1),
  score: z.number(),
  reason: z.string().min(1),
});

export const ContextCandidateSchema = z.object({
  path: RelativePathSchema,
  score: z.number(),
  rank: z.number().int().positive(),
  selected: z.boolean(),
  reason: z.string().min(1),
  signals: z.array(RankingSignalSchema).default([]),
  estimatedTokens: z.number().int().nonnegative().optional(),
});

export const FileSummarySchema = z.object({
  path: RelativePathSchema,
  contentHash: z.string().min(1).optional(),
  summary: z.string().min(1).max(1200),
  symbols: z.array(z.string().min(1)).default([]),
  declarations: z.array(z.string().min(1)).default([]),
  imports: z.array(z.string().min(1)).default([]),
  testNames: z.array(z.string().min(1)).default([]),
  snippet: z.string().min(1).max(1200).optional(),
  warnings: z.array(WarningSchema).default([]),
  redactions: z.array(RedactionSchema).default([]),
});

export const TokenEstimateSchema = z.object({
  modelHint: z.string().min(1).optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
  method: z.enum(["exact", "approximate", "fallback"]),
  confidence: z.enum(["low", "medium", "high"]),
});

export const ContextPackBudgetSchema = z.object({
  response: z.object({
    limitTokens: z.number().int().positive(),
    usedTokens: z.number().int().nonnegative(),
    exhausted: z.boolean(),
  }),
  recommendedContent: z.object({
    limitTokens: z.number().int().positive(),
    usedTokens: z.number().int().nonnegative(),
    exhausted: z.boolean(),
  }),
});

export const TokenAccountingMethodSchema = z.enum(["exact", "approximate", "fallback"]);

export const TokenAccountingConfidenceSchema = z.enum(["low", "medium", "high"]);

export const AgentTokenBreakdownSchema = z
  .object({
    agentInputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    agentOutputTokens: z.number().int().nonnegative().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.cachedInputTokens !== undefined &&
      value.agentInputTokens !== undefined &&
      value.cachedInputTokens > value.agentInputTokens
    ) {
      context.addIssue({
        code: "custom",
        message: "Cached input tokens must be a subset of agent input tokens.",
        path: ["cachedInputTokens"],
      });
    }
  });

export const ObservedWorkflowTokenUsageSchema = z
  .object({
    source: z.enum(["provider", "host"]),
    provider: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    breakdown: AgentTokenBreakdownSchema,
    totalTokens: z.number().int().nonnegative(),
  })
  .superRefine(validateConsumedTokenTotal);

export const EstimatedWorkflowTokenUsageSchema = z
  .object({
    source: z.enum(["local_estimator", "host", "optimizer"]),
    method: TokenAccountingMethodSchema,
    confidence: TokenAccountingConfidenceSchema,
    modelHint: z.string().min(1).max(200).optional(),
    breakdown: AgentTokenBreakdownSchema,
    totalTokens: z.number().int().nonnegative(),
  })
  .superRefine(validateConsumedTokenTotal);

export const RecommendedContentTokenEstimateSchema = z.object({
  tokens: z.number().int().nonnegative(),
  method: TokenAccountingMethodSchema,
  confidence: TokenAccountingConfidenceSchema,
  modelHint: z.string().min(1).max(200).optional(),
});

export const OptimizerTokenOverheadSchema = z
  .object({
    requestTokens: z.number().int().nonnegative(),
    responseTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    method: TokenAccountingMethodSchema,
    confidence: TokenAccountingConfidenceSchema,
    modelHint: z.string().min(1).max(200).optional(),
  })
  .superRefine((value, context) => {
    if (value.totalTokens !== value.requestTokens + value.responseTokens) {
      context.addIssue({
        code: "custom",
        message: "Optimizer overhead must equal request plus response tokens.",
        path: ["totalTokens"],
      });
    }
  });

export const WorkflowTokenAccountingSchema = z
  .object({
    observed: ObservedWorkflowTokenUsageSchema.optional(),
    estimated: EstimatedWorkflowTokenUsageSchema.optional(),
    optimizerOverhead: OptimizerTokenOverheadSchema.optional(),
    recommendedContent: RecommendedContentTokenEstimateSchema.optional(),
  })
  .refine((value) => value.observed !== undefined || value.estimated !== undefined, {
    message: "Workflow token accounting requires observed or estimated consumed usage.",
  });

export const ContextPackSchema = z.object({
  metadata: ContractMetadataSchema,
  packId: z.string().min(1).max(500).optional(),
  task: z.object({
    description: z.string().min(1).max(20000),
    analysis: TaskAnalysisSchema.optional(),
  }),
  selected: z.array(ContextCandidateSchema),
  excluded: z.array(ContextCandidateSchema).default([]),
  omittedCandidateCount: z.number().int().nonnegative().optional(),
  expansion: z
    .object({
      hasMore: z.boolean(),
      nextCursor: z.string().min(1).max(2048).optional(),
    })
    .optional(),
  summaries: z.array(FileSummarySchema).default([]),
  budget: ContextPackBudgetSchema.optional(),
  tokenEstimate: TokenEstimateSchema.optional(),
  expansionRules: z.array(z.string().min(1)).default([]),
  warnings: z.array(WarningSchema).default([]),
});

export const ContextRankingEvidenceSchema = z.object({
  metadata: ContractMetadataSchema,
  packId: z.string().min(1).max(500),
  taskDescription: z.string().min(1).max(20000),
  workspaceRootHash: z.string().min(1),
  selected: z.array(ContextCandidateSchema),
  excluded: z.array(ContextCandidateSchema),
});

export const ContextExpansionPageSchema = z.object({
  packId: z.string().min(1).max(500),
  candidates: z.array(ContextCandidateSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(2048).optional(),
  remainingCandidateCount: z.number().int().nonnegative(),
});

export type TaskComplexity = z.infer<typeof TaskComplexitySchema>;
export type OptimizationMode = z.infer<typeof OptimizationModeSchema>;
export type TaskOperation = z.infer<typeof TaskOperationSchema>;
export type TaskHints = z.infer<typeof TaskHintsSchema>;
export type TaskAnalysis = z.infer<typeof TaskAnalysisSchema>;
export type RankingSignal = z.infer<typeof RankingSignalSchema>;
export type ContextCandidate = z.infer<typeof ContextCandidateSchema>;
export type FileSummary = z.infer<typeof FileSummarySchema>;
export type TokenEstimate = z.infer<typeof TokenEstimateSchema>;
export type ContextPackBudget = z.infer<typeof ContextPackBudgetSchema>;
export type TokenAccountingMethod = z.infer<typeof TokenAccountingMethodSchema>;
export type TokenAccountingConfidence = z.infer<typeof TokenAccountingConfidenceSchema>;
export type AgentTokenBreakdown = z.infer<typeof AgentTokenBreakdownSchema>;
export type ObservedWorkflowTokenUsage = z.infer<typeof ObservedWorkflowTokenUsageSchema>;
export type EstimatedWorkflowTokenUsage = z.infer<
  typeof EstimatedWorkflowTokenUsageSchema
>;
export type RecommendedContentTokenEstimate = z.infer<
  typeof RecommendedContentTokenEstimateSchema
>;
export type OptimizerTokenOverhead = z.infer<typeof OptimizerTokenOverheadSchema>;
export type WorkflowTokenAccounting = z.infer<typeof WorkflowTokenAccountingSchema>;
export type ContextPack = z.infer<typeof ContextPackSchema>;
export type ContextRankingEvidence = z.infer<typeof ContextRankingEvidenceSchema>;
export type ContextExpansionPage = z.infer<typeof ContextExpansionPageSchema>;

function validateConsumedTokenTotal(
  value: {
    readonly breakdown: z.infer<typeof AgentTokenBreakdownSchema>;
    readonly totalTokens: number;
  },
  context: z.RefinementCtx,
): void {
  const { agentInputTokens, agentOutputTokens } = value.breakdown;

  if (agentInputTokens === undefined || agentOutputTokens === undefined) {
    return;
  }

  const consumedTotal = agentInputTokens + agentOutputTokens;

  if (value.totalTokens !== consumedTotal) {
    context.addIssue({
      code: "custom",
      message:
        "Total workflow tokens must equal agent input plus agent output tokens. Cached input, optimizer overhead, and recommended content are not added again.",
      path: ["totalTokens"],
    });
  }
}
