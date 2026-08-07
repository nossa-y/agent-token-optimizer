import { access } from "node:fs/promises";

import type { DiagnosticResult, DiagnosticStatus } from "../contracts";
import type { AgentTokenStore } from "../store";

export interface DoctorCheckContext {
  readonly packageVersion?: string;
  readonly operationId?: string;
  readonly minimumNodeMajor?: number;
  readonly minimumNodeVersion?: string;
  readonly workspacePath?: string;
  readonly store?: AgentTokenStore;
  readonly now?: Date;
}

interface DoctorCheck {
  readonly name: string;
  readonly status: DiagnosticStatus;
  readonly message: string;
  readonly recovery?: string;
}

export async function runDoctor(
  context: DoctorCheckContext = {},
): Promise<DiagnosticResult> {
  const minimumNodeVersion =
    context.minimumNodeVersion ??
    (context.minimumNodeMajor === undefined
      ? "22.13.0"
      : `${context.minimumNodeMajor}.0.0`);
  const checks = [
    checkNodeVersion(minimumNodeVersion),
    ...(context.workspacePath ? [await checkWorkspaceAccess(context.workspacePath)] : []),
    ...(context.store ? [await checkStoreHealth(context.store)] : []),
  ];

  return {
    metadata: {
      contractVersion: "1.0",
      generatedAt: (context.now ?? new Date()).toISOString(),
      generator: {
        name: "agent-token-optimizer",
        version: context.packageVersion ?? "0.1.0",
      },
      ...(context.operationId ? { operationId: context.operationId } : {}),
    },
    status: summarizeStatus(checks),
    checks,
    warnings: [],
  };
}

function checkNodeVersion(minimumNodeVersion: string): DoctorCheck {
  if (compareVersions(process.versions.node, minimumNodeVersion) >= 0) {
    return {
      name: "node_version",
      status: "pass",
      message: `Node ${process.versions.node} satisfies >=${minimumNodeVersion}.`,
    };
  }

  return {
    name: "node_version",
    status: "fail",
    message: `Node ${process.versions.node} is below required version ${minimumNodeVersion}.`,
    recovery: `Install Node ${minimumNodeVersion} or newer.`,
  };
}

function compareVersions(current: string, minimum: string): number {
  const currentParts = parseVersion(current);
  const minimumParts = parseVersion(minimum);

  for (let index = 0; index < 3; index += 1) {
    const difference = (currentParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function parseVersion(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);

  if (!match) {
    throw new TypeError(`Invalid Node version: ${value}`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

async function checkWorkspaceAccess(workspacePath: string): Promise<DoctorCheck> {
  try {
    await access(workspacePath);

    return {
      name: "workspace_access",
      status: "pass",
      message: "Workspace path is readable.",
    };
  } catch {
    return {
      name: "workspace_access",
      status: "fail",
      message: "Workspace path is not readable.",
      recovery: "Check the workspace path and filesystem permissions.",
    };
  }
}

async function checkStoreHealth(store: AgentTokenStore): Promise<DoctorCheck> {
  try {
    const health = await store.health();

    return {
      name: "store_health",
      status: health.ok ? "pass" : "warn",
      message: `Store has ${health.records} records and ${health.migrationsApplied.length} migrations applied.`,
      ...(health.ok ? {} : { recovery: "Run cache repair and retry diagnostics." }),
    };
  } catch {
    return {
      name: "store_health",
      status: "fail",
      message: "Store health check failed.",
      recovery: "Initialize or repair the local cache store.",
    };
  }
}

function summarizeStatus(checks: readonly DoctorCheck[]): DiagnosticStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }

  if (checks.some((check) => check.status === "warn")) {
    return "warn";
  }

  if (checks.length === 0) {
    return "skip";
  }

  return "pass";
}
