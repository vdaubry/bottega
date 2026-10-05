# Epic feature branches — where a ticket forks from and merges into

Every epic develops on one long-lived integration branch, `epic/{id}-{slug}`.
Its tickets fork off it, their PRs target it, their worktrees are re-synced from
it, and the epic finishes with a single PR from it into the repo's default
branch. Nothing else about a ticket changes: same worktree layout, same agents,
same prompts — they just point at a different base.

The entity itself is
[`entity-and-conversations.md`](./entity-and-conversations.md), and the git
primitives it builds on are [`../agents/worktrees-and-pr.md`](../agents/worktrees-and-pr.md).

## One question, one answer: `resolveBaseBranch`

Since architecture-v2 step 3 the answer is a **task property**:
`tasks.base_branch`, stamped at creation (the epic layer passes its feature
branch; standalone tasks stay NULL). The load-bearing helper is the task
layer's

```ts
resolveBaseBranch(task, repoPath)   // tasks.base_branch, else repo default
```

(`server/services/tasks/baseBranch.ts`), and **every** git-facing path goes
through it: worktree creation, manual sync, the auto-sync hook (which fires
exactly when `base_branch` is set), `prService`, merge-cleanup, the
worktree-status panel, and the `{{baseBranch}}` prompt variable. Its NULL
answer is `getDefaultBranch(repoPath)` — resolved, never assumed.
`server/services/epics/epicBranch.ts` keeps only the epic's own lifecycle:
`ensureEpicFeatureBranch` and `createEpicCompletionPR`.

## `ensureEpicFeatureBranch(repoPath, epicId)`

Called before every epic-ticket creation, so a ticket can never exist without
the branch it is supposed to fork from. It is **idempotent and serialized per
epic** (an in-flight-promise map — two tickets created back to back would
otherwise both find `feature_branch` NULL and both create the branch).

| State | What happens |
|---|---|
| `epics.feature_branch` set, branch on origin | no-op (one `ls-remote`) |
| set, gone from origin, still local | re-push |
| set, origin unreachable | keep local, `warning` |
| set, gone from both sides | recreate off the default branch + a loud `warning` that previously merged work is not included |
| not set | `fetch` → `git branch {name} origin/{default}` (local-ref fallback) → `push -u` → `setFeatureBranch` |

The id makes the name unique per repo, so a pre-existing same-named branch can
only be this epic's and is **adopted**, not treated as a conflict.

Failures degrade instead of blocking: a push rejection or a remoteless repo
records the branch anyway and returns a `warning` (surfaced as `warning` on the
create-task response). The next ticket creation retries the push; a PR against a
branch that never reached origin fails loudly at PR time, which is the right
place for it.

`buildEpicBranchName` runs through `assertValidBranchName`, and
`parseTaskIdFromBranch` anchors on `^task/` — an epic branch can never be read
as a ticket branch by the GitHub webhook (regression-tested). Its counterpart
`parseEpicIdFromBranch` (`^epic/`) is what routes a comment on the final pull
request to the epic's delivery agent ([`delivery.md`](./delivery.md)); the two
are disjoint by construction.

## `createEpicTicket` — the epic-layer creation path

Since architecture-v2 step 3 ticket creation is an **epic-layer** service
(`server/services/epics/ticketService.ts`), shared by `POST /epics/:id/tasks`
and the stories agent's `create_task` tool ([`stories.md`](./stories.md)) —
the plain task route no longer accepts epic fields. The order matters:

1. validate the epic and the caller's access (`EpicNotInProjectError` → 404),
2. `ensureEpicFeatureBranch` — **before** anything else exists,
3. `createTaskWithWorktree({ baseBranch: featureBranch })` — the task domain's
   own creation path (row + worktree forked off the base + task doc, with
   rollback), which stamps `tasks.base_branch`,
4. record membership and position (transitionally on the task row; the
   `epic_tickets` link table replaces that in step 5).

`deleteTaskCompletely` is the mirror (worktree removal + transcript purge +
row + archive) and stays a task-domain function; the epic layer renumbers the
remaining tickets afterwards (`renumberTickets`).

`createWorktree` keeps its pre-epic behaviour byte-for-byte when no base is
passed. Given one, it fetches the branch first and forks off `origin/{base}`
(falling back to the local ref), so a ticket starts from what origin has rather
than a stale local copy.

## Auto-sync at loop entry points

