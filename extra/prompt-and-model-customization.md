# Extra — Prompt and model customization

Two independent customization layers sit on top of the core agents. Neither is
required; core ships fixed prompts and can hardcode a single provider/model
(see [`../core/harness-contract.md`](../core/harness-contract.md)). This extra
makes both **configurable** — the *what an agent says* and the *what runs it*.

## What it adds

1. **Prompt overrides.** Every agent prompt is a markdown template with
   `{{variable}}` placeholders. Defaults ship with the app; a user (or operator)
   can drop a same-named file in an override directory to replace any one of them
   without touching code. A small template engine renders them per run.
2. **Per-user model/effort selection.** Each user stores a full
   `Record<AgentType, {provider, model, effort}>` — which LLM backend, which
   model, and how much reasoning effort each of the six agent roles runs on.
   Core resolves this at run start. The cardinal rule: **the model is always
   explicit and resolved deterministically**, never defaulted or inferred at the
   SDK boundary.

The two layers are orthogonal — you can take prompt overrides without per-user
models, or vice versa — but they share one seam: the agent's turn input. The
prompt layer decides the *message* the agent receives; the model layer decides
the `(provider, model, effort)` triple the harness receives. Both are assembled
in `startAgentRun` (the function core's
[`orchestration-loop.md`](../core/orchestration-loop.md) defers to this spec for
steps 2 and 6).

---

## Layer 1 — Prompt overrides

### Prompts are markdown templates, not string literals

The core agents (planning, implementation, review, PR — plus the `refinement`
and `yolo` extras and the `pr-feedback` webhook variant) each have a default
prompt as a `.md` file under `server/constants/prompts/`, and the plan template
under `server/constants/templates/`. None of the agent logic embeds prompt text;
it loads a named template and renders it.

A **prompt definition registry** is the source of truth for what prompts exist:
each entry carries a `name`, a human `label`, a `kind` (`prompt` or `template`),
the on-disk `file`, and the **allowlisted variable set** that template may
reference. See the `PROMPT_DEFINITIONS` array in
[`../reference/server/services/promptRenderer.ts`](../reference/server/services/promptRenderer.ts).
The registry is what the settings UI lists and what variable-validation checks
against.

### The override lookup: default vs `~/.bottega/prompts/`

Resolution is two-tier and dead simple. For a prompt named `X`:

- The **default** lives at `server/constants/{prompts,templates}/X.md` (bundled
  with the app).
- An **override** may live at `<archiveRoot>/{prompts,templates}/X.md`, where
  `archiveRoot` is `$BOTTEGA_ARCHIVE_ROOT` or `~/.bottega` by default.

`loadPrompt(name)` returns the override file if it exists, otherwise the default
(`loadOverride` → `loadDefault`). That is the entire override mechanism — file
presence wins. `hasOverride`, `saveOverride` (creates the dir, writes, returns
mtime), and `deleteOverride` (revert to default) round out the CRUD; study
`getOverridesDir` / `loadPrompt` / `resolvePromptPath` in `promptRenderer.ts`.
Note this is a **single instance-wide override directory**, not per-user — the
override is an operator-level customization of agent behavior, distinct from the
per-user model layer below.

### The template engine and the variable contract

`render(template, vars)` does `{{var}}` substitution and — critically —
**throws on a missing variable** rather than rendering an empty string, so a
typo'd placeholder surfaces immediately instead of silently corrupting a prompt.
`extractVariables` and `findUnknownVariables` enforce the other direction: a
candidate override may only reference variables in that prompt's allowlist, so a
user can't introduce `{{nonexistent}}` that will blow up at run time. Templates
(`kind: 'template'`, e.g. the plan template) are read **verbatim by the agent**
and never go through `render()`, so `{{ }}` markers in them are literal text and
validation is skipped — see the guard in `findUnknownVariables`.

The variable set per prompt is small and stable: most carry `taskDocPath` and
`taskId`; planning adds `planTemplatePath`; the PR/YOLO prompts add
`prContextLine` and `prCreateOrVerifyBlock`; the feedback prompt adds `prUrl`
and `feedbackSection`. The exact lists are the `variables` arrays in the
registry.

### How `agentPrompts.ts` composes a per-agent message

[`../reference/server/constants/agentPrompts.ts`](../reference/server/constants/agentPrompts.ts)
is the bridge between "a template file" and "the message a turn receives." For
each agent it: pre-builds any **dynamic sections** in JS (loops/conditionals the
template engine can't express — e.g. `buildPrCreateOrVerifyBlock` choosing
"create a new PR" vs "verify the existing PR", or the webhook feedback section
quoting review comments), then calls `renderPrompt(name, vars)` to inject them.
The one cross-prompt reference worth noting: planning injects
`resolvePromptPath('plan-template')` as `planTemplatePath` so the rendered
planning prompt points the agent at the *active* plan template (override if one
exists, else default) by absolute path — see `generatePlanificationMessage`.

