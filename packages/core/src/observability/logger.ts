import { normalizeError, type NormalizedError } from "../errors";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly component: string;
  readonly event: string;
  readonly operationId?: string;
  readonly workspaceHash?: string;
  readonly host?: string;
  readonly elapsedMs?: number;
  readonly message?: string;
  readonly error?: NormalizedError;
  readonly context?: Record<string, string | number | boolean | null>;
}

export interface LoggerSink {
  write: (event: LogEvent) => void | Promise<void>;
}

export interface LoggerOptions {
  readonly component: string;
  readonly sink?: LoggerSink;
  readonly operationId?: string;
  readonly workspaceHash?: string;
  readonly host?: string;
}

export interface LogContext {
  readonly message?: string;
  readonly elapsedMs?: number;
  readonly context?: Record<string, string | number | boolean | null>;
}

export interface Logger {
  readonly child: (options: Partial<LoggerOptions>) => Logger;
  readonly debug: (event: string, context?: LogContext) => Promise<void>;
  readonly info: (event: string, context?: LogContext) => Promise<void>;
  readonly warn: (event: string, context?: LogContext) => Promise<void>;
  readonly error: (event: string, error: unknown, context?: LogContext) => Promise<void>;
}

export class ConsoleJsonSink implements LoggerSink {
  public write(event: LogEvent): void {
    const line = JSON.stringify(event);

    if (event.level === "error" || event.level === "warn") {
      console.error(line);
      return;
    }

    console.log(line);
  }
}

export class MemoryLogSink implements LoggerSink {
  public readonly events: LogEvent[] = [];

  public write(event: LogEvent): void {
    this.events.push(event);
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? new ConsoleJsonSink();

  async function write(level: LogLevel, event: string, context: LogContext = {}) {
    await Promise.resolve(
      sink.write({
        timestamp: new Date().toISOString(),
        level,
        component: options.component,
        event,
        ...(options.operationId ? { operationId: options.operationId } : {}),
        ...(options.workspaceHash ? { workspaceHash: options.workspaceHash } : {}),
        ...(options.host ? { host: options.host } : {}),
        ...(context.elapsedMs !== undefined ? { elapsedMs: context.elapsedMs } : {}),
        ...(context.message ? { message: context.message } : {}),
        ...(context.context ? { context: sanitizeContext(context.context) } : {}),
      }),
    );
  }

  return {
    child(childOptions) {
      return createLogger({
        component: childOptions.component ?? options.component,
        sink: childOptions.sink ?? sink,
        ...optionalString("operationId", childOptions.operationId ?? options.operationId),
        ...optionalString(
          "workspaceHash",
          childOptions.workspaceHash ?? options.workspaceHash,
        ),
        ...optionalString("host", childOptions.host ?? options.host),
      });
    },
    debug(event, context) {
      return write("debug", event, context);
    },
    info(event, context) {
      return write("info", event, context);
    },
    warn(event, context) {
      return write("warn", event, context);
    },
    async error(event, error, context) {
      await Promise.resolve(
        sink.write({
          timestamp: new Date().toISOString(),
          level: "error",
          component: options.component,
          event,
          ...(options.operationId ? { operationId: options.operationId } : {}),
          ...(options.workspaceHash ? { workspaceHash: options.workspaceHash } : {}),
          ...(options.host ? { host: options.host } : {}),
          ...(context?.elapsedMs !== undefined ? { elapsedMs: context.elapsedMs } : {}),
          ...(context?.message ? { message: context.message } : {}),
          ...(context?.context ? { context: sanitizeContext(context.context) } : {}),
          error: normalizeError(error),
        }),
      );
    },
  };
}

function sanitizeContext(
  context: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      typeof value === "string" && isSecretLike(key, value) ? "[REDACTED]" : value,
    ]),
  );
}

function isSecretLike(key: string, value: string): boolean {
  return /secret|token|password|key/iu.test(key) || /sk-[A-Za-z0-9_-]{16,}/u.test(value);
}

function optionalString<TKey extends "operationId" | "workspaceHash" | "host">(
  key: TKey,
  value: string | undefined,
): Record<TKey, string> | Record<string, never> {
  return value ? ({ [key]: value } as Record<TKey, string>) : {};
}
