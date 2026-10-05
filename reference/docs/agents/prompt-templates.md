# Agent prompt templates — defaults, per-instance overrides, the editor

Each agent type renders a message from a Markdown prompt template. This is the
override model and the settings UI that edits it. The agents that consume these
are in [`agentic-loop.md`](./agentic-loop.md).

## The bundled defaults

`server/constants/prompts/*.md` ships one file per agent type:
`planification.md`, `planification-nontechnical.md`, `implementation.md`,
`review.md`, `refinement.md`, `pr.md`, `pr-feedback.md`, `yolo.md`, the
non-technical guardrail's `planification-sensitive-areas.md`, plus the
Explore `atlas-artifact.md` and the epic pipeline's `epic-architecture.md`,
`epic-specification.md` and `epic-stories.md`. The matching agent-message
builders live in `server/constants/agentPrompts.ts` (e.g.
`generateImplementationMessage`) — what `startAgentRun`'s `switch` calls — and,
for epics, in `server/constants/epicAgentPrompts.ts`
(`generateEpicArchitectureMessage`, `generateEpicSpecificationMessage`,
`generateEpicStoriesMessage`, called by `startEpicAgentRun`; see
[`../epics/entity-and-conversations.md`](../epics/entity-and-conversations.md),
[`../epics/technical-specification.md`](../epics/technical-specification.md) and
[`../epics/stories.md`](../epics/stories.md)).

> `epic-architecture.md` was called `epic-planning.md` in the v0 spike. An
> operator override saved under the old name is orphaned — re-save it under the
> new one.
>
> The architecture-stage redesign (2026-08-22) changed two variable sets:
> `epic-architecture` now takes `epicId`, `epicName`, `specDir`, `specFileList`,
> `architectureDir`, `architectureFileList`, `repoPath` (the single
> `SPEC_FILES_SECTION` is gone), and `epic-specification` takes
> `architectureDir`/`architectureFileList` instead of
> `beforeMermaid`/`afterMermaid`. An operator override of either prompt that
> still references a retired variable throws at run start (`render` fails loud
> on a variable the dict lacks) — re-save it from the new default.

`server/constants/templates/plan-template.md` is a `kind: 'template'` (its
`{{ }}` markers are literal, never `render()`-ed) — the plan skeleton whose full
content planification inlines into its prompt as `{{planTemplate}}`, wrapped in
a `<plan-template>` block.

The non-technical guardrail's list is **per project**, not a template:
`projects.sensitive_areas` (edited on the Edit project page and the New Project
modal, `src/components/SensitiveAreasField.tsx`) holds the parts of the
application a non-technical user must not change without a technical review.
`startAgentRun` hands it to `generatePlanificationMessage`, which uses it for the
**non-technical** prompt only: blank after trim → `{{sensitiveAreasSection}}`
renders to nothing and the guardrail is absent from the prompt altogether;
non-blank → the list is wrapped in `planification-sensitive-areas.md` (the
escalation protocol: one plain-language `ask_user` offering *ask a technical
team member* / *leave that part out* / *use a simpler alternative*, and on
escalation `scripts/block-workflow.ts` instead of a plan) and injected between
the prompt's Audience and Planning Workflow sections. On/off is decided in code,
never by the agent. The protocol prompt itself stays instance-wide and editable.
A `PromptDefinition` may carry a `description`, surfaced under the label in the
editor.

## promptRenderer — default vs override

`server/services/promptRenderer.ts` owns resolution. Every prompt has a
**definition** in `PROMPT_DEFINITIONS` (`:52`): `name`, `label`, `kind`
(`prompt`|`template`), `file`, and an **allowlist of `variables`**. Resolution is
two-layer:

- **Default** — bundled at `server/constants/{prompts,templates}/`.
- **Override** — a same-named file under the `~/.bottega/{prompts,templates}/`
  archive (`BOTTEGA_ARCHIVE_ROOT`). `loadPrompt(name)` (`:184`) returns the
  override if present, else the default — so an instance can re-tune any agent
  without code changes.

