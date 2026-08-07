import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import { kimiAdapter } from "./adapters/kimi";
import { applyHostInstallPlan } from "./file-ops";
import type {
  ApplyHostInstallPlanOptions,
  HostAdapter,
  HostApplyResult,
  HostDetection,
  HostDetectionContext,
  HostInstallContext,
  HostInstallPlan,
  HostInstallationStatus,
  SupportedHost,
} from "./types";

const ADAPTERS: readonly HostAdapter[] = [claudeAdapter, codexAdapter, kimiAdapter];

export async function detectHostAdapters(
  context: HostDetectionContext,
): Promise<HostDetection[]> {
  const requestedHosts = normalizeRequestedHosts(context.requestedHosts);
  const detectionContext = {
    ...context,
    ...(requestedHosts ? { requestedHosts } : {}),
  };
  const detections = await Promise.all(
    ADAPTERS.map((adapter) => adapter.detect(detectionContext)),
  );

  return detections.sort((left, right) => left.host.localeCompare(right.host));
}

export async function createHostInstallPlan(
  context: HostInstallContext,
): Promise<HostInstallPlan> {
  const requestedHosts = normalizeRequestedHosts(context.requestedHosts);
  const detections = await detectHostAdapters({
    homePath: context.homePath,
    workspaceRoot: context.workspaceRoot,
    ...(requestedHosts ? { requestedHosts } : {}),
  });
  const adaptersByHost = new Map(ADAPTERS.map((adapter) => [adapter.host, adapter]));
  const changes = [];
  const warnings = [];

  for (const detection of detections) {
    if (!detection.detected) {
      continue;
    }

    const adapter = adaptersByHost.get(detection.host);

    if (!adapter) {
      warnings.push(`No adapter is registered for host ${detection.host}.`);
      continue;
    }

    changes.push(...(await adapter.planInstall(context, detection)));
  }

  if (changes.length === 0) {
    warnings.push(
      "No supported hosts were detected. Pass --hosts codex,claude-code,kimi to select hosts explicitly.",
    );
  }

  return {
    detections,
    changes,
    warnings,
  };
}

export async function createHostUninstallPlan(
  context: HostInstallContext,
): Promise<HostInstallPlan> {
  return await createHostChangePlan(context, "uninstall");
}

export async function inspectHostAdapters(
  context: HostInstallContext,
): Promise<HostInstallationStatus[]> {
  const requestedHosts = normalizeRequestedHosts(context.requestedHosts);
  const detections = await detectHostAdapters({
    homePath: context.homePath,
    workspaceRoot: context.workspaceRoot,
    ...(requestedHosts ? { requestedHosts } : {}),
  });
  const adaptersByHost = new Map(ADAPTERS.map((adapter) => [adapter.host, adapter]));

  return await Promise.all(
    detections
      .filter((detection) => detection.detected)
      .map(async (detection) => {
        const adapter = adaptersByHost.get(detection.host);
        if (!adapter) {
          throw new Error(`No adapter is registered for host ${detection.host}.`);
        }
        return await adapter.inspect(context, detection);
      }),
  );
}

export async function applyDetectedHostInstallPlan(
  plan: HostInstallPlan,
  options: ApplyHostInstallPlanOptions = {},
): Promise<HostApplyResult> {
  return await applyHostInstallPlan(plan, options);
}

export function parseSupportedHosts(
  value: string | undefined,
): SupportedHost[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  return normalizeRequestedHosts(
    value
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
  );
}

function normalizeRequestedHosts(
  hosts: readonly string[] | undefined,
): SupportedHost[] | undefined {
  if (!hosts) {
    return undefined;
  }

  const normalizedHosts = hosts.map((host) => {
    switch (host) {
      case "claude":
      case "claude-code":
        return "claude-code";
      case "codex":
        return host;
      case "kimi":
      case "kimi-code":
        return "kimi";
      default:
        throw new Error(`Unsupported host adapter: ${host}`);
    }
  });

  return [...new Set(normalizedHosts)];
}

async function createHostChangePlan(
  context: HostInstallContext,
  action: "uninstall",
): Promise<HostInstallPlan> {
  const requestedHosts = normalizeRequestedHosts(context.requestedHosts);
  const detections = await detectHostAdapters({
    homePath: context.homePath,
    workspaceRoot: context.workspaceRoot,
    ...(requestedHosts ? { requestedHosts } : {}),
  });
  const adaptersByHost = new Map(ADAPTERS.map((adapter) => [adapter.host, adapter]));
  const changes = [];
  const warnings = [];

  for (const detection of detections) {
    if (!detection.detected) {
      continue;
    }
    const adapter = adaptersByHost.get(detection.host);
    if (!adapter) {
      warnings.push(`No adapter is registered for host ${detection.host}.`);
      continue;
    }
    changes.push(...(await adapter.planUninstall(context, detection)));
  }

  if (changes.length === 0) {
    warnings.push(`No supported hosts were selected for ${action}.`);
  }

  return { detections, changes, warnings };
}
