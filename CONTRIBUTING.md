# Contributing

Thanks for improving Agent Token Optimizer. Changes must preserve its local, bounded,
private, and reversible behavior.

## Contribution Workflow

All changes must arrive through a pull request. Do not push directly to `main`.

1. Fork `bethvourc/agent-token-optimizer` on GitHub.
2. Clone your fork and add this repository as the upstream remote:

   ```sh
   git clone https://github.com/<your-username>/agent-token-optimizer.git
   cd agent-token-optimizer
   git remote add upstream https://github.com/bethvourc/agent-token-optimizer.git
   ```

3. Update your local `main`, then create a focused branch:

   ```sh
   git fetch upstream
   git switch main
   git merge --ff-only upstream/main
   git switch -c feature/short-description
   ```

4. Make the change on that branch, add or update tests, and run the relevant validation.
5. Commit the focused change and push the branch to your fork:

   ```sh
   git push -u origin feature/short-description
   ```

6. Open a pull request from your forked branch into this repository's `main` branch.
   Complete the pull request template, explain the user-visible effect, and allow CI to
   pass before requesting review.

Repository collaborators follow the same branch-and-pull-request workflow but may push
their short-lived branch directly to this repository. Merged branches are deleted
automatically.

## Setup

Use Node.js 22.13 or newer and pnpm 10.33.2.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm run ci
```

Useful focused commands:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm public:check
pnpm audit:prod
pnpm security:sbom
pnpm eval
pnpm eval:report
```

## Pull Requests

- Keep the change focused and explain its user-visible effect.
- Add tests for behavior, failure handling, privacy, and rollback where relevant.
- Update root documentation when commands, supported hosts, persistence, or security
  boundaries change.
- Do not commit `dist`, coverage, caches, credentials, host configs, generated reports,
  package archives, or provider output.
- Treat benchmark results as evidence, not marketing. Do not add a token-savings claim
  unless a valid paired provider run passes the documented gates.

Host changes must preserve existing user hooks, repeat installs, dry runs, backups,
diagnosis, uninstall, and rollback. MCP changes must keep the process bound to its launch
workspace and fixed cache path. Hook changes must remain network-free and must never
persist raw prompts or source text.

Before requesting review, run `pnpm run ci` and `pnpm audit:prod`. Include the focused
test commands and results in the pull request.

## Security

Do not disclose vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).
