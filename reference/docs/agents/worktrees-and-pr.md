# Worktrees & PRs — git primitives, unified PR creation, completion scripts

Every task runs in its own git worktree; PRs are created from it by either the
manual button or the PR agent through one service. This is the git/PR plumbing the
agentic loop sits on ([`agentic-loop.md`](./agentic-loop.md)).

## Worktree primitives

`server/services/worktree.ts` wraps git via the `execFile`-only `runCommand`
helper (see [`github-webhooks.md`](./github-webhooks.md) for why that matters).
The path/branch conventions are the load-bearing contract:

- **Worktree dir** — `getWorktreePath(repo, taskId)` = `{repo}-worktrees/task-{taskId}`
  (`:9`); `getWorktreeProjectPath` (`:16`) appends `subproject_path` for monorepos.
- **Branch** — `task/{taskId}-{sanitized-title}`, created off the task's **base
  branch** (`createWorktree`, `:186`): the repo default for a standalone ticket,
  the epic's feature branch for an epic ticket. `parseTaskIdFromBranch` reverses
  it in the webhook path (and never matches `epic/…`).
- `createWorktree` does no provisioning of its own — the repo's `post-checkout`
  hook runs inside `git worktree add` (see
  [`worktree-provisioning.md`](./worktree-provisioning.md)), with a 10-minute
  budget and an orphan sweep on failure; `worktreeExists` is the cheap presence
  check used everywhere the cwd is resolved.

Status / mutation helpers: `getWorktreeStatus` (ahead/behind the base branch,
plus the unsaved-work counters below), `hasUncommittedChanges`,
`commitAllChanges`, `pushChanges`, `syncWithBase`, `removeWorktree`,
`mergeAndCleanup`. PR helpers: `createPullRequest` (via `gh`, with `--base`),
`getPullRequestStatus` (exists/url/CI/mergeable).

**Base branch.** `createWorktree` / `getWorktreeStatus` / `syncWithBase` /
`createPullRequest` / `mergeAndCleanup` all take an optional trailing
`baseBranch`. Omitted, each resolves the repo default and behaves exactly as it
did pre-epics. Callers resolve it once through the task layer's
`resolveBaseBranch` (`server/services/tasks/baseBranch.ts`, reading
`tasks.base_branch`) — see
[`../epics/feature-branch.md`](../epics/feature-branch.md).

`syncWithBase` (formerly `syncWithMain`) always `git merge --abort`s a failed
merge: it runs automatically before some agent runs, and a half-merged worktree
is worse than a reported conflict.

## The unsaved-work guard — nothing deletes a worktree silently

`server/services/worktreeSafety.ts` answers one question — *would deleting this
worktree lose work?* — and the two primitives that destroy a worktree
(`removeWorktree`, `mergeAndCleanup`) call it before doing anything, unless the
caller passes `{ force: true }`. The check lives **inside the primitives, not in
each route**, so a new caller inherits it instead of having to remember it.

**Two kinds of unsaved work, and the second is the expensive one.**
`getWorktreeSafety` reports `dirtyFiles` (from `git status --porcelain
--untracked-files=all`, so a new directory is listed as its files rather than
collapsed to `sub/`) *and* `unpushedCommits`. The unpushed count is the one that
matters: `gh pr merge` merges the branch's **remote** head, so commits that never
left the box are not in the merge and die with the worktree — on a tree that
reports perfectly clean.

Unpushed is `git rev-list --count HEAD --not --remotes=origin`, **not**
`origin/<branch>..HEAD`. The range form needs an `origin/<branch>` to subtract,
and a branch that was never pushed has none — it would have to fall back to a base
branch the caller may not have supplied, and silently report 0. "What is reachable
from HEAD and from no origin ref" needs no parameters and is right in every case.
A repo with no origin refs reports 0: there is nowhere to push. The check never
`git fetch`es (these paths are interactive, and this app is the only thing pushing
these branches); a stale ref can only over-report, which fails safe. A worktree git
cannot read reports **clean** — it is already gone or broken, and blocking would
strand the user.

When work would be lost, the primitives throw `UnsavedWorktreeWorkError`, which
carries the whole report. Every destructive route catches it and answers the same
409 body (`UnsavedWorktreeWorkResponse` in `shared/api/tasks.ts`), built by
`sendUnsavedWorkConflict` in `routes/tasks.ts` — including the PR number, so the
client can name the destination. One shape for one modal:

