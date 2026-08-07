import { describe, expect, it } from "vitest";

import { buildStructuralSummary } from "./summary";

describe("buildStructuralSummary", () => {
  it("returns compact exports, declarations, dependencies, test names, and a task snippet", () => {
    const summary = buildStructuralSummary({
      content: [
        'import { loadSettings } from "./settings";',
        "export function createSession(userId: string): boolean {",
        "  return loadSettings(userId).redirect;",
        "}",
        "const sessionStore = new Map<string, boolean>();",
        'describe("session redirect", () => {',
        '  it("redirects an invalid session", () => {',
        '    expect(createSession("invalid")).toBe(true);',
        "  });",
        "});",
      ].join("\n"),
      file: { language: "typescript", path: "src/auth/session.test.ts" },
      task: "Fix the invalid session redirect test",
      maxChars: 600,
    });

    expect(summary.summary).toContain("Structural outline");
    expect(summary.symbols).toEqual(
      expect.arrayContaining([
        "export function createSession(userId: string): boolean {",
      ]),
    );
    expect(summary.declarations).toEqual(
      expect.arrayContaining(["const sessionStore = new Map<string, boolean>();"]),
    );
    expect(summary.imports).toEqual(["./settings"]);
    expect(summary.testNames).toEqual(
      expect.arrayContaining(["session redirect", "redirects an invalid session"]),
    );
    expect(summary.snippet).toContain("createSession");
    expect(totalTextLength(summary)).toBeLessThanOrEqual(600);
  });

  it("does not emit an arbitrary snippet when no task is supplied", () => {
    const summary = buildStructuralSummary({
      content: "export const enabled = true;\n",
      file: { language: "typescript", path: "src/config.ts" },
      maxChars: 600,
    });

    expect(summary.snippet).toBeUndefined();
    expect(summary.symbols).toEqual(["export const enabled = true;"]);
  });
});

function totalTextLength(summary: {
  readonly summary: string;
  readonly symbols: readonly string[];
  readonly declarations: readonly string[];
  readonly imports: readonly string[];
  readonly testNames: readonly string[];
  readonly snippet?: string;
}): number {
  return [
    summary.summary,
    ...summary.symbols,
    ...summary.declarations,
    ...summary.imports,
    ...summary.testNames,
    ...(summary.snippet ? [summary.snippet] : []),
  ].reduce((total, value) => total + value.length, 0);
}
