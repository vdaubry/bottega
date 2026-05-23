# Extra — The Kanban board (task-authoring UI)

## What it adds

A React single-page app for **authoring and managing tasks**: a four-screen
flow that lets a human create projects, write a task, watch the agent pipeline
run live, and chat with an agent — all without leaving the browser.

> I open the **Dashboard** and see my projects as a grid. I click one and land
> on its **Board**, a Kanban with columns for Pending / In Progress / In Review
> / Completed. I press **New Task**, type a title and a description, and a card
> appears in Pending. I open the card's **Task Detail**, read the doc, and press
> **Run** to start the planning agent. The card moves across the board on its own
> as the agents work, with a live indicator while one is streaming. When I want
> to steer, I open a **Chat** and talk to an agent directly.

That is the whole job: turn a human's intent into the one artifact core
requires — a task's markdown doc at the known archive path — and give the human
a place to press the **Run** buttons that drive the [orchestration
loop](../core/orchestration-loop.md).

## Why it's an extra (not core)

Core only requires that a task row exists and its markdown doc is present at the
known archive path (see [`task-and-workspace.md`](../core/task-and-workspace.md)).
*How* that doc comes to exist is preference. This board is one opinionated way;
a team could swap it for Jira, Notion, or a CLI and core would not notice.

## The swap-it-out seam (read this first)

Everything below is a UI over a tiny contract. To replace the board with another
task source, you only need to reproduce two side effects that core's task-create
already performs (see the create handler in
[`reference/server/routes/tasks.ts`](../reference/server/routes/tasks.ts)):

1. **Insert a `task` row** under a project (which points at a git repo path).
2. **Seed the doc** at the archive path with the human's request, and create the
   worktree.

Then trigger the loop by POSTing an agent-run (`POST /api/tasks/:taskId/agent-runs`).
A Jira integration that did those three things on ticket creation would drive the
exact same pipeline. The board is just the reference's chosen front door — it
adds no capability the loop depends on. Keep that boundary crisp: **the UI never
parses agent output or owns workflow state; it reads task flags and renders
them.** All routing lives server-side in the completion handler.

## The four screens

A flat React Router tree (see [`reference/src/App.tsx`](../reference/src/App.tsx))
maps one route per screen. Navigation is forward (Dashboard → Board → Detail →
Chat) with a back button at each level.

| Screen | Route | What it shows |
|---|---|---|
| **Dashboard** | `/` | Grid of project cards; each card shows task counts and a live indicator. Create / edit / delete projects. |
| **Board** | `/projects/:projectId` | Kanban for one project: four status columns. Create / edit / delete tasks. |
| **Task Detail** | `/projects/:projectId/tasks/:taskId` | The task doc (editable markdown), the conversation list, and the **AgentSection** Run buttons. |
| **Chat** | `/projects/:projectId/tasks/:taskId/chat/:conversationId` | One streaming conversation — manual chat or a resumed agent run. |

**All ids in the URL are SQLite row ids.** `:projectId`, `:taskId`,
`:conversationId` map straight to `projects.id` / `tasks.id` /
`conversations.id`. A shared link is therefore directly queryable against the
database — there is no separate slug or external id layer. The reference also
ships secondary routes off the same ids (`/edit`, `/show` for a full-page doc
view); those are conveniences, not part of the core flow.

Each page component is a thin wrapper that reads its URL params, resolves the
matching rows through `TaskContext`, and renders the screen
([`reference/src/pages/`](../reference/src/pages/) — `DashboardPage`,
`BoardPage`, `TaskDetailPage`, `ChatPage`). On a deep link the wrapper loads
projects → finds the project → loads its tasks → finds the task → loads the
conversation, redirecting up a level if any id is missing.

## TaskContext — the state hub

A single React context owns the client's view of the domain and is the one place
that calls the REST API. See
[`reference/src/contexts/TaskContext.tsx`](../reference/src/contexts/TaskContext.tsx).

It holds `projects`, the `tasks` for the selected project, the selected task's
`conversations` / `taskDoc` / `agentRuns`, and the current selection. It exposes
CRUD methods (`createProject`, `createTask`, `updateTask`, `deleteTask`,
`createConversation`, …) that each call `/api/*`, then optimistically update
local state from the response. Build it as the only REST caller for domain
state so screens stay declarative — they read context and render, they don't
fetch.

