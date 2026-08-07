import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ApplyHostInstallPlanOptions,
  HostConfigChangeAction,
  HostApplyResult,
  HostConfigChange,
  HostInstallPlan,
} from "./types";

export const MANAGED_HOOK_MARKER = "agent-token-optimizer-managed-hook";

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readTextIfExists(targetPath: string): Promise<string | undefined> {
  if (!(await pathExists(targetPath))) {
    return undefined;
  }

  return await readFile(targetPath, "utf8");
}

export async function applyHostInstallPlan(
  plan: HostInstallPlan,
  options: ApplyHostInstallPlanOptions = {},
): Promise<HostApplyResult> {
  if (options.dryRun) {
    return {
      applied: [],
      skipped: plan.changes,
    };
  }

  const applied: HostConfigChange[] = [];
  const skipped: HostConfigChange[] = [];

  try {
    for (const change of plan.changes) {
      if (change.action === "unchanged") {
        skipped.push(change);
        continue;
      }

      const backupPath = await backupExistingFile(change, options.now ?? new Date());
      const appliedChange = {
        ...change,
        ...(backupPath ? { backupPath } : {}),
      };

      await atomicWriteFile(change.path, change.content);
      applied.push(appliedChange);
    }
  } catch (error) {
    await rollbackHostConfigChanges(applied);
    throw error;
  }

  return {
    applied,
    skipped,
  };
}

export function createHostConfigChange(input: {
  readonly host: HostConfigChange["host"];
  readonly path: string;
  readonly description: string;
  readonly content: string;
  readonly existingContent: string | undefined;
  readonly skipIfMissing?: boolean;
}): HostConfigChange {
  const existed = input.existingContent !== undefined;
  const action: HostConfigChangeAction =
    !existed && input.skipIfMissing
      ? "unchanged"
      : !existed
        ? "create"
        : input.existingContent === input.content
          ? "unchanged"
          : "update";

  return {
    host: input.host,
    path: input.path,
    description: input.description,
    content: input.content,
    existed,
    action,
  };
}

export async function rollbackHostConfigChanges(
  changes: readonly HostConfigChange[],
): Promise<void> {
  for (const change of [...changes].reverse()) {
    if (change.backupPath && (await pathExists(change.backupPath))) {
      await atomicWriteFile(change.path, await readFile(change.backupPath, "utf8"));
      continue;
    }

    if (!change.existed) {
      await rm(change.path, { force: true });
    }
  }
}

export function createManagedHookJsonConfig(input: {
  readonly existingContent?: string;
  readonly command: readonly string[];
  readonly additionalContextLimit?: number;
}): string {
  const existing = parseJsonObject(input.existingContent);
  const hooks = parseRecord(existing.hooks);
  const userPromptSubmit = parseHookGroups(hooks.UserPromptSubmit);
  const unmanagedGroups = userPromptSubmit.filter((group) => !isManagedHookGroup(group));
  const hook = {
    type: "command",
    command: renderShellCommand(input.command),
    timeout: 30,
    statusMessage: "Selecting focused repository context",
    ...(input.additionalContextLimit
      ? { additionalContextLimit: input.additionalContextLimit }
      : {}),
  };

  return `${JSON.stringify(
    {
      ...existing,
      hooks: {
        ...hooks,
        UserPromptSubmit: [...unmanagedGroups, { hooks: [hook] }],
      },
    },
    null,
    2,
  )}\n`;
}

export function removeManagedHookJsonConfig(input: {
  readonly existingContent?: string;
}): string {
  const existing = parseJsonObject(input.existingContent);
  const hooks = parseRecord(existing.hooks);
  const userPromptSubmit = parseHookGroups(hooks.UserPromptSubmit);
  const hasManagedHook = userPromptSubmit.some((group) => isManagedHookGroup(group));

  if (!hasManagedHook) {
    return input.existingContent ?? "{}\n";
  }

  const unmanagedGroups = userPromptSubmit.filter((group) => !isManagedHookGroup(group));
  const nextHooks = { ...hooks };

  if (unmanagedGroups.length > 0) {
    nextHooks.UserPromptSubmit = unmanagedGroups;
  } else {
    delete nextHooks.UserPromptSubmit;
  }

  const nextConfig = { ...existing };

  if (Object.keys(nextHooks).length > 0) {
    nextConfig.hooks = nextHooks;
  } else {
    delete nextConfig.hooks;
  }

  return `${JSON.stringify(nextConfig, null, 2)}\n`;
}

export function inspectManagedHookJsonConfig(input: {
  readonly existingContent?: string;
  readonly command: readonly string[];
}): "not-installed" | "installed" | "version-mismatch" | "invalid" {
  try {
    const existing = parseJsonObject(input.existingContent);
    const hooks = parseRecord(existing.hooks);
    const managedGroup = parseHookGroups(hooks.UserPromptSubmit).find((group) =>
      isManagedHookGroup(group),
    );

    if (!managedGroup) {
      return "not-installed";
    }

    const installedCommand = getManagedHookCommand(managedGroup);
    return installedCommand === renderShellCommand(input.command)
      ? "installed"
      : "version-mismatch";
  } catch {
    return "invalid";
  }
}

async function backupExistingFile(
  change: HostConfigChange,
  now: Date,
): Promise<string | undefined> {
  if (!change.existed || !(await pathExists(change.path))) {
    return undefined;
  }

  const backupPath =
    change.backupPath ??
    `${change.path}.agent-token-optimizer.${now.toISOString().replace(/[:.]/gu, "-")}.bak`;
  await mkdir(path.dirname(backupPath), { mode: 0o700, recursive: true });
  await writeFile(backupPath, await readFile(change.path, "utf8"), {
    flag: "wx",
    mode: 0o600,
  });

  return backupPath;
}

export async function atomicWriteFile(
  targetPath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(targetPath), { mode: 0o700, recursive: true });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, content, { flag: "wx", mode: 0o600 });
  await rename(temporaryPath, targetPath);
  await chmod(targetPath, 0o600);
}

function parseJsonObject(content: string | undefined): Record<string, unknown> {
  if (!content?.trim()) {
    return {};
  }

  const parsed = JSON.parse(content) as unknown;

  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }

  throw new Error("Host config must be a JSON object.");
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function parseHookGroups(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  throw new Error("UserPromptSubmit hooks must be an array.");
}

function isManagedHookGroup(value: unknown): boolean {
  return getManagedHookCommand(value)?.includes(MANAGED_HOOK_MARKER) ?? false;
}

function getManagedHookCommand(value: unknown): string | undefined {
  const group = parseRecord(value);

  if (!Array.isArray(group.hooks)) {
    return undefined;
  }

  for (const hookValue of group.hooks) {
    const hook = parseRecord(hookValue);
    if (hook.type === "command" && typeof hook.command === "string") {
      if (hook.command.includes(MANAGED_HOOK_MARKER)) {
        return hook.command;
      }
    }
  }

  return undefined;
}

function renderShellCommand(command: readonly string[]): string {
  if (command.length === 0) {
    throw new Error("Hook command must include an executable.");
  }

  return command.map(quoteShellArgument).join(" ");
}

function quoteShellArgument(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replaceAll('"', '\\"')}"`;
  }

  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