`render(template, vars)` (`:223`) replaces `{{var}}` and **throws on a missing
variable** (fail loud, no silent empty string). `findUnknownVariables` (`:256`)
validates a candidate override against the allowlist before save (templates skip
this — their `{{ }}` are literal).

One variable is **built in**: `{{scriptsDir}}`, the absolute path of this
install's `scripts/` directory (`getScriptsDir`, resolved from the module's own
location). `render` supplies it to every prompt and `allowedVariables` adds it to
every prompt's allowlist, so the completion-script commands the prompts hand to
agents (`tsx {{scriptsDir}}/complete-plan.ts {{taskId}}`) work wherever Bottega
is installed.

**Never `@`-reference a Bottega-installation path from a prompt.** Task agents
run with the *target repo* as their project; an `@`-file mention of a path
inside the Bottega checkout makes the Claude Agent SDK attach Bottega's own
`CLAUDE.md` alongside the file, leaking Bottega's project docs into the target
repo's agent context. Inline content instead: planification passes the plan
template's full text as `{{planTemplate}}` (`loadPrompt('plan-template')`,
override-aware). `resolvePromptPath` (the active path) survives only to feed the
legacy `{{planTemplatePath}}` variable that pre-inlining operator overrides may
still reference. The regression guard lives in
`server/constants/agentPrompts.test.ts` ("never leak Bottega project docs").

The asymmetry is deliberate and load-bearing for upgrades: `render` throws on a
variable the *template* references and the dict lacks, never the reverse. So
adding a variable to an allowlist (as `{{baseBranch}}` did for `pr`, `yolo` and
`pr-feedback`) leaves every pre-existing operator override working untouched —
it simply keeps whatever it had hardcoded until someone updates it.

**Renaming a variable therefore needs the old name kept as an alias.** `pr` and
`yolo` pass the publish step as `{{prPublishBlock}}`; the generators also pass the
identical text under its former name `{{prCreateOrVerifyBlock}}`, and both are on
the allowlist. Without the alias, every override written before the rename would
throw on render rather than degrade. `{{planTemplatePath}}` exists for the same
reason.

**The flip side of overrides: a stale one silently keeps the old behaviour.** An
override is the whole file, so it shadows every later change to the bundled
default — including a fix. The `pr.md` override that was byte-identical to its
default is the worst case of this: harmless-looking, and it would have pinned the
PR agent to the pre-fix procedure after a deploy. When a default prompt changes
for a *correctness* reason, check `~/.bottega/prompts/` and delete the overrides
that no longer differ deliberately (Settings → Agent Prompts → Reset).

## The settings UI + routes

`src/components/AgentPromptsTab.tsx` (Settings → Agent Prompts) lists prompts +
templates, loads one (showing default vs override), edits, **Save** (writes an
override) or **Reset** (deletes the override → falls back to default). It talks to
`server/routes/settings.ts`:

| Method | Route | Effect |
|---|---|---|
| GET | `/api/settings/prompts` | list (`listPromptNames`) |
| GET | `/api/settings/prompts/:name` | default + override + content |
| PUT | `/api/settings/prompts/:name` | `saveOverride` (validates variables) |
| DELETE | `/api/settings/prompts/:name` | `deleteOverride` (reset to default) |

## Key files

- `server/constants/prompts/*.md` — the bundled per-agent prompts.
- `server/constants/templates/plan-template.md` — the plan skeleton template.
- `server/constants/prompts/planification-sensitive-areas.md` — the non-technical guardrail's escalation protocol, wrapped around the project's `sensitive_areas` list by `generatePlanificationMessage`.
- `server/constants/agentPrompts.ts` — the `generate*Message` builders `startAgentRun` calls.
- `server/services/promptRenderer.ts:52` — `PROMPT_DEFINITIONS`; `:184` `loadPrompt`; `:223` `render`.
- `server/routes/settings.ts` — the prompt CRUD endpoints.
- `src/components/AgentPromptsTab.tsx` — the editor UI.
