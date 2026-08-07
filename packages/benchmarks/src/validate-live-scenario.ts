#!/usr/bin/env node

import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

type ExportedFunction = (...args: never[]) => unknown;

const validators: Readonly<Record<string, (workspaceRoot: string) => Promise<void>>> = {
  "configuration-documentation-change": validateReleaseConfiguration,
  "cross-package-api-change": async (workspaceRoot) => {
    const module = await loadTypeScriptModule(
      workspaceRoot,
      "packages/service/src/record-charge.ts",
    );
    const recordCharge = readFunction(module, "recordCharge") as (
      amount: number,
      currency: string,
    ) => {
      readonly amount: number;
      readonly currency: string;
      readonly reference: string;
    };
    const charge = recordCharge(20, "USD");
    assert(charge.amount === 20, "recordCharge must preserve the amount.");
    assert(charge.currency === "USD", "recordCharge must preserve the currency.");
    assert(
      charge.reference === "charge-usd",
      "recordCharge must derive the lowercase currency reference.",
    );
  },
  "distracting-large-repository": async (workspaceRoot) => {
    const module = await loadTypeScriptModule(workspaceRoot, "src/billing/charge.ts");
    const calculateInvoiceCharge = readFunction(module, "calculateInvoiceCharge") as (
      subtotal: number,
      taxRate: number,
    ) => number;
    assert(
      calculateInvoiceCharge(10.01, 0.2) === 12.01,
      "calculateInvoiceCharge must round the final amount to the nearest cent.",
    );
  },
  "security-auth-change": async (workspaceRoot) => {
    const module = await loadTypeScriptModule(workspaceRoot, "src/auth/token.ts");
    const validateBearerToken = readFunction(module, "validateBearerToken") as (
      token: { readonly value: string; readonly expiresAt: number },
      now: number,
    ) => boolean;
    assert(
      validateBearerToken({ value: "secret", expiresAt: 1 }, 2) === false,
      "Expired bearer tokens must be rejected.",
    );
    assert(
      validateBearerToken({ value: "secret", expiresAt: 2 }, 2) === false,
      "Bearer tokens expiring at the current time must be rejected.",
    );
    assert(
      validateBearerToken({ value: "secret", expiresAt: 3 }, 2) === true,
      "Unexpired bearer tokens must remain valid.",
    );
    assert(
      validateBearerToken({ value: "", expiresAt: 3 }, 2) === false,
      "Empty bearer tokens must remain invalid.",
    );
  },
  "skip-trivial-task": async (workspaceRoot) => {
    const module = await loadTypeScriptModule(workspaceRoot, "src/label.ts");
    assert(
      module.receiveLabel === "Receive updates",
      'The maintenance label must read "Receive updates".',
    );
  },
  "stack-trace-bug": async (workspaceRoot) => {
    const module = await loadTypeScriptModule(workspaceRoot, "src/session/parser.ts");
    const parseSession = readFunction(module, "parseSession") as (value: {
      readonly token?: string;
    }) => string;
    let missingTokenError: unknown;
    try {
      parseSession({});
    } catch (error) {
      missingTokenError = error;
    }
    assert(
      missingTokenError instanceof TypeError &&
        missingTokenError.message === "Session token is required.",
      'parseSession must throw TypeError("Session token is required.") for a missing token.',
    );
    assert(
      parseSession({ token: "session-123" }) === "session-123",
      "parseSession must continue returning valid tokens.",
    );
  },
  "terminology-symbol-mismatch": async (workspaceRoot) => {
    const module = await loadTypeScriptModule(workspaceRoot, "src/welcome-card.ts");
    const renderWelcomeCard = readFunction(module, "renderWelcomeCard") as (
      memberName: string,
    ) => string;
    assert(
      renderWelcomeCard("Ada") === "Hello, Ada — let's get started.",
      "renderWelcomeCard must use the new onboarding greeting.",
    );
  },
  "typescript-api-change": async (workspaceRoot) => {
    const module = await loadTypeScriptModule(workspaceRoot, "src/user-api.ts");
    const formatUserRecord = readFunction(module, "formatUserRecord") as (user: {
      readonly id: string;
      readonly displayName: string;
      readonly active: boolean;
    }) => string;
    assert(
      formatUserRecord({ id: "user_123", displayName: "Ada Lovelace", active: true }) ===
        "Ada Lovelace (user_123) — active",
      "formatUserRecord must append the active state.",
    );
    assert(
      formatUserRecord({ id: "user_456", displayName: "Grace Hopper", active: false }) ===
        "Grace Hopper (user_456) — inactive",
      "formatUserRecord must append the inactive state.",
    );
  },
};

export async function validateLiveScenario(
  scenarioId: string,
  workspaceRoot: string,
): Promise<void> {
  const validator = validators[scenarioId];

  if (!validator) {
    throw new Error(`Unknown live benchmark scenario: ${scenarioId}`);
  }

  await validator(path.resolve(workspaceRoot));
}

async function validateReleaseConfiguration(workspaceRoot: string): Promise<void> {
  const [configuration, documentation] = await Promise.all([
    readFile(path.join(workspaceRoot, "config/release.yml"), "utf8"),
    readFile(path.join(workspaceRoot, "docs/release.md"), "utf8"),
  ]);
  assert(
    /rolloutTimeoutSeconds:\s*180(?:\s|$)/u.test(configuration),
    "The release configuration must set rolloutTimeoutSeconds to 180.",
  );
  assert(
    /180 seconds/u.test(documentation),
    "The release documentation must state the 180-second staging timeout.",
  );
}

async function loadTypeScriptModule(
  workspaceRoot: string,
  entryPath: string,
): Promise<Record<string, unknown>> {
  const sourceFiles = await collectTypeScriptFiles(workspaceRoot);
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "ato-live-validation-"));

  try {
    const program = ts.createProgram(sourceFiles, {
      esModuleInterop: true,
      ignoreDeprecations: "6.0",
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      noEmitOnError: true,
      outDir: outputRoot,
      rootDir: workspaceRoot,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
    });
    const emit = program.emit();
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .concat(emit.diagnostics)
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);

    if (diagnostics.length > 0) {
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCanonicalFileName: (fileName) => fileName,
          getCurrentDirectory: () => workspaceRoot,
          getNewLine: () => "\n",
        }),
      );
    }

    const emittedPath = path.join(outputRoot, entryPath.replace(/\.ts$/u, ".js"));
    const require = createRequire(import.meta.url);
    return require(emittedPath) as Record<string, unknown>;
  } finally {
    await rm(outputRoot, { force: true, recursive: true });
  }
}

async function collectTypeScriptFiles(
  rootPath: string,
  currentPath = "",
): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(path.join(rootPath, currentPath), {
    withFileTypes: true,
  });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        return await collectTypeScriptFiles(rootPath, relativePath);
      }
      return entry.isFile() && entry.name.endsWith(".ts")
        ? [path.join(rootPath, relativePath)]
        : [];
    }),
  );
  return files.flat();
}

function readFunction(
  module: Record<string, unknown>,
  exportName: string,
): ExportedFunction {
  const value = module[exportName];
  if (typeof value !== "function") {
    throw new TypeError(`Expected ${exportName} to be an exported function.`);
  }
  return value as ExportedFunction;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  const scenarioId = process.argv[2];
  if (!scenarioId) {
    throw new Error("Pass a live benchmark scenario ID to validate.");
  }
  await validateLiveScenario(scenarioId, process.cwd());
  console.log(`Validated live benchmark scenario: ${scenarioId}`);
}
