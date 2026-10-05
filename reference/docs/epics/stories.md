# The stories stage — turning a specification into tickets

The third stage of the epic pipeline. A provider-neutral conversation reads the
approved technical specification, negotiates the ticket split with the user in
chat, and then creates the epic's tickets through MCP tools — each one brief,
ordered, and self-contained enough to be implemented by an agent that knows
nothing about the epic.

The `bottega` MCP server it
extends is [`technical-specification.md`](./technical-specification.md); the
feature branch its tickets fork from is [`feature-branch.md`](./feature-branch.md).

## The ticket list is the state

There is no `stories.md`. The agreed split lives in the `tasks` rows themselves:
order in `epic_tickets.position`, scope in each ticket's document, dependencies,
deferrals and expected trouble stated inside the descriptions. Nothing else is
carried into the stages that follow — the `summaries/stories.md` recap that
`mark_stage_complete` once wrote was dropped on 2026-08-23 (see
[`technical-specification.md`](./technical-specification.md)). The next stage
is the [specification review](./spec-review.md), which carries this same tool
catalog: it reports anything inconsistent across the architecture, the
specification and the tickets, and revises the tickets itself once the user
approves a finding — this conversation is not reopened.

A document copy was rejected for two reasons. It would drift on every
`update_task` / `delete_task` — and the orchestrator reads DB state anyway. And
it would have to live in `docs/`, which is exactly where an implementing agent
is sent to read one specification document: finding an epic-wide ticket list
next to it is the isolation leak the whole design exists to prevent.

## The story tools

`server/services/epics/bottega/tools/story.ts`, attached to `epic-stories`
conversations by the same row-derived injection as every other bottega tool.

| Tool | What it does |
|---|---|
| `create_task({title, description})` | One ticket, appended at the end of the epic order |
| `list_epic_tasks({includeDescriptions?})` | The epic's tickets in execution order, each with a `revisable` flag |
| `update_task({taskId, title?, description?, position?})` | Revise a ticket that has not started |
| `delete_task({taskId})` | Remove a ticket that has not started, with its worktree and document |

**`create_task` is the human route.** It calls the same
`createTaskWithWorktree` that `POST /api/projects/:id/tasks` calls (via the epic layer's `createEpicTicket`, which passes the feature branch as the base), so an
agent-created ticket is byte-for-byte a human-created one: the row, the epic's
feature branch ensured first, the worktree forked off it, the task doc written
from `description`. That equivalence is what lets ticket-level agents stay
untouched — they cannot tell who wrote their ticket. `delete_task` delegates to
`deleteTaskCompletely` for the same reason.

`epic_tickets.position` has no unique index (positions are a service-layer
concern), so `moveTicket` (`server/services/epics/ticketService.ts`) renumbers the
whole sequence `1..N` on every move, and `delete_task` closes the gap it
leaves. Gaps and duplicates left by a manual `POST /epics/:id/tasks` with an
explicit position are normalized on the way past.

### The two guards

**The revision window** — `update_task` and `delete_task` work only while a
ticket is `pending` *and* has no agent runs. Rewriting the description of a
ticket an agent is already implementing would change the brief underneath it.

**The list closes when work starts** — `create_task` refuses once any ticket of
the epic has left `pending` or has agent runs. Tickets execute in order, so
inserting into a sequence already being worked is mid-epic re-planning, which v1
deliberately does not support. Two signals say it has: the epic's durable
`orchestration_active` flag (true from the moment the user starts orchestration,
before any ticket moves) and the derived one above, which also catches a ticket
a human pressed Run on.

Both refusals are `fail()` results phrased as "what went wrong, what to do
instead" — the agent's next move is only as good as that sentence.

## The agent

Started with `POST /api/epics/:id/agent-runs {agentType:'epic-stories'}`, gated
on `specs_complete` (set when the specification agent's own
`mark_stage_complete` recorded the user's approval), through the same
`startEpicAgentRun` as every other stage.

**Session config**: cwd = the project's main checkout;
`disallowedTools: ['Write','Edit','MultiEdit','NotebookEdit']`. This stage
produces nothing on disk — tickets exist only through its tools — so every
file-writing tool is denied outright and no write gate is needed: there is no
legitimate write for one to allow. Bash and sub-agents stay ON for repo research
(the prompt keeps the shell read-only — the cwd is the main checkout).

**The message** (`generateEpicStoriesMessage`) lists the specification documents
as absolute paths, the spec directory, and the repo path. It deliberately does
*not* snapshot the existing tickets: `list_epic_tasks` returns them live, so a
re-run reads the current list rather than one captured when the run started.

**The prompt** (`server/constants/prompts/epic-stories.md`) splits the work in
three phases: discussion until the user agrees to a concrete list (no
`create_task` before that), creation in agreed order, then verify-and-revise. It
inlines the ticket-description template — Goal / Context / Scope / Out of scope /
Dependencies / Acceptance criteria — and states the isolation rule verbatim:

> The agent that implements the ticket sees ONLY this description. Not the epic,
> not the other tickets, not the specification, not this conversation.

Hence "point at a document, don't summarize the epic": a description may carry
extracts or an absolute path like
`Read the section "Pricing tiers" of …/docs/02-pricing.md`, but a summary of the
specification inside a ticket is a copy that goes stale.

## Edge cases worth knowing

- **A premature `create_task`** is the failure that costs the user something —
  worktrees and branches they then have to clean up. It is prompt-enforced only;
  the tools cannot tell agreement from enthusiasm.
- **Re-running the stage** starts a fresh conversation. Tickets already created
  are found through `list_epic_tasks`, and revisable ones can still be changed.
- **A ticket poked manually first** (the user starts its planification) closes
  the revision window for it, and closes `create_task` for the whole epic. The
  refusal text says so; the user handles it manually.
- **`mark_stage_complete({stage:'stories'})`** flips `stories_complete`, and
  that is all — the tickets are the hand-off; the prompt tells the agent to
  `update_task` anything still worth knowing into a ticket before signing off.
  It opens the specification review, not implementation: orchestration also
  needs `review_complete`.

## Key files

- `server/services/epics/bottega/tools/story.ts` — the four tools and their guards (shared with the specification review).
- `server/services/taskService.ts` — `createTaskWithWorktree`, `deleteTaskCompletely`; `server/services/epics/ticketService.ts` — `createEpicTicket`, `moveTicket`, `renumberTickets`.
- `server/constants/prompts/epic-stories.md` — the prompt (operator-overridable).
- `server/constants/epicAgentPrompts.ts` — `generateEpicStoriesMessage`.
- `server/constants/epicAgents.ts` — `EPIC_STORIES_DISALLOWED_TOOLS`.
- `server/routes/epics.ts` — `checkStageGate`, the `specs_complete` gate.
