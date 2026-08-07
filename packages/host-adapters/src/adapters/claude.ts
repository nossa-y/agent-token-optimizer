import path from "node:path";

import {
  createHostConfigChange,
  createManagedHookJsonConfig,
  inspectManagedHookJsonConfig,
  pathExists,
  readTextIfExists,
  removeManagedHookJsonConfig,
} from "../file-ops";
import type {
  HostAdapter,
  HostConfigChange,
  HostDetection,
  HostDetectionContext,
  HostInstallContext,
} from "../types";

export const claudeAdapter: HostAdapter = {
  host: "claude-code",
  displayName: "Claude Code",
  async detect(context) {
    const configPath = claudeConfigPath(context);
    const detected = await pathExists(path.join(context.homePath, ".claude")).then(
      async (directoryExists) => directoryExists || (await pathExists(configPath)),
    );

    return {
      host: "claude-code",
      displayName: "Claude Code",
      detected: isRequested(context, "claude-code") || detected,
      confidence: isRequested(context, "claude-code")
        ? "requested"
        : detected
          ? "high"
          : "low",
      reason: detected
        ? "Detected Claude Code configuration directory or settings file."
        : "Claude was not detected; pass --hosts claude-code to force a config plan.",
      configPath,
    };
  },
  async planInstall(context, detection) {
    return [await createClaudeConfigChange(context, detection)];
  },
  async planUninstall(_context, detection) {
    const existingContent = await readTextIfExists(detection.configPath);
    return [
      createHostConfigChange({
        host: "claude-code",
        path: detection.configPath,
        description: "Remove the managed UserPromptSubmit hook from Claude Code.",
        existingContent,
        skipIfMissing: true,
        content: removeManagedHookJsonConfig({
          ...(existingContent ? { existingContent } : {}),
        }),
      }),
    ];
  },
  async inspect(context, detection) {
    const existingContent = await readTextIfExists(detection.configPath);
    const status = inspectManagedHookJsonConfig({
      ...(existingContent ? { existingContent } : {}),
      command: context.hookCommand,
    });
    return {
      host: "claude-code",
      displayName: "Claude Code",
      configPath: detection.configPath,
      status,
      message: statusMessage(status),
    };
  },
};

function claudeConfigPath(context: HostDetectionContext): string {
  return path.join(context.homePath, ".claude", "settings.json");
}

async function createClaudeConfigChange(
  context: HostInstallContext,
  detection: HostDetection,
): Promise<HostConfigChange> {
  const existingContent = await readTextIfExists(detection.configPath);

  return createHostConfigChange({
    host: "claude-code",
    path: detection.configPath,
    description: "Install the managed UserPromptSubmit hook for Claude Code.",
    existingContent,
    content: createManagedHookJsonConfig({
      ...(existingContent ? { existingContent } : {}),
      command: context.hookCommand,
    }),
  });
}

function isRequested(context: HostDetectionContext, host: "claude-code"): boolean {
  return context.requestedHosts?.includes(host) ?? false;
}

function statusMessage(
  status: Awaited<ReturnType<HostAdapter["inspect"]>>["status"],
): string {
  switch (status) {
    case "installed":
      return "The managed hook is installed and matches this checkout.";
    case "version-mismatch":
      return "The managed hook points to a different checkout or command; run install again.";
    case "invalid":
      return "The Claude Code settings file is not valid managed-hook JSON.";
    case "not-installed":
      return "The managed hook is not installed.";
  }
}