This rendered string is the agent's turn `prompt`. It is distinct from the
`customSystemPrompt` (the task-doc context block) — `startAgentRun` passes both
into the conversation. The tech/non-tech planning split
(`planification` vs `planification-nontechnical`) is selected here too, but the
*role logic* behind that choice belongs to
[`auth-and-multi-user.md`](./auth-and-multi-user.md).

---

## Layer 2 — Per-user model and effort

### One settings blob per user, six agents each

Each user owns one row in `user_agent_model_settings` (`user_id` PK,
`settings_json` TEXT) holding their full
`Record<AgentType, {provider, model, effort}>` for the six agent types with
settings (`planification`, `implementation`, `refinement`, `review`, `pr`,
`yolo`). See the table in
[`../reference/server/database/init.sql`](../reference/server/database/init.sql)
and the type in
[`../reference/shared/types/agentModelSettings.ts`](../reference/shared/types/agentModelSettings.ts).
This **replaced** a single global `app_settings.agent_model_settings` blob — the
point of going per-user is that each user runs agents on a provider/model they
actually hold credentials for.

### The per-provider enums

`provider ∈ {anthropic, openai, opencode}`. Each provider owns its own model and
effort namespaces — there is deliberately **no common subset**
([`../reference/shared/providers/models.ts`](../reference/shared/providers/models.ts)):

- **Anthropic** — models `sonnet`/`opus`; efforts `low`…`max`.
- **OpenAI (Codex)** — models `gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini`; efforts
  `minimal`…`xhigh`.
- **OpenCode** — models are a **live, upstream-owned Zen catalog**, so the enum
  is intentionally *empty*; storage uses an `opencode/<id>` prefix and validation
  only checks that shape. **Never hardcode a Zen model id** — a guessed id fails
  loud at the SDK boundary (`Model not found`). OpenCode has no effort dimension
  (reasoning is baked into the model id), so `effort` is `null` and the UI hides
  the dropdown. `isModelForProvider`/`isEffortForProvider` are the validators;
  `MODELS_FOR_UI`/`EFFORTS_FOR_UI` are the dropdown sources.

Capabilities ([`../reference/shared/providers/capabilities.ts`](../reference/shared/providers/capabilities.ts))
are separate from the model/effort enums — that matrix gates Claude-only
features (see the harness contract). This spec only picks the
`(provider, model, effort)`; capability guards are core.

### Resolution at run start — `loadAgentModelSettings(userId)`

[`../reference/server/services/agentModelSettings.ts`](../reference/server/services/agentModelSettings.ts)
owns resolution. `loadAgentModelSettings(userId)` reads the row, parses the JSON,
and validates **every one of the six entries**; a missing row, unparseable JSON,
or any invalid entry throws `MissingUserAgentSettingsError` — it **never returns
a silent default**. `startAgentRun` then:

1. Resolves the acting user (fails if there is none — there's no user to resolve
   settings for).
2. Pulls `loadAgentModelSettings(userId)[agentType]` → `(provider, model, effort)`.
3. **Validates credentials up front** via `getCredentialStore(provider).read(userId)`,
   re-throwing as `ProviderCredentialsMissingError` so the route layer can render
   a "Connect &lt;provider&gt;" prompt (HTTP 403) instead of a stacktrace — this is
   the 403 the core trigger surface mentions.
4. **Stamps `(provider, model, effort)` onto the new `task_agent_runs` and
   `conversations` rows** before starting the turn, then passes them into the
   harness as part of `ProviderRunOptions`.

See `agentRunner.ts` around the `loadAgentModelSettings` call and the
`conversationsDb.create(taskId, provider, model, effort)` line. Stamping the
conversation row is what makes the model **deterministic on resume**.

### The deterministic-model rule

This is the load-bearing invariant, and it mirrors the harness contract: a turn
**never runs on a defaulted or inferred model**. On start, the model comes from
the user's setting; on resume, it comes from the stored conversation row, never
re-derived. `resolveResumeModelEffort` re-resolves `(model, effort)` from the
**resuming** user's setting only when that setting targets the *same provider*
the conversation was created with — **provider is session-bound** and cannot be
switched mid-conversation (cross-provider resume is out of scope). Any
mismatch, an unseeded resuming user, a manual chat, or a programmatic resume
falls back to the row's stored values. The failure mode this prevents is feeding
an OpenAI model name into the Anthropic SDK; the rule is "fail loud, don't guess."

### Seeding and backfill

Because resolution fails loud, every user must be seeded **before** they can run
an agent. Two mechanisms:

- **Seed on first provider-connect.** After a successful credential write,
  `ensureUserAgentModelSettings(userId)` (via the non-throwing
  `seedAgentSettingsAfterConnect` wrapper) seeds all six agents to the highest-
  priority connected provider's default model (`anthropic`→sonnet,
  `openai`→gpt-5.5, `opencode`→the *first live* Zen model — declining to seed if
  none resolves, since guessing an id is forbidden). See `buildSeedSettings` /
  `defaultSettingForProvider`.
