# The specification review — the gate before autonomous implementation

The fourth stage of the epic pipeline, between the stories stage and the
orchestrator. An `epic-spec-review` agent reads every level of the epic's description —
the functional specification, the architecture document, the technical
specification, every ticket — checks them against each other and against the
code, writes one report, and then **settles it with the user**: they discard
the findings they disagree with and approve the rest, and the agent applies the
approved ones itself, at whichever level the fix belongs — the functional
specification included. When the user gives the go-ahead the agent signs
the stage off, and orchestration — which cannot start without that sign-off —
begins on documentation that has been reviewed end to end.

The stages it reads are [`entity-and-conversations.md`](./entity-and-conversations.md)
(architecture), [`technical-specification.md`](./technical-specification.md)
and [`stories.md`](./stories.md); the stage it guards is
[`orchestrator.md`](./orchestrator.md).

## Why a fourth stage

The three upstream stages run as independent conversations, and the only thing
that travels between them is files: the architecture document, then the
specification documents, then the ticket documents. That is the isolation
principle doing its job, and it is also exactly how gaps appear — a decision
settled in the specification conversation and never written down, two
sub-documents that name one thing two ways, a ticket pointing at a section
nobody wrote, a claim about the code that stopped being true.

Downstream, nothing catches those. The orchestrator and the implementing agents
treat the approved specification as truth and never challenge it (the rule the
PR reviewer is built on), and a ticket agent cannot ask anyone anything. So a
contradiction is resolved by whichever side the implementer happens to pick, and
a gap by a guess — and the first human to see the result is reading a pull
request.

## Four levels, one conversation

The epic's documents are four zoom levels of one description — the functional
specification (what the product must do, the user's own document), the
architecture fully zoomed out, the technical specification on each decision's
details, the tickets on one change each — and the review's job is their
consistency. That shapes the user's workflow into something strictly
forward-moving: once a stage is approved, the user never reopens its
conversation, and never edits a document by hand. Every correction the review
surfaces is made **here**, by the reviewer, at whichever level it belongs —
which is why this is the one epic agent whose write surface spans `spec/`,
`architecture/`, `docs/` *and* the ticket tools. The functional specification
is in that list on purpose: when the user confirms that the product deviates
from it (a feature dropped, a behaviour simplified), the spec is the document
that has to change, or every level below it contradicts it forever — exactly
the kind of "every agent surfaces the same inconsistency" loop the first real
run hit. Copying findings back into earlier conversations, or replacement text
into the spec, by hand was the alternative, and it is not a workflow anyone
wants.

## What it is — and what it is not

It is a **consistency and completeness gate**, not a design review. The user
approved the architecture, the specification and the ticket split; the review
does not second-guess any of it. Its prompt (`server/constants/prompts/epic-spec-review.md`)
defines a finding as exactly one of four things — a **contradiction** between
two inputs, a **gap** an implementer cannot fill, an **error** (a claim about
the code that is false, a change the code cannot take as described), or an
**open question** — and says in as many words that a decision the reviewer
would have taken differently is not one. It checks seven dimensions:

1. functional spec → technical spec (coverage, no contradictions; a
   deliberate deviation is a finding whose fix is the user's call — the
   technical level changes, or the functional spec changes to say so);
2. architecture → technical spec (same decisions, same names);
3. the technical spec against itself (cross-document contradictions, dangling
   references, open questions, each sub-document standing alone);
4. the technical spec against the code (every claim an implementer will rely on,
   verified in the repo; feasibility);
5. technical spec → tickets (everything in scope assigned exactly once, nothing
   beyond scope);
6. each ticket alone (its pointers exist, its dependencies are earlier tickets,
   the order is implementable, out-of-scope statements agree across tickets,
   acceptance criteria are checkable);
7. autonomy (anything that will need a human mid-implementation — a credential,
   a manual step, a missing asset).

Two severities: **Blocking** (an autonomous implementer would guess, pick a
side, stall, or build something wrong) and **Advisory** (worth knowing, not
worth stopping for). "When in doubt, it is blocking" — the cost of a false
blocker is one human read, the cost of a missed one is a wrong implementation
nobody reviews until the pull request.

## The four parts of the conversation

The prompt is a procedure in four parts, and the first one ends with the agent
deliberately stopping.

1. **Review.** Read everything, in order; verify every code claim before
   citing it (sub-agents for the parallel parts); write the report with every
   finding `open`; present it in chat — the blockers one line each with the
   decision each needs, flagged as *the user's call* (a contradiction between
   two approved documents, a product decision, a missing asset) or *mechanical*
   (a false code claim, a dangling pointer) — and **end the turn**. Nothing is
   edited before the user has spoken.
