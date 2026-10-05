# QA — the scenario book, and the agent that runs it

After delivery there was no structured check that the epic actually works as a
product: the tickets were reviewed one by one against their own briefs, but
nobody ever clicked through the whole feature. The QA step is that check, built
as **two agents around one artifact** — a CSV of test scenarios the user
approves before anything is executed.

- **`epic-qa-scenarios`** derives the scenario book from the epic's documents
  and tickets: every button, form and state combination, dozens to hundreds of
  rows. The user reviews it in the Artifacts tab, gives feedback in the
  conversation, and the agent signs the stage off on their explicit word.
- **`epic-qa-execution`** runs the approved book against the delivered feature
  branch — its own dev server, driven with the Playwright MCP browser tools —
  and records per-row results into the same CSV.

The asymmetry is deliberate and mirrors delivery ([`delivery.md`](./delivery.md)):
the scenario book is a **gated stage** (flag `qa_complete`, stage name `'qa'`,
owned by the writer, human backstop included), while execution is an **agent
with no stage** — no flag, no sign-off, any number of runs; the filled book is
its outcome.

## One artifact, structured writes only

`qa/scenarios.csv`, in the epic archive next to `review/`. Header
`id,feature,title,steps,expected,status,confidence,notes`; ids `S-001…` are
stable forever (results and revisions address rows by id); `status` is
`pass`/`fail`/empty (= not run); `confidence` grades the evidence 1–3 (3 a
deterministic DOM assertion, 1 a judgment call like reading a screenshot for
CSS alignment). The whole contract lives in **one module**,
`shared/schemas/qa.ts` (over the dependency-free RFC-4180 codec in
`shared/utils/csv.ts`), consumed by the server tools, the routes' tests and
the frontend table.

Neither agent ever hand-edits CSV text. The writer's catalog is
`write_qa_scenarios` (`replace` for the first batch, `upsert` by id after,
batches ≤50, a `replace` that discards recorded results says so) and
`delete_qa_scenarios` (all-or-nothing on unknown ids); the executor's is
`record_qa_results` (1–20 per call, strict parse, unknown ids refused, updates
only the three result cells, answers with the not-run count). The handlers own
serialization (`server/services/epics/bottega/tools/qa.ts`), so a malformed
book is impossible rather than merely detected — and `edit_epic_document`'s
oldText-uniqueness contract would in any case fight a CSV of hundreds of
near-identical rows. Both catalogs also carry the read-only half of the
document tools (`buildDocumentReadTools`); the writer adds
`mark_stage_complete`, whose per-stage description ties the sign-off to the
user's explicit approval of the book.

Results are durable per batch, which is what makes execution resumable: the
opening message computes `N pass / M fail / K not run — resume at the first
not-run row` from the CSV at run start, so an interrupted run costs only the
unrecorded scenarios, and "Run again" naturally continues.

## Where each agent runs

The writer is a document stage like the four framing stages: cwd = the main
checkout (read-only by prompt), native writers denied, writable dir `qa/`
(`getEpicStageWritableDirs`), AskUserQuestion on — the book is settled in
conversation, spec-review style: present a summary **and stop** (never the CSV
itself — counts per feature area), revise in place from feedback, sign off
only on the user's word.

