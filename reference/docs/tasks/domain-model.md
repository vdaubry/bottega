# Tasks domain model — projects, tasks, conversations, workflow flags

The core entities Bottega is built around and their on-disk + DB shape. The
SQLite schema mechanics are in
[`../architecture/data-model.md`](../architecture/data-model.md); this doc is the
*domain* view.

## The three-level hierarchy

`projects` → `tasks` → `conversations`. A **project** is a git repo
(`repo_folder_path`, optional `subproject_path` for monorepos). A **task** is a
unit of work in that repo — it owns a git worktree (see
[`../agents/worktrees-and-pr.md`](../agents/worktrees-and-pr.md)), a markdown doc,
and a set of conversations. A **conversation** is one provider session (see
[`../conversations/lifecycle-and-streaming.md`](../conversations/lifecycle-and-streaming.md)).
Row types: `ProjectRow` / `TaskRow` / `ConversationRow` (`shared/types/db.ts`).

## Task status lifecycle

`TaskStatus` (`shared/types/db.ts:23`) = `pending | in_progress | in_review |
completed` — the four Kanban columns (see [`board-and-screens.md`](./board-and-screens.md)).
Starting work (a conversation or an agent run) auto-flips `pending → in_progress`;
the rest are set explicitly via `PUT /api/tasks/:id`.

## Worktree setup state

Creating a task returns at once; its git worktree is set up **in the
background** (`server/services/tasks/worktreeSetup.ts`). That setup is `git
worktree add`, which runs the project's own `post-checkout` hook — dependency
installs, builds — so it can take minutes, or hang
([`../agents/worktree-provisioning.md`](../agents/worktree-provisioning.md)).
`tasks.worktree_state` says where it stands:

| State | Meaning |
|---|---|
| `provisioning` | the setup is queued or running |
| `ready` | the worktree exists and is usable (every task from before this column, and every non-git task) |
| `failed` | the setup failed or timed out; `worktree_error` holds the reason and the hook's last output lines |

The rules:

- **No conversation starts on a task that is not `ready`** — no chat, no
  agent, no Explore. `conversationsDb.create` enforces it
  (`TaskWorktreeNotReadyError`, mapped to **409**); `startAgentRun`, the
  Explore route and the conversation route check before their own side
  effects. Editing, renaming, deleting the task stay allowed.
- **A failed setup never deletes the task.** It stays `failed`, for
  `POST /tasks/:id/worktree/retry` (which first clears what the failed attempt
  left) or a delete. Deleting tasks on failure is how tasks used to vanish
  while an agent was already working in them: the row was visible, and usable,
  before its worktree was done.
- **One setup at a time per repository**, in creation order — a hook usually
  installs into caches every worktree of the repo shares. The 10-minute budget
  counts from a setup's start.
- **A setup is one process group.** A timeout, a delete (which cancels the
  setup first) or a shutdown kills the hook's children too, not just `git`.
- **A restart fails what was running.** The boot crash recovery (owner-only,
  like the orphan sweep) marks every `provisioning` row `failed`.

Every change publishes the `worktree-state-changed` TaskEvent; `index.ts`
forwards it on the task channel as `task-worktree-updated`, which drives the
board's *SETTING UP* / *SETUP FAILED* badge and the task page's banner (with
Retry / Delete). The epic layer subscribes too: the sequencer waits for a
ticket still being set up and pauses the epic on a failed one
([`../epics/orchestrator.md`](../epics/orchestrator.md#sequencing)).

## Workflow flags (the loop's state)

Separate from `status`, a task carries the **agentic-loop** state as boolean/int
columns (`TaskRow`, `shared/types/db.ts:97`):

| Flag | Meaning |
|---|---|
| `workflow_complete` | implementation↔review loop is done → start refinement→PR |
| `refinement_complete` | refinement agent finished |
| `pr_agent_complete` | PR agent (terminal) finished |
| `workflow_blocked` | loop halted (the agent's own `scripts/block-workflow.ts` — a review block, or the non-technical planning guardrail escalating to a technical user — a base-sync conflict, or `MAX_WORKFLOW_RUNS`) |
| `workflow_blocked_reason` | why, in the agent's words — published on the `workflow-blocked` TaskEvent, shown as the task header's *Paused* banner, and cleared on unblock |
| `workflow_run_count` | agent iterations so far (loop-guard counter) |
| `yolo_mode` | run the whole pipeline as one continuous conversation |

These are the chaining state machine's inputs — see
[`../agents/agentic-loop.md`](../agents/agentic-loop.md). Agents flip them by
running the `complete-workflow` / `complete-pr` scripts.

## The on-disk task-doc archive

The task's plan/spec markdown does **not** live in the worktree — it lives in a
central archive under `~/.bottega` (`BOTTEGA_ARCHIVE_ROOT`) so it survives a PR
merge that deletes the worktree. `server/services/documentation.ts` owns the
layout:

- Doc — `~/.bottega/projects/{projectId}/tasks/task-{taskId}.md`
  (`getTaskDocPath`, `:33`).
- Input files — `…/tasks/task-{taskId}/input_files/`.
- Recordings — `~/.bottega/projects/{projectId}/recordings/task-{taskId}.webm`.

`buildContextPrompt` (`:306`) folds the doc + input files into the system prompt
every agent run gets. (Any `.bottega/tasks/*.md` *inside* a repo is legacy and
ignored.)

## URL routing = SQLite rows

Every id in a URL is a SQLite row id:
`/projects/:projectId/tasks/:taskId/chat/:conversationId`. So
`/projects/178/tasks/562/chat/2683` is three direct row lookups — handy for
debugging against the live DB.

## Key files

- `shared/types/db.ts:23` — `TaskStatus`; `:97` the `TaskRow` workflow flags.
- `server/database/db.ts` — `projectsDb` / `tasksDb` / `conversationsDb` query helpers.
- `server/services/documentation.ts:33` — `getTaskDocPath`; `:306` `buildContextPrompt`.
- `server/routes/tasks.ts` — the task REST surface (create starts the worktree setup; `POST /tasks/:id/worktree/retry`).
- `server/services/tasks/worktreeSetup.ts` — the background worktree setup: per-repo queue, cancel, retry, boot sweep.
- `server/services/projectService.ts` — `hasProjectAccess` + the membership-scoped getters.