One field worth calling out: `liveTaskIds`, a `Set<taskId>` of tasks that have a
streaming session right now. It drives every "Live" indicator (see below).

## Columns map to `task.status`

The board groups tasks by `task.status` into one column each —
`pending`, `in_progress`, `in_review`, `completed` (see
[`reference/src/components/Dashboard/BoardView.tsx`](../reference/src/components/Dashboard/BoardView.tsx),
`tasksByStatus`, and the per-column config in
[`BoardColumn.tsx`](../reference/src/components/Dashboard/BoardColumn.tsx)).
The loop owns the status transitions (`pending → in_progress` on first agent
activity, etc. — see [`task-and-workspace.md`](../core/task-and-workspace.md));
the board only *reads* `status` and slots the card into the matching column. A
card crossing the board is the visual echo of a server-side status write
arriving over WebSocket. The Completed column sorts most-recent-first; a user can
also set status by hand on the Task Detail screen, which is just a
`PUT /api/tasks/:id` with `{ status }`.

(The four-column layout matches the four statuses. Earlier docs mention "three
columns" — `in_review` was added later; build four.)

## Project CRUD — point at a git repo

A project is a name plus a `repo_folder_path` on disk (optionally a
`subproject_path` for monorepos). The Dashboard's project form POSTs
`/api/projects`; the server validates the body and inserts the row
([`reference/server/routes/projects.ts`](../reference/server/routes/projects.ts)).
There is no repo cloning — the path must already be a git checkout the server can
reach. A duplicate `repo_folder_path` returns 409. Editing and deleting a project
are the obvious `PUT` / `DELETE` on the same id.

## Task CRUD — creating a task seeds the doc + worktree

This is the load-bearing action and the reason the board can be swapped out:
**creating a task is what produces core's required artifacts.** The "New Task"
form on the Board collects a title and an optional description, then calls
`createTask` → `POST /api/projects/:projectId/tasks`. The create handler (in
[`reference/server/routes/tasks.ts`](../reference/server/routes/tasks.ts)) does,
in order:

1. insert the `task` row,
2. if the project path is a git repo, **create the worktree** (and roll the row
   back if that fails),
3. **seed the markdown doc** at the archive path with the description (the
   human's original request) — empty if none.

After that, the task is a first-class unit of work whether or not the board ever
touches it again. Deleting a task tears down the worktree, purges its
conversations' messages, and deletes the archive. (The mechanics of worktree and
doc live in [`task-and-workspace.md`](../core/task-and-workspace.md); the board
just calls the endpoint.)

The reference Board also has an **Ask Question** shortcut that creates a
throwaway task + a conversation in one step and jumps straight to Chat — handy,
but it is the same two primitives (create task, create conversation) composed.

## The AgentSection "Run" buttons → the orchestration loop

On Task Detail, the **AgentSection** lists the agent roles (Planification,
Implementation, Review, PR — plus the `refinement` / `yolo` extras) with a
**Run** button each. See
[`reference/src/components/AgentSection.tsx`](../reference/src/components/AgentSection.tsx)
and the handler `handleRunAgent` in
[`reference/src/pages/TaskDetailPage.tsx`](../reference/src/pages/TaskDetailPage.tsx).

Pressing Run POSTs `/api/tasks/:taskId/agent-runs` with `{ agentType }` — the
manual entry point of the [orchestration loop](../core/orchestration-loop.md).
From there the loop is autonomous: the user presses Run once (for planning, then
again for implementation after the plan gate) and the server chains the rest.

The button surface only needs to handle the loop's documented responses:

- **409** — an agent is already running for this task (one-running-agent rule);
  show a "busy" toast, don't start a second.
- **403** with `PROVIDER_CREDENTIALS_MISSING` — the configured harness has no
  credentials for this user; open the connect-provider modal.

Each agent's button derives its visual state — Run / Running / Completed /
Failed — by reading the agent-run's `status` and the relevant **task flags**
(`workflow_complete`, `pr_agent_complete`, …), never by interpreting prose. This
is the same DB-driven truth the completion handler uses; the UI is just a second
reader of those booleans. The little chat-bubble button beside a finished run
deep-links to that run's conversation so the human can read what it did.

## Live updates via WebSocket task subscriptions

The board would be dead between REST snapshots without a push channel. The client
subscribes to **per-task** WebSocket channels for exactly the tasks currently on
screen, and re-renders on the events those tasks emit.

- A screen (Dashboard, Board) computes the visible task-id set and hands it to
  [`useTasksLiveSubscriptions`](../reference/src/hooks/useTasksLiveSubscriptions.ts),
  which sends `subscribe-task` / `unsubscribe-task` deltas and re-subscribes the
  whole set after a reconnect. Single-task screens (Detail, Chat) use the
  one-task variant (`useTaskSubscription`).
- `TaskContext` listens for the resulting `streaming-started` / `streaming-ended`
  events and maintains `liveTaskIds`; that set drives every "Live" badge.
- Other task-channel events — `agent-run-updated`, `task-blocked`,
  `conversation-added`, `conversation-name-updated` — update the agent rows,
  flip a card to blocked, and keep conversation lists fresh.

Subscriptions are scoped on purpose: task events only reach subscribers, so a
screen must subscribe the ids it renders or its indicators go stale. (The
WebSocket runtime and broadcast contract are core — see
[`harness-contract.md`](../core/harness-contract.md).)

## The Chat screen

Chat renders one conversation's streaming transcript and an input box. A
conversation is created either manually (the "New Chat" modal, picking provider +
model) or implicitly by an agent run, and is always reached by its row id in the
URL. The streaming/transcript mechanics belong to
[`harness-contract.md`](../core/harness-contract.md); manual-chat conveniences
(slash commands, attachments, voice, title generation, the context meter) are
their own extra — this spec only places Chat as the fourth screen and routes to
it.

## What to build

- [ ] A four-route SPA (Dashboard, Board, Task Detail, Chat) with row-id URLs;
      page wrappers that resolve URL params to rows and redirect up on a miss.
- [ ] A single state context that is the only REST caller for projects / tasks /
      conversations / docs / agent-runs, exposing CRUD + selection.
- [ ] Dashboard: project grid with task counts + a live indicator; project
      create / edit / delete.
- [ ] Board: four columns keyed off `task.status`; task create (→ worktree +
      seeded doc via the create endpoint), edit, delete.
- [ ] Task Detail: editable task doc, conversation list, and the AgentSection
      Run buttons that POST agent-runs and handle 409 / 403.
- [ ] Per-task WebSocket subscriptions scoped to on-screen tasks, feeding a
      `liveTaskIds` set and refreshing agent rows / blocked state / conversation
      lists live.
- [ ] Agent button states derived from agent-run `status` + task flags, never
      from agent output.

## Reference map

| Concern | File |
|---|---|
| Routes + provider stack | `reference/src/App.tsx` |
| Page wrappers (param → rows) | `reference/src/pages/{DashboardPage,BoardPage,TaskDetailPage,ChatPage}.tsx` |
| State hub (REST + selection + `liveTaskIds`) | `reference/src/contexts/TaskContext.tsx` |
| Project grid / dashboard | `reference/src/components/Dashboard/Dashboard.tsx` |
| Kanban board + columns | `reference/src/components/Dashboard/{BoardView,BoardColumn,BoardTaskCard}.tsx` |
| Task Detail (doc + convo list + agents) | `reference/src/components/TaskDetailView.tsx` |
| Run buttons | `reference/src/components/AgentSection.tsx` + `handleRunAgent` in `TaskDetailPage.tsx` |
| Live subscriptions | `reference/src/hooks/{useTasksLiveSubscriptions,useTaskSubscription}.ts` |
| Project CRUD HTTP | `reference/server/routes/projects.ts` |
| Task CRUD + worktree/doc seeding | `reference/server/routes/tasks.ts` |

## Boundaries (not in this spec)

- The task row, archive doc, and worktree mechanics →
  [`task-and-workspace.md`](../core/task-and-workspace.md).
- What "Run" actually triggers — agent runs, chaining, the plan gate, blocking →
  [`orchestration-loop.md`](../core/orchestration-loop.md).
- How a conversation streams and how WebSocket broadcasts work →
  [`harness-contract.md`](../core/harness-contract.md).
- Manual-chat UX (slash commands, attachments, voice, title generation, context
  meter) → `chat-ux.md`.
- Per-agent prompt overrides and per-user model/effort pickers in the modals →
  `prompt-and-model-customization.md`.
- Accounts, project membership, and the non-technical auto-advance past the plan
  gate → `auth-and-multi-user.md`.
