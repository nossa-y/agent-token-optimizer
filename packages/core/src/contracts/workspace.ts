import { z } from "zod";
import {
  AbsolutePathSchema,
  ContractMetadataSchema,
  IsoDateTimeSchema,
  RelativePathSchema,
  WarningSchema,
} from "./common";

export const FileKindSchema = z.enum([
  "source",
  "test",
  "config",
  "documentation",
  "asset",
  "generated",
  "binary",
  "unknown",
]);

export const IgnoreReasonSchema = z.enum([
  "gitignore",
  "optimizer_config",
  "binary",
  "oversized",
  "outside_workspace",
  "unsupported",
]);

export const WorkspaceFileSchema = z.object({
  path: RelativePathSchema,
  kind: FileKindSchema,
  language: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative(),
  contentHash: z.string().min(1).optional(),
  modifiedAt: IsoDateTimeSchema.optional(),
  generated: z.boolean().default(false),
  ignored: z.boolean().default(false),
  ignoreReason: IgnoreReasonSchema.optional(),
});

export const WorkspaceIndexSchema = z.object({
  metadata: ContractMetadataSchema,
  workspace: z.object({
    rootPath: AbsolutePathSchema,
    rootHash: z.string().min(1),
    name: z.string().min(1).optional(),
  }),
  files: z.array(WorkspaceFileSchema),
  totals: z.object({
    filesDiscovered: z.number().int().nonnegative(),
    filesIndexed: z.number().int().nonnegative(),
    filesIgnored: z.number().int().nonnegative(),
    bytesIndexed: z.number().int().nonnegative(),
  }),
  warnings: z.array(WarningSchema).default([]),
});

export type FileKind = z.infer<typeof FileKindSchema>;
export type IgnoreReason = z.infer<typeof IgnoreReasonSchema>;
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;
export type WorkspaceIndex = z.infer<typeof WorkspaceIndexSchema>;
