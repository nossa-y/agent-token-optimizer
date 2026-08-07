import { z } from "zod";

import { ContractMetadataSchema, RelativePathSchema } from "./common";
import { OptimizationModeSchema, TaskComplexitySchema } from "./optimization";

export const UserPromptHookEvidenceSchema = z.object({
  metadata: ContractMetadataSchema,
  event: z.literal("UserPromptSubmit"),
  taskHash: z.string().regex(/^[a-f0-9]{64}$/u),
  workspaceRootHash: z.string().min(1),
  outcome: z.enum(["skipped", "context_injected"]),
  recommendation: z.object({
    mode: OptimizationModeSchema,
    complexity: TaskComplexitySchema,
    risk: z.enum(["low", "medium", "high"]),
  }),
  selectedFiles: z.array(
    z.object({
      path: RelativePathSchema,
      contentHash: z.string().min(1).optional(),
    }),
  ),
  response: z.object({
    budgetTokens: z.number().int().positive().max(2_000),
    usedTokens: z.number().int().nonnegative(),
  }),
  cache: z.object({
    enabled: z.boolean(),
    previousWorkspaceIndexFound: z.boolean(),
    previousWorkspaceAnalysisFound: z.boolean(),
    reusedFiles: z.number().int().nonnegative(),
    changedFiles: z.number().int().nonnegative(),
    deletedFiles: z.number().int().nonnegative(),
  }),
  durationMs: z.number().int().nonnegative(),
});

export type UserPromptHookEvidence = z.infer<typeof UserPromptHookEvidenceSchema>;
