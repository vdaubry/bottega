# The agentic loop — agent types, startAgentRun, the chaining state machine

How Bottega drives a task through automated coding agents. The agents *are*
conversations (see [`../conversations/lifecycle-and-streaming.md`](../conversations/lifecycle-and-streaming.md));
this doc covers what makes a conversation an *agent run* and how runs chain.

## The six agent types

`AgentType` (`shared/types/db.ts:25`) = `planification | implementation | review |
refinement | pr | yolo`. Each maps to a prompt template (see
[`prompt-templates.md`](./prompt-templates.md)) and a `task_agent_runs` row.
Roughly: **planification** writes the plan, **implementation** builds it,
**review** checks + tests it, **refinement** addresses review feedback, **pr**
opens/updates the PR (terminal), **yolo** does the whole thing in one continuous
conversation.

## startAgentRun

`startAgentRun(taskId, agentType, options)`
(`server/services/agentRunner.ts:57`) is the single entry point:

1. Resolve the effective cwd (worktree if one exists), the central
   `taskDocPath` (survives PR merge), and the task's **base branch**
   (`resolveBaseBranch`, `server/services/tasks/baseBranch.ts` — `tasks.base_branch`, else the repo default),
   which is threaded into every prompt that talks about `origin/<base>`.
2. Generate the agent's message from its prompt template (the `switch` at `:81`;
   planification picks tech vs non-tech by the **triggering** user's
   `is_technical`).
3. Resolve **this user's** configured `(provider, model, effort)` for this agent
   type (`loadAgentModelSettings(userId)[agentType]`, `:137`) — per-user, no
   silent default; an unseeded user throws.
4. Fail closed if the user has no credentials for that provider
   (`ProviderCredentialsMissingError` → the route renders "Connect <provider>").
5. `incrementRunCount`, create the `task_agent_runs` row (stamped `provider`),
   mark it `running`, create + link the conversation, broadcast `agent-run-updated`.
   For an **epic ticket** at a loop entry point (`planification`/`yolo`/`pr`) on a
   clean worktree, the worktree is then merged with the epic's feature branch; a
   conflict fails the run, blocks the task and raises `BaseSyncConflictError`
   (→ 409). See [`../epics/feature-branch.md`](../epics/feature-branch.md).
6. `startConversation(...)` with the agent message + a context system prompt.
   `implementation`/`yolo` get `disallowedTools: ['Agent']` (no sub-agent spawn).

The run's completion, status flip, and chaining are **not** here — they're owned
by the conversation completion handler.

## DB-derived completion (the failure rule)

`buildAgentRunCompletionHandler(ctx)`
(`server/services/conversation/agentRunLifecycle.ts:95`) is composed into the
streaming loop's `onComplete`. It reads the linked run's **DB status**:

- `running` → the loop exited normally → mark `completed`, broadcast, maybe chain.
- `failed` → task user Stop, orphan-recovery, or a terminal provider error
  already wrote it → **no-op, no chain**.

There is **intentionally no `isError` parameter**. Three task-run paths set `failed`
*before* the handler runs: `abortSession` (task user Stop), the server-restart orphan
sweep, and `failLinkedAgentRunIfRunning` (`:45`) — which pre-marks `failed` when
a non-Anthropic provider surfaces a terminal `result` error (usage limit, dropped
SSE) as in-band data instead of throwing. Without that pre-mark, a Codex usage
limit would mark `completed` → chain → hit the limit again → run away to the cap.

## The chaining state machine

`handleAgentChaining(taskId, agentType, ctx)` (`:175`), `setTimeout(…, 1000)` per
hop, re-checking fresh task flags before each start:

- **planification → implementation** — auto-chains **only for non-technical
  owners**; technical owners keep the manual-Run gate. Skipped entirely for an
  **automation-driven** run (`task_agent_runs.driver = 'automation'`, set by
  the epic orchestrator and inherited down the chain): the driver reviews the
  plan before approving it, so auto-chaining would review nothing. The same
  driver also forces the technical planification prompt variant and mutes
  per-turn push notifications.
  See [`../epics/orchestrator.md`](../epics/orchestrator.md).
  Never when the task is **blocked** either: the non-technical prompt's
  sensitive-areas guardrail (driven by the project's `sensitive_areas` list, see
  [`prompt-templates.md`](./prompt-templates.md))
  escalates by running `scripts/block-workflow.ts` instead of writing a plan,
  and the turn end announces that like any agent block (`task-blocked` +
  `workflow-blocked`), so the task waits for a technical user to press Resume
  and reply in the planning conversation.
- **implementation ↔ review** — the core loop; each completion chains to the
  other (`nextType`, `:285`).
- **`workflow_complete` → refinement → pr** — once the workflow is flagged
  complete (an agent ran `scripts/complete-workflow.ts`), run refinement, then —
  if a worktree exists — the PR agent. PR is terminal.
- **Guards** — `workflow_blocked` stops the loop; `workflow_run_count >=
  MAX_WORKFLOW_RUNS` (`:23`, **25**) auto-blocks and broadcasts `task-blocked`.
  An agent's own block (`scripts/block-workflow.ts <taskId> "reason"`, a
  separate process writing straight to SQLite) is first seen here, at turn end:
  the adapter broadcasts `task-blocked` and publishes the `workflow-blocked`
  TaskEvent carrying the reason, so a supervising epic orchestrator is woken
  instead of the loop just going quiet.
  `startAgentRun` performs the authoritative one-running-run check immediately
  before its synchronous SQLite writes; routes, chaining and the webhook may
  preflight it for a better response, but the entry point owns the invariant.
  Epic reviewer concurrency is an epic-domain policy and is invisible here.
- **Orchestrator wake-ups** — for an orchestrated ticket, the same turn-end
  handler also notifies the epic's orchestrator: planification and PR turns
  always, mid-chain runs only when they **failed** (a successful hop is the
  chain doing its job). `task-blocked` and a chain that fails to start are
  reported too — nobody else is watching those.

The task workflow flags (`workflow_complete`, `refinement_complete`,
`pr_agent_complete`, `workflow_blocked`, `workflow_run_count`) are the loop's
state — see [`../tasks/domain-model.md`](../tasks/domain-model.md).

## YOLO mode

A single continuous conversation that runs the full pipeline itself (no chaining);
`disallowedTools: ['Agent']` keeps it one visible transcript. The UI surfaces it
as a separate launch when `yoloMode` is on (see [`agent-ui.md`](./agent-ui.md)).

## Key files

- `server/services/agentRunner.ts:57` — `startAgentRun` (the entry point).
- `server/services/conversation/agentRunLifecycle.ts:95` — completion handler;
  `:175` `handleAgentChaining`; `:23` `MAX_WORKFLOW_RUNS`; `:45` `failLinkedAgentRunIfRunning`.
- `server/services/agentModelSettings.ts:48` — `loadAgentModelSettings` (per-user resolve).
- `server/routes/agent-runs.ts` — the REST surface (`POST /tasks/:taskId/agent-runs`).
- `shared/types/db.ts:25` — `AgentType`.
