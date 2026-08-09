# Agent Guide

This file is the fast path for coding agents working in this repository.

## Objective

Maintain a local `UserPromptSubmit` hook that gives Codex, Claude Code, and Kimi Code a
small, relevant context pack before exploration. Do not introduce remote runtime
dependencies, telemetry, or unproven performance claims.

## Repository Map

- `packages/cli`: commands, hook runtime, cache lifecycle
- `packages/core`: discovery, analysis, ranking, context packs, redaction, SQLite store
- `packages/host-adapters`: Codex, Claude Code, and Kimi Code hook
  install/doctor/uninstall
- `packages/mcp-server`: secured advanced MCP surface; not installed by default
- `packages/benchmarks`: offline and opt-in provider-backed paired evaluations
- `packages/report-ui`: static evaluation report rendering
- `test/e2e`: cross-package local lifecycle tests
- `test/security` and `scripts/security`: privacy, supply-chain, and public checks

Dependency direction is CLI/hosts/MCP/benchmarks toward core. Core must not import those
packages.

## Required Invariants

- Keep hook output at 1,200 estimated tokens by default and 2,000 maximum.
- Fail open without echoing prompts, source, or secrets.
- Never persist raw prompts, source, snippets, hook payloads, or credentials.
- Canonicalize workspace roots and reject traversal and symlink escapes.
- Do not accept MCP-controlled cache destinations.
- Merge and remove only the managed hook group; preserve user hooks byte-for-byte where no
  managed change is needed.
- Use atomic owner-only host and cache writes with backups.
- Do not add Cursor to supported hosts without a verified deterministic integration.
- Do not edit generated `dist`, `coverage`, `artifacts`, or `output` files.

## Validation

Run focused tests while editing, then:

```sh
pnpm build
pnpm run ci
pnpm audit:prod
```

For lifecycle changes, also run:

```sh
pnpm exec vitest run test/e2e/local-hook-lifecycle.test.ts packages/host-adapters/src/detect.test.ts
```

For ranking or evaluation changes, run `pnpm eval` and `pnpm eval:report`. Provider-backed
`pnpm eval:live` is opt-in and must never expose credentials or raw model output.