| Path | Endpoint |
|---|---|
| Merge & Cleanup | `POST /tasks/:id/merge-cleanup` |
| Discard worktree / status → Completed | `DELETE /tasks/:id/worktree` |
| Delete task | `DELETE /tasks/:id` |

All three take `?force=true` as the escape hatch. Two callers deliberately differ:
the **old-completed sweep** (`DELETE /projects/:id/tasks/cleanup-old-completed`)
never forces — it skips guarded tickets and reports them in `skipped`, because a
batch job is the last place to discard work silently; and the two **agent tools**
(`merge_task` on the orchestrator, `delete_task` on the stories agent) never force
either — they translate the error into a tool failure telling the agent to get the
work pushed or hand the decision back to the user.

On the client, `src/hooks/useWorktreeGuard.tsx` is the single consumer: it runs
the action, catches the 409, renders `UnsavedWorktreeWorkModal`, and resolves to
`ok` / `saved` / `cancelled` / `error`. **`saved` means the user chose to commit &
push and the destructive action deliberately did not run** — the push moved the PR
head and re-triggered CI, so merging in the same breath would land a head nobody
has seen green. `intent` picks the wording and which button is primary: on
`delete` the user already asked for destruction, so discard is primary; everywhere
else saving is.

`getWorktreeStatus` carries the same counters (`dirtyFiles`, `unpushed`,
`dirtyPaths`) so the task page can show them *before* the user reaches a
destructive button — `ahead`/`behind` are measured against the base branch and
look identical whether or not the work reached the PR. `TaskDetailView` refreshes
them on `streaming-ended`, which is exactly when a live-tested worktree goes
dirty.

## prService — one PR path for button and agent

`server/services/prService.ts` is the **single** PR entry point shared by the
manual "Create PR" button and the PR agent, so both behave identically:

- **`createOrUpdatePR(repoPath, taskId, title, body)`** — commit any uncommitted
  changes, resolve the task's base branch, refuse if `ahead === 0` relative to it
  ("No changes to create a PR"), then `createPullRequest(..., base)`. The base is
  resolved *inside* the service so the signature stays stable for its callers.
- **`getCIStatusWithDetails`** — surfaces CI status + failure details for a task's
  PR (drives the Fix-CI flow).
- **`shouldRunPrAgent(task)`** — `workflow_complete && !pr_agent_complete`.

## Task creation and deletion — `taskService`

`server/services/taskService.ts` holds the single implementation of "make a
task" (`createTaskWithWorktree`: row → worktree forked off the optional
`baseBranch` → task doc, with rollback) and "destroy a task"
(`deleteTaskCompletely`: worktree, transcripts, row, archive — emitting the
`task-deleted` TaskEvent). It knows nothing about epics: the epic layer's
`createEpicTicket` (`server/services/epics/ticketService.ts`) ensures the
feature branch first and calls the same function with it as the base, so an
agent-created ticket is byte-for-byte a human-created task. See
[`../epics/stories.md`](../epics/stories.md).

## The completion scripts (agent-callable)

Agents signal loop state by running CLI scripts (`tsx scripts/…`) that flip task
flags directly in SQLite; the running conversation's completion handler reads
those flags on the next hop (see the chaining state machine):

- **`scripts/complete-plan.ts <taskId>`** — sets `planification_complete = 1`, the
  flag that ends the planning loop.
- **`scripts/complete-workflow.ts <taskId>`** — sets `workflow_complete = 1`, the
  flag that ends the implementation↔review loop and starts refinement→PR.
- **`scripts/complete-pr.ts <taskId>`** — sets `pr_agent_complete` via
  `markPrAgentComplete`, marking the PR agent (the terminal step) done. **Refuses
  on a worktree that still holds unpublished work** — see below.
- **`scripts/block-workflow.ts <taskId> [reason…]`** — blocks the task instead;
  for an epic ticket the reason is the message the orchestrator is woken with.

All call `initializeDatabase()` first and are idempotent (no-op if already set).

### They must load from any cwd — no runtime path aliases in their graph

