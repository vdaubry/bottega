# Making a worktree runnable — the project's `post-checkout` hook

A git worktree contains only what git tracks. Everything else a project needs
to actually *run* — installed dependencies, `.env` files, gitignored runtime
directories — has to be put there by something. That something is the
**project**, through git's own `post-checkout` hook, and Bottega's job is to do
nothing.

This matters because Bottega serves worktrees: a ticket's from the task page, an
epic's feature branch from the Delivery section
([`../web-server/switch-server.md`](../web-server/switch-server.md)). A worktree
that cannot boot the app is a worktree you cannot preview.

## Why the hook, and not Bottega

Bottega used to do this itself, and the list it copied says everything about why
that was wrong: `.env`/`.env.local`/`.env.development`/`.env.development.local`,
`log`/`tmp`/`storage` (Rails' directory names), `node_modules` and `.venv`.
Nothing for Ruby's `vendor/bundle` and `.bundle/config`, Go's or PHP's
`vendor/`, Elixir's `_build` and `deps`, Rust's `target/`, or the dozen other
shapes a project can have. Supporting every stack is not a job Bottega can win.

The second reason is stronger, and it is structural. **A worktree is always a
worktree.** When epics gained their own worktree, none of that provisioning
happened — not because anything was broken, but because the new code path did
not *call* it. A mechanism you can forget to call is in the wrong place. Git
cannot forget: `post-checkout` runs inside `git worktree add` itself, for every
worktree, however it was created — by Bottega, by the epic layer, or by a person
typing `git worktree add` by hand.

The third is a bonus. A hook is synchronous: when `git worktree add` returns,
the worktree is ready, so nothing downstream needs a separate "dependencies
are not ready yet" check. The flip side is that `git worktree add` now *waits*
for the hook — which is why Bottega gives it a 10-minute budget instead of the
usual 30-second command timeout, runs it as one process group (a timeout kills
the hook's children too, not just `git`), and why a failing hook fails the
add (Bottega then sweeps the half-made worktree and branch rather than leaving
orphans).

Because that wait can be minutes, **task creation does not wait for it**: the
task is created at once as `worktree_state: 'provisioning'` and the worktree
is set up in the background. Until it is `ready` no conversation can start on
the task; a failed setup leaves the task `failed`, with the hook's last output,
for a retry or a delete — never deleted. See
[`../tasks/domain-model.md`](../tasks/domain-model.md#worktree-setup-state).

## The contract

Write an executable `post-checkout` hook in the project repo. Git invokes it
with:

| | |
|---|---|
| **Working directory** | the **new worktree** (for `git worktree add`) |
| **`$1`** | previous HEAD — the **null SHA** (`0000…`) for a fresh worktree |
| **`$2`** | new HEAD |
| **`$3`** | `1` for a branch checkout, `0` for a file checkout |
| **Exit status** | becomes the exit status of the git command; a failure does **not** undo the checkout |

The null-SHA `$1` is how the hook distinguishes *"a worktree was just created"*
from *"someone switched branches in an existing checkout"* — provisioning
usually only wants the former.

Bottega adds nothing to this: no env vars, no timeout, no arguments. It is git's
contract, not Bottega's. (The separate `.bottega/switch.sh` hook —
[`../web-server/switch-server.md`](../web-server/switch-server.md) — is a
different thing: that one runs on *serving* a worktree, to build and restart.
This one runs on *creating* one.)

### Making it part of the repo

`.git/hooks` is per-clone and not committed, so a hook written there is local to
one machine. To make the mechanism actually travel with the project, commit it
and point git at it:

```bash
mkdir -p .githooks
mv .git/hooks/post-checkout .githooks/post-checkout   # or write it there
chmod +x .githooks/post-checkout
git config core.hooksPath .githooks                    # once per clone
git add .githooks && git commit -m "Provision worktrees on checkout"
```

Bottega detects the hook with `git rev-parse --git-path hooks/post-checkout`,
which honours `core.hooksPath`, so either location works.

## Examples

Each is a complete `post-checkout`. The `$1`/`$3` guard makes it a no-op on an
ordinary branch switch.

### Rails

```bash
#!/usr/bin/env bash
set -euo pipefail
[ "$3" = 1 ] && [ "$1" = "0000000000000000000000000000000000000000" ] || exit 0

MAIN="$(git rev-parse --path-format=absolute --git-common-dir)/.."
ln -sfn "$MAIN/.env" .env
ln -sfn "$MAIN/config/master.key" config/master.key
mkdir -p log tmp/pids storage
bundle install --quiet
yarn install --silent
```

### Node

```bash
#!/usr/bin/env bash
set -euo pipefail
[ "$3" = 1 ] && [ "$1" = "0000000000000000000000000000000000000000" ] || exit 0

MAIN="$(git rev-parse --path-format=absolute --git-common-dir)/.."
cp "$MAIN/.env" .env 2>/dev/null || true
# A real install, not a copy: it resolves this branch's lockfile.
pnpm install --frozen-lockfile
```

### Python

```bash
#!/usr/bin/env bash
set -euo pipefail
[ "$3" = 1 ] && [ "$1" = "0000000000000000000000000000000000000000" ] || exit 0

MAIN="$(git rev-parse --path-format=absolute --git-common-dir)/.."
cp "$MAIN/.env" .env 2>/dev/null || true
uv sync --frozen
```

> **Copy or symlink?** Symlink shared state you want to stay in sync (a dev
> SQLite database); copy anything a branch might legitimately need to change
> (`.env`, so a worktree can point at a different port without moving the main
> app). Bottega's own repo hook splits exactly this way — see
> `.githooks/post-checkout` at the repository root for a worked example.

> **Install, don't copy, dependencies.** `cp -a node_modules` carries the *main*
> branch's dependency tree into a branch that may have changed its lockfile.
> A real `install` in the hook is both correct and usually fast, because the
> package manager's global store is already warm.

## Without a hook — a bare checkout

A project with no executable `post-checkout` hook gets exactly what git gives
it: a worktree containing the tracked files and nothing else. There is no
fallback — the built-in guessing (`.env*` symlinks, `node_modules`/`.venv`
copies, Rails' `log/tmp/storage`) was deleted once the hook mechanism landed.
That is perfectly fine for a repo that needs nothing else to run; for one that
does, agents cannot run its tests and "switch server" will point NGINX at a
tree that cannot boot.

To make the difference visible rather than silent, Project Settings → Web
Server Switching shows a warning when the repo has no executable hook
(`worktreeProvisioning: 'none'` on `GET /api/projects/:id/web-server`).

## Key files

- `server/services/worktree.ts` — `worktreeProvisioningMode` (the `hook` /
  `none` predicate behind the settings warning), the 10-minute `worktree add`
  budget (`WORKTREE_ADD_TIMEOUT_MS`), the hook-output tail returned on failure,
  and `cleanupFailedWorktreeAdd` (the orphan sweep when a hook fails).
- `server/services/shell.ts` — `runCommandGroup`, the process-group runner the
  add goes through.
- `server/services/tasks/worktreeSetup.ts` — the background setup a new task's
  worktree goes through.
- `src/pages/ProjectEditPageWrapper.tsx` — the settings banner.
