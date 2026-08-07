import path from "node:path";

import {
  createHostConfigChange,
  createManagedHookTomlConfig,
  inspectManagedHookTomlConfig,
  pathExists,
  readTextIfExists,
  removeManagedHookTomlConfig,
} from "../file-ops";
import type {
  HostAdapter,
  HostConfigChange,
  HostDetection,
  HostDetectionContext,
  HostInstallContext,
} from "../types";

export const kimiAdapter: HostAdapter = {
  host: "kimi",
  displayName: "Kimi Code",
  async detect(context) {
    const configPath = kimiConfigPath(context);
    const detected = await pathExists(path.join(context.homePath, ".kimi-code")).then(
      async (directoryExists) => directoryExists || (await pathExists(configPath)),
    );

    return {
      host: "kimi",
      displayName: "Kimi Code",
      detected: isRequested(context, "kimi") || detected,
      confidence: isRequested(context, "kimi") ? "requested" : detected ? "high" : "low",
      reason: detected
        ? "Detected Kimi Code configuration directory or config file."
        : "Kimi Code was not detected; pass --hosts kimi to force a config plan.",
      configPath,
    };
  },
  async planInstall(context, detection) {
    return [await createKimiConfigChange(context, detection)];
  },
  async planUninstall(_context, detection) {
    const existingContent = await readTextIfExists(detection.configPath);
    return [
      createHostConfigChange({
        host: "kimi",
        path: detection.configPath,
        description: "Remove the managed UserPromptSubmit hook from Kimi Code.",
        existingContent,
        skipIfMissing: true,
        content: removeManagedHookTomlConfig({
          ...(existingContent ? { existingContent } : {}),
        }),
      }),
    ];
  },
  async inspect(context, detection) {
    const existingContent = await readTextIfExists(detection.configPath);
    const status = inspectManagedHookTomlConfig({
      ...(existingContent ? { existingContent } : {}),
      command: kimiHookCommand(context),
    });
    return {
      host: "kimi",
      displayName: "Kimi Code",
      configPath: detection.configPath,
      status,
      message: statusMessage(status),
    };
  },
};

function kimiConfigPath(context: HostDetectionContext): string {
  return path.join(context.homePath, ".kimi-code", "config.toml");
}

function kimiHookCommand(context: HostInstallContext): readonly string[] {
  return [...context.hookCommand, "--host", "kimi"];
}

async function createKimiConfigChange(
  context: HostInstallContext,
  detection: HostDetection,
): Promise<HostConfigChange> {
  const existingContent = await readTextIfExists(detection.configPath);

  return createHostConfigChange({
    host: "kimi",
    path: detection.configPath,
    description: "Install the managed UserPromptSubmit hook for Kimi Code.",
    existingContent,
    content: createManagedHookTomlConfig({
      ...(existingContent ? { existingContent } : {}),
      command: kimiHookCommand(context),
    }),
  });
}

function isRequested(context: HostDetectionContext, host: "kimi"): boolean {
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
      return "The Kimi Code config file contains a malformed managed hook block.";
    case "not-installed":
      return "The managed hook is not installed.";
  }
}
