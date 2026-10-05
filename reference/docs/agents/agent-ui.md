# Agent UI — launching agents, live status, TodoList, Fix-CI

The frontend of the agentic loop: the launch panel, how step status stays live,
the plan-derived TodoList, and the Fix-CI entry point. The backend is
[`agentic-loop.md`](./agentic-loop.md).

## AgentSection — the launch panel

`src/components/AgentSection.tsx` renders one row per agent type (planification,
implementation, review, refinement, pr — or just **yolo** when `yoloMode` is on,
filtered at `:81` off `task.yolo_mode`). Clicking a row calls `onRunAgent(type)`,
which the page wrapper (`src/pages/TaskDetailPage.tsx:226`) backs with
`api.agentRuns.create(taskId, type)` → `POST /tasks/:taskId/agent-runs` →
`startAgentRun`. A local `runningType` guard blocks double-clicks.

Each row's indicator reflects **its own latest run's** status — blue while
`running`, green on `completed`, red on `failed`. The "latest run" is the one with
the **highest run id** (`getAgentRun`, `:104`): the implementation↔review loop
produces several runs per type, and the highest autoincrement id is the most
recent. Deliberately **not** gated on the task-level `workflow_complete` /
`refinement_complete` flags — those aren't pushed over WS, so depending on them
would leave finished steps stuck until a manual refresh.

## Live status via `agent-run-updated`

The backend broadcasts `agent-run-updated` on the task channel on every status
change (created/running/completed/failed). `useTaskSubscription`
(`src/hooks/useTaskSubscription.ts:60`) folds it into the task's `agentRuns`
array, so `AgentSection` re-renders the mechanical blue→green flow live without
polling. Dashboard-wide liveness uses `useTasksLiveSubscriptions` (see
[`../frontend/state-and-realtime.md`](../frontend/state-and-realtime.md)).

## TodoList — the plan view

`src/components/TodoList.tsx` renders a visual todo list from the agent's
`TodoWrite` tool calls (`{ todos: [{ content, status, … }] }`, statuses
`pending|in_progress|completed`) with color-coded badges — how the
implementation/plan progress surfaces inside a conversation.

## The run-phase trigger

The implementation prompt is phase-oriented ("Implement the next phase from the
plan"), so re-running **implementation** advances the plan one phase at a time;
there is no separate "run phase" control — it's the implementation agent launched
again from `AgentSection` (or auto-chained).

## PR-repair entry points

When a task's PR is blocked, `TaskDetailView` swaps the green Merge button for a
repair button — **Fix conflicts** (`:972`, amber, when `mergeable === 'CONFLICTING'`)
or **Fix CI** (`:1015`, red, when CI failed) — both opening `PRFixModal` (`:1165`).
The modal picks a provider+model (the shared `ProviderModelPicker`) and starts a
conversation seeded with a pre-defined prompt for that repair (`buildFixPrompt`,
`:127` — deliberately not an editable agent prompt), then navigates into the chat.
Conflicts win over CI: GitHub reports no meaningful CI verdict for a branch that
cannot merge. See [`../conversations/chat-ui.md`](../conversations/chat-ui.md).

## Key files

- `src/components/AgentSection.tsx:81` — yolo filter; `:104` `getAgentRun` (latest-by-id).
- `src/pages/TaskDetailPage.tsx:226` — `handleRunAgent` → `api.agentRuns.create`.
- `src/hooks/useTaskSubscription.ts:60` — folds `agent-run-updated` into task state.
- `src/components/TodoList.tsx` — the TodoWrite-driven plan view.
- `src/components/{TaskDetailView,PRFixModal}.tsx` — the Fix-CI / Fix-conflicts entry points.
