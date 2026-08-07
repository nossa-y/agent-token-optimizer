# Security Policy

Agent Token Optimizer reads local source trees and modifies coding-agent hook
configuration. Security and reversibility are part of the product contract.

## Supported Version

The project is pre-1.0 and distributed from a local clone. Security fixes target the
latest commit on `main`. Older checkout states are not supported.

## Report A Vulnerability

Use GitHub private vulnerability reporting for this repository. If private reporting is
not available, open a minimal issue asking for a private contact channel. Do not include
exploit details, secrets, private source, cache contents, hook payloads, or host config.

Include the affected commit, operating system, host, a reproduction using synthetic data,
and the expected impact. Relevant impacts include source exposure, workspace escape,
arbitrary file access or write, command execution, credential leakage, and host
configuration corruption.

Reports are acknowledged and triaged on a best-effort basis. A disclosure timeline will be
agreed with the reporter after impact and remediation are understood.

## Security Invariants

- Runtime optimization is local and network-free.
- Raw prompts and source contents are ephemeral and are not stored or logged.
- Secret-shaped content is redacted before hook output.
- Workspace reads are constrained to a canonical root; symlink escapes are rejected.
- MCP callers cannot select a different workspace boundary or cache destination.
- Host writes are atomic, backed up, owner-only on POSIX, and limited to one identifiable
  managed hook group.
- Uninstall preserves hooks not managed by this project.
- CI uses least-privilege permissions and immutable action revisions.

## User Responsibilities

Review hook commands before granting host trust, protect the local checkout from untrusted
modification, do not install from an unreviewed fork, and clear the local cache before
sharing a machine image or support bundle.
