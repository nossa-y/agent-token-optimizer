import { z } from "zod";

export const ContractVersionSchema = z.literal("1.0");

export const IsoDateTimeSchema = z
  .string()
  .datetime()
  .describe("ISO 8601 timestamp in UTC or with an explicit offset.");

export const RelativePathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !value.startsWith("/"), "Path must be relative.")
  .refine((value) => !value.includes("\0"), "Path must not contain null bytes.")
  .refine(
    (value) => !value.split(/[\\/]+/).includes(".."),
    "Path must not traverse outside the workspace.",
  );

export const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), "Path must not contain null bytes.");

export const HostNameSchema = z.enum([
  "claude-code",
  "codex",
  "cursor",
  "kimi",
  "windsurf",
  "unknown",
]);

export const SeveritySchema = z.enum(["debug", "info", "warn", "error"]);

export const WarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: SeveritySchema.exclude(["debug"]),
  path: RelativePathSchema.optional(),
  recoverable: z.boolean().default(true),
});

export const ContractMetadataSchema = z.object({
  contractVersion: ContractVersionSchema,
  generatedAt: IsoDateTimeSchema,
  generator: z.object({
    name: z.literal("agent-token-optimizer"),
    version: z.string().min(1),
  }),
  operationId: z.string().min(1).optional(),
});

export const RedactionSchema = z.object({
  redacted: z.boolean(),
  reason: z
    .enum(["secret_pattern", "user_config", "ignored_file", "none"])
    .default("none"),
  replacement: z.string().default("[REDACTED]"),
});

export type ContractVersion = z.infer<typeof ContractVersionSchema>;
export type ContractMetadata = z.infer<typeof ContractMetadataSchema>;
export type HostName = z.infer<typeof HostNameSchema>;
export type Warning = z.infer<typeof WarningSchema>;
export type Redaction = z.infer<typeof RedactionSchema>;
