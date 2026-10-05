# Extra — Epics

## What it adds

A layer **on top of tasks** for features too large for one task. An epic takes
an uploaded functional specification through a staged pipeline. Four
conversational *framing* stages turn it into an architecture document, a
technical specification, an ordered list of tickets, and a consistency review.
Then an **orchestrator** agent drives each ticket — an ordinary Bottega task —
through the normal task pipeline, one after the other, on a shared feature
branch, and a dedicated **PR reviewer** agent reviews, fixes and merges each
ticket's pull request. Finally the whole feature is tested (QA) and landed
through one final pull request that a human merges.

```
functional spec (uploaded)
        │
        ▼
architecture ─▶ specification ─▶ stories ─▶ spec review    FRAMING
 (document)      (documents)     (tickets)    (gate)       one conversation
                                                 │         each, user-approved
                                                 ▼
┌─ IMPLEMENTATION: the orchestrator, one ticket at a time, in order ────────┐
│ plan ─▶ implement ⇄ review ─▶ PR ─▶ PR reviewer: review, fix, CI, merge   │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │ all tickets merged into epic/{id}-{slug}
                                      ▼
final PR opened ─▶ QA + delivery on the feature branch ─▶ a human merges it
```

The human is present for framing, on escalation, and for the final merge.

## Why it's an extra (not core)

Core does one thing: several agents collaborating on **one task**. How a large
feature is decomposed, specified and delivered is opinion — spec-first,
strictly sequential tickets, an agent standing in for the tech lead. Remove
this extra and the task layer is unchanged, by construction: it never imports
it. Epics do rely on three small, epic-agnostic seams in the task layer (a base
branch, a run `driver`, an event stream) that any automation could reuse.

## The design rule: tasks agnostic, epics on top

1. **The task layer imports nothing from the epic layer.** No `epic_id` on a
   task, no "is this an epic ticket?" branch anywhere below.
2. **The epic layer acts on tasks only through the task service API** — the
   same functions the REST routes call when a human clicks
   ([`../reference/server/services/tasks/index.ts`](../reference/server/services/tasks/index.ts)).
   Agent tools are one adapter over that API, REST is the other.
3. **The task layer publishes domain events to nobody in particular**; the
   epic layer subscribes. A task never knows whether anyone listens.

**One API down, one event stream up, nothing else.** Rule 3 exists because a
tool call is request/response *from* an agent, and the orchestrator is asleep
while a ticket is worked — something server-side has to wake it.

Why so strict: every place where task code asks about epics is a place where a
change for one layer silently breaks the other — for example a "one agent per
task" guard that counts a supervising epic run as occupancy, so the supervisor
deadlocks against itself the moment it starts a ticket agent. Separate run
tables and separate guards make that class of bug unrepresentable.

The three task-layer seams:

- **`tasks.base_branch`** — the branch a task forks from and opens its PR
  into; NULL means the repo default. The epic layer passes its feature branch
  at creation. `resolveBaseBranch` is the single answer every git path reads.
- **`driver` on a task agent run** (`human` | `automation`), inherited by
  chained runs. Policy, not identity: an automation-driven run uses the
  technical planning prompt, does **not** auto-chain out of planning (its
  driver reviews the plan first), and sends no push notification at turn end.
- **Task events** — an in-process, synchronous, ordered emitter
  ([`events.ts`](../reference/server/services/tasks/events.ts)): `run-ended`,
  `question-parked`, `workflow-blocked`, `chain-start-failed`, `task-merged`,
  `task-deleted`, `worktree-state-changed`. `run-ended` fires after the run's
  terminal status write and **before** any chaining decision, so a subscriber
  always sees a turn end before the next agent starts. Subscriber errors are
  caught; a listener can never fail a turn.

The boundary is enforced, not conventional: lint import zones in
[`eslint.config.ts`](../reference/eslint.config.ts), kept honest by
[`boundary.test.ts`](../reference/server/test/boundary.test.ts).

## Data model

All in [`init.sql`](../reference/server/database/init.sql).

