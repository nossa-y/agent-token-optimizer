import { z } from "zod";

import { ContractMetadataSchema, RelativePathSchema } from "./common";
import { FileKindSchema, IgnoreReasonSchema } from "./workspace";

export const WORKSPACE_ANALYSIS_INDEX_VERSION = 1;

export const AnalyzedSymbolSchema = z.object({
  name: z.string().min(1).max(500),
  kind: z.enum(["class", "enum", "function", "interface", "type", "variable"]),
  exported: z.boolean(),
  signature: z.string().min(1).max(1200),
});

export const WorkspaceFileAnalysisSchema = z.object({
  path: RelativePathSchema,
  language: z.string().min(1).optional(),
  contentHash: z.string().min(1).optional(),
  analysisMethod: z.enum(["typescript_ast", "lexical_fallback", "skipped"]),
  symbols: z.array(AnalyzedSymbolSchema).default([]),
  imports: z.array(z.string().min(1).max(2048)).default([]),
  internalDependencies: z.array(RelativePathSchema).default([]),
  testTargets: z.array(RelativePathSchema).default([]),
  lexicalTerms: z.array(z.string().min(1).max(200)).default([]),
  ownership: z.object({
    workspaceName: z.string().min(1).optional(),
    packagePath: z.string().min(1).max(2048).optional(),
    packageName: z.string().min(1).max(500).optional(),
  }),
  policy: z.object({
    kind: FileKindSchema,
    generated: z.boolean(),
    ignored: z.boolean(),
    ignoreReason: IgnoreReasonSchema.optional(),
  }),
});

export const WorkspaceAnalysisIndexSchema = z.object({
  metadata: ContractMetadataSchema,
  indexVersion: z.literal(WORKSPACE_ANALYSIS_INDEX_VERSION),
  workspace: z.object({
    rootHash: z.string().min(1),
    name: z.string().min(1).optional(),
  }),
  files: z.array(WorkspaceFileAnalysisSchema),
  documentFrequencies: z.record(z.string().min(1), z.number().int().positive()),
  statistics: z.object({
    analyzedFiles: z.number().int().nonnegative(),
    fallbackFiles: z.number().int().nonnegative(),
    skippedFiles: z.number().int().nonnegative(),
    reusedFiles: z.number().int().nonnegative(),
    changedFiles: z.number().int().nonnegative(),
    deletedFiles: z.number().int().nonnegative(),
  }),
});

export type AnalyzedSymbol = z.infer<typeof AnalyzedSymbolSchema>;
export type WorkspaceFileAnalysis = z.infer<typeof WorkspaceFileAnalysisSchema>;
export type WorkspaceAnalysisIndex = z.infer<typeof WorkspaceAnalysisIndexSchema>;