- **Backfill.** A one-shot migration replicates the historical global default
  (`DEFAULT_AGENT_MODEL_SETTINGS`, all-Opus/high) into a per-user row for
  pre-existing users. The legacy `provider ?? 'anthropic'` coercion in
  `loadAgentModelSettings` keeps those rows valid.

A **blocking first-login provider modal** is the UX that guarantees a seed
exists: a brand-new user with no connected provider can't dismiss it, so they
can't reach a state where `startAgentRun` would throw on an unseeded user.

### The settings UI and routes

`GET/PUT /api/user-agent-model-settings` reads and replaces this user's full
six-agent map; `GET .../connected-providers` returns which providers this user
has credentials for. The `GET` returns `{ needsSeeding: true }` (not an error)
when the user is unseeded, which the UI uses to show the connect-provider state.
See
[`../reference/server/routes/userAgentModelSettings.ts`](../reference/server/routes/userAgentModelSettings.ts).
The settings tab (a "Agent Models" tab, one row per agent type) filters its
provider dropdown to `connected-providers` and its model/effort dropdowns to the
selected provider's `MODELS_FOR_UI`/`EFFORTS_FOR_UI`. Prompt overrides get their
own settings surface backed by `GET/PUT/DELETE /api/settings/prompts[/:name]`
(list with `isCustomized`, fetch content + default + variable allowlist + mtime,
save with optimistic-concurrency `expectedMtime` 409 and unknown-variable 400,
delete to revert) — see
[`../reference/server/routes/settings.ts`](../reference/server/routes/settings.ts).

---

## What to build

- [ ] A prompt template registry (name, label, kind, file, allowlisted
      variables) as the single source of truth for which prompts exist.
- [ ] A two-tier loader: bundled default vs override-directory file; override
      wins on presence. Plus `save`/`delete`/`hasOverride`.
- [ ] A `{{var}}` template engine that **throws on missing variables**, plus
      variable extraction and an against-the-allowlist validator (skipped for
      verbatim templates).
- [ ] Per-agent message composition that pre-builds dynamic sections in code and
      injects them via render — and a way to reference one active prompt's path
      from another (the plan-template path).
- [ ] A per-user `Record<AgentType, {provider, model, effort}>` store (one JSON
      row per user) with strict load-time validation that **fails loud**, no
      silent default.
- [ ] Per-provider model + effort enums, with OpenCode treated as a live,
      prefix-validated, upstream-owned catalog (never a hardcoded list).
- [ ] Run-start resolution: load the setting, validate provider credentials
      (typed missing-credentials error), stamp `(provider, model, effort)` on the
      run + conversation rows, pass them into the harness.
- [ ] Deterministic resume: read model off the stored row; only re-resolve from
      the resuming user when the provider matches; never infer at the SDK
      boundary.
- [ ] Seed-on-connect + a one-shot backfill, gated by a blocking first-login
      provider modal so no unseeded user can trigger a run.
- [ ] Settings UI: an Agent Models tab (provider/model/effort per agent, dropdowns
      scoped to connected providers) and a prompt-editor surface.

## Reference map

| Concern | File |
|---|---|
| Template engine + override lookup | `reference/server/services/promptRenderer.ts` |
| Per-agent message composition | `reference/server/constants/agentPrompts.ts` |
| Default prompts / templates | `reference/server/constants/{prompts,templates}/*.md` |
| Per-user settings type + seeding helpers | `reference/shared/types/agentModelSettings.ts` |
| Settings load/save/seed/resume resolution | `reference/server/services/agentModelSettings.ts` |
| Run-start resolution + stamping | `reference/server/services/agentRunner.ts` (`loadAgentModelSettings`, `conversationsDb.create`) |
| Per-provider model + effort enums | `reference/shared/providers/models.ts` |
| Settings table | `reference/server/database/init.sql` (`user_agent_model_settings`) |
| Prompt-override HTTP routes | `reference/server/routes/settings.ts` |
| Per-user model HTTP routes | `reference/server/routes/userAgentModelSettings.ts` |
| Missing-credentials error | `reference/server/services/credentials/types.ts` (`ProviderCredentialsMissingError`) |

## Boundaries (not in this spec)

- The provider interface, the `ProviderRunOptions` shape `(model, effort, env)`
  feeds, and the capability matrix that gates provider-specific features →
  [`../core/harness-contract.md`](../core/harness-contract.md).
- Where per-user credentials come from and how `env` is built for the SDK, and
  the tech/non-tech role logic behind the planning-prompt split →
  [`./auth-and-multi-user.md`](./auth-and-multi-user.md).
- Concrete provider/credential integrations (Anthropic OAuth, Codex, OpenCode
  Zen, the live Zen catalog endpoint) → [`./harnesses/overview.md`](./harnesses/overview.md).
- The `startAgentRun` entry point itself, chaining, and the run/conversation row
  lifecycle → [`../core/orchestration-loop.md`](../core/orchestration-loop.md).
- The prompt *content* and the agents' behavioral contracts →
  [`../core/planning-agent.md`](../core/planning-agent.md),
  [`../core/execution-loop.md`](../core/execution-loop.md).