- **`epics`** — project-scoped. `status`, a `slug` stamped at creation (so the
  branch name survives a rename), five one-way **stage flags**
  (`architecture_complete`, `specs_complete`, `stories_complete`,
  `review_complete`, `qa_complete`), `feature_branch`, and the orchestration
  state: `orchestration_active`, `orchestration_blocked`,
  `orchestration_blocked_reason`.
- **`epic_tickets`** (`epic_id`, `task_id` UNIQUE, `position`) — membership and
  execution order live in the epic layer. Deleting an epic deletes memberships,
  never tasks: a ticket's worktree and PR outlive the container.
- **`epic_agent_runs`** — separate from `task_agent_runs`, with its own
  agent-type list. `ticket_task_id` records the ticket a run is *about* (the
  orchestrator supervises it, the reviewer reviews it) and is what lets a
  resume rebuild the same context.
- **Conversations are owner-less.** The base row carries only an `owner_kind`
  tag; `task_conversations` / `epic_conversations` link tables hold ownership.
  The conversation runtime imports neither domain and asks an **owner
  adapter**, registered by each domain at boot, for everything owner-specific:
  cwd, linked run, turn hooks, Stop semantics, orphan sweep, tool injection
  (`epicOwnerAdapter` in
  [`adapter.ts`](../reference/server/services/epics/adapter.ts)). An epic
  conversation is thus a normal conversation; the chat UI needs nothing new.

**The archive, and the isolation principle.** An epic's documents live
*outside the repo*, under
`~/.bottega/projects/{projectId}/epics/epic-{epicId}/`: `spec/` (the upload),
`architecture/`, `docs/` (the technical specification), `review/`, `qa/` and
`orchestrator/outcomes/`. A ticket worktree never carries the epic's big
picture: a ticket-level agent sees only what its ticket document hands it — an
extract, or an explicit path to one document. That keeps ticket agents and
their prompts untouched by this extra, and is why `docs/` holds nothing but the
specification (no ticket list, no review, no narrative).

## Stages: started on purpose, signed off by the user, forward-only

`startEpicAgentRun(epicId, agentType, options)`
([`epicAgentRunner.ts`](../reference/server/services/epics/epicAgentRunner.ts))
is the epic counterpart of `startAgentRun`: it creates an `epic_agent_runs` row
and an epic-scoped conversation, resolves the acting user's model for that
agent type, and runs in the project's **main checkout** (framing has no
worktree). Unlike the task loop, **nothing chains** — every stage is started
deliberately.

- **Gates.** A stage opens when its predecessor's flag is set (`checkStageGate`
  in [`routes/epics.ts`](../reference/server/routes/epics.ts); `409` otherwise),
  and a start is refused while another agent of the epic is running.
- **Sign-off is the user's word.** The agent calls
  `mark_stage_complete({ stage })` only after explicit approval in chat (the
  stage must be its own, have a flag, and not be set). A tool rather than only
  a button, so the approval stays in the transcript that produced it; a "Mark
  complete" button remains as the human backstop, sharing one stage↔flag map
  ([`epicStages.ts`](../reference/server/services/epics/epicStages.ts)).
- **Two facts per stage, never conflated**: the latest run's status (what the
  machinery did) and the flag (what the user approved). A `completed` run with
  no flag is the normal state while the user is still reading.
- **The output is the whole hand-off.** Only files and tickets travel between
  stages — never the conversation, and there is deliberately no "summary for
  the next stage" argument: a second channel beside the documents gives an
  agent somewhere to put what it left out of them.
- **Forward-only.** Flags never clear. Once a stage is approved the user never
  reopens its conversation or edits a document by hand; a problem found later
  is fixed where it is found (see the spec review) — the alternative is
  relaying findings between conversations by hand. Stages stay re-runnable: a
  re-run is a new conversation that lists the existing output. The documents
  are the state; the transcript is only how they got there.

**Write containment.** Framing agents run in the user's real checkout, so
native file writers are denied and documents are written through
`write_epic_document` / `edit_epic_document`, which confine every path to the
directories that stage owns. `getEpicStageWritableDirs`
([`epicArchive.ts`](../reference/server/services/epics/epicArchive.ts)) is the
one map both the tools and the context prompt (`buildEpicContextPrompt`) read,
so what an agent is told and what it is allowed cannot disagree. The shell
stays **on**, read-only by prompt: denying it blocked reading git history and
pull requests, and sub-agents inherit denials, so delegation did not help.

