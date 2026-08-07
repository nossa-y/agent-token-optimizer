import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const WorkspaceOptimizationConfigSchema = z
  .object({
    maxFileSizeBytes: z.number().int().positive().max(10_000_000).optional(),
    maxFiles: z.number().int().positive().max(100_000).optional(),
    maxTotalBytes: z.number().int().nonnegative().max(1_000_000_000).optional(),
    concurrency: z.number().int().positive().max(64).optional(),
    rankingLimit: z.number().int().positive().max(200).optional(),
    fallbackLimit: z.number().int().nonnegative().max(50).optional(),
    responseTokenBudget: z.number().int().positive().max(100_000).optional(),
    recommendedContentTokenBudget: z.number().int().positive().max(10_000_000).optional(),
    selectionThreshold: z.number().min(0).max(100).optional(),
    summaryMaxChars: z.number().int().positive().max(12_000).optional(),
    extraIgnorePatterns: z.array(z.string().min(1).max(500)).max(200).optional(),
    supportedLanguages: z.array(z.string().min(1).max(100)).max(100).optional(),
  })
  .strict();

const WorkspaceCacheConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .strict();

const WorkspaceMcpConfigSchema = z
  .object({
    command: z
      .union([
        z.array(z.string().min(1).max(1_000)).min(1).max(20),
        z.string().min(1).max(1_000),
      ])
      .transform((value) => (Array.isArray(value) ? value : value.trim().split(/\s+/u))),
  })
  .strict();

const WorkspaceHostAdaptersConfigSchema = z
  .object({
    configured: z.boolean().default(false),
    requestedHosts: z.array(z.string().min(1).max(100)).default([]),
    plannedChanges: z
      .array(
        z.object({
          host: z.string().min(1).max(100),
          path: z.string().min(1).max(4_096),
          description: z.string().min(1).max(1_000),
        }),
      )
      .default([]),
    appliedChanges: z
      .array(
        z.object({
          host: z.string().min(1).max(100),
          path: z.string().min(1).max(4_096),
          backupPath: z.string().min(1).max(4_096).optional(),
        }),
      )
      .default([]),
  })
  .strict();

export const WorkspaceConfigurationSchema = z
  .object({
    version: z.literal(1),
    workspaceRoot: z.string().min(1).max(4_096),
    cachePath: z.string().min(1).max(4_096).optional(),
    cache: WorkspaceCacheConfigSchema.optional(),
    mcp: WorkspaceMcpConfigSchema.optional(),
    hostAdapters: WorkspaceHostAdaptersConfigSchema.optional(),
    optimization: WorkspaceOptimizationConfigSchema.optional(),
  })
  .strict();

export type WorkspaceConfiguration = z.infer<typeof WorkspaceConfigurationSchema>;

export interface LoadedWorkspaceConfiguration {
  readonly configPath: string;
  readonly config?: WorkspaceConfiguration;
}

export function workspaceConfigurationPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agent-token-optimizer", "config.json");
}

export async function loadWorkspaceConfiguration(
  workspaceRoot: string,
): Promise<LoadedWorkspaceConfiguration> {
  const configPath = workspaceConfigurationPath(workspaceRoot);

  try {
    const serialized = await readFile(configPath, "utf8");
    const config = WorkspaceConfigurationSchema.parse(JSON.parse(serialized) as unknown);

    return { configPath, config };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { configPath };
    }

    throw new Error(
      `Invalid workspace configuration at ${configPath}: ${formatError(error)}`,
    );
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
