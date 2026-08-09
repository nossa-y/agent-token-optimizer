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

export const MANAGED_TOML_BLOCK_BEGIN = "# >>> agent-token-optimizer managed hooks >>>";
export const MANAGED_TOML_BLOCK_END = "# <<< agent-token-optimizer managed hooks <<<";

// The managed region is a byte span the installer owns end to end: the begin
// and end markers are recognized only as exact standalone lines, the block
// carries no trailing newline, and install prepends a single "\n" separator
// when appending after existing content. Uninstall removes exactly that span
// (block plus the one separator), so install -> uninstall restores the original
// bytes verbatim. Nothing outside the owned span is trimmed or rewritten.

export function createManagedHookTomlConfig(input: {
  readonly existingContent?: string;
  readonly command: readonly string[];
}): string {
  const block = renderManagedTomlBlock(input.command);
  const base = removeManagedHookTomlConfig({
    ...(input.existingContent !== undefined
      ? { existingContent: input.existingContent }
      : {}),
  });

  return base === "" ? block : `${base}\n${block}`;
}

export function removeManagedHookTomlConfig(input: {
  readonly existingContent?: string;
}): string {
  const existingContent = input.existingContent ?? "";
  const span = locateManagedTomlBlock(existingContent);

  if (span === undefined) {
    return existingContent;
  }

  return existingContent.slice(0, span.ownedStart) + existingContent.slice(span.end);
}

export function inspectManagedHookTomlConfig(input: {
  readonly existingContent?: string;
  readonly command: readonly string[];
}): "not-installed" | "installed" | "version-mismatch" | "invalid" {
  try {
    const existingContent = input.existingContent ?? "";
    const span = locateManagedTomlBlock(existingContent);

    if (span === undefined) {
      return "not-installed";
    }

    const block = existingContent.slice(span.blockStart, span.end);
    return block === renderManagedTomlBlock(input.command)
      ? "installed"
      : "version-mismatch";
  } catch {
    return "invalid";
  }
}

function renderManagedTomlBlock(command: readonly string[]): string {
  return [
    MANAGED_TOML_BLOCK_BEGIN,
    "# Managed by Agent Token Optimizer. Do not edit this block; run install or uninstall instead.",
    "[[hooks]]",
    'event = "UserPromptSubmit"',
    `command = ${encodeTomlBasicString(renderShellCommand(command))}`,
    "timeout = 30",
    MANAGED_TOML_BLOCK_END,
  ].join("\n");
}

interface ManagedTomlSpan {
  /** Byte offset of the first character of the begin marker line. */
  readonly blockStart: number;
  /** Byte offset just past the end marker text (before any trailing newline). */
  readonly end: number;
  /** Byte offset of the owned span, including one leading "\n" separator if present. */
  readonly ownedStart: number;
}

function locateManagedTomlBlock(content: string): ManagedTomlSpan | undefined {
  const begins = findStandaloneMarkers(content, MANAGED_TOML_BLOCK_BEGIN);
  const ends = findStandaloneMarkers(content, MANAGED_TOML_BLOCK_END);

  if (begins.length === 0 && ends.length === 0) {
    return undefined;
  }

  const begin = begins[0];
  const end = ends[0];

  if (begins.length !== 1 || ends.length !== 1 || begin === undefined) {
    throw new Error("The managed hook block markers are malformed.");
  }

  if (end === undefined || end.start < begin.start) {
    throw new Error("The managed hook block markers are misordered.");
  }

  const ownedStart =
    begin.start > 0 && content[begin.start - 1] === "\n" ? begin.start - 1 : begin.start;

  return { blockStart: begin.start, end: end.textEnd, ownedStart };
}

/**
 * Finds every occurrence of `marker` that is a standalone line: it begins the
 * file or follows a newline, and it ends the file or is followed by a newline
 * (optionally a CRLF). Marker text embedded in a TOML string or trailed by
 * other characters is deliberately not matched.
 */
function findStandaloneMarkers(
  content: string,
  marker: string,
): { readonly start: number; readonly textEnd: number }[] {
  const matches: { readonly start: number; readonly textEnd: number }[] = [];
  let searchFrom = 0;

  for (;;) {
    const start = content.indexOf(marker, searchFrom);

    if (start === -1) {
      break;
    }

    const textEnd = start + marker.length;
    const atLineStart = start === 0 || content[start - 1] === "\n";
    const nextChar = content[textEnd];
    const atLineEnd =
      nextChar === undefined ||
      nextChar === "\n" ||
      (nextChar === "\r" && content[textEnd + 1] === "\n");

    if (atLineStart && atLineEnd) {
      matches.push({ start, textEnd });
    }

    searchFrom = textEnd;
  }

  return matches;
}

function encodeTomlBasicString(value: string): string {
  let encoded = '"';

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (character === "\\") {
      encoded += "\\\\";
    } else if (character === '"') {
      encoded += '\\"';
    } else if (codePoint < 0x20 || codePoint === 0x7f) {
      encoded += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      encoded += character;
    }
  }

  return `${encoded}"`;
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