2. **Settle.** The user asks, challenges, discards, decides, approves.
   Challenges are met with evidence, once; a discarded finding is recorded with
   the user's reason and is thereby closed — they have taken responsibility for
   it. `ask_user` is the right tool for a user's-call finding that can be
   phrased as concrete options. The reviewer never decides a user's-call
   finding for them and never downgrades a finding to shorten the list.
3. **Apply.** An approved finding is applied by the reviewer, in place, at
   every level it touches: `spec/` (rewriting the contradicted passage in the
   spec's own voice, only on the user's explicit confirmation of the product
   decision — never a note beside it), `architecture/` and `docs/` with its
   writers (the minimal edit, written as decisions, `00-master.md` kept
   accurate, documents kept self-contained); tickets through `update_task`
   (whole document, ticket shape and isolation rule preserved) —
   `create_task`/`delete_task` only on an explicit agreement, since a created
   ticket is a worktree and a branch. A correction at one level is propagated
   to the levels below; what was touched is re-verified, and a problem the fix
   surfaces becomes a new finding rather than a silent edit. The report's
   statuses are updated as the record of what the review did.
4. **Sign off.** When no blocking finding is open and every approved fix is
   applied, the agent asks for the go-ahead; on the user's explicit word it
   calls `mark_stage_complete({ stage: 'review' })`. A report
   with zero findings still ends with the agent asking — approval is the
   user's word, for this stage like every other.

## The report is the record, not the hand-off

The stage writes one file, `review/review.md` in the epic archive
(`getEpicReviewDir`, `server/services/documentation.ts`), kept current for the
whole conversation: a status line (blocking / advisory / applied / discarded /
open), a summary, the findings (B1…, A1…) each with an absolute locator, the
quoted text on both sides of a disagreement, why it blocks, a proposed fix
naming the document that should carry it, and a status that moves from `open`
to `applied — what changed, where` or `discarded — the user's reason`; a
"Verified" list; and on a re-review a "Since the previous review" section.

`review/` is its own directory for the reason `architecture/` is: `docs/` stays
purely the specification, so a ticket agent pointed at one specification
document never finds the epic-wide review next to it. The report is for the
human. What the review settled lives **in the documents and tickets** — that is
the hand-off, exactly as for every other stage, and no downstream prompt tells
an agent to read the report. The prompt says so at the sign-off: a decision
that lives only in the review conversation is lost the moment it ends.

It is read on the epic page through `GET /epics/:id/review[/:filename]`
(basename-only, like the two document routes) in a third `EpicMarkdownBrowser`
mount, "Specification review", between the technical specification and the
tickets.

## Session config

A document-writing stage like architecture and specification: native writers
are denied, Bash stays on for read-only verification (`git log`, `gh pr diff`,
a test run, a `psql` query), sub-agents stay on for parallel cross-checks, and
`ask_user` stays on because the review is a conversation. Provider-neutral
archive tools confine writes to **four** directories — `review/`, `spec/`,
`architecture/`, `docs/` — which is why
`getEpicStageWritableDirs` answers a list rather than one directory: the gate
allows a path inside any of them and names all of them in a denial. The
repository stays out of bounds; so does every other epic's archive. The
context prompt's archive listing stops calling the functional specification
read-only for this one stage. Its MCP catalog is the stories catalog (`create_task`,
`list_epic_tasks`, `update_task`, `delete_task`, under the same revision-window
guards) plus `mark_stage_complete`, whose description for this stage says the
approval is of the corrected state — "never while an approved fix is still
unapplied". Model key `epic-spec-review`, provider-selectable, Opus/high by default.

## Where it plugs in

- **Flag**: `epics.review_complete` (guarded ALTER; its backfill joined
  tickets through the pre-split `tasks.epic_id`, which is why it runs before
  `splitOwnerTables` in the migration order).
  `EpicStageFlag` gains `'review'`; `FLAG_BY_STAGE.review → 'review'`,
  `FLAG_COLUMN.review → 'review_complete'` (`server/constants/epicStages.ts`).