The executor runs **in the epic's delivery worktree** (`{kind:'epic', epicId,
deliveryWorktree:true}`, ensured before the run row exists, exactly like
delivery) — the only checkout where every merged ticket exists together. Its
write rule is stricter than delivery's: the worktree is for *running* the app,
never for changing it; native writers are denied and results flow only through
`record_qa_results`. Its context prompt carries a Testing Configuration
section: port `getEpicDevServerPort(epicId) = 4100 + epicId % 900` (a band
deliberately disjoint from the task band 3100–3999), the `lsof` free-port
check, never kill a process you did not start, and the within-turn lifecycle —
the per-turn SDK subprocess is aborted at turn end, killing its children, so
the server is started as a shell background process inside a Bash call, used,
and killed by port before the turn ends. Playwright MCP tools need no plumbing:
the operator-level MCP config already reaches every spawned agent on all three
providers.

## Automatic continuation

One execution turn rarely finishes a large book (the first real one covered
~45 of 134 scenarios), so execution loops without a human in between:
`server/services/epics/qaLoop.ts` runs in the executor's turn-end hook (the
epic adapter's one QA dispatch, gated on the run having ended *normally* —
failed and user-blocked runs never chain), re-reads the CSV after the same 1 s
settle as the ticket sequencer, and starts a fresh `epic-qa-execution` run —
blank context, the `{{qaProgress}}` resume line recomputed — while not-run
rows remain. The decision is deterministic backend code; no flag is written
when it finishes ("the filled book is the outcome"), just a banner
notification. Termination: every row resulted; a turn that recorded nothing
new (the stall guard — the executor deliberately leaves rows it cannot run,
so respawning would loop forever); `MAX_QA_CONTINUATIONS` as a backstop; or
the user's Stop. Guard state (not-run baseline + continuation count) is
memory-only like the bridge queue — a server restart just pauses the loop, and
the next Run QA click (which resets the budget via `resetQaLoopState`) resumes
from the CSV.

## The fix agent

`epic-qa-fix` — stage-less like execution, one autonomous **mission** per
click of the QA section's "Fix failures" button (offered when the book records
≥1 `fail`). One conversation runs the whole repair: `create_fix_ticket` turns
every failed row into ONE real epic ticket (`createEpicTicket` — feature-branch
fork, PR back into it, appended position), then the mission supervises it with
the orchestrator's own verbs (`ticketSupervision.ts`, shared catalog) — start
planification, answer its questions from the epic docs, approve the plan — and
sleeps between `[bottega-event]` wakes. Routing rides the **generalized
bridge**: `supervisedEpicOf` resolves the supervisor per epic (orchestration
wins outright; otherwise the newest `epic-qa-fix` run whose stamped
`ticket_task_id` matches the event's task). Two supervisor kinds differ in two
events only: a completed `pr` run wakes the fix agent to review and merge the
PR **itself** (epic-pr-review style, `merge_task` with a re-test closing)
instead of spawning the reviewer, and `task-merged` triggers no sequencing
hop. After the merge it re-tests the failed scenarios in the delivery worktree
(ff-only pull, own dev server, Playwright) and overwrites their rows via
`record_qa_results` — self-certified by design (the user's call: fewer runs
over separation), then `notify_user`. Runaway caps block the **run row**
(`blockQaFixSupervision`), never the epic's orchestration flags; a user Stop
blocks the same way, and a message into the conversation resumes. Boot
recovery wakes an in-flight mission with `server-restarted`. While the fix
ticket is unmerged, the `epic-qa-execution` gate's every-ticket-merged rule
blocks "Run QA" — accepted; it unblocks when the fix merges.

## Gates

`checkStageGate` (`server/routes/epics.ts`):

- `epic-qa-scenarios` needs `review_complete` — the book derives from the
  documents, so the review must have finalized them.
- `epic-qa-execution` needs, in order: `qa_complete` (the user approved the
  book — or the backstop), a `feature_branch`, **every ticket merged** (a
  scenario for an unmerged ticket would fail spuriously; the same rule as the
  completion PR, with the unmerged tickets named), and `scenarios.csv` on disk
  (the backstop can set the flag without a book ever being written).

`EpicQaSection` mirrors all of it client-side in its disabled-state tooltips.

## UI

Main tab, fourth section (**QA**, after Delivery): a Scenarios row (status chip
from the latest run + the signed-off mark from the flag + the "Mark complete"
backstop + Start/Run again) and an Execution row (Run QA + runs newest-first),
each listing its conversations. Artifacts tab, fifth section (**QA
scenarios**): `QaScenariosTable` over the shared `EpicFileBrowser` shell — a
summary strip (`N pass / M fail / K not run`), the scenario table (status
cells colored, confidence with its rubric as a tooltip, quoted newlines
preserved), a parse failure degrading to a banner over the raw text, and a
**Download CSV** link. The download is the first raw-bytes epic route
(`GET /epics/:id/qa/:filename/download`, `Content-Disposition: attachment`);
a plain `<a href>` cannot send the Authorization header, so the link carries
`?token=` — the query-token path the review-recording player already uses.
Liveness costs nothing new: `record_qa_results` rewrites the file in place, the
browser's `size:mtimeMs` cache key invalidates, and the 10 s running-poll
refreshes the listing — the table fills in while the executor works.

## Key files

- `shared/utils/csv.ts`, `shared/schemas/qa.ts` — the codec and the contract.
- `server/services/epics/bottega/tools/qa.ts` — the three structured tools.
- `server/services/epics/bottega/mcpServer.ts` — both catalogs;
  `tools/documents.ts` — `buildDocumentReadTools`.
- `server/constants/prompts/epic-qa-scenarios.md`, `epic-qa-execution.md` —
  the prompts (operator-overridable).
- `server/services/epics/epicAgentPrompts.ts` — the two message builders +
  the computed progress line.
- `server/services/epics/epicAgentRunner.ts` — both start cases (execution
  mirrors delivery's ensure-worktree-first).
- `server/services/epics/qaLoop.ts` — the automatic continuation;
  `server/services/epics/adapter.ts` — its turn-end dispatch (and the fix
  mission's flush).
- `server/constants/prompts/epic-qa-fix.md`,
  `server/services/epics/bottega/tools/qaFix.ts`,
  `server/services/epics/bottega/tools/ticketSupervision.ts` — the fix
  mission's prompt, its own verbs, and the supervision catalog shared with the
  orchestrator; `server/services/epics/orchestrator/bridge.ts` —
  `supervisedEpicOf`/`resolveSupervisor`, the generalized wake routing.
- `server/services/epics/epicArchive.ts` — `getEpicQaDir`, the QA
  list/read/exists helpers, the executor's write rule and Testing
  Configuration; `server/services/documentation.ts` — `getEpicDevServerPort`.
- `server/services/epics/epicStages.ts`, `server/database/epics.ts`,
  `server/database/db.ts`, `init.sql` — stage `'qa'` ↔ `qa_complete`
  (guarded ALTER, **no backfill** — a QA that never ran is honestly
  incomplete), the `agent_type` CHECK widening (probe: `epic-qa-execution`),
  the two model keys seeded per user.
- `server/routes/epics.ts` — the two gates, the QA file routes, the download.
- `src/components/epic/EpicQaSection.tsx`, `QaScenariosTable.tsx`,
  `src/pages/EpicDetailPage.tsx` — the Main-tab section and the Artifacts
  browser; `EpicsPanel.tsx` — the sixth stage dot.
