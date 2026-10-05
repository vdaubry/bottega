# The orchestrator — autonomous implementation

The last stage of the epic pipeline. Once the tickets exist, an
`epic-orchestrator` agent drives each of them the way a tech lead would: it
starts planification, answers the questions that agent asks, reviews the plan
and approves it. When the ticket's pull request is open, a second agent takes
over — the **PR reviewer** (`epic-pr-review`, [below](#the-pr-reviewer)) —
which reviews the pull request against the whole specification, fixes what it
finds itself, gets CI green and merges. The human is involved at the start of
the epic and on escalation — and for the one irreversible act at the end.

The tickets it drives are the
stories stage's output ([`stories.md`](./stories.md)), checked by the
specification review before it may start ([`spec-review.md`](./spec-review.md));
the tools it acts through are the `bottega` MCP server
([`technical-specification.md`](./technical-specification.md)).

## The one idea: it is a drop-in for the human

Every verb in the orchestrator's catalog wraps the exact service the UI calls.
`start_planification` is `startAgentRun`. `answer_question` is
`resolveAskUserQuestion` — the same function the answer widget's WS handler
calls. `send_feedback_to_planification` is a plain `sendMessage`, so the
planification agent reads an ordinary user message. The reviewer's `merge_task`
and the Merge button both call the task-domain `mergeTask` saga: one
write-ahead merge identity, one authoritative completion transition, one boot
reconciliation path.

Ticket-level agents therefore experience **nothing new**. Their prompts are
untouched by Phases 4–7. Only two additive changes exist, and neither is
visible to them:

- The orchestrator's runs are **automation-driven** (`startAgentRun`'s
  `driver: 'automation'`, inherited down the chain — architecture-v2 step 2),
  which is what skips the planification→implementation auto-chain (the
  driver reviews the plan first), forces the technical prompt variant, and
  mutes per-turn push notifications for the autonomous stretch.

## Dormant between events

**Nothing runs while a ticket is being worked.** Each wake is one conversation
turn: the orchestrator acts, ends its turn, and the SDK subprocess exits. There
is no process and no token spend between events. This is why the prompt spends
so much of its length on turn discipline ("after any action that waits on an
agent, END YOUR TURN") — the model ending its turn is the mechanism, not an
optimization.

**One run + conversation per ticket.** Supervising a ticket is dozens of
events; ten tickets in one transcript would exhaust context exactly when
judgment matters. The supervised ticket is recorded on the run row
(`task_agent_runs.ticket_task_id`), so a resume weeks later rebuilds the same
context — the same row-as-source-of-truth rule the MCP injection follows.

**Orchestration is a durable epic flag, not a run status.** Since nothing is
running most of the time, "is this epic being driven?" cannot be read off a
row's status. `epics.orchestration_active` answers it, and
`orchestration_blocked` (+ `orchestration_blocked_reason`) halts the bridge
without leaving orchestration. The bridge **drops every wake while the block
is set** (logged since 2026-08-26), which is why a blocked orchestrator that
acts anyway — a user chats with it and it restarts a stage — must first lift
the block: every action tool calls `resumeOrchestration()`
(`orchestrator/blocking.ts`, the `blockOrchestration` inverse: flag off,
bridge counters reset, same broadcast) right before it starts or steers a
ticket agent. Without that, the started run is stranded — its failure event
is dropped and nobody ever hears (epic 4's restarted PR agent,
2026-08-26). **The orchestrated-task rule** —
`task.epic_id → epic.orchestration_active` — is what every hook, guard and
notification filter checks; it is `isOrchestratedTask(taskId)` in
`epics/orchestrator/bridge.ts`, two indexed row reads and no await.

## The event bridge

`server/services/epics/orchestrator/bridge.ts`. Waking the orchestrator means
**resuming its conversation with a message** — the ordinary follow-up-chat
path. Events render as `[bottega-event]` blocks: a header line
(`type=… task=… agent=… run=… status=…`), a `flags:` line read fresh from the
ticket row at send time, an optional payload, and one closing instruction.

Since architecture-v2 step 1, the task layer no longer calls the bridge:
ticket-level hooks **emit TaskEvents** (`server/services/tasks/events.ts`) and
the epic layer's subscriber (`server/services/epics/taskEventSubscriber.ts`,
registered by `initEpics()`) translates them into the bridge events below. The
epic-conversation rows of the table (a reviewer or orchestrator turn ending)
still reach the bridge directly from the completion handler.

| Source | Fires for | Event |
|---|---|---|
| TaskEvent `run-ended` | a planification turn, any of them | `planification-turn-ended` |
| same | a `pr` turn that **completed** | *(no event — `schedulePrReview` starts the PR reviewer)* |
| same | a `pr` turn that **failed** — or, from the hand-off itself, one that could not happen (no open PR, start threw) | `pr-turn-ended` + a payload saying which |
| turn-end handler (`agentRunLifecycle`) | a PR reviewer turn that ended **without merging** | `pr-review-ended` |
| same | a PR reviewer turn that ended **merged** | *(no event — sequences to the next ticket)* |
| TaskEvent `run-ended` | an impl/review/refinement run that **failed** | `agent-run-failed` |
| turn-end handler (`agentRunLifecycle`) | the orchestrator's own turn | *(drains the queue, then sequences)* |
| TaskEvent `question-parked` | a ticket agent's question | `question-pending` |
| AskUserQuestion park site | the orchestrator's **own** question | *(a push notification — the user answers)* |
| TaskEvent `workflow-blocked` (`agent-requested`) | a ticket agent ran `scripts/block-workflow.ts` | `task-blocked` + its stated reason |
| TaskEvent `workflow-blocked` (`max-iterations`) | the ticket hit `MAX_WORKFLOW_RUNS` | `task-blocked` |
| TaskEvent `chain-start-failed` | starting the next agent threw | `chain-start-failed` |
| TaskEvent `workflow-blocked` (`base-sync-conflict`) | the feature branch would not merge | `sync-failed` |
| TaskEvent `task-merged` / `task-deleted` | a ticket merged or was deleted | *(no event — sequences / re-evaluates)* |
| TaskEvent `worktree-state-changed` (`ready` / `failed`) | a supervised ticket's background worktree setup ended — its agent was told to wait for it | `worktree-setup-ended` + the outcome (the error, if it failed) |
| same | no agent supervises the ticket yet | *(no event — re-sequences: the sequencer may be waiting on it)* |

Successful mid-chain hops stay **silent** — the chain handles those itself, and
narrating them would wake the orchestrator dozens of times per ticket.

**An agent's own block** (`agent-requested`) is the odd one out: the agent runs
`scripts/block-workflow.ts` from inside its turn, a separate process that writes
`workflow_blocked` (and now `workflow_blocked_reason`) straight to SQLite. The
server only sees it when the chain re-reads the row at turn end, so
`tasks/adapter.ts` publishes the TaskEvent from there. Without that publish the
loop just stops and the orchestrator sleeps through it — a ticket blocked on
something as ordinary as a missing browser connector never reaches the one
agent whose job is to clear it.

**Queueing.** Events land while the orchestrator is mid-turn (its own tool call
started the run that just failed). A per-epic FIFO holds them, deduped on
`(taskId, type, runId)`, and the turn-end hook delivers everything as **one**
message — a second concurrent resume on the same conversation would fork the
session. The queue is memory-only by design: a restart drops it, and the boot
reconciliation supersedes anything lost.

**Counters** (per orchestrator conversation, in memory) stop a model going in
circles: 40 wakes per ticket, 8 `question-pending`, 6 `planification-turn-ended`,
6 `pr-turn-ended`, 3 `pr-review-ended`. A breach stops injection and blocks the
epic through `blockOrchestration` — the same path `block_epic` takes, because
from the user's side an escalation and a runaway are the same event.

## Sequencing

`server/services/epics/orchestrator/sequencing.ts`, running in the turn-end hook
with the shape `handleAgentChaining` uses: `setTimeout(1s)` → fresh re-reads →
guards → act. The next ticket is the first that has not merged. If the current
conversation is already on it, nothing happens — idle is the resting state, not
a stall. A ticket's worktree is set up in the background after it is created
(`tasks/worktreeSetup.ts`), and no agent may start before it is ready: while
the next ticket is still `provisioning` the sequencer waits (the subscriber
re-sequences when the setup ends); if its setup `failed`, it pauses the epic
through `blockOrchestration` with the reason — only a human can retry a setup.
When every ticket has merged, orchestration ends: the flag clears, the
row broadcasts, the epic's final pull request is opened and the user is
notified — all server-side, with no orchestrator turn involved. **The epic's
status is not flipped** — the epic is done when a human merges its final pull
request.

The same module owns the second hop, the hand-off to the PR reviewer
(`schedulePrReview` → `startPrReview`): same settle delay, same fresh re-reads,
and a `started: false` answer is a refusal with a reason, never an error. Only
two refusals wake the orchestrator — no open pull request, or the start threw —
because only those need a decision. A reviewer already in flight, a paused
epic, a ticket merged meanwhile: silence.

## The PR reviewer

Once the ticket's pull-request agent ends with a pull request open, the ticket
leaves the orchestrator's hands. `schedulePrReview` starts an `epic-pr-review`
run — epic-scoped with `ticket_task_id`, exactly the orchestrator's row shape —
in a **fresh conversation** whose cwd is the **ticket's worktree**
(`ConversationTarget.worktreeTaskId`, the one epic conversation not in the main
checkout). It is one long turn, like the task-level PR agent, not a dormant
event loop.

**Why a separate agent, and why a fresh conversation.** Measured on the first
three real runs (epic 3), the orchestrator's context stood at ~75–82k tokens by
the time `pr-turn-ended` arrived — supervision noise the review had to think
through — and its tool surface (no Bash, no writers) left it one lever,
`request_pr_changes`, which cost a full PR-feedback run plus a CI cycle plus a
wake per finding. Three PRs, zero change requests. The reviewer starts with an
empty context and the whole specification, and carries the PR agent's full
surface so it can verify (run the suite) and fix in place.

**The three decisions it is built on** (all in `epic-pr-review.md`):

1. **The specification is the source of truth.** A human approved the
   specification and the orchestrator approved the plan; the reviewer
   implements against them and never challenges them. There is no escalation
   for a design question and no `AskUserQuestion` (denied in
   `EPIC_PR_REVIEW_DISALLOWED_TOOLS`, the only denial).
2. **It fixes what it finds itself, in the worktree, in the same turn** — no
   feedback round-trip. Scope discipline is by prompt: this ticket's scope,
   nothing from later tickets, no unrelated refactors.
3. **The CI loop is bounded** (the `pr.md` procedure: 20 polls, 10 fix rounds,
   3 rebases) and the one exit is `block_epic`, for CI it cannot get green —
   never for the specification. Behind that, the bridge's `pr-review-ended`
   cap and `MAX_WAKES`.

**Its catalog is two tools** (`tools/prReview.ts`): `merge_task` — bound to its
own ticket, refusing any other id, with the live guards the orchestrator's
version had (open PR, not conflicting, CI not red/pending, no unsaved worktree
work) and the required `outcomeSummary`; and the shared `block_epic`. It marks
`pr_agent_complete` itself when it lands a ticket whose PR agent had given up
on CI. Everything else it does with its shell.

**When its turn ends** (`onPrReviewTurnEnded`): ticket merged → the sequencer
hops; not merged → `pr-review-ended` wakes the orchestrator, whose prompt
allows exactly one `start_pr_review` retry (a fresh reviewer inspects the
worktree's leftover changes first) and then `block_epic`. A reviewer that
blocked the epic itself produces no wake.

## Restarts self-heal

`bottega.service` redeploys on every merge to main, so pausing on restart would
pause active epics constantly. After the orphan sweep, `server/index.ts` walks
`epicsDb.listOrchestrating()` and hands each one a `server-restarted` snapshot
event: *you were interrupted, re-read the state.* Deliberately a snapshot and
not a replay — which is exactly what makes the in-memory queue safe to lose.
`/orchestrator/resume` uses the same function with different wording.

## The tool catalog

`server/services/epics/bottega/tools/orchestrator.ts`. Every `taskId` is validated
against `task.epic_id === epicId` — an orchestrator can only touch its own
epic's tickets, and every verb that changes something is for the ticket it
drives.

| Tool | Notes |
|---|---|
| `get_epic_state` | flags, orchestration state, every ticket in order — read fresh, never from an earlier turn |
| `start_planification` | guards: no running agent, no finished plan; forces the technical prompt |
| `get_pending_question` / `answer_question` | the parked questions, and the human widget's own resolve call |
| `read_task_plan` | the ticket document once `planification_complete` |
| `send_feedback_to_planification` | fire-and-forget `sendMessage` (the REST 202 pattern) |
| `approve_plan_and_start_implementation` | after this the impl↔review→refinement→pr chain runs itself |
| `get_task_progress` | flags, latest run per type, the latest **PR review** run, PR + CI, and the **worktree path** so it can Read the code |
| `read_agent_transcript` | any run of any ticket of this epic: text, reasoning, tool calls, tool results, errors. For debugging — see below |
| `resume_ticket` | unblock + reset the run count (`unblockTask`, the REST Resume pair) and restart `implementation`, `review` or `pr`; the optional `note` rides into that run's prompt as `extraContext`. The **only** verb that restarts a ticket agent — refuses only a ticket that is both `workflow_complete` and `pr_agent_complete`, because `workflow_complete` alone still covers the whole refinement → PR stretch |
| `start_pr_review` | the retry path only — the server starts the reviewer itself when the PR agent ends |
| `open_epic_pr` | a fallback; the sequencer opens the final PR itself when the last ticket merges |
| `block_epic` / `notify_user` | escalate, or just say something |

No `get_pr_diff`, `request_pr_changes` or `merge_task` any more: the
orchestrator never reviews or merges a pull request — the PR reviewer does
(2026-08-23). No `mark_stage_complete`: the `implementation` stage has no flag.
(The orchestrator used to carry the tool to write a closing
`summaries/implementation.md`; the summary argument was dropped on 2026-08-23 —
see [`technical-specification.md`](./technical-specification.md).)

### `read_agent_transcript`

**Who.** The orchestrator only: `mcpServer.ts` gives this catalog to
`epic-orchestrator` and to no other agent type.

**Why.** Debugging. The flags say a ticket stopped, not why, and
`agent-run-failed`, `pr-review-ended` and `server-restarted` carry no detail.
The account of what happened is in the run's transcript.

**What it returns.** One window of a run's transcript: assistant text,
reasoning, tool calls with their arguments, tool results with their errors, and
turn-end results. UI bookkeeping entries (`ai-title`, `last-prompt`, `mode`,
`attachment`, `progress`, `queue-operation`) are dropped and counted. Each
entry carries a stable index; blocks over 800 chars are truncated, a slice at
100k.

| Argument | Effect |
|---|---|
| `taskId` alone | the ticket's run index — its task runs plus its `epic-pr-review` runs, with run id, stage, status, conversation id, timestamps |
| `agentType` | newest run of that stage; `pr-review` is the epic-level reviewer |
| `runId` | one specific run, for a stage that ran more than once |
| `limit` / `before` | window size, and the exclusive upper index to page back from. Default: last 40 |
| `search` | keep entries containing the text; the header lists every matching index |
| `expand` | render one block untruncated, by `tool_use` id or `#<entryIndex>` |
| `subagent` | read a subagent transcript instead of the main one |

The header carries the entry count, the tool tally with per-tool error counts,
the indices of entries whose blocks carry errors, and the subagent keys
available.

**Guards.** The task must exist and belong to this epic. Any ticket of the epic
is readable; the tool writes nothing.

**Implementation.** `tools/transcript.ts` resolves the run and applies the
guards; `conversation/transcriptReader.ts` loads, normalizes, windows and
renders. The latter is infrastructure and provider-neutral — the Codex and
OpenCode mirrors write the same entry shape the Claude session store does.

**Why `outcomeSummary` is required on the reviewer's `merge_task`:** it is the
only channel through which one ticket's work informs the next. Each ticket gets
fresh conversations, so nothing else survives. Requiring it at merge time forces
the summary at the exact moment the reviewer knows the answer — and it has just
read the final code, which is why the summary moved from the orchestrator to it.

## Epic memory across tickets

`generateEpicOrchestratorMessage` rebuilds it per ticket — and
`generateEpicPrReviewMessage` rebuilds the same memory for the reviewer, plus
where it is (worktree, PR, base branch): the mission, the ticket document
inlined (what the implementing agent sees, so the review is against the same
brief; by review time it carries the approved plan), `00-master.md` inlined
(small by contract), the live story table with current statuses, and the
outcome notes of every ticket already delivered. Notes live in
`~/.bottega/projects/{p}/epics/epic-{e}/orchestrator/outcomes/task-{id}.md` —
outside `docs/`, which stays purely the specification: an implementing agent
sent to read one specification document must never find the epic's
ticket-by-ticket narrative next to it.

## Session config

cwd is the project's main checkout (big-picture reads; ticket code by absolute
`worktreePath`). `disallowedTools` is **empty** — the full task-agent surface,
`AskUserQuestion` included. It used to deny Bash, the writers and sub-agents, on
the reasoning that every change reaches the repository through a ticket agent
anyway; that held for changes and broke for everything else. A ticket blocked on
a missing browser connector left the orchestrator unable to check whether the
claim was even true, so its only honest move was to stop the epic. Containment
is now by prompt (never write from the main checkout; Bash is for diagnosis and
environment repair), as with the document stages. The catalog is enforced on
**every** turn, not just the first: `sendMessage` re-derives it from the
conversation's rows
(`epicDisallowedToolsForConversation`, same pattern as the docs write gate) and
merges it into the resume options — the capstone QA run caught wake turns
running without it. Model key `epic-orchestrator` (provider-selectable, Opus
by default), `bypassPermissions`.

The PR reviewer is the mirror image: cwd is the ticket worktree, nothing denied
but `AskUserQuestion`, no docs write gate (its writable dir is `null` — the
gate is for archive writers, and it writes code), model key `epic-pr-review`
(provider-selectable, Opus by default), `bypassPermissions`. Pause aborts it like
any epic run, but records it as `blocked` first; Resume or a message continues
that same conversation. A restart still orphan-sweeps genuinely running rows.

**Notifications** for orchestrated tickets are muted in `notifyClaudeComplete`:
a twelve-ticket epic would otherwise push two dozen times about work the user
explicitly delegated. Only the orchestrator's escalations and completions
notify.

## REST + UI

| Route | |
|---|---|
| `POST /epics/:id/orchestrator/start` | needs `stories_complete` + `review_complete` (the specification review passed, or its backstop) + tickets + not already running |
| `POST /epics/:id/orchestrator/pause` | blocks, and durably interrupts any streaming orchestrator/reviewer turn before aborting it |
| `POST /epics/:id/orchestrator/resume` | resumes the exact blocked conversation; escalation-only blocks still use a snapshot wake |

All three answer the updated epic row. `EpicImplementationSection` renders from
it plus the ticket rows: the status-colored ticket rows and segmented progress
bar, the current ticket, the blocked banner with its reason, and
Start/Pause/Resume (chip and button read the orchestration state via
`orchestrationAction.ts`, not the latest dormant run). Each ticket row expands
to its own orchestration conversation and PR-review conversations. There is
deliberately **no live feed** — a spinner would be lying for hours at a
stretch. See [`ui.md`](./ui.md).

## Edge cases worth knowing

- **A user stops an orchestrator or reviewer turn** — the run becomes
  `blocked` before transport abort, the epic bridge stays closed, and the
  completion hook cannot start anything. A human message (or Resume) returns
  that exact run to `running`; no replacement conversation is created.
- **A technical turn failure** — remains `failed` and reaches the existing
  reviewer/orchestrator recovery hooks. It is never treated as a user pause.
- **A ticket completed by hand** — the story table and `nextTicket` read live
  rows, so the sequencer simply skips it.
- **Mid-epic re-planning** is out of v1: `create_task` is not in this catalog,
  and the stories tools close once work starts. The orchestrator escalates
  instead.
- **A parked escalation holds an SDK subprocess** for as long as the human takes.
  Known trade-off; the restart fallback covers process loss.
- **Counters reset on restart** (they are in memory). The durable per-task
  `MAX_WORKFLOW_RUNS` backstop remains.
- **The reviewer's worktree normally vanishes under it** — cleanup runs after
  the authoritative merge transition while the reviewer still has the tree as
  cwd. If removal fails or times out, the task remains completed and cleanup is
  retried from its durable landing row; sequencing never mistakes housekeeping
  failure for an unmerged PR.
- **A GitHub review lands during orchestration** — the webhook starts a
  PR-feedback run as it always did; when that run ends, `schedulePrReview`
  hands the updated pull request to a reviewer (or stays silent if one is
  already in flight). The reviewer remains the gate before merge.
- **A reviewer dies mid-fix** (restart, provider error) — its uncommitted
  changes stay in the worktree; the retry reviewer's first step is
  `git status`, and it keeps or discards them on their merits.

## Key files

- `server/services/epics/orchestrator/bridge.ts` — events, queue, counters, `isOrchestratedTask`.
- `server/services/epics/orchestrator/sequencing.ts` — the ticket hop, the reviewer hand-off (`startPrReview`/`schedulePrReview`), epic completion, `wakeOrchestrator`.
- `server/services/epics/orchestrator/blocking.ts` — the one way an epic stops, and the one way an acting orchestrator resumes it (`resumeOrchestration`).
- `server/services/tasks/events.ts` — the task domain's event stream; `server/services/epics/taskEventSubscriber.ts` — the epic layer's translation of it into bridge events (v2 step 1).
- `server/services/epics/index.ts` — `initEpics()` (broadcaster registry + event subscription) and the boot resume.
- `server/services/epics/bottega/tools/orchestrator.ts` — the orchestrator's catalog.
- `server/services/epics/bottega/tools/prReview.ts` — the reviewer's catalog (`merge_task`), `tools/blockEpic.ts` the shared `block_epic`.
- `server/services/epics/bottega/tools/transcript.ts` — `read_agent_transcript`, the orchestrator's debugger; `server/services/conversation/transcriptReader.ts` — the provider-neutral read/window/render behind it.
- `server/constants/prompts/epic-orchestrator.md` — the state machine as procedure.
- `server/constants/prompts/epic-pr-review.md` — the review: spec as truth, fix in place, bounded CI, merge.
- `server/constants/epicAgentPrompts.ts` — `generateEpicOrchestratorMessage`, `generateEpicPrReviewMessage`.
- `server/services/conversation/conversationScope.ts` — `worktreeTaskId`, the one epic conversation in a worktree.
