# Architecture

Agent Token Optimizer is a local preprocessing layer between a user prompt and a coding
agent's first repository exploration.

## Runtime Flow

```text
Codex / Claude Code
        |
        | UserPromptSubmit JSON (prompt + active cwd)
        v
local CLI hook
        |
        +-- assess trivial task --------------------> no injected context
        |
        +-- canonical workspace discovery
        +-- structural analysis and ranking
        +-- bounded, redacted context pack
        v
hookSpecificOutput.additionalContext
        |
        v
coding agent begins its normal turn
```

The hook performs no model call and no network request. Activation is deterministic
because the host runs the hook before the turn rather than asking the model to opt into a
skill or MCP tool.

## Packages

`packages/core` owns pure contracts and local algorithms: workspace policy, discovery,
incremental structural analysis, task assessment, ranking, summarization, redaction, token
estimation, and SQLite persistence.

`packages/cli` composes the hook workflow and exposes lifecycle, diagnostics, manual
optimization, cache, and advanced MCP commands.

`packages/host-adapters` owns host detection and JSON merging. It writes one marked hook
group to Codex `hooks.json` or Claude Code `settings.json`. It does not install skills or
MCP configuration.

`packages/mcp-server` exposes advanced local tools. Each server is bound at startup to a
canonical workspace and cache. Request arguments cannot widen either boundary. This
package is not part of the default installation.

`packages/benchmarks` and `packages/report-ui` are evidence tooling. Offline tests cover
determinism; live paired runs are opt-in and require behavioral parity, valid provider
usage, and recorded hook activation.

## Persistence

The default cache is `~/.agent-token-optimizer/cache.sqlite`. It may contain workspace
paths and hashes, sanitized structural symbols/imports, content-free activation evidence,
and token estimates. It does not contain raw prompts, raw source, snippets, credentials,
or hook payloads. Cache files are rewritten atomically with owner-only POSIX permissions.

## Trust Boundaries

1. The host supplies a prompt and active working directory. Both are untrusted input.
2. Discovery canonicalizes the working directory and prevents symlink escape.
3. Repository configuration may tune bounded ranking limits or disable caching, but the
   installed hook's cache destination is fixed outside repository control.
4. Generated context is redacted and token-bounded before it crosses back to the host.
5. Host configuration is user-owned. Install and uninstall preserve unrelated entries,
   create backups, and require the user to review host trust prompts.

The architecture intentionally excludes a remote service, automatic updates, telemetry,
and npm package execution from the initial public release.