The prompts hand agents an absolute path (`tsx {{scriptsDir}}/complete-plan.ts
42` — `scriptsDir` is a built-in prompt variable that `render` resolves to this
install's `scripts/` directory, see
[`prompt-templates.md`](./prompt-templates.md)) and the agent runs
it from *its own* task worktree — a checkout of the target project. tsx reads
`paths` from the tsconfig.json it finds in the **current working directory**, not
next to the entry file, so a runtime (value) `@shared/*` import anywhere in a
script's module graph makes every one of these calls die with
ERR_MODULE_NOT_FOUND before a line of the script runs. Server code reachable from
`database/db.ts` therefore imports `shared/` **relatively**; `import type` is
fine, the transformer erases it.

Nothing else notices when this breaks — the server runs with the repo as its cwd,
and vitest mirrors the aliases (`vitest.config.ts`) — which is how the QA-step PR
(#151) took every stage-completion call down for two weeks by adding one import
to `epicArchive.ts`, reached through `epicConversion.ts`.
`scripts/agent-invoked-scripts.test.ts` is the guard: it runs each of the four
commands from a temp directory with no tsconfig above it.

## The publish gate — the PR stage cannot sign off on work it left behind

`getTaskPublishState(taskId)` in `prService.ts` asks the unsaved-work question
above at the *other* end of the lifecycle. The guard protects a worktree someone
is about to delete; this protects the moment the task is declared finished, when
that deletion becomes inevitable — the worktree goes when the PR merges, so the
only tree a PR stage may sign off on is one that is already safe to throw away.
Same `getWorktreeSafety` probe, so the two can never disagree about what counts
as clean, and deliberately on the worktree **root** rather than the monorepo
subproject path: a byproduct dropped one directory up is exactly as lost. A
missing worktree reports published — there is nothing left to publish, and
refusing would strand the task.

`complete-pr.ts` calls it before `markPrAgentComplete` and exits 1 with the file
list and the triage rule (delete byproducts, commit and push everything else).
**No `--force`**: the escape hatch is a human's, via
`PATCH /api/tasks/:id/workflow-complete`, which sets the flag directly. An agent
gets no way around it.

**Why a hard gate and not just prompt text.** The PR prompt's first step used to
branch on whether a PR already existed, and the "it exists" path checked for
unpublished work nowhere — it went straight to mergeability and CI. Taking it
once is enough to lose work: a project whose `CLAUDE.md` tells every agent to
open a PR gets one from the *implementation* agent, so the PR stage finds a PR
and signs the task off against a commit that predates everything review and
refinement wrote. Those two stages edit files and deliberately never commit
(`review.md`, `refinement.md`) — publishing their edits is the PR stage's whole
job. The failure is silent in the worst way: CI goes green, on the wrong commit,
and the loss only surfaces after the merge. `buildPrPublishBlock`
(`server/constants/agentPrompts.ts`) now runs the same inventory → triage →
commit → push → verify-the-PR-head procedure in both states, differing only in
whether the last step creates the PR or lets the push update the open one; this
gate is what makes it non-optional.

## Key files

- `server/services/worktree.ts:9` — `getWorktreePath` (the `{repo}-worktrees/task-{id}` convention);
  `createWorktree`, `getWorktreeStatus`, `syncWithBase`, `createPullRequest`, `mergeAndCleanup`, `getPullRequestStatus`.
- `server/services/worktreeSafety.ts` — `getWorktreeSafety`, `assertWorktreeSafeToDestroy`, `UnsavedWorktreeWorkError`.
- `server/routes/tasks.ts` — `sendUnsavedWorkConflict` (the shared 409 translator).
- `src/hooks/useWorktreeGuard.tsx` + `src/components/UnsavedWorktreeWorkModal.tsx` — the client half.
- `server/services/tasks/baseBranch.ts` — `resolveBaseBranch`; `server/services/epics/epicBranch.ts` — `ensureEpicFeatureBranch`, `createEpicCompletionPR`.
- `server/services/taskService.ts` — `createTaskWithWorktree`, `deleteTaskCompletely`.
- `server/services/prService.ts` — `createOrUpdatePR`, `getCIStatusWithDetails`, `shouldRunPrAgent`, `getTaskPublishState`.
- `scripts/complete-workflow.ts` — set `workflow_complete`.
- `scripts/complete-pr.ts` — set `pr_agent_complete`, behind the publish gate.
- `server/constants/agentPrompts.ts` — `buildPrPublishBlock` (the state-agnostic publish step shared by `pr.md` and `yolo.md`).
- `server/services/shell.ts` — the `execFile`-only `runCommand` every git/`gh` call goes through.