**The tool channel.** Each agent type gets exactly the verbs it may use
(`toolsFor` in
[`mcpServer.ts`](../reference/server/services/epics/bottega/mcpServer.ts)),
defined once and adapted to whichever harness runs the turn. The catalog and
the tool denials are re-derived from the conversation's own rows on **every**
turn
([`bottegaInjection.ts`](../reference/server/services/epics/bottegaInjection.ts),
`epicDisallowedToolsForConversation`), so a resume weeks later has the first
turn's surface. Handlers never throw: a refusal is a `fail()` result saying
what went wrong and what to do instead.

## The four framing stages

Prompts are `epic-*.md` in [`prompts/`](../reference/server/constants/prompts);
[`epicAgentPrompts.ts`](../reference/server/services/epics/epicAgentPrompts.ts)
builds each opening message, listing its inputs as absolute paths.

1. **Architecture** (`epic-architecture`, always open). Writes first, with no
   interrogation round: the epic split into a few topics, each a short text, a
   mermaid diagram and, only where targeted, a code block. The user reacts;
   every follow-up is a revision edited in place.
2. **Technical specification** (`epic-specification`). Interrogates the user,
   explores the repo, writes `00-master.md` (a map) plus `NN-topic.md`
   sub-documents. Held to two criteria because its readers are agents that see
   nothing else and cannot ask: **no open questions** (every fork taken, or
   explicitly out of scope) and **entirely self-contained** ("if you would tell
   the next agent something in chat, it belongs in the documents").
3. **Stories** (`epic-stories`). Agrees a split in chat, *then* creates tickets
   with `create_task` / `list_epic_tasks` / `update_task` / `delete_task`
   ([`story.ts`](../reference/server/services/epics/bottega/tools/story.ts)).
   Creation order is execution order. **The ticket list is the state** — there
   is no stories document to drift. Each description must stand alone (goal,
   context, scope, out of scope, dependencies, acceptance criteria) and points
   at specification sections rather than summarizing them. Two guards: a
   ticket is revisable only while `pending` with no agent runs, and the list
   closes for additions once any ticket has started.
4. **Specification review** (`epic-spec-review`) — the gate before autonomy.
   A consistency-and-completeness check, not a design review: a finding is a
   contradiction, a gap, an error against the code, or an open question; each
   is blocking or advisory. The conversation has four parts: review everything
   and **stop**; settle each finding with the user; **apply the approved fixes
   itself, at every level** (functional spec, architecture, specification,
   tickets); sign off on the user's go-ahead. It is the one agent whose write
   surface spans all levels, because stages are forward-only.

Why the review exists: the stages are isolated conversations joined only by
files, which is exactly how gaps appear — and downstream nothing catches them.
Implementing agents cannot ask, and treat the specification as truth, so a
contradiction is settled by a guess that a human first sees in a pull request.

## The feature branch

Every epic develops on one integration branch, `epic/{id}-{slug}`
([`epicBranch.ts`](../reference/server/services/epics/epicBranch.ts)).

- `createEpicTicket`
  ([`ticketService.ts`](../reference/server/services/epics/ticketService.ts)),
  shared by the stories tool and `POST /epics/:id/tasks`, runs
  `ensureEpicFeatureBranch` **first**, then the task layer's normal creation
  with `baseBranch` set, then records membership and position. An
  agent-created ticket is byte-for-byte a human-created task.
- `ensureEpicFeatureBranch` is idempotent and serialized per epic; a push
  failure degrades to a warning (the PR step fails loudly later if it matters).
- A ticket's worktree forks from the feature branch and its PR targets it, so
  each ticket builds on everything merged before it and review stays
  ticket-sized.
- **Auto-sync.** A task with a base branch merges it into a clean worktree
  before a loop-entry agent starts (planning, PR, YOLO — `autoSyncWithBase` in
  [`agentRunner.ts`](../reference/server/services/agentRunner.ts)). Never
  mid-loop: that would rewrite files an agent is reasoning about. A conflict
  aborts the merge, blocks the task and emits `workflow-blocked`.
- The epic ends with **one final PR** from the feature branch into the default
  branch (`createEpicCompletionPR`), which only a human merges.

## Autonomous implementation

`POST /epics/:id/orchestrator/start` requires `stories_complete`,
`review_complete`, at least one unmerged ticket and no epic agent running. It
sets `orchestration_active` and hands over to the sequencer.

### The orchestrator is a drop-in for the human

Every verb in its catalog
([`ticketSupervision.ts`](../reference/server/services/epics/bottega/tools/ticketSupervision.ts),
[`orchestrator.ts`](../reference/server/services/epics/bottega/tools/orchestrator.ts))
wraps the exact service the UI calls: `start_planification` and
`approve_plan_and_start_implementation` are `startAgentRun` with
`driver: 'automation'`; `answer_question` is the question widget's resolver;
`send_feedback_to_planification` is a plain chat message; `resume_ticket` is
the Resume button plus a note. Ticket-level agents therefore experience nothing
new and cannot tell who is on the other side — which is what lets their prompts
stay untouched. Every tool validates that the task belongs to this epic.

Per ticket, the prompt is a procedure: start planning; answer its questions
from the specification (never "up to you"); review the plan (at most three
feedback rounds); approve; then **silence** while implementation ⇄ review → PR
chains itself. It never writes code and never merges.

It carries the full tool surface, shell included: most stoppages are an
environment to repair or a claim to disprove, and a supervisor with no hands
can only stop the epic. Containment is by prompt (its cwd is the main checkout;
it never writes there). `read_agent_transcript` lets it read why a run stopped
before retrying.

### Dormant between events

- **Nothing runs while a ticket is worked.** Each wake is one conversation
  turn; the agent acts, ends its turn, and its process exits. The model ending
  its turn is the mechanism, not an optimization.
- **One run and conversation per ticket**, so ten tickets of supervision never
  share one context window.
- **Orchestration is a durable epic flag, not a run status** — a dormant run
  reads `completed` most of the time.

**Waking it** means resuming its conversation with a message, the ordinary
follow-up-chat path
([`bridge.ts`](../reference/server/services/epics/orchestrator/bridge.ts)).
Events render as `[bottega-event]` blocks: a header (`type`, `task`, `agent`,
`run`, `status`), a `flags:` line read fresh from the ticket at send time, an
optional payload and one closing instruction. The subscriber
([`taskEventSubscriber.ts`](../reference/server/services/epics/taskEventSubscriber.ts))
first checks the task is a ticket of an actively orchestrated epic
(`supervisedEpicOf`), then translates:

| Task event | Result |
|---|---|
| `run-ended`, planning, any outcome | wake: `planification-turn-ended` |
| `run-ended`, PR agent, completed | no wake — hand the PR to the reviewer |
| `run-ended`, PR agent, failed (or no PR to hand over) | wake: `pr-turn-ended` |
| `run-ended`, implementation / review / refinement, failed | wake: `agent-run-failed` |
| the same, completed | silence — the task chain handles it itself |
| `question-parked` | wake: `question-pending`, with the questions |
| `workflow-blocked` (agent's own block, iteration cap) | wake: `task-blocked` |
| `workflow-blocked` (base sync conflict) | wake: `sync-failed` |
| `chain-start-failed` | wake: `chain-start-failed` |
| `worktree-state-changed` | wake: `worktree-setup-ended`, or re-sequence |
| `task-merged`, `task-deleted` | no wake — the sequencer re-evaluates |

Mid-chain successes stay silent on purpose: narrating them would wake the
orchestrator dozens of times per ticket for nothing.

**Queueing.** Events arrive while the orchestrator is mid-turn (its own tool
call started the run that just failed). A per-epic FIFO, deduplicated on
(task, type, run), holds them and delivers the batch as **one** message when
the turn ends (`flush`) — two concurrent resumes of one conversation would fork
the session. The queue is memory-only by design; see restarts below.

**Runaway caps.** Per supervising conversation: `MAX_WAKES` (40) and per-type
`EVENT_CAPS` (questions 8, plan turns 6, PR turns 6, review endings 3). A
breach blocks the epic exactly as an escalation does.

### Sequencing

[`sequencing.ts`](../reference/server/services/epics/orchestrator/sequencing.ts)
is deliberately dumb: it never decides work is finished, it reacts to the state
a merge left behind. `scheduleNextTicket` waits a one-second settle, then
`advance` re-reads everything: the next ticket is the first not `completed`
(`nextTicket`). If the current conversation is already on it, nothing happens —
idle is the resting state. Otherwise it starts a fresh orchestrator run for it
(waiting on a worktree still being set up; blocking the epic if setup failed).
Tickets run **strictly one at a time**: each assumes the previous ones merged.

When no ticket remains, `finishOrchestration` clears the flag, opens the final
PR server-side (an invariant, not a prompt convention) and notifies the user.
**The epic's status is not flipped** — the epic is done when a human merges.

### The PR reviewer

When a ticket's PR agent ends with a pull request open, `schedulePrReview`
starts an `epic-pr-review` run in a **fresh conversation** whose cwd is the
**ticket's worktree**. It is one long turn, not a dormant loop.

Why a separate agent: by PR time the orchestrator's context is full of
supervision noise, and review-by-feedback costs a full agent run plus a CI
cycle per finding. A reviewer that starts empty, holds the whole specification
and has a shell can verify and fix in place. Three decisions shape it:

1. **The specification is the source of truth.** A human approved it and the
   orchestrator approved the plan. Where code and specification disagree, the
   code is wrong. The reviewer never re-plans, never escalates a design
   question, and has no question tool — a parked question would hold the whole
   sequence for something the documents answer.
2. **It applies its own fixes**, in the worktree, in the same turn. There is no
   one to send feedback to. Scope is this ticket only.
3. **The CI loop is bounded** (polls, fix rounds, rebases); its single exit is
   `block_epic`, for infrastructure — never for the specification.

Its catalog is two tools
([`prReview.ts`](../reference/server/services/epics/bottega/tools/prReview.ts)).
`merge_task` is bound to its own ticket, re-checks live (PR open, no conflict,
CI neither failed nor pending, no unsaved work in the worktree), then calls the
task layer's `mergeTask` — the Merge button's own function, a small saga: record
the intent, merge on the remote, re-read an ambiguous answer, complete the task
atomically, emit `task-merged`, clean the worktree up as retryable housekeeping.

**Epic memory across tickets.** `merge_task` *requires* an `outcomeSummary`,
written to `orchestrator/outcomes/` before the merge. Each ticket gets fresh
conversations, so this is the only channel through which one ticket informs the
next; requiring it at merge time captures it when the reviewer has just read
the final code. The orchestrator's and reviewer's opening messages rebuild the
same memory per ticket: the ticket document, `00-master.md`, the live ticket
table and every earlier outcome note.

When the reviewer's turn ends (`onPrReviewTurnEnded`): merged → the sequencer
hops; not merged → the orchestrator is woken with `pr-review-ended` and may
start one fresh reviewer (`start_pr_review`), then must escalate.

### Blocking, pausing and restarts

- **One way to stop.** `block_epic` (either agent), a runaway cap, a failed
  worktree setup and the user's Pause all go through `blockOrchestration`
  ([`blocking.ts`](../reference/server/services/epics/orchestrator/blocking.ts)):
  set the flag and reason, broadcast, notify. From the user's side they are the
  same event — the epic stopped and needs them.
- **Escalate only after trying.** A ticket's block is a claim to test: the
  orchestrator diagnoses, repairs or overrules, and resumes the ticket. Its
  escalations are a question (one decision, answered in its conversation) and
  `block_epic` (stuck after trying). It never lowers the bar to keep moving.
- **A blocked epic drops every wake.** So an orchestrator that acts while
  blocked (the user chats with it and it restarts something) first lifts the
  block (`resumeOrchestration`); otherwise that run would fail unheard.
- **A user Stop is a resumable pause, not a failure.** The run becomes
  `blocked` and the epic is blocked *before* the transport is aborted, so the
  turn-end hook is inert. A message, or Resume, returns that exact run to
  `running`; the block is lifted only once the new turn is live. A technical
  failure stays `failed` and takes the recovery hooks.
- **Restarts self-heal.** After the boot orphan sweep and the merge
  reconciliation, `resumeOrchestrationAfterRestart`
  ([`index.ts`](../reference/server/services/epics/index.ts)) sends every
  active, unblocked epic a `server-restarted` wake: *you were interrupted,
  re-read the state.* A snapshot, not a replay — which is what makes the
  in-memory queue and counters safe to lose.

### Concurrency rules

- **Task layer:** one running agent per task, enforced inside `startAgentRun`.
  It knows nothing of epics; a supervising run lives in `epic_agent_runs` and
  can never trip it.
- **Epic layer:** neither the user nor the sequencer can start an epic agent
  while another is running (`getRunningAgentForEpic`; a `blocked` run still
  counts — it is resumable in place), and an epic has at most one
  running-or-blocked PR reviewer (`getActivePrReviewerForEpic`), checked
  synchronously next to the insert and again at turn start.
- One wake in flight per conversation, and every hop re-reads live state
  after its settle delay instead of trusting what the ending turn believed.

## Delivery

Landing the final PR — conflicts with a default branch that moved on, CI,
review comments — is done by `epic-delivery`. It is **an agent, not a stage**:
no flag, no sign-off, any number of runs, gated only on a feature branch
existing. It works in a dedicated **delivery worktree**
(`{repo}-worktrees/epic-{id}`, `ensureEpicDeliveryWorktree`) because the main
checkout's HEAD must never move under whoever is using it. It merges the
default branch *into* the feature branch (never a rebase — tickets forked from
it), never force-pushes, and **never merges the final PR**.

Two ways in: the epic page, and a GitHub `@`-mention on the final PR. The
webhook maps `epic/{id}-…` back to the epic (`parseEpicIdFromBranch`, disjoint
from the `task/` parser) and starts the same kind of run
([`deliveryWebhook.ts`](../reference/server/services/epics/deliveryWebhook.ts)).
Details: [`delivery.md`](../reference/docs/epics/delivery.md).

## QA

Ticket reviews check each change against its brief; nobody has clicked through
the whole feature. QA is two agents around one artifact, `qa/scenarios.csv`:

- **`epic-qa-scenarios`** — a gated stage (`qa_complete`, after the review)
  that derives a scenario book from the documents and tickets; the user
  approves it.
- **`epic-qa-execution`** — stage-less, any number of runs. It needs the
  approved book and every ticket merged, runs the app from the delivery
  worktree, and records `pass` / `fail` per row.

Neither edits CSV text: structured tools own the serialization, so a malformed
book is impossible and results are durable per batch. That makes execution
resumable — a deterministic turn-end loop
([`qaLoop.ts`](../reference/server/services/epics/qaLoop.ts)) starts a fresh
run while rows remain, and stops when the book is full, a run records nothing
new, or a cap is hit. An optional `epic-qa-fix` mission turns failures into one
fix ticket and supervises it with the orchestrator's own verbs over the same
event bridge. Details: [`qa.md`](../reference/docs/epics/qa.md).

## UI, in one paragraph

A `Tasks | Epics` toggle on the project board; a creation page (name + spec
files); an epic page with a **Main** tab (Framing rail, Implementation with the
tickets in execution order and Start / Pause / Resume, Delivery, QA) and an
**Artifacts** tab (read-only browsers over the archive, mermaid rendered).
There is deliberately no live feed for orchestration — a spinner would lie for
hours — so the page renders the durable state and the blocked banner. Liveness
comes from an epic WebSocket channel (`epic-updated`, run status) plus the
tickets' task channels. Details: [`ui.md`](../reference/docs/epics/ui.md).

## When to install it

Install epics when features regularly span many tasks, you will invest in an
approved specification up front, and you want implementation to run unattended
behind it. The costs: several long framing conversations, a supervising and a
reviewing agent per ticket, and strict sequencing. Skip it for work that fits
in one task, or if you would rather split and sequence tasks by hand.

## What to build

- [ ] Epic-agnostic task seams: `base_branch`, the run `driver` and its three
      policies, the event emitter (`run-ended` before chaining), and a public
      task service facade including `mergeTask`.
- [ ] `epics`, `epic_tickets`, `epic_agent_runs`; owner-less conversations with
      link tables and owner adapters; an import boundary (lint + test).
- [ ] The archive outside the repo, the per-stage writable-directory map, and
      path-confined document tools.
- [ ] `startEpicAgentRun`, stage gates, `mark_stage_complete`, the one-way
      human backstop, and a per-agent-type tool catalog re-derived every turn.
- [ ] The four framing prompts and the story tools with their two guards.
- [ ] The feature branch lifecycle, ticket creation through it, auto-sync at
      loop entry, the final PR.
- [ ] Orchestration: durable flags, the event subscriber, the wake bridge
      (queue, dedupe, caps), the sequencer, the supervision tools.
- [ ] The PR reviewer: worktree-scoped conversation, `merge_task` with live
      guards and a required outcome summary, a per-epic singleton.
- [ ] One blocking path, resumable Stop, the snapshot wake on restart.
- [ ] The delivery worktree and agent (with the webhook entry point); the QA
      scenario stage, execution agent and continuation loop.

## Reference map

| Concern | File |
|---|---|
| Boundaries and data model (authoritative) | [`architecture-v2.md`](../reference/docs/epics/architecture-v2.md) |
| Task facade, `mergeTask`, `taskProgress` | `../reference/server/services/tasks/index.ts` |
| Task events; emission before chaining | `../reference/server/services/tasks/events.ts`, `../reference/server/services/tasks/adapter.ts` (`onTurnEnded`, `handleAgentChaining`) |
| Epic boot wiring, restart recovery | `../reference/server/services/epics/index.ts` (`initEpics`, `resumeOrchestrationAfterRestart`) |
| Epic owner adapter (cwd, Stop, turn hooks) | `../reference/server/services/epics/adapter.ts` |
| Starting a stage; reviewer singleton | `../reference/server/services/epics/epicAgentRunner.ts` |
| Per-agent tool surface | `../reference/server/services/epics/epicAgents.ts`, `../reference/server/services/epics/bottega/mcpServer.ts` |
| Stage sign-off | `../reference/server/services/epics/bottega/tools/stage.ts`, `../reference/server/services/epics/epicStages.ts` |
| Archive, writable dirs, context prompt | `../reference/server/services/epics/epicArchive.ts`, `../reference/server/services/epics/bottega/tools/documents.ts` |
| Ticket creation and ordering | `../reference/server/services/epics/ticketService.ts` (`createEpicTicket`, `moveTicket`) |
| Feature branch, final PR, delivery worktree | `../reference/server/services/epics/epicBranch.ts` |
| Event translation | `../reference/server/services/epics/taskEventSubscriber.ts` |
| Wake bridge (queue, caps), sequencing, blocking | `../reference/server/services/epics/orchestrator/` (`bridge.ts`, `sequencing.ts`, `blocking.ts`) |
| Orchestrator and reviewer tools | `../reference/server/services/epics/bottega/tools/` |
| REST surface, gates, start / pause / resume | `../reference/server/routes/epics.ts` |
| Prompts | `../reference/server/constants/prompts/epic-*.md` |
| Frontend | `../reference/src/pages/EpicDetailPage.tsx`, `../reference/src/components/epic/` |
| Per-stage detail | `../reference/docs/epics/` (`orchestrator.md`, `spec-review.md`, `stories.md`, `technical-specification.md`, `feature-branch.md`) |

## Boundaries (not in this spec)

- The task pipeline each ticket runs through, its flags and iteration cap →
  [`../core/orchestration-loop.md`](../core/orchestration-loop.md),
  [`../core/execution-loop.md`](../core/execution-loop.md).
- Tasks, worktrees and the `task/{id}-{slug}` branch convention →
  [`../core/task-and-workspace.md`](../core/task-and-workspace.md).
- The task-level PR agent the reviewer takes over from →
  [`../core/pull-request-agent.md`](../core/pull-request-agent.md).
- The GitHub webhook that delivery's second entry point extends →
  [`./pr-comment-retrigger.md`](./pr-comment-retrigger.md).
- Prompt overrides and per-user models (one key per epic agent type) →
  [`./prompt-and-model-customization.md`](./prompt-and-model-customization.md).
- The planning-prompt variants the `driver` policy selects between →
  [`./auth-and-multi-user.md`](./auth-and-multi-user.md).