`startAgentRun` merges the epic's feature branch into the ticket worktree before
the agent starts reading code — but only when **all** of these hold:

- the ticket belongs to an epic that has a feature branch,
- the worktree exists,
- the working tree is clean,
- the agent type is a **loop entry point**: `planification`, `yolo`, `pr`.

`implementation`, `review` and `refinement` are deliberately excluded: mid-loop
the worktree holds in-flight state, and merging under it would rewrite files the
agent is reasoning about.

`syncWithBase` always runs `git merge --abort` on failure, so this automatic
path can never hand an agent a tree full of conflict markers. On conflict the
run is marked `failed`, the task `workflow_blocked`, `agent-run-updated` +
`task-blocked {reason:'base-sync-conflict'}` are broadcast, and a typed
`BaseSyncConflictError` propagates — `POST /api/tasks/:id/agent-runs` turns it
into a 409 telling the user to resolve the conflicts and resume.

## PRs, merges, and the completion PR

- `prService.createOrUpdatePR` resolves the base internally (signature-stable
  for its callers) and threads it into both the ahead-check and
  `gh pr create --base`.
- `mergeTask(taskId)` is the product boundary used by both the Merge button
  and the epic reviewer. It persists the PR URL/head/base before `gh pr merge`,
  confirms ambiguous responses by re-reading GitHub, atomically marks the task
  completed, then removes the worktree as retryable housekeeping. `base` is
  refreshed after cleanup so the next ticket forks off the merged work; ticket
  sequencing does not wait for that cleanup because ticket creation fetches
  its explicit base itself.
- `getWorktreeStatus(repo, taskId, base)` counts ahead/behind against the base
  and returns it as `baseBranch` (`mainBranch` is kept as a deprecated alias for
  the existing worktree panel).
- **`POST /api/epics/:id/complete-pr`** → `createEpicCompletionPR`, run from the
  main checkout (framing has no worktree): fetch, verify the branch is on
  origin, ahead-check `origin/{default}..origin/{feature}` (0 → "No changes"),
  then `gh pr create --head {feature} --base {default}`. The epic's status is
  **not** auto-flipped, and merging that PR stays a human act.
  `findEpicCompletionPR` is its read-only sibling — the same `gh pr list`
  lookup, best-effort, used to tell the delivery agent what it is working on.

## The delivery worktree

Landing that final pull request — merging the default branch into the feature
branch, resolving the conflicts, answering a review — needs the branch checked
out somewhere, and the main checkout is not it: moving its HEAD moves the
working copy a person (and, on a self-hosting box, the running service) is
using. So the epic gets `{repo}-worktrees/epic-{id}`, created on demand,
reused across delivery runs, removed only with the epic — and never taking the
branch with it. `ensureEpicDeliveryWorktree` / `removeEpicDeliveryWorktree`
live beside the branch lifecycle in `epicBranch.ts`; the agent that works there
is [`delivery.md`](./delivery.md).

The invariant, stated precisely: **an epic has no worktree while framing;
delivery has one, and it is the feature branch itself.**

## Prompts: `{{baseBranch}}`

`pr.md`, `yolo.md` and `pr-feedback.md` rebase onto
`origin/{{baseBranch}}`, and the generated `{{prCreateOrVerifyBlock}}` uses
`git log origin/{base}..HEAD` and `gh pr create --base {base}`. `startAgentRun`
resolves the base once and passes it to every generator, so webhook-triggered
runs get it for free.

Operator overrides in `~/.bottega/prompts` are safe by construction: `render()`
throws only on template variables missing from the dict, never the reverse, so a
pre-Phase-3 override keeps working (with its own hardcoded base) until it is
updated to use `{{baseBranch}}`.

## Edge cases worth knowing

- **Two epics, one repo** — ids make the branch names unique; the per-epic
  in-flight map serializes each epic's ensure independently.
- **Default branch renamed mid-epic** — ticket PRs are unaffected (they target
  the feature branch); the completion PR resolves the default at call time.
  `origin/HEAD` staleness is a known limitation of `getDefaultBranch`.
- **Feature branch drift from the default** is *not* auto-reconciled — the
  completion PR surfaces the conflicts, and the delivery agent resolves them in
  the delivery worktree ([`delivery.md`](./delivery.md)) by merging (never
  rebasing: the branch is public, its tickets forked off it).
- **Remoteless repos** degrade exactly as before: everything stays local and the
  warnings say so.
