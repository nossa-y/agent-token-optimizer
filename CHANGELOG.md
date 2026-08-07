# Changelog

All notable user-visible changes are recorded here.

## Unreleased

### Added

- Kimi Code host support: the managed `UserPromptSubmit` hook is installed as one marked
  TOML block that is spliced in and out without altering surrounding bytes, honoring
  `KIMI_CODE_HOME` for the config location. The hook accepts content-part prompt arrays,
  and `--host kimi` emits plain-text context because Kimi Code appends hook stdout to the
  turn context.
- `cache list` and `cache evict --workspace <path>` commands for cache inspection and
  selective workspace eviction. `cache list` prints record counts and keys only, never
  cached values; `cache evict` keeps records without workspace attribution.
- Deterministic local `UserPromptSubmit` context hook shared by Codex and Claude Code.
- Local `install`, `doctor`, and `uninstall` lifecycle with dry-run, backups, idempotency,
  drift detection, and preservation of user hooks.
- Workspace and cache boundary regression tests, owner-only cache/host files, and a
  cross-host end-to-end lifecycle test.

### Changed

- The launch model is now a local clone rather than npm publication.
- Host setup is hook-first; MCP is secured and non-default.
- All workspace packages are private and CI validates public readiness.
- The supported runtime is Node.js 22.13 or newer.

### Removed

- npm publication automation, remote installer wrappers, changesets, duplicate skills,
  stale placeholder CLI commands, and initial Cursor support.
