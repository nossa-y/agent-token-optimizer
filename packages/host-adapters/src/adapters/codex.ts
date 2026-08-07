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

export const codexAdapter: HostAdapter = {
  host: "codex",
  displayName: "Codex",
  async detect(context) {
    const configPath = codexConfigPath(context);
    const detected =
      (await pathExists(path.join(context.homePath, ".codex"))) ||
      (await pathExists(configPath));

    return {
      host: "codex",
      displayName: "Codex",
      detected: isRequested(context, "codex") || detected,
      confidence: isRequested(context, "codex") ? "requested" : detected ? "high" : "low",
      reason: detected
        ? "Detected Codex configuration directory or config.toml."
        : "Codex was not detected; pass --hosts codex to force a config plan.",
      configPath,
    };
  },
  async planInstall(context, detection) {
    return [await createCodexConfigChange(context, detection)];
  },
  async planUninstall(_context, detection) {
    const existingContent = await readTextIfExists(detection.configPath);
    return [
      createHostConfigChange({
        host: "codex",
        path: detection.configPath,
        description: "Remove the managed UserPromptSubmit hook from Codex.",
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
      host: "codex",
      displayName: "Codex",
      configPath: detection.configPath,
      status,
      message: statusMessage(status),
    };
  },
};

function codexConfigPath(context: HostDetectionContext): string {
  return path.join(context.homePath, ".codex", "hooks.json");
}

async function createCodexConfigChange(
  context: HostInstallContext,
  detection: HostDetection,
): Promise<HostConfigChange> {
  const existingContent = await readTextIfExists(detection.configPath);

  return createHostConfigChange({
    host: "codex",
    path: detection.configPath,
    description: "Install the managed UserPromptSubmit hook for Codex.",
    existingContent,
    content: createManagedHookJsonConfig({
      ...(existingContent ? { existingContent } : {}),
      command: context.hookCommand,
      additionalContextLimit: 1400,
    }),
  });
}

function isRequested(context: HostDetectionContext, host: "codex"): boolean {
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
      return "The Codex hooks file is not valid managed-hook JSON.";
    case "not-installed":
      return "The managed hook is not installed.";
  }
}
