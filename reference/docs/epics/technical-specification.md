# The technical-specification stage — and the `bottega` MCP server

The second stage of the epic pipeline. After the architecture document, an
interactive provider-selected conversation interrogates the user about everything the
functional spec left open, explores the repo read-only, writes a set of
technical-specification documents into the epic archive, iterates across turns
until the user approves — then signs the stage off itself through an MCP tool.

The entity and the run
machinery it plugs into are [`entity-and-conversations.md`](./entity-and-conversations.md).

## The `bottega` MCP server

This phase introduces the channel every later epic agent acts on Bottega
through: a **provider-neutral MCP catalog**
(`server/services/epics/bottega/mcpServer.ts`). Claude adapts the definitions to
an in-process `createSdkMcpServer`; Codex and OpenCode receive a fresh
bearer-authenticated loopback Streamable HTTP endpoint per turn. In every case
the handlers run in Bottega as the acting user. Prompts refer to portable tool
names such as `mark_stage_complete`; harness-specific prefixes are incidental.

The catalog is **per agent type**, not per conversation, so a stage is handed
exactly the verbs it is allowed to use:

| Agent type | Tools | |
|---|---|---|
| `epic-architecture` | archive list/read/write/edit + `mark_stage_complete` | signs the architecture document off |
| `epic-specification` | archive list/read/write/edit + `mark_stage_complete` | |
| `epic-stories` | + `create_task`, `list_epic_tasks`, `update_task`, `delete_task` | [`stories.md`](./stories.md) |
| `epic-spec-review` | the stories catalog + `mark_stage_complete` — it revises the tickets the user approves a finding against, and edits `spec/`, `architecture/` and `docs/` with its writers | [`spec-review.md`](./spec-review.md) |
| `epic-orchestrator` | the drive-a-ticket catalog up to the pull request — no sign-off, `implementation` has no flag | [`orchestrator.md`](./orchestrator.md) |
| `epic-pr-review` | `merge_task` + `block_epic` — the per-ticket PR reviewer does everything else with its shell | [`orchestrator.md`](./orchestrator.md#the-pr-reviewer) |

Every epic stage run gets a server; the injection layer still attaches none for
an empty catalog, defensively.

`withBottegaMcpServer` and `portableBottegaTools`
(`server/services/epics/bottegaInjection.ts`) are the two transport adapters.
The owner adapter exposes them to Claude's SDK assembly and the remote gateway
respectively, on both a new conversation and resume. They derive everything
from the **DB rows** —
conversation → derived `epic_id`, then
`epicAgentRunsDb.getByConversationId` → agent type — never from the caller's
arguments, so a WS resume, a follow-up message and the 401-retry path all
re-attach the same catalog. Task conversations, and manual epic chats with no
linked run, are untouched.

Tool handlers never throw: a guard violation is a `fail()` result the model
reads and reacts to (`server/services/epics/bottega/toolResult.ts`).

### `mark_stage_complete({ stage })`

Guards: the stage must be the one this conversation's agent type owns, it must
have a flag, and that flag must not already be set. Effects:
`epicsDb.setStageComplete` and an `epic-updated` broadcast on the epic channel.
That is all: **the stage's output is the whole hand-off** to the next stage.
The tool's description is per stage: the specification review's adds that the
approval is of the corrected state — every finding the user approved applied
to the documents and tickets (see [`spec-review.md`](./spec-review.md)).

It used to take an optional `summary` (≤4000 chars, persisted to
`…/epic-{id}/summaries/{stage}.md` and path-listed in every later epic
conversation's context prompt). Dropped on 2026-08-23, for three reasons. It
created a second level of information beside the documents, so "what the next
stage needs" had two homes and the documents were not held to being complete.
Its prompts asked for four substantive sections while the validator capped the
text at 4000 characters — the first real specification run burned three tool
calls trimming a hand-off note. And nothing read it back: the UI never showed
it, no route served it, `readEpicStageSummary` had no production caller, and
downstream prompts never told the next agent to open it. The specification
prompt now carries the requirement the summary was papering over — see
[The specification agent](#the-specification-agent).

Why a tool rather than a CLI script (the `complete-plan.ts` pattern the task
agents use): it works for every stage whatever its tool surface, the argument is
typed and validated, and the effect broadcasts in-process. Why not only a UI
button: the approval stays in the transcript that produced it. The human "Mark
stage complete" button (Phase 6) remains as a backstop.

## The specification agent

Started with `POST /api/epics/:id/agent-runs {agentType:'epic-specification'}`,
gated on `architecture_complete` (set by the architecture agent's own
`mark_stage_complete`, or by the human backstop — so the gate is "the user
approved the architecture document") and on the usual one-stage-at-a-time busy
guard. It runs
through the same `startEpicAgentRun` as every other stage.

**Session config** (`server/constants/epicAgents.ts`):

- cwd = the project's **main checkout**. The dominant activity is repo
  exploration, so relative Grep/Glob must just work; the handful of documents are
  addressed by absolute path. Epics never run in a worktree.
- native Write/Edit/MultiEdit/NotebookEdit are denied. Documents are written
  through `write_epic_document` / `edit_epic_document`, whose handlers enforce
  the archive and stage boundary identically for all harnesses. Sub-agents and
  **Bash stay on**. Bash was denied at first as a mutation
  risk in the real checkout. That bought nothing a task agent does not already
  have (a task agent's shell is not confined to its worktree either) and it
  blocked the stage's actual job: the first real specification run could not
  read a pull request or another branch, and because sub-agents inherit
  `disallowedTools`, delegating did not help. The prompt now carries the rule
  instead — the shell reads (`git log`, `git show <ref>:<path>`, `gh pr diff`),
  it never changes the checkout's state.
- `permissionMode: 'bypassPermissions'`, like every Bottega turn. `ask_user`
  persists the question and resumes the selected harness through the standard
  question widget.

**The message** (`generateEpicSpecificationMessage`,
`server/constants/epicAgentPrompts.ts`) renders `epic-specification.md` with the
epic name and id, the spec directory and its files as absolute paths, the
architecture directory and its file(s) as absolute paths (or a note that no
document was written), the docs directory **and its current contents**, and the
repo path. The prompt asks the specification to stay **consistent** with the
architecture document — same decisions, same names — while leaving the
sub-document split to the agent. The docs listing is what makes a re-run
revision-aware: a second run continues the document set instead of starting a
parallel one.

**The prompt** (`server/constants/prompts/epic-specification.md`, operator-
overridable like every other) opens by telling the agent who reads the
documents: agents, which see nothing else — not the other documents, not the
functional spec, **not this conversation** — and cannot ask. From that it
derives the **two acceptance criteria** the stage is held to, and the test
`promptRenderer.test.ts` pins:

1. **No open questions.** No "TBD", no options-with-a-recommendation, no
   "the team decides". Every fork is taken; what cannot be settled is taken out
   of scope explicitly. The agent asks in as many `ask_user` rounds as it takes
   (the prompt caps each round at four questions).
2. **Entirely self-contained.** After reading the documents an implementer
   holds 100% of what the feature needs. The test the prompt gives the agent:
   *if you would feel the need to tell the next agent something in chat, it
   belongs in the documents.*

The process has a step for each: interrogate before writing, and — new —
**check both criteria before recapping**, re-reading every document as a
single-ticket implementer who cannot ask; a gap that needs the user becomes a
question now, a gap that only needs the conversation gets written in. The recap
"carries no information the documents do not" — a "what the next stage needs
to know" paragraph in chat is named as the symptom of a gap. The motivating
run (epic 4, 2026-08-23) ended exactly that way: eight approved
documents, then a closing message listing four things "I'd want carried forward
if the split gets handed to someone new".

The prompt also pins the output contract — `00-master.md` (light overview + an
index table) plus `NN-topic.md` sub-documents, each **self-contained enough to
be cited alone**, ~400 lines max, "decisions, never questions" — and that
complete is not long: the facts an implementer cannot invent and the decisions
it must not re-take, not prose around them. Follow-up messages are revision
requests: edit in place, keep the index accurate, never fork versioned copies;
a follow-up that settles something is written into the documents, not just
acknowledged.

The self-contained rule is the isolation principle showing up again: a ticket
points an implementing agent at *one* document, and that agent sees nothing else
about the epic — see [`stories.md`](./stories.md).

## Write containment

Three stages write files — architecture, specification and the specification
review — and all run in the user's real checkout. Native writers are denied;
all archive writes go through `documents.ts`. It lexically confines the path,
rejects symbolic-link escapes, checks the stage-owned directory, limits files
to 1 MB, and replaces through an atomic temporary rename. The review owns all
four of `review/`, `spec/`, `architecture/` and `docs/`; the earlier stages own
only their output directory. `getEpicStageWritableDirs` is the single mapping.

The older Claude PreToolUse gate remains defense in depth for a historical
session whose native write surface was already assembled. Portable tools are
the cross-harness enforcement boundary. Both the portable catalog and the
stage's native-tool denials are derived from conversation/run rows again on
every resume, so a revision weeks later has the same surface as the first turn.

## The archive

```
~/.bottega/projects/{projectId}/epics/epic-{epicId}/
├── spec/          uploaded functional specification (read-only to every stage but the review, which amends it on the user's confirmation)
├── architecture/  the architecture document — the architecture stage's writable surface
├── docs/          the technical specification — the specification stage's writable surface
├── review/        the specification review's report — the review stage's writable surface (see spec-review.md)
└── orchestrator/  the orchestrator's own outcome notes (Phase 7, see orchestrator.md)
```

`docs/` stays purely the technical specification: an implementing agent sent to
read one document must never find any epic-wide narrative next to it. There is
no `summaries/` any more (see `mark_stage_complete` above); an epic signed off
before 2026-08-23 may still carry the directory on disk, and nothing reads it.

## `epic-updated`

A new server→client message on the epic channel carrying the epic's status and
its four stage flags. Emitted by `mark_stage_complete` (every stage, the
architecture one included) and by the epic CRUD routes (PATCH, the stage
backstop, the orchestrator endpoints). `useEpicEvents` exposes it as
`onEpicUpdated`; Phase 6's stage rail renders from it.

## UI

The stage sits in `EpicStageRail` on `EpicDetailPage`, and the documents it
writes are read in `EpicDocsBrowser` right below (markdown, with mermaid fences
rendered) — see [`ui.md`](./ui.md). Starting the stage navigates into its
conversation, which *is* the live view.

## Edge cases worth knowing

- **The user never approves** — nothing is signed off; the documents still exist
  and the stage stays re-runnable. Nothing else in the pipeline is blocked
  except the stories stage, whose gate reads `specs_complete`.
- **The specification review finds a gap here** — it is fixed in the review
  conversation, by the reviewer, once the user approves the finding; this
  conversation is not reopened.
- **Re-running the stage** starts a *new* conversation whose message lists the
  existing documents. Revising in the old conversation and re-running both work;
  the documents are the state, the transcript is only how they got there.
- **`mark_stage_complete` twice** fails with "already marked complete" — the
  flag is set, and the only other way to set it is the human backstop
  (`POST /epics/:id/stages/:stage/complete`), which refuses for the same reason.
- **A stage that writes nothing** is possible (the agent could sign off after
  pure discussion). Nothing enforces file count; the user's approval is the gate.
- **Operator prompt overrides** written before this phase are unaffected — the
  new prompt is a new name, and `render()` only throws on variables the template
  uses that the caller did not supply.
