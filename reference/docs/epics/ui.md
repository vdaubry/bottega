# The Epics UI

Observability before autonomy. Phases 2–5 built a pipeline whose only view was
the stage conversations; this is the surface that shows an epic as a whole —
where it is, what each stage produced, and which tickets came out of it — so
that when the orchestrator runs unattended there is somewhere to watch it from.

The orchestration controls it
hosts are [`orchestrator.md`](./orchestrator.md).

## Where epics live in the app

The project board grows a `Tasks | Epics` toggle. Epics are a view *of a
project*, not a separate destination, and the toggle is driven by the URL rather
than component state — `/projects/:id` and `/projects/:id/epics` are two routes
onto the same `BoardView`, so a tab is linkable and the back button moves
between them.

| Route | Surface |
|---|---|
| `/projects/:id` | the board, Tasks tab |
| `/projects/:id/epics` | the board, Epics tab (`EpicsPanel`) |
| `/projects/:id/epics/new` | `EpicNewPage` — name + spec upload |
| `/projects/:id/epics/:epicId` | `EpicDetailPage` |
| `/projects/:id/epics/:epicId/chat/:conversationId` | `EpicChatPage` (Phase 2) |

The old v0 "Design Epic" button is gone; the primary action follows the active
tab (New Task / New Epic).

## Two facts per stage, never conflated

`EpicStageRail` is the **Framing** section (the four preparation stages —
Architecture → Technical specification → Stories → Specification review; the
implementation stage lives in its own section below, attached to the tickets
it drives). For each stage the rail renders **two independent things**:

- the **status chip**, from that stage's latest agent run (highest id — the rule
  `AgentSection` uses for tasks): what the machinery last did;
- the **signed-off mark**, from the epic row's stage flag: what the user
  approved.

Conflating them would hide the two states that matter most. A stage can be
signed off with *no run at all* (the backstop below, or a flag set by an earlier
version of the app), and a stage routinely has a `completed` run that nobody has
approved yet — that is exactly the state while the user is still reading the
output. Only the flag opens the next stage's gate. For the specification review,
`completed` + not signed off is the expected resting state between turns: the
reviewer presented its findings and is waiting for the user in its
conversation — see [`spec-review.md`](./spec-review.md).

The gates repeated in the rail mirror `checkStageGate` in
`server/routes/epics.ts`, which stays authoritative: the client decides whether
to *offer* a button, and a start the server refuses surfaces its 409 on the page.

### The "Mark complete" backstop

`POST /api/epics/:id/stages/:stage/complete` sets a stage flag by hand, for the
cases that never reach `mark_stage_complete`: a stage finished
outside its conversation, an agent that forgot to call the tool, a flag the user
wants set to unblock the next stage — and, for the specification review, the
user skipping the gate.

It is deliberately **one-way** — nothing clears a flag. Stages stay re-runnable
regardless, so un-marking has no meaning. The stage↔flag mapping lives in
`server/constants/epicStages.ts` and is shared with the MCP tool, so the button
and the agent can never disagree about what 'specification' means. Both emit
`epic-updated`, so an open page reflects either immediately.

## Reading what the stages produced — the Artifacts tab

`EpicDetailPage` splits into two tabs. **Main** is the work, in four titled
sections that mirror the pipeline: **Framing** (the four-stage rail),
**Implementation** (the orchestration controls plus the tickets in execution
order, one expandable row each), **Delivery** (the final pull request and the
conversations that land it — see [`delivery.md`](./delivery.md)) and **QA**
(the scenario book and its execution — see [`qa.md`](./qa.md)). **Artifacts**
is what the pipeline
produced, as an ordered index of `CollapsibleSection`s — functional
specification, architecture document, technical specification, specification
review report, QA scenarios — each **folded by default**. A folded section's browser is not
mounted, so nothing fetches bytes until the user expands it (the browsers
auto-load their first file on mount).

- **Architecture document** — `EpicMarkdownBrowser` over
  `GET /epics/:id/architecture[/:filename]`: the markdown the architecture stage
  wrote into the archive's `architecture/` directory, rendered with its mermaid
  fences drawn. Normally one `architecture.md`; a split reads in order because
  the server lists the directory sorted by name and the first file opens by
  default. Until the stage has written anything the section shows a note that
  points at starting it.
- **Technical-specification documents** — the *same* `EpicMarkdownBrowser`,
  mounted a second time over `GET /epics/:id/docs[/:filename]`, with
  `00-master.md` opened by default because that is the map (first file, sorted).
- **Specification review** — the same browser a third time, over
  `GET /epics/:id/review[/:filename]`: the one `review.md` the review stage
  keeps current (findings and what became of each, what was verified). Until
  the stage has run the section says so and points at starting it.
- **Functional spec** — `EpicSpecFilesSection`: the uploaded files shown *raw*.
  This is the pipeline's input; when checking an agent's output, what matters is
  what the file actually says, and the agents read these same bytes. The
  specification review amends these files in place on the user's confirmation
  of a deviation; the shared browser's mtime-keyed cache reloads them.

