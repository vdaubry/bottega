# Task screens — Dashboard, Board, Task Detail

The 4-screen flow a user walks to reach a conversation, and the controls each
screen exposes. State + routing live in
[`../frontend/state-and-realtime.md`](../frontend/state-and-realtime.md); the
entities are [`domain-model.md`](./domain-model.md).

## The flow

`Dashboard → BoardView → TaskDetailView → ChatInterface`. Each screen is a thin
**component** rendered by a **page wrapper** under `src/pages/` that reads route
params and `useTaskContext()` (`DashboardPage`, `BoardPage`, `TaskDetailPage`,
`ChatPage`). Routes are id-based (`/projects/:projectId/tasks/:taskId/…`).

## Dashboard

`src/components/Dashboard/Dashboard.tsx` — the landing screen. Two parts:
- **Project cards** (`ProjectCardGrid` / `ProjectCard`) — one card per project the
  user is a member of, with per-status task counts.
- **In-Progress section** (`InProgressSection`) — **cross-project**: every task
  with status `in_progress` across *all* the user's projects, so active work is
  visible without drilling into each board.

`ViewToggle` switches a project between the board and a flat list.

## BoardView — the Kanban

`src/components/Dashboard/BoardView.tsx` renders one project's tasks as **four
`BoardColumn`s** keyed by `TaskStatus`: `pending`, `in_progress`, `in_review`,
`completed` (`:458`+). Cards are `BoardTaskCard`; `CompletedCollapse` folds the
done column. Live badges on a card come from `liveTaskIds` (a task currently
streaming) — see the realtime doc.

## TaskDetailView — the control surface

`src/components/TaskDetailView.tsx` is the densest screen. It shows the task's
**editable markdown doc** (from the central archive,
`readTaskDoc`/`writeTaskDoc`) and the task's **conversation list**
(`ConversationList`), and hosts:

- **`AgentSection`** — launch/resume the agents (see [`../agents/agent-ui.md`](../agents/agent-ui.md)).
- **Worktree status** — commits ahead/behind the base branch, plus an amber
  "N uncommitted · M unpushed" badge (refreshed on `streaming-ended`) that says
  whether what you are live-testing has actually reached the PR.
- **Workflow block banner** — when `workflow_blocked` carries a reason (a
  review block, the non-technical planning guardrail escalating to a technical
  user), an amber *Paused: …* banner under the header repeats the agent's
  reason and the red **Resume** button's tooltip carries it too. Resume is not
  gated: whoever presses it unblocks the task.
- **CI / PR controls** — `prStatus` + `ciStatus`, a "Create PR" button
  (`prService`), and — when the PR is blocked — a **Fix conflicts** (mergeable
  `CONFLICTING`) or **Fix CI** (CI failed) button → `PRFixModal`.
- **Switch server** — point the NGINX symlink at this task's worktree to
  live-preview the branch (see [`../web-server/switch-server.md`](../web-server/switch-server.md)).
- **Explore** — open the Explore IDE for this task (see
  [`../atlas/explore-ide.md`](../atlas/explore-ide.md)).

Every control here that deletes the worktree — **Merge & Cleanup**, **Merge
without PR**, and the status dropdown's **Completed** — goes through
`useWorktreeGuard`, as does **Delete task** on the board and the edit page. If the
worktree still holds uncommitted or unpushed work the action stops and offers
cancel / commit & push / discard instead of destroying it. See
[`../agents/worktrees-and-pr.md`](../agents/worktrees-and-pr.md#the-unsaved-work-guard--nothing-deletes-a-worktree-silently).

Clicking a conversation navigates to `ChatPage` → `ChatInterface`
([`../conversations/chat-ui.md`](../conversations/chat-ui.md)).

## Key files

- `src/components/Dashboard/Dashboard.tsx` (+ `ProjectCardGrid`, `InProgressSection`) — the landing screen.
- `src/components/Dashboard/BoardView.tsx:458` — the four `TaskStatus` columns; `BoardColumn` / `BoardTaskCard`.
- `src/components/TaskDetailView.tsx` — doc + conversations + worktree/CI/PR/switch/explore controls.
- `src/pages/{DashboardPage,BoardPage,TaskDetailPage,ChatPage}.tsx` — the route wrappers.
