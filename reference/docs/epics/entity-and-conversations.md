# Epics — the entity, epic-scoped conversations, and the architecture stage

An **epic** is a large feature developed through a staged pipeline:
architecture document → technical specification → story split → specification
review → orchestrated implementation. This document covers the entity, the
machinery that lets a conversation belong to an epic instead of a task, and the
first stage.

## The entity

`epics` (`server/database/init.sql`) is project-scoped and holds container
lifecycle only: `status` (`active|completed|cancelled`), four **stage flags** —
`architecture_complete`, `specs_complete`, `stories_complete`,
`review_complete` (see [`spec-review.md`](./spec-review.md)) — and the
orchestration flags the last stage runs on (`orchestration_active`,
`orchestration_blocked`, `orchestration_blocked_reason`; see
[`orchestrator.md`](./orchestrator.md)). The
current stage is the first incomplete flag, and every stage stays independently
re-runnable (the task workflow-flag pattern). `slug` is stamped at creation
(`slugifyEpicName`, `shared/utils/slug.ts`) so the Phase-3 feature branch
`epic/{id}-{slug}` is deterministic and survives a rename.

Tickets join an epic through the `epic_tickets` link table (`epic_id`,
`task_id` UNIQUE, `position` — the orchestrator's execution order). Deleting
an epic deletes only the link rows: a ticket's worktree and PR outlive the
container. The `tasks` table itself knows nothing about epics.

`epicsDb`/`epicTicketsDb`/`epicAgentRunsDb` (`server/database/epics.ts` —
importable only by the epic layer, the boundary lint enforces it) are the
only places that touch this SQL.
(An `epic_artifacts` table used to hold the v1 BEFORE/AFTER mermaid pair; it is
gone from `init.sql` and never created any more, but — like `epic_runs` — is
never dropped from an existing database.)

## Conversations are task- OR epic-scoped

`conversations.task_id` used to be `NOT NULL`, which is exactly why the v0 Epic
Planning spike ran *outside* the conversation machinery. Since the
architecture-v2 split ([`architecture-v2.md`](./architecture-v2.md)) the base
row carries **no owner FK at all** — just `owner_kind` (`'task'|'epic'`), the
dispatch tag. Ownership lives in the `task_conversations` /
`epic_conversations` link tables (one row per conversation, created in the
same transaction as the base row); `conversationsDb`'s queries LEFT JOIN them
so a returned `ConversationRow` still exposes derived `task_id`/`epic_id`.
Because nothing cascades from an owner to the base row any more, the owning
domain's delete service removes its conversations explicitly (transcript
purge, then `conversationsDb.delete`).

Agent runs are split the same way: `task_agent_runs` (task runs, the six task
types) and `epic_agent_runs` (epic runs, the `epic-*` types — each table with
its own narrow `agent_type` CHECK; SQLite cannot alter a CHECK in place, so
adding one means a rebuild, `widenEpicAgentRunTypeCheck`). Everything conversation-keyed —
abort, resume, the completion handler, the boot orphan sweep — dispatches
through the **owner-adapter registry**
(`server/services/conversation/ownerAdapters.ts`): each domain registers an
adapter at boot (`initTasks()`/`initEpics()` from `server/index.ts`) and the
conversation runtime, which imports neither domain, asks the adapter for
scope/cwd, the linked run, user-interruption and turn-start/turn-end handling,
question parking, orphan sweeping, MCP injection and provider gating.
`epic_agent_runs` also carries
`ticket_task_id`: which ticket an `epic-orchestrator` run supervises or an
`epic-pr-review` run reviews, distinct from the owner (the run belongs to the
*epic*), and what lets a resume rebuild the same context.

**Scope resolution happens once**, in
`resolveConversationScope` (`server/services/conversation/conversationScope.ts`),
which dispatches to the owner adapter: a task resolves to its worktree
(falling back to the repo checkout), an epic resolves to the project's
**main checkout** — framing has no worktree. Two exceptions, both because the
conversation changes a branch: an epic PR-review run resolves to its reviewed
ticket's worktree (validated through `epicTicketsDb.epicOf`), and an
`epic-delivery` run to the epic's own delivery worktree
([`delivery.md`](./delivery.md)).
`startConversation` takes a `ConversationTarget` (`{kind:'task'|'epic'}`) rather
than a task id; `sendMessage` derives the target from the row. The epic adapter's
provider gate is a no-op: epic conversations and every epic agent run on
Claude Code, Codex or OpenCode. Owner tools are defined once and adapted to the
selected harness at the conversation boundary.

## The epic WS channel