- **Stage name**: `'review'` in `EPIC_STAGE_NAMES`, between `stories` and
  `implementation` — the backstop route is `POST /epics/:id/stages/review/complete`.
- **Agent type**: `'epic-spec-review'` in `EPIC_AGENT_TYPES`, `EpicAgentType`,
  the `epic_agent_runs.agent_type` CHECK (init.sql for fresh installs; since
  the v2 split each run table carries its own narrow type list, so adding a
  type means editing the CHECK in init.sql plus a guarded rebuild in
  `runMigrations`).
- **Gates** (`checkStageGate`, `server/routes/epics.ts`): the review needs
  `stories_complete`; `POST /epics/:id/orchestrator/start` now needs
  `review_complete` on top of `stories_complete`. The rail and the orchestration
  panel mirror both (`stageBlockedReason`, `primaryOrchestrationAction`).
- **Model key**: `epic-spec-review`, seeded by `backfillEpicStageModelKeys`
  (`EPIC_STAGE_KEYS_TO_SEED`); label "Epic: Specification review" in
  Settings → Agent Models.
- **Prompt**: `epic-spec-review.md`, operator-overridable, rendered by
  `generateEpicSpecReviewMessage` with every input as absolute paths, a ticket
  table (order, id, title, status, ticket document path — the locator the
  report cites) and the previous report's listing.
- **Archive**: `review/` created by `ensureEpicDirs`, named in
  `buildEpicContextPrompt`'s archive listing, removed with the rest by
  `deleteEpicArchive`.

## Existing epics

An epic whose implementation had already begun when this stage shipped is past
the gate by definition: the story tools close once work starts, so there is
nothing a review could get fixed. The column migration therefore backfills
`review_complete = 1` for epics with `stories_complete = 1` and either
`orchestration_active = 1` or any ticket that has left `pending`
(`backfillReviewCompleteForStartedEpics`) — the same two "work has started"
signals the story tools read. An epic whose tickets are all still pending keeps
`0` and goes through the gate.

## Edge cases worth knowing

- **No tickets, no documents, no spec** — each is a blocking finding the message
  names outright rather than a reason to refuse the run; the report says so and
  the conversation decides what to do.
- **A re-run** starts a fresh conversation whose message lists the existing
  report; the prompt treats it as a re-review — read the old report, review from
  scratch anyway (fixes may have landed anywhere), write "Since the previous
  review". Revising in the old conversation and re-running both work; the
  documents are the state, the transcript is how they got there.
- **The backstop** (`Mark complete` on the review row) sets the flag without a
  review or with findings still open — the user skipping the gate, one-way, as
  for every stage.
- **A created ticket** mid-review is a real worktree and branch, exactly like
  one the stories stage creates; the prompt makes it an explicit-agreement-only
  action for that reason.
- **Operator prompt overrides** are unaffected: a new prompt name, and `render()`
  only throws on variables the template uses that the caller did not supply.

## Key files

- `server/constants/prompts/epic-spec-review.md` — the prompt: the four kinds of finding, the seven checks, the report, the four-part conversation.
- `server/constants/epicAgentPrompts.ts` — `generateEpicSpecReviewMessage`, `reviewTicketTableSection`.
- `server/services/epics/epicAgents.ts` — `EPIC_SPEC_REVIEW_DISALLOWED_TOOLS`
  (native writers denied; portable document tools supplied).
- `server/constants/epicStages.ts` — the `review` stage ↔ `review_complete` mapping.
- `server/services/epics/bottega/mcpServer.ts` — the catalog (story tools + sign-off); `tools/stage.ts` — the per-stage sign-off wording.
- `server/services/documentation.ts` — `getEpicReviewDir`, `listEpicReviewDocs`, `readEpicReviewDoc`, `getEpicStageWritableDirs` (a list since this stage).
- `server/services/epics/epicDocsWriteGate.ts` — the multi-directory gate.
- `server/database/db.ts` — the `review_complete` ALTER, `backfillReviewCompleteForStartedEpics`, `AGENT_RUN_TYPES` + `NEWEST_AGENT_RUN_TYPE`.
- `server/routes/epics.ts` — `checkStageGate`, the orchestrator start gate, `GET /epics/:id/review[/:filename]`.
- `src/components/epic/EpicStageRail.tsx`, `EpicsPanel.tsx`, `EpicImplementationSection.tsx`, `src/pages/EpicDetailPage.tsx` — the stage row, the card dot, the start gate, the report browser.
