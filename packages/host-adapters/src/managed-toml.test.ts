import { describe, expect, it } from "vitest";

import {
  createManagedHookTomlConfig,
  inspectManagedHookTomlConfig,
  MANAGED_HOOK_MARKER,
  MANAGED_TOML_BLOCK_BEGIN,
  MANAGED_TOML_BLOCK_END,
  removeManagedHookTomlConfig,
} from "./file-ops";

const command = [
  "/usr/bin/node",
  "/opt/agent-token-optimizer/packages/cli/dist/index.js",
  "hook",
  "user-prompt",
  "--managed-by",
  MANAGED_HOOK_MARKER,
  "--cache-path",
  "/home/user/.agent-token-optimizer/cache.sqlite",
  "--host",
  "kimi",
];

function install(existingContent: string): string {
  return createManagedHookTomlConfig({ existingContent, command });
}

function uninstall(existingContent: string): string {
  return removeManagedHookTomlConfig({ existingContent });
}

describe("managed TOML block byte preservation", () => {
  // The central invariant: install then uninstall restores the input verbatim,
  // regardless of newline style, trailing whitespace, or surrounding content.
  const roundTripCases: Record<string, string> = {
    "empty file": "",
    "LF with final newline": 'model = "kimi-k2"\n',
    "LF without final newline": 'model = "kimi-k2"',
    "CRLF with final newline": 'model = "kimi-k2"\r\n[settings]\r\nverbose = true\r\n',
    "CRLF without final newline": 'model = "kimi-k2"\r\n[settings]\r\nverbose = true',
    "multiple trailing blank lines": 'model = "kimi-k2"\n\n\n',
    "trailing spaces on content lines": 'model = "kimi-k2"   \n[a]  \nb = 1\t\n',
    "no newline and trailing spaces": 'model = "kimi-k2"   ',
    "marker text inside a TOML string": `note = "${MANAGED_TOML_BLOCK_BEGIN}"\nother = "${MANAGED_TOML_BLOCK_END}"\n`,
  };

  for (const [name, original] of Object.entries(roundTripCases)) {
    it(`restores original bytes exactly after install then uninstall: ${name}`, () => {
      const installed = install(original);
      expect(uninstall(installed)).toBe(original);
    });
  }

  it("appends the managed block without altering bytes outside it", () => {
    const original = 'model = "kimi-k2"\n\n\n';
    const installed = install(original);

    // Every original byte is preserved as a prefix; only the owned block is added.
    expect(installed.startsWith(original)).toBe(true);
    expect(installed).toContain(MANAGED_TOML_BLOCK_BEGIN);
    expect(installed).toContain('event = "UserPromptSubmit"');
    expect(installed).toContain("--host");
  });

  it("does not treat marker text inside a TOML string as a managed block", () => {
    const original = `note = "${MANAGED_TOML_BLOCK_BEGIN}"\n`;

    expect(inspectManagedHookTomlConfig({ existingContent: original, command })).toBe(
      "not-installed",
    );
    // Uninstall is a no-op because there is no standalone managed block.
    expect(uninstall(original)).toBe(original);
    // Install adds a real block and leaves the string value untouched.
    const installed = install(original);
    expect(installed).toContain(`note = "${MANAGED_TOML_BLOCK_BEGIN}"`);
    expect(inspectManagedHookTomlConfig({ existingContent: installed, command })).toBe(
      "installed",
    );
  });

  it("preserves user content both before and after the managed block", () => {
    const installed = install("before = 1\n");
    const withSuffix = `${installed}\nafter = 2\n`;

    const cleaned = uninstall(withSuffix);
    expect(cleaned).toContain("before = 1");
    expect(cleaned).toContain("after = 2");
    expect(cleaned).not.toContain(MANAGED_TOML_BLOCK_BEGIN);
    expect(cleaned).not.toContain(MANAGED_TOML_BLOCK_END);
  });

  it("reports command drift as a version mismatch", () => {
    const installed = install('model = "kimi-k2"\n');

    expect(inspectManagedHookTomlConfig({ existingContent: installed, command })).toBe(
      "installed",
    );
    expect(
      inspectManagedHookTomlConfig({
        existingContent: installed,
        command: [...command, "--response-budget", "800"],
      }),
    ).toBe("version-mismatch");
  });

  it("is idempotent across repeated installs", () => {
    const original = 'model = "kimi-k2"\n';
    const once = install(original);
    const twice = install(once);

    expect(twice).toBe(once);
  });

  it("treats duplicate or misordered standalone markers as invalid", () => {
    const block = install("").trim();
    const duplicate = `${block}\n\n${block}\n`;
    const misordered = `${MANAGED_TOML_BLOCK_END}\nevent = "UserPromptSubmit"\n${MANAGED_TOML_BLOCK_BEGIN}\n`;

    expect(inspectManagedHookTomlConfig({ existingContent: duplicate, command })).toBe(
      "invalid",
    );
    expect(inspectManagedHookTomlConfig({ existingContent: misordered, command })).toBe(
      "invalid",
    );
    expect(() => uninstall(duplicate)).toThrow();
    expect(() => uninstall(misordered)).toThrow();
  });
});