`subscribe-epic` / `unsubscribe-epic` mirror the task channel:
`makeBroadcastToEpicSubscribers` (`server/websocket/dispatch.ts:155`) fans out
`agent-run-updated`, `epic-updated` (the row's own status + stage flags),
`conversation-added`, `conversation-name-updated` and the streaming start/end
events to open epic pages. **Transcripts still flow on the
conversation channel** — an epic conversation is a normal conversation, so the
chat page needs nothing epic-specific. The v0 `epic-run-*` channel (digested log
lines + a bespoke live view) is gone: the stage's conversation IS its live view.

## The archive — and the isolation principle

Epic documents live **outside the repo**, in
`~/.bottega/projects/{projectId}/epics/epic-{epicId}/`, with `spec/` (the
uploaded functional spec), `architecture/` (the architecture document the
architecture stage writes), `docs/` (the technical-specification set the
specification stage writes), `review/` (the specification review's report) and
`orchestrator/` (the implementation stage's own outcome notes). Each writing
stage may only write into its own directory — the review, whose job is the
consistency of every level, into `spec/`, `architecture/` and `docs/` too —
`getEpicStageWritableDirs` (`server/services/epics/epicArchive.ts`) is the one map
the write gate and the context prompt both read. This is deliberate:
a ticket worktree must never carry the epic's big picture, so ticket-level agents
can only ever see what a ticket description hands them (an extract, or an
explicit path to one document).

`buildEpicContextPrompt` (`server/services/epics/epicArchive.ts`) is the
epic-scoped counterpart of `buildContextPrompt` — it hands the agent the
authoritative absolute paths plus a must-read spec list, and says nothing about
tickets. `buildContextPrompt` (tasks) is untouched.

## The architecture stage

`startEpicAgentRun(epicId, agentType, opts)` (`server/services/epics/epicAgentRunner.ts`)
is the epic counterpart of `startAgentRun`, and the entry point every later
stage plugs into. Differences from the task path, all deliberate: the run and
conversation are epic-scoped, the cwd is the main checkout, there is no workflow
run counter and no task status to flip, and **nothing chains afterwards** — a
stage is started on purpose (by the user now, by the orchestrator in Phase 7).

The architecture agent runs the `epic-architecture` prompt
(`server/constants/prompts/epic-architecture.md`, rendered by
`generateEpicArchitectureMessage` with the spec files, the architecture directory
and its current contents as absolute paths). Its deliverable is an
**architecture document**: the epic split into a few coherent topics and, per
topic, a short text (what changes, the key decisions), a mermaid diagram of
whatever type fits (system, component, sequence, data-flow — the model's
choice) and, only when targeted, a code block (a schema migration, pseudocode
for critical logic). The prompt is deliberately a short statement of intent —
the model decides the topics and their number — and the document is written in
the language of the functional specification.

It is a **file-writing stage**, configured exactly like the specification stage:
native writers are denied, Bash remains available for read-only investigation,
and archive writes use the provider-neutral document tools. Those tools confine
every write to `architecture/` regardless of harness. One `architecture.md` is
the normal shape; the model may split into several ordered files.

Nothing is harvested from the transcript and nothing flips the flag on write.
The agent writes first (no interrogation rounds — `ask_user` is for a
genuine blocker only), recaps in chat, and every follow-up message is a
revision edited in place. When the user approves, it calls
`mark_stage_complete({ stage: 'architecture' })`, which sets
`architecture_complete` and broadcasts `epic-updated` — the human "Mark
complete" button remains as the backstop. The document is the whole hand-off:
the specification stage reads it by path (see
[`technical-specification.md`](./technical-specification.md)), and nothing
from the architecture conversation travels beside it.

The v1 contract — exactly two ```mermaid blocks, BEFORE then AFTER, harvested
into `epic_artifacts` — was retired on 2026-08-22: one whole-system diagram
cannot hold an epic that touches several dashboards at once.

## REST surface

Item routes are flat, collections hang off the project
(`server/routes/epics.ts`, mounted at `/api`):

| Route | Notes |
|---|---|
| `POST /projects/:projectId/epics` | multipart (`name` + spec `files`); **starts no agent** |
| `GET /projects/:projectId/epics` | newest first |
| `GET/PATCH/DELETE /epics/:id` | delete purges transcripts, cascades rows, detaches tickets, removes the archive |
| `GET/POST/DELETE /epics/:id/spec-files[/:filename]` | the uploaded functional spec |
| `GET /epics/:id/architecture[/:filename]` | the architecture document file(s), sorted by name (basename-only reads) |
| `GET /epics/:id/docs[/:filename]` | technical-spec documents (basename-only reads) |
| `GET /epics/:id/review[/:filename]` | the specification review report (basename-only reads) |
| `GET /epics/:id/tasks` | the epic's tickets in execution order |
| `GET/POST /epics/:id/conversations` | manual epic chat (zod-narrowed to anthropic) |
| `GET/POST /epics/:id/agent-runs` | one generic start endpoint; `checkStageGate` answers 409 for a stage that isn't reachable yet (architecture: always open; specification: needs `architecture_complete`; stories: needs `specs_complete`; spec-review: needs `stories_complete`; `epic-delivery`: no stage flag at all, only a `feature_branch`). It refuses `epic-orchestrator` outright — that stage runs one conversation per ticket and is entered through its own endpoint |
| `POST /epics/:id/stages/:stage/complete` | the human "Mark stage complete" backstop; one-way, 409 when already set |
| `POST /epics/:id/orchestrator/{start,pause,resume}` | enter, halt and release autonomous implementation; all three answer the updated row. `start` needs `review_complete` on top of `stories_complete` |

Auth is the usual 404-not-403 membership check. A stage already running answers
`409` with the running run; missing model settings `409`; missing Claude
credentials `403` with `PROVIDER_CREDENTIALS_MISSING`.

## Model settings

The v0 single `epic` model key is replaced by one per epic agent —
`epic-architecture`, `epic-specification`, `epic-stories`, `epic-orchestrator`,
`epic-pr-review`, `epic-spec-review`, and `epic-delivery` (which needs its own
because the GitHub webhook starts it with no human present to pick a model) —
all selectable between the connected providers, surfaced in
Settings → Agent Models. Every key lands at once because the loader fails loud
on a missing key: `backfillEpicStageModelKeys` (`server/database/db.ts`) carries
a user's old `epic` choice into `epic-architecture`, seeds the others to
Opus as defaults, and drops the stale key.

## Migrating from the v0 spike

`epic_runs` rows are folded into real epics exactly once by
`convertEpicRunsToEpics` (`server/database/epicConversion.ts`, sentinel
`app_settings['epic_runs_converted']`): one epic per `(project, name)`,
`architecture_complete` set when any run produced a complete diagram pair, spec
files written into the archive. The v0 diagrams themselves are not carried over
(the stage writes a document now); they stay readable in the legacy table,
which is left in place — dead, never written again, never dropped.

The `conversations` rebuild is the riskiest step in the phase: it is a *parent*
table (`task_agent_runs.conversation_id … ON DELETE SET NULL`), so a naive
`DROP TABLE` with foreign keys on would null out every run→conversation link.
The migration follows the SQLite 12-step procedure with `foreign_keys=OFF`,
copies an **explicit column list** (ALTER-added columns sit at different ordinal
positions on migrated vs fresh databases), and asserts afterwards that the row
counts, the link count and the FK-violation count are unchanged.
`server/database/epicMigration.test.ts` runs the real migration against a
seeded old-shape database and is the regression net for all of that.

## Frontend

- `/projects/:projectId/epics` — the project board with its **Epics tab** active.
- `/projects/:projectId/epics/new` — `EpicNewPage`: name + spec upload.
- `/projects/:projectId/epics/:epicId` — `EpicDetailPage`: the stage rail,
  diagrams, documents, tickets, spec files.
- `/projects/:projectId/epics/:epicId/chat/:conversationId` — `EpicChatPage`:
  `ChatInterface` with `selectedTask={null}`.

`useEpicEvents` subscribes to the epic channel; a 10s poll backstops a dropped
socket while a stage is running. The whole surface is [`ui.md`](./ui.md).

## Key files

- `server/database/init.sql` — `epics`, `epic_tickets`, `epic_agent_runs`, the link tables.
- `server/database/epics.ts` — `epicsDb`/`epicTicketsDb`/`epicAgentRunsDb` (epic-layer-only).
- `server/database/db.ts` — the rebuilds + backfills in `runMigrations`; `splitOwnerTables`.
- `server/database/epicConversion.ts` — the one-shot v0 conversion.
- `server/services/conversation/ownerAdapters.ts` — the registry the runtime dispatches through.
- `server/services/epics/adapter.ts` — the epic owner adapter; `server/services/epics/index.ts` — `initEpics`.
- `server/services/conversation/conversationScope.ts` — `resolveConversationScope`.
- `server/services/epics/epicAgentRunner.ts` — `startEpicAgentRun`; `getRunningAgentForEpic` below it.
- `server/services/epics/epicDocsWriteGate.ts` — the per-stage write containment.
- `server/services/epics/epicArchive.ts` — `buildEpicContextPrompt`, `getEpicStageWritableDirs` + the epic archive helpers.
- `server/constants/prompts/epic-architecture.md` — the architecture stage's prompt.
- `server/routes/epics.ts` — the REST surface; `:485` the per-stage gates.
- `server/websocket/dispatch.ts:155` — the epic channel broadcaster.

## The stages after architecture

The technical-specification stage — and the in-process `bottega` MCP server that
every later epic agent acts on Bottega through — is
[`technical-specification.md`](./technical-specification.md). The stories stage,
which turns that specification into the epic's tickets, is
[`stories.md`](./stories.md). The specification review that gates everything
the three produced before implementation is [`spec-review.md`](./spec-review.md).
The orchestrator that then drives every ticket to merge is
[`orchestrator.md`](./orchestrator.md). What happens after the last ticket
merges — the epic's own pull request, and the agent that lands it — is
[`delivery.md`](./delivery.md).

## Where an epic's tickets live

The `epic_tickets` row is only half the story: the tickets themselves develop on the
epic's feature branch, `epic/{id}-{slug}`, and the branch lifecycle — plus the
base-branch threading through worktree creation, sync, PRs and merges — is
[`feature-branch.md`](./feature-branch.md).
