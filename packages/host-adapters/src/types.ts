export type SupportedHost = "claude-code" | "codex" | "kimi";
export type HostConfigChangeAction = "create" | "update" | "unchanged";

export interface HostDetectionContext {
  readonly homePath: string;
  readonly workspaceRoot: string;
  readonly requestedHosts?: readonly SupportedHost[];
}

export interface HostInstallContext extends HostDetectionContext {
  readonly hookCommand: readonly string[];
}

export interface HostDetection {
  readonly host: SupportedHost;
  readonly displayName: string;
  readonly detected: boolean;
  readonly confidence: "requested" | "high" | "medium" | "low";
  readonly reason: string;
  readonly configPath: string;
}

export interface HostConfigChange {
  readonly host: SupportedHost;
  readonly path: string;
  readonly description: string;
  readonly content: string;
  readonly existed: boolean;
  readonly action: HostConfigChangeAction;
  readonly backupPath?: string;
}

export interface HostInstallPlan {
  readonly detections: readonly HostDetection[];
  readonly changes: readonly HostConfigChange[];
  readonly warnings: readonly string[];
}

export interface HostApplyResult {
  readonly applied: readonly HostConfigChange[];
  readonly skipped: readonly HostConfigChange[];
}

export interface HostAdapter {
  readonly host: SupportedHost;
  readonly displayName: string;
  readonly detect: (context: HostDetectionContext) => Promise<HostDetection>;
  readonly planInstall: (
    context: HostInstallContext,
    detection: HostDetection,
  ) => Promise<readonly HostConfigChange[]>;
  readonly planUninstall: (
    context: HostInstallContext,
    detection: HostDetection,
  ) => Promise<readonly HostConfigChange[]>;
  readonly inspect: (
    context: HostInstallContext,
    detection: HostDetection,
  ) => Promise<HostInstallationStatus>;
}

export interface HostInstallationStatus {
  readonly host: SupportedHost;
  readonly displayName: string;
  readonly configPath: string;
  readonly status: "not-installed" | "installed" | "version-mismatch" | "invalid";
  readonly message: string;
}

export interface ApplyHostInstallPlanOptions {
  readonly dryRun?: boolean;
  readonly now?: Date;
}