All four use one `EpicFileBrowser` shell — they differ only in where bytes come
from and how they render. `EpicMarkdownBrowser` owns nothing but the markdown
rendering: `EpicDetailPage` hands it the file list and a loader per section, so
the component never imports `api`. Selection is the single trigger for loading a
file, and content is cached per file *version* (size + mtime): a click that also
fetched would race the effect and read the same document twice, and agents
revise documents in place, so a same-name rewrite must still reload.

Liveness needs nothing extra. The page's existing refetches (`epic-updated`,
`streaming-ended`, `agent-run-updated`, the 10 s poll while a stage runs)
re-list both directories; a rewritten file changes its cache key, and a newly
written file is auto-selected because it is the first one.

Both document sections are read-only by design: documents are revised by asking
in the stage's conversation, never edited here — the transcript is how they got
to their current state.

### Mermaid inside documents

`docsMarkdownComponents` extends the shared `markdownComponents` with one
override: a ```mermaid fence renders as `ExpandableMermaidDiagram` — the inline
diagram (`MermaidDiagram`, shrunk to the document column) plus an "Open full
size" overlay button. The button is a *sibling* of the diagram rather than a
wrapper, because the render-failure fallback is a `<pre>` and block content
cannot sit inside a `<button>`.

**Click to expand.** The affordance opens `DiagramModal`, a single-diagram
full-screen viewer built on the generic `DiagramPanZoomPane` + `panZoom.ts`:
drag to pan, wheel to zoom toward the cursor, `+`/`-`, `0` fit, `1` actual
size, Esc / Close / backdrop to close. It opens fitted and centred
(`FITTED_CAMERA` — the camera is stored relative to each diagram's own fit, so
the same camera works for any diagram size). The modal portals to
`document.body`: it would otherwise mount inside the browser's `prose-sm`
wrapper, whose typography descendant rules restyle headings, paragraphs and
`kbd`. It takes focus on open and hands it back to the affordance on close. A
source mermaid cannot parse shows the error card *without* the source in the
viewer — the inline diagram already shows it. The `open` state lives in each
affordance, not in a per-render components table: `docsMarkdownComponents` is a
module constant, and anything else would remount every diagram on each render.

**Scoped to the epic's document surfaces only.** Architecture and
specification documents genuinely contain diagrams (the review report reuses
the same renderer), whereas chat transcripts
routinely quote mermaid *as source* — someone pasting a broken diagram to ask
about it should see their text, not an error card. Global chat markdown is
untouched.

## Implementation — orchestration and the tickets, one section

`EpicImplementationSection` is the whole implementation stage on one card:
the orchestration header on top, the tickets below it. It replaced the earlier
three-surface layout (an Implementation row and a PR-review row in the rail, a
ticket list, and an orchestration panel at the bottom of the page) — twelve
tickets meant twelve orchestrator and twelve reviewer conversations flattened
into two rail disclosures, and the one primary action was duplicated across
the rail and the panel.

**The header** carries the status chip, the merged count, and the stage's one
primary button — Start orchestration / Pause / Resume — rendered by
`OrchestrationActionButton` from `primaryOrchestrationAction`
(`orchestrationAction.ts`): Start needs `stories_complete` **and**
`review_complete` and at least one ticket — the same gate
`POST /epics/:id/orchestrator/start` enforces — and its tooltip names the
missing one. Once every ticket has merged the function returns `null` and the
button disappears: the stage is over, and the epic's own pull request belongs
to Delivery below (folding "Open final PR" in here made the epic's last action
read as a fourth orchestration step). The section additionally holds Start while a framing stage's
agent is running (the one-stage-at-a-time rule, which the server enforces
too). The **status chip** reads `orchestrationStatus` — Running while
`orchestration_active`, Paused on a block, Completed once every ticket has
merged — never the latest `epic-orchestrator` run, whose status is
`completed` for most of an active orchestration precisely because the
orchestrator is dormant between events. Below the controls: a segmented
progress bar (one segment per ticket, colored like the rows), the
"Currently on #n" line, and the blocked banners (the orchestrator's own
reason, and any `workflow_blocked` tickets by position).

There is deliberately **no live feed**. The orchestrator is dormant between
events — it wakes, takes one decision, and its subprocess exits — so a spinner
would be lying for hours at a stretch. The section renders the state those
decisions leave behind, and the one urgent thing (an escalation) arrives as a
push notification and as the banner.

**The tickets** are listed in **execution order**, not in kanban columns: an
epic's tickets are a sequence — the orchestrator runs them in `position`
order, each assuming the previous merged — and splitting them by status would
scatter that sequence across four lists. Each row's **background is its
state**, the same palette as the task page's agent list (`AgentSection`):
green = merged, blue = in progress / in review, red = `workflow_blocked`,
plain = not started — so the list itself is the progress visualization. The
LIVE dot still comes from the ticket's task channel.

**A row expands** (chevron; clicking navigates nowhere) to the conversations
attached to that ticket, with the cardinality the run model dictates
([`orchestrator.md`](./orchestrator.md)): **one orchestration conversation**
— one run + conversation per ticket, resumed at every wake, so it is a single
labeled row without a status chip (the dormant run's `completed` would lie) —
and **the PR-review conversations, plural, newest first, each with its run
status**: a retry or a GitHub review landing mid-orchestration starts a fresh
reviewer, so a ticket legitimately accumulates several. Both are found by
`ticket_task_id` on the epic's agent runs. The expanded panel and a
quick-action icon on the collapsed row both open the normal task screen:
ticket-level agent detail belongs there.

A stopped reviewer has status `blocked` and still counts as the one review in
flight. The implementation header therefore continues to describe that ticket
as being reviewed while the paused banner offers Resume; it never implies that
a second reviewer should be launched.

## Delivery — the final pull request, and its conversations

`EpicDeliverySection` is the third Main-tab section: **Switch Server**, **New
conversation**, **Open final PR**, and every `epic-delivery` run's conversation
newest first, each labelled by its conversation name with its run status.
**Switch Server** points the project's served symlink at the epic's feature
branch so the whole epic can be clicked through at the project URL — the same
control and endpoint the task page uses, and the project board's "Serving: …"
pill then names the epic (see
[`../web-server/switch-server.md`](../web-server/switch-server.md)). It is where a merge
conflict on the feature branch gets resolved, and where a `@`-mention on the
final pull request lands — the webhook starts the same kind of run, so both
show up in one list. Both buttons say why they are disabled rather than letting
the user meet a bare error. The whole design, and why delivery is an agent with
a section rather than a fifth stage with a flag, is
[`delivery.md`](./delivery.md).

## Liveness

Two channels, because they carry different things:

- the **epic channel** (`subscribe-epic`, Phase 2) — stage runs, the row's own
  flags via `epic-updated`, conversations;
- the **task channels** of the epic's tickets — `useTasksLiveSubscriptions(ticketIds)`,
  the same hook the board uses. This is what lights a ticket's LIVE dot on the
  epic page while its implementation agent works; the epic channel says nothing
  about ticket-level agents. Fan-in is bounded by the ticket count (~5–20).

A 10s poll backstops a silently dropped socket while any stage is running.

The page also refetches on `conversation-added` and `conversation-name-updated`:
a delivery conversation the GitHub webhook started belongs to no click of the
user's, and its AI title lands after its first turn.

`epic-updated` fires from `mark_stage_complete` (any stage's agent signing the
stage off), the "Mark complete" backstop route, and epic CRUD
(`PATCH /epics/:id`). The architecture stage has no completion handler of its
own any more: its turn ends with the generic run-status broadcast, and the flag
moves only on explicit sign-off — which is why the page refetches on
`streaming-ended` as well, to pick up a document the agent wrote without
signing off.

## Key files

- `src/components/Dashboard/BoardView.tsx` — the `Tasks | Epics` toggle (`tab` prop, URL-driven).
- `src/components/epic/EpicsPanel.tsx` — the tab's cards; stage dots are flags, not runs.
- `src/pages/EpicDetailPage.tsx` — the two tabs, composition + both subscriptions.
- `src/components/epic/EpicStageRail.tsx` — the four framing stages, gates, backstop, per-stage conversation disclosures.
- `src/components/epic/CollapsibleSection.tsx` — the artifacts tab's folded sections (children unmounted while folded).
- `src/components/epic/{EpicFileBrowser,EpicMarkdownBrowser,EpicSpecFilesSection}.tsx` — reading surfaces; `EpicMarkdownBrowser` is mounted three times (architecture, technical specification, specification review).
- `src/components/epic/docsMarkdown.tsx` — mermaid-in-markdown, the document surfaces only.
- `src/components/epic/ExpandableMermaidDiagram.tsx` — the inline diagram + "Open full size" affordance.
- `src/components/epic/DiagramModal.tsx` — the single-diagram full-screen viewer (portal, focus in/back).
- `src/components/epic/{DiagramPanZoomPane.tsx,panZoom.ts}` — the pan/zoom viewport and its pure camera geometry.
- `src/components/MermaidDiagram.tsx`, `src/hooks/useMermaidSvg.ts`, `src/components/MermaidErrorCard.tsx` — rendering one source to SVG, and the two failure cards.
- `src/components/epic/EpicImplementationSection.tsx` — the orchestration controls + the expandable ticket rows with their per-ticket conversations.
- `src/components/epic/EpicDeliverySection.tsx` — the final pull request and its conversations.
- `src/components/epic/orchestrationAction.ts`, `OrchestrationActionButton.tsx` — the orchestration state and its one primary action.
- `server/constants/epicStages.ts` — the stage↔flag mapping shared by the tool and the route.
- `server/routes/epics.ts` — the backstop route and `broadcastEpicRow`.
