# Epics architecture v2 — tasks agnostic, epics on top

> **Status: implemented.** This is the reference for the v2 boundaries, data
> model and domain surfaces. The original migration introduced a transient
> task-worktree lease in step 4; it was removed on 2026-08-25 after reviewer
> ownership moved fully into `epic_agent_runs`.

## Why v2

The first epic to reach autonomous implementation (epic 4, 2026-08-23) stalled
on the orchestrator's first turn: `start_planification` was refused with *"A
epic-orchestrator agent is already running on task 1658"* — the "agent already
running" was **the orchestrator's own run**. The guard `getRunningAgentForTask`
had been taught (#125) to count epic runs bound to a ticket through
`ticket_task_id`; correct for the PR reviewer, which occupies the ticket's
worktree, and wrong for the orchestrator, which merely supervises it — and
which is `running` precisely while it calls the tools that guard protects.

That bug is a symptom, not the disease. The roadmap's locked decision 4 says
**"Ticket-level agents must not know epics exist"** — and it was applied to
the prompts while the *code* drifted the other way. Today the task layer
consults the epic layer at twelve call sites across six files
(`agentRunLifecycle`, `askUserQuestion`, `notifications`, `agentRunner`,
`taskService`, `prService` + three task routes), the shared tables force
task-or-epic branches into every consumer, and one column
(`ticket_task_id`) means two different things depending on `agent_type`.
Each of those is a place where the next #125-style change can silently break
the other layer.

v2 extends decision 4 from the prompts to the code and the schema: **the task
domain is complete and epic-agnostic; the epic domain is a layer on top that
drives tasks exactly the way a human does.**

## The three rules

1. **The task layer imports nothing from the epic layer.** No
   `isOrchestratedTask`, no `notifyOrchestrator`, no `resolveTaskBaseBranch`,
   no `ensureEpicFeatureBranch`, no `epic_id` in any conditional. Enforced by
   lint (below), not by convention.
2. **The epic layer acts on tasks only through the task domain's public
   service API** — the same functions the REST routes call when a human
   clicks. The bottega MCP is the adapter that exposes that API to an agent;
   REST is the adapter that exposes it to a person. One API, two adapters:
   "the orchestrator is a drop-in for the human", made structural.
3. **The task layer publishes domain events to nobody in particular.** The
   epic layer subscribes. A task never knows whether anyone is listening.

Rule 3 is why "the only connection is an MCP" is amended rather than adopted
verbatim: an MCP is request/response *from* the agent, and the orchestrator is
dormant — something server-side must wake it when a ticket's turn ends. Today
that is the bridge, called by name from inside the task layer at seven sites.
In v2 it is a subscriber on a bus the task layer owns. **One API down, one
event stream up, nothing else.**

## The target shape

```
┌────────────────────────── EPIC DOMAIN ───────────────────────────┐
│ epics · epic_tickets · epic_agent_runs · epic_conversations       │
│ stages · orchestration (bridge = event subscriber, sequencing)    │
│ epic branch lifecycle · epic archive · bottega MCP catalogs       │
└──────────────┬───────────────────────────────────┬───────────────┘
               │ calls the task service API        │ subscribes to TaskEvents
               ▼                                   │
┌────────────────────────── TASK DOMAIN ───────────┴───────────────┐
│ tasks · task_agent_runs · task_conversations · workflow loop      │
│ worktree/PR/CI · service API · TaskEvents · driver                │
│ knows nothing above                                               │
└──────────────────────────────┬───────────────────────────────────┘
                               │ both domains register with
                               ▼
┌────────────────── CONVERSATION RUNTIME (infrastructure) ─────────┐
│ conversations (no owner columns) · SDK streaming · session store  │
│ abort/resume · orphan sweep · owner-adapter registry              │
└──────────────────────────────────────────────────────────────────┘
```

The runtime is today's `conversation/` machinery with the owner branches
extracted: it streams turns, stores sessions, aborts, resumes — and dispatches
ownership questions ("whose conversation is this, what is its cwd, whom do I
call at turn end, which WS channel carries it") to **owner adapters** the two
domains register at boot. `messages` / `session_summaries` are untouched (they
key on session-id strings, not on owners).

## Data model

### Tables

```sql
-- INFRASTRUCTURE: no owner columns. `owner_kind` is a dispatch tag for the
-- runtime's adapter registry, not a foreign key.
CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('task', 'epic')),
    claude_conversation_id TEXT,
    session_path TEXT DEFAULT NULL,
    context_usage_json TEXT DEFAULT NULL,
    name TEXT DEFAULT NULL,
    provider TEXT NOT NULL DEFAULT 'anthropic',
    provider_session_id TEXT,
    model TEXT DEFAULT NULL,
    effort TEXT DEFAULT NULL,
    atlas_enabled INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- TASK DOMAIN
CREATE TABLE task_conversations (
    conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX idx_task_conversations_task_id ON task_conversations(task_id);

CREATE TABLE task_agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_type TEXT NOT NULL CHECK(agent_type IN
      ('planification','implementation','refinement','review','pr','yolo')),
    status TEXT DEFAULT 'pending' CHECK(status IN
      ('pending','running','completed','failed','blocked')),
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    provider TEXT NOT NULL DEFAULT 'anthropic',
    -- Who started this run and therefore reviews its output: a person, or an
    -- automation (the epic orchestrator today; any future driver tomorrow).
    -- Inherited by chained runs. Policy, not identity: it decides the
    -- planification prompt variant, the auto-chain, and push notifications.
    driver TEXT NOT NULL DEFAULT 'human' CHECK(driver IN ('human','automation')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);

-- tasks: epic_id and epic_order are GONE. One column is new:
--   base_branch TEXT DEFAULT NULL
--     The branch this task forks from and merges into; NULL = the repo's
--     default branch, resolved at use. Set at creation by whoever creates the
--     task (the epic layer passes its feature branch). Auto-sync at loop
--     entry applies exactly when base_branch is set — today's epic-ticket
--     rule, expressed as a task property.
-- EPIC DOMAIN
CREATE TABLE epic_tickets (
    epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (epic_id, task_id)
);

CREATE TABLE epic_conversations (
    conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE
);
CREATE INDEX idx_epic_conversations_epic_id ON epic_conversations(epic_id);

CREATE TABLE epic_agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
    agent_type TEXT NOT NULL CHECK(agent_type IN
      ('epic-architecture','epic-specification','epic-stories',
       'epic-spec-review','epic-orchestrator','epic-pr-review')),
    status TEXT DEFAULT 'pending' CHECK(status IN
      ('pending','running','completed','failed','blocked')),
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    provider TEXT NOT NULL DEFAULT 'anthropic',
    -- The ticket this run is ABOUT (orchestrator: supervises; reviewer:
    -- reviews). One meaning. No task-layer code can read it, because no
    -- task-layer code reads this table.
    ticket_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
);
```

Decisions worth spelling out:

- **Link tables, not XOR columns.** The XOR (`(task_id IS NULL) + (epic_id IS
  NULL) = 1`) put owner FKs *inside* the infrastructure table — the
  infrastructure referencing the domains. Link tables invert the arrow: each
  domain references the infrastructure. `owner_kind` is a plain dispatch tag
  so the runtime resolves an owner in one read instead of probing both link
  tables.
- **`epic_tickets` replaces `tasks.epic_id`/`epic_order`.** Membership is
  epic-layer data; `UNIQUE (task_id)` keeps "a task belongs to at most one
  epic". Deleting an epic deletes memberships, never tasks (today's
  SET-NULL semantics, now structural). Position renumbering
  (`moveTaskInEpic`, the delete-renumber loop in `story.ts`) becomes a plain
  epic-layer update — no more rewriting task rows to keep an ORDER BY stable.
- **`ticket_task_id` keeps its name but loses its ambiguity**: it lives only
  in `epic_agent_runs` and means "the ticket this epic conversation is
  about". It is also the durable source for rebuilding a reviewer's worktree
  context on resume; it is not task-owned occupancy state.
- **Run ids are preserved by the migration** (epic rows copied with explicit
  ids); the two tables' sequences then diverge, which is fine because no
  surface mixes them: the task page lists task runs, the epic page epic runs.

### Concurrency ownership

```
task execution guard(taskId) =
  task_agent_runs has a running row for taskId

epic PR-review guard(epicId) =
  epic_agent_runs has a running or blocked epic-pr-review row for epicId
```

Read against the epic-4 incident: the orchestrator's run lives in
`epic_agent_runs`, so `start_planification` → `startAgentRun` consults only
`task_agent_runs`. The task domain has no representation of an epic reviewer.
The epic layer separately enforces one resumable PR reviewer per epic, using
the table where reviewer ownership already lives. `startAgentRun` owns the
authoritative task-local check immediately before inserting; routes, chaining
and the GitHub webhook preflight the same query for clearer responses.

## The task domain's public surface

### Service API (commands + queries)

The facade the REST routes, the WS dispatcher, and the epic layer all call.
Most functions exist today; the work is completing the facade and making the
epic layer use it instead of `tasksDb`/`agentRunsDb` (the inventory found 9
raw-DB access patterns from epic code, including `tasks.update({status:
'completed'})` in `merge_task` — which today bypasses the status-change
notification and streaming-session cleanup the REST route performs; routing
through one `mergeTask()` fixes that class of drift for good).

| Function | Exists as | Notes |
|---|---|---|
| `createTask({projectId, title, description, baseBranch?, userId})` | `createTaskWithWorktree` | loses `epicId`/`epicOrder` and the `ensureEpicFeatureBranch` call — the caller passes a ready `baseBranch` |
| `deleteTask(taskId, {force})` | `deleteTaskCompletely` | now emits `task-deleted` |
| `updateTitle` / `writeDoc` / `readDoc` | `tasksDb.update` + `documentation` | facade'd |
| `startAgentRun(taskId, type, {driver, …})` | `startAgentRun` | `driver` replaces `actorIsTechnicalOverride` |
| `sendMessageToConversation` | `sendMessage` | unchanged |
| `answerQuestion(conversationId, answers)` | `resolveAskUserQuestion` | unchanged |
| `pendingQuestion(taskId)` | *(new)* | wraps the `pendingAskUserQuestions` map the orchestrator tools read directly today |
| `taskProgress(taskId)` | *(new)* | flags + latest run per type + PR/CI + worktree path — the `get_task_progress` body, minus the epic-run part |
| `getRunningAgentForTask(taskId)` | `getRunningAgentForTask` | task-local query; `startAgentRun` is the authoritative enforcement point |
| `mergeTask(taskId, {force?})` | task landing saga over the worktree primitives | writes merge intent, confirms the remote merge, atomically completes the task, emits `task-merged`; cleanup is retryable housekeeping |
| `resolveBaseBranch(taskId)` | `resolveTaskBaseBranch` | moves INTO the task layer: `tasks.base_branch ?? getDefaultBranch(repo)` — `worktree.ts` already takes the string and is the model |
| `worktreeStatus` / `syncWorktree` / `createOrUpdatePR` / `prStatus` | exist | now read `resolveBaseBranch` internally |

### TaskEvents

An in-process typed emitter (`server/services/tasks/events.ts`). Emission is
synchronous and ordered; **`run-ended` fires where `notifyOrchestratorOfTurnEnd`
sits today — after the run's terminal write, before any chaining decision** —
preserving the load-bearing notify-before-chain ordering. Subscriber errors
are caught and logged; a listener can never fail a turn.

| Event | Payload | Replaces (producer site today) |
|---|---|---|
| `run-ended` | `{taskId, runId, agentType, status, driver, conversationId}` | `agentRunLifecycle.ts:258/263/272/277` — every agent type, every outcome; the *subscriber* filters |
| `question-parked` | `{taskId, conversationId, questions}` | `askUserQuestion.ts:184` |
| `workflow-blocked` | `{taskId, reason: 'max-iterations' \| 'base-sync-conflict', detail?}` | `agentRunLifecycle.ts:407`, `agentRunner.ts:414` |
| `chain-start-failed` | `{taskId, nextAgentType, error}` | `agentRunLifecycle.ts:455` |
| `task-merged` | `{taskId}` | *(new — from `mergeTask`; lets the epic advance immediately on a hand-merged ticket instead of at the next `advance`)* |
| `task-deleted` | `{taskId}` | *(new — closes the known gap where deleting a ticket mid-epic is silent)* |
| `worktree-state-changed` | `{taskId, state, error}` | *(new — the background worktree setup started (a retry), finished or failed; see [`../tasks/domain-model.md`](../tasks/domain-model.md))* |

### The merge boundary is a durable saga

GitHub and SQLite cannot share a transaction. `mergeTask` therefore writes a
`task_landings` row containing the exact PR URL, head and base **before** it
asks GitHub to merge. A non-zero or timed-out `gh` response is ambiguous, so
the service re-reads that PR: remote `MERGED` is the authoritative completion
fact. Recording `task_landings.state = merged` and `tasks.status = completed`
happens in one SQLite transaction; only then are replay-safe notifications and
`task-merged` emitted.

Worktree/branch removal is deliberately outside that completion boundary. Its
`cleanup_state` is retried independently (with a deadline appropriate for
dependency-heavy worktrees), and cleanup failure is returned as a warning,
never as “the merge failed.” On boot, `reconcileTaskLandings` checks every
persisted `merge_requested` PR and repairs the local transaction when GitHub
merged before a crash. It never auto-merges a PR that is still open. Boot runs
this reconciliation before epic sequencing reads ticket status. If Bottega
first discovers a PR after it was already merged, the task is reconciled but
its worktree is marked non-retryable for cleanup: without a recorded pre-merge
safety checkpoint, restart recovery must leave that tree for manual review.

### The `driver` policies

Three behaviours currently keyed on "is this ticket orchestrated?" or on the
`actorIsTechnicalOverride` knob become policies of the run's driver — an
epic-agnostic concept any future automation (cron, webhook bot) reuses:

1. **Planification prompt variant**: `driver === 'automation'` → the
   technical prompt (the driver reviews the plan itself). Replaces
   `actorIsTechnicalOverride` (`agentRunner.ts:147-158`).
2. **No auto-chain out of planification** for automation-driven runs.
   Replaces the `isOrchestratedTask` check in `handleAgentChaining:300`.
   Chained runs (implementation → review → refinement → pr) inherit the
   driver, so the whole autonomous stretch stays `automation`.
3. **No push notification** for automation-driven runs' turn ends. Replaces
   `isOrchestratedTaskNotification` (`notifications.ts:214-252`). Badge
   updates stay unsuppressed (today's behaviour, now documented).

Two deliberate semantic changes, called out for review rather than hidden:

- **A manual chat on an orchestrated ticket will push again.** Today it is
  muted by the task-level check; under v2 a conversation with no automation
  run behind it notifies its human. The person asked directly; they get their
  answer.
- **A human manually starting planification on a ticket mid-orchestration**
  would follow human rules (their prompt variant, their auto-chain). Today
  the task-level check suppressed the chain. This is out-of-band interference
  either way; the orchestrator still receives `run-ended` (the subscriber
  filters by ticket membership, not driver) and re-reads state.

## The epic domain

### The bridge becomes a subscriber

`epicOrchestrator/bridge.ts` keeps its queue, dedupe, caps, wake mechanics,
and `[bottega-event]` rendering **unchanged** — what changes is how events
reach it. One subscriber module maps TaskEvents to today's bridge events:

| TaskEvent | Condition (epic-side) | Bridge event |
|---|---|---|
| `run-ended` agentType=planification | ticket of an active orchestration | `planification-turn-ended` |
| `run-ended` agentType=pr, completed | same | `schedulePrReview(...)` (the hand-off, no wake) |
| `run-ended` agentType=pr, failed | same | `pr-turn-ended` + today's payload |
| `run-ended` impl/review/refinement, failed | same | `agent-run-failed` |
| `question-parked` | same | `question-pending` |
| `workflow-blocked` max-iterations | same | `task-blocked` |
| `workflow-blocked` base-sync-conflict | same | `sync-failed` |
| `chain-start-failed` | same | `chain-start-failed` |
| `task-merged` | same | `scheduleNextTicket(epicId)` |

"Ticket of an active orchestration" — today's `isOrchestratedTask` — moves
into the epic layer where it belongs: `epic_tickets` join + `orchestration_active`.
The `flags:` line the bridge renders into every wake reads task state through
`taskProgress()` instead of `tasksDb.getById`.

### Ticket creation and the feature branch

`POST /epics/:id/tasks` (new route) and the stories/spec-review `create_task`
tool share one epic-layer service: validate the epic, `ensureEpicFeatureBranch`
**first**, then `createTask({…, baseBranch: featureBranch})`, then insert the
`epic_tickets` row. `taskService` drops `epicsDb`, `ensureEpicFeatureBranch`,
`EpicNotInProjectError`, `nextEpicOrder`, `moveTaskInEpic`. The task-creation
REST body loses `epic_id`/`epic_order` — **a breaking API change** with no UI
caller (verified: nothing in `src/` passes them); external REST users create
tickets through the epic route instead.

`createEpicCompletionPR`, `getTaskEpicBranch` and the post-merge
feature-branch fetch stay epic-side or become parameterized exactly as
`worktree.ts` already models (`base !== mainBranch` → fetch), reading tickets
through the task API.

### The PR reviewer

Stays an **epic agent** — a ticket is the same task whether or not a reviewer
ever visits it, and its stage list never varies. What changes is how it
enters the worktree: the epic adapter validates `ticket_task_id` membership
and resolves that ticket's worktree as the conversation cwd. The epic layer
allows at most one `running` or resumably `blocked` `epic-pr-review` run per
epic. No occupancy pointer is written to the task. `merge_task` calls
`mergeTask()` — picking up the status-change notification and session cleanup
it silently skipped before v2.

### The MCP rule

Every bottega tool handler calls into the task/epic service APIs — no
`tasksDb`/`agentRunsDb`/`pendingAskUserQuestions` access from
`server/services/bottega/`. The inventory's per-tool call lists are the
checklist; the new facade functions above (`pendingQuestion`, `taskProgress`,
`mergeTask`, ticket listing via `epic_tickets`) cover every current raw read.

## The conversation runtime

Each domain registers an **owner adapter** at boot:

```ts
interface ConversationOwnerAdapter {
  kind: 'task' | 'epic';
  /** Owner + project of a conversation, for authz and channel routing. */
  resolve(conversationId: number): OwnerRef | null;
  /** The linked agent run, if any (each domain owns its runs table). */
  linkedRun(conversationId: number): OwnerRunRef | null;
  /** Reject a turn before provider setup when owner concurrency forbids it. */
  assertTurnCanStart(conversationId: number): void;
  /** Persist a user Stop before transport is aborted. */
  interruptLinkedRun(conversationId: number): OwnerRunRef | null;
  /** Mark a provider turn live; epic Stop resumes the same blocked row. */
  onTurnStarted(ctx: TurnStartContext): Promise<void>;
  /** Turn-end hook: run-status write, broadcasts, chaining/sequencing. */
  onTurnEnded(ctx: TurnEndContext): Promise<void>;
  /** Boot: fail orphaned running runs. */
  sweepOrphans(): void;
}
```

What this absorbs, site by site (from the inventory):

- `buildAgentRunCompletionHandler`'s `epicId != null` branch → the epic
  adapter's `onTurnEnded`; the task branch (status write → **emit
  `run-ended`** → chain → notify) → the task adapter's.
- `agentRunsDb.getByConversationId` (owner-blind reverse link) → per-adapter
  `linkedRun`; terminal provider failure and user interruption dispatch
  separately. A task Stop is terminal; an epic Stop is `blocked`, and the
  epic turn-start hook returns that same row to `running` on a message.
- `authorizeConversationAccess` (WS), `resolveConversationOwner` (REST),
  `getAllActiveStreamingSessions` → `resolve()`.
- The boot orphan sweep unions the adapters' `sweepOrphans()`.
- `withAtlasMcpServer` (task-only) / `withBottegaMcpServer` +
  `epicDocsWriteGate` + `epicDisallowedToolsForConversation` (epic-only)
  become adapter-provided hooks — the symmetric split already visible at
  `startConversation.ts:164-179` made uniform.
- The epic adapter exposes one provider-neutral tool catalog. Claude receives
  an in-process SDK adapter; Codex and OpenCode receive a per-turn authenticated
  loopback Streamable HTTP MCP endpoint.

WS message shapes, channels and the dual-emit (`taskId?` / `epicId?` on
`agent-run-updated`, `streaming-*`, `conversation-*`) are **unchanged** — the
adapters supply the channel key the emitters splice today.

## What does not change

Prompts and their operator overrides; tool names and catalogs; the epic
archive layout and the isolation principle; the bridge's queue/dedupe/caps
and the dormant-between-events model; stage flags and gates; UI routes and
WS contracts; the board; locked decisions 1–5 (v2 *implements* #4). The
`epic-pr-review` and `epic-orchestrator` conversations behave identically
from the model's point of view.

## Boundary enforcement

Structure, so the rules outlive this document:

- **Module layout**: new task facade + events under
  `server/services/tasks/`; every epic module (`epicOrchestrator/`,
  `epicBranch.ts`, `epicEvents.ts`, `epicAgentPrompts.ts`, `bottega/`,
  `epicDocsWriteGate.ts`, epic archive helpers out of `documentation.ts`)
  consolidates under `server/services/epics/`. `db.ts` splits by owner
  (`database/tasks.ts`, `database/epics.ts`, `database/conversations.ts`, …)
  so import rules can see the difference.
- **ESLint `no-restricted-imports`** (CI-enforced):
  - outside `server/services/epics/**` + the layer's REST adapters
    (`server/routes/epics.ts`, and `server/routes/webhooks.ts` since the
    delivery agent gave the epic layer an inbound GitHub half — see
    [`delivery.md`](./delivery.md)): importing from `server/services/epics/**`
    or `server/database/epics*` is an error;
  - inside `server/services/epics/**`: importing `server/database/tasks*` or
    task-internal modules (anything not exported from the task facade) is an
    error;
  - the runtime imports neither domain.
- **Tests**: the orchestration seam test keeps running the *real* guards over
  its tables (the lesson of the epic-4 stall: a stubbed guard hid the bug);
  a boundary test asserts the lint config covers every task-layer directory.

## Migration plan

Five steps, each an independently shippable PR that removes a coupling class
for good, ordered so behaviour changes land before schema changes. The live
DB is migrated by the existing conventions (guarded ALTERs, probe-guarded
table rebuilds with `countFkViolations` + row-count invariants, `init.sql`
updated in lockstep because `test/db-helper.ts` builds fixtures from it).
Rehearse every schema step against a copy of the live DB using the isolated
worktree recipe before merging.

### Step 1 — TaskEvents + the bridge subscriber
**Status: DONE.** `server/services/tasks/events.ts` +
`server/services/epics/taskEventSubscriber.ts`; `epicOrchestrator/` moved to
`server/services/epics/orchestrator/`; boot wiring in `initEpics()`
(`server/services/epics/index.ts`). `task-deleted` is emitted by
`deleteTaskCompletely`; `task-merged` lands with the `mergeTask()` facade in a
later step.
`server/services/tasks/events.ts`; replace the seven task-layer
`isOrchestratedTask`/`notifyOrchestrator`/`schedulePrReview` call sites
(`agentRunLifecycle` ×5, `askUserQuestion`, `agentRunner`, `notifications`)
with emissions; the epic subscriber implements the mapping table above.
`index.ts`'s boot wake and broadcaster registration move into an epic-layer
`initEpics()` the entrypoint calls.
**Done when:** no file outside `server/services/epics/` imports the bridge or
sequencing; the orchestration seam test passes with events; the notify-before-
chain ordering has an explicit test.

### Step 2 — `driver`
**Status: DONE.** Guarded ALTER placed after `widenAgentRunTypeCheck` (old
databases rebuild on their pre-driver shape first); the three policies key on
the run row's `driver`; `run-ended` carries it; the two semantic changes are
covered in `agentRunLifecycle.test.ts` and `notifications.test.ts`.
Guarded ALTER (`driver TEXT NOT NULL DEFAULT 'human'`); `startAgentRun`
accepts it; chaining inherits it; the three policies switch over;
`actorIsTechnicalOverride` and `isOrchestratedTaskNotification` are deleted.
**Done when:** the orchestrator's tools pass `driver: 'automation'` and the
two flagged semantic changes are covered by tests.

### Step 3 — `tasks.base_branch`
**Status: DONE.** `resolveBaseBranch` lives in
`server/services/tasks/baseBranch.ts`; ticket creation/ordering in
`server/services/epics/ticketService.ts` (+ `POST /epics/:id/tasks`);
`epicBranch.ts` moved under `server/services/epics/` with only the epic's own
lifecycle left; the webhook answers a sync conflict with 200 `blocked`.
Membership still rides on `tasks.epic_id`/`epic_order` behind the transitional
`tasksDb.attachToEpic` until step 5.
Guarded ALTER; backfill `UPDATE tasks SET base_branch = (SELECT
feature_branch FROM epics WHERE epics.id = tasks.epic_id) WHERE epic_id IS
NOT NULL`; `resolveBaseBranch` moves into the task layer; ticket creation
moves to the epic-layer service + `POST /epics/:id/tasks`; `taskService`,
`prService`, `agentRunner` and the three task routes drop their `epicBranch`
imports; auto-sync keys on `base_branch IS NOT NULL`. The webhook route gains
the missing `BaseSyncConflictError` handler (pre-existing bug).
**Done when:** `epicBranch.ts` has no caller outside `server/services/epics/`.

### Step 4 — task-local and epic-local concurrency
**Status: REPLACED (2026-08-25).** The transient worktree lease was removed:
its liveness depended on an in-memory stream, it was inactive after Stop, and
it made task state represent an epic implementation detail. A guarded
migration drops `tasks.worktree_lease_conversation_id` from existing installs.

`startAgentRun` now enforces one running task run at the task-domain entry
point. The webhook and chain preflight the same query. Separately,
`startEpicAgentRun` enforces one `running` or `blocked` PR reviewer per epic
from `epic_agent_runs`. No task-layer code reads `ticket_task_id` or knows
that epics exist.

### Step 5 — the table split
**Status: DONE.** `splitOwnerTables` in `db.ts` (probe: `conversations`
schema contains `owner_kind` — the new tables' existence proves nothing,
because `init.sql` lays empty shells down before migrations run; the split
drops the shells and refuses if one holds rows). Every legacy epic-era
migration is gated on the same probe. `db.ts` is split into
`database/{connection,tasks,epics,conversations}.ts`; `conversations` link
rows are created inside the same transaction as the base row; the owner-
adapter registry (`services/conversation/ownerAdapters.ts`) is wired by
`initTasks()`/`initEpics()` from `server/index.ts`; the boundary lint zones
are live in `eslint.config.ts` and `server/test/boundary.test.ts` keeps them
in sync with the task-layer directory; rehearsed against a `.backup` copy of
the live DB (row counts preserved, no new FK violations, idempotent re-run).
`epic_agent_runs` (rows copied from `task_agent_runs WHERE epic_id IS NOT
NULL`, ids preserved), `task_agent_runs` rebuilt (drop `epic_id`/
`ticket_task_id`, narrow the CHECK — retiring `widenAgentRunTypeCheck`'s
probe in favour of per-table type lists), `task_conversations`/
`epic_conversations` backfilled from the owner columns, `conversations`
rebuilt without them (+ `owner_kind`), `epic_tickets` backfilled from
`tasks.epic_id`/`epic_order`, `tasks` rebuilt without the epic columns.
Owner-adapter registry in the runtime; `db.ts` split; boundary lint turned
on; shared types split (`TaskAgentRunRow` / `EpicAgentRunRow`; `TaskRow`
loses `epic_id`/`epic_order`; the epic ticket-list response becomes
`{position, …TaskRow}` — the only frontend reads of `epic_order` are the
orchestration panel and the tickets section, six sites).
Explicit-delete semantics: the epic delete service removes its conversations
(base rows included) and memberships itself — no longer implied by FKs on a
shared table. Retire or guard `scripts/data-migrations/drop-custom-agents.ts`,
whose stale `conversations` rebuild predates even v1.
**Done when:** the lint boundary is green, `AnyAgentType` survives only in
the WS message vocabulary, and a fresh install and a migrated live copy pass
the full suite identically.

## Risks and open edges

- **The `tasks` and `conversations` rebuilds are the highest-stakes
  migrations** this codebase has run (every FK in the system points at one of
  them). The rebuild convention (FK off → explicit column copy → invariant
  checks → throw on regression) exists and is tested; rehearse on a live-DB
  copy first, and land step 5 alone, not with behaviour changes.
- **Run-id preservation** matters only within each table's own consumers
  after the split; the copy keeps ids so open pages and historical links
  survive the deploy.
- **External REST consumers** lose `epic_id` on task
  creation — announce, and point at `POST /epics/:id/tasks`.
- **Fixture churn**: 31 test files construct rows with the old columns; the
  db-helper gains the new tables from `init.sql` automatically, but per-file
  fixture edits are part of step 5's cost.
- An epic being **actively orchestrated during a step-5 deploy** is safe by
  the same mechanism as any deploy (runs orphan-swept, boot wake re-reads
  state) — but schedule it while no epic is mid-ticket anyway.

## Key files (as of the design; updated per step)

- The design was derived from three exhaustive code inventories taken on
  2026-08-23 (every task→epic call site; the epic→task API surface + the
  event catalogue; the schema and its readers down to the frontend). Their
  load-bearing findings are the tables above; re-derive with fresh greps
  before each step rather than trusting stale line numbers.
- `server/services/tasks/` — the facade + events (new, step 1–4).
- `server/services/epics/` — the consolidated epic domain (steps 1–5).
- `server/services/runningAgents.ts` — deleted in step 4.
- `server/database/init.sql`, `db.ts` — the schema steps.
- `docs/epics/*.md` — each step updates the affected docs; this file is the
  map of what moved where.
