# Provider connection UI — connect panels, the gate, model pickers

The frontend side of providers: how a user connects a backend, the gate that
forces ≥1 connection, the shared model picker, and the per-agent model settings
tab. Backend counterparts are in [`credentials.md`](./credentials.md) and the
per-provider docs.

## The three connect panels

One panel per provider, each owning its own connect/disconnect flow and success
state:

- **`ClaudeAuthPanel`** — drives the OAuth PTY flow via `ClaudeAuthContext`
  (`src/contexts/ClaudeAuthContext.tsx`): start login → show the authorize URL →
  paste the code → poll status. See [`claude.md`](./claude.md).
- **`CodexAuthPanel`** — device-auth: shows the URL + device code, then polls
  `/api/codex-auth/status` (no code paste-back). See [`codex.md`](./codex.md).
- **`OpenCodeAuthPanel`** — a plain Zen-key text field (`PUT
  /api/opencode-auth/key`); no login subprocess. See [`opencode.md`](./opencode.md).

The same three panels render in **two places** — there is one source of truth per
provider: inside `ProvidersModal` (the blocking gate) and in **Settings →
Providers** (`Settings.tsx`, the `'providers'` tab). `ClaudeAuthContext` exposes
`requireClaudeAuth()` so flows that need Claude specifically can pop the modal.

## The ConnectedProviders gate

`ConnectedProvidersContext` (`src/contexts/ConnectedProvidersContext.tsx`) tracks
which providers the user has connected (via `GET
.../connected-providers`) and renders a **non-dismissable `ProvidersModal`** until
`hasAny` is true — a user can't reach the app without credentials for ≥1 provider
(agents/chats would have no backend). While blocked it polls every 2.5 s so the
modal self-dismisses the moment any panel connects. Connecting a provider also
seeds the user's per-agent model settings server-side, so once `hasAny` flips the
user is fully set up. Must be nested **inside** `ClaudeAuthProvider` (the modal's
`ClaudeAuthPanel` consumes `useClaudeAuth()`).

## The shared ProviderModelPicker

Every place that starts a conversation lets the user pick an explicit
`(provider, model[, effort])` pair — **the server never defaults a model**.
`useProviderModelSelection()` (`src/hooks/useProviderModelSelection.ts`)
centralises that state: the connected-provider filter, the OpenCode catalog
fetch, the provider→model reset, and the derived dropdown options.
`<ProviderModelPicker/>` (`src/components/ProviderModelPicker.tsx`) is the
presentational pair driven by that hook — reused by the New Conversation, Ask-a-
Question, and Fix-CI modals (see
[`../conversations/chat-ui.md`](../conversations/chat-ui.md)). `preferredProvider`
picks the highest-priority *connected* provider (`anthropic > openai > opencode`)
as the default. OpenCode model labels come from the live Zen catalog; Anthropic /
OpenAI labels are static.

## The AgentModels settings tab

**Settings → Agent Models** (`AgentModelsTab.tsx`, the `'agentModels'` tab) sets
the per-user `(provider, model, effort)` for each of the six agent types **plus**
the `schema` key. It filters each row's provider dropdown to the user's connected
providers, and lazy-loads the OpenCode catalog when `opencode` is connected. Each
row is an `AgentModelSettingRow`. Persists to `user_agent_model_settings`
(see [`../architecture/data-model.md`](../architecture/data-model.md)); the
backend resolver is `agentModelSettings.ts` and the settings shape lives in
`shared/types/agentModelSettings.ts`.

### The Anthropic-locked key (non-obvious)

`AGENT_TYPES_WITH_SETTINGS` is the six task agent types plus the `schema` key
and six epic stage keys
(`shared/types/agentModelSettings.ts`): `schema` (the Explore
schema-generation model) and one per epic stage agent — `epic-architecture`,
`epic-specification`, `epic-stories`, `epic-spec-review`, `epic-orchestrator`,
`epic-pr-review`.
Only **`schema` is always seeded and backfilled to Anthropic**: the code-atlas
engine still attaches directly to the Claude SDK. Every epic stage is selectable
between Claude Code, Codex and OpenCode because its Bottega tools and question
lifecycle use the portable MCP runtime. `ANTHROPIC_LOCKED_DEFAULTS` is the map the seeder
(`buildSeedSettings`), the zod boundary
(`shared/schemas/userAgentModelSettings.ts`) and the UI's `lockedProvider` all
read. The existing epic-key backfills still ensure every pre-existing user row
has a complete settings shape, but those values are defaults rather than locks.

> Every epic key lands together with its backfill on purpose: the loader fails
> loud on ANY missing key, so a key and its backfill must ship in the same
> release (`epic-pr-review` and `epic-spec-review` followed the same rule on
> 2026-08-23). The
> backfill also carries a user's v0 `epic` choice into `epic-architecture` and
> drops the stale key (the PUT schema is `.strict()`).

> The **Account** tab's `ApiKeyPanel` manages the Bottega *app* API key
> (`ccui_…`), not a provider credential — that belongs to
> [`../auth/authentication.md`](../auth/authentication.md), not here.

## Key files

- `src/components/{ClaudeAuthPanel,CodexAuthPanel,OpenCodeAuthPanel}.tsx` — the connect panels.
- `src/components/ProvidersModal.tsx` — the blocking modal hosting all three.
- `src/contexts/ConnectedProvidersContext.tsx` — the ≥1-provider gate.
- `src/contexts/ClaudeAuthContext.tsx` — Claude OAuth UI state + `requireClaudeAuth`.
- `src/hooks/useProviderModelSelection.ts` + `src/components/ProviderModelPicker.tsx` — the shared picker.
- `src/components/{AgentModelsTab,AgentModelSettingRow}.tsx` — per-agent model settings.
- `shared/types/agentModelSettings.ts:48` — `AgentModelKey` (incl. the `schema` key);
  `:93` `SCHEMA_DEFAULT_SETTING`, `:133` the `key === 'schema'` schema-lock special-case.
- `server/services/agentModelSettings.ts` — the per-user settings resolver (`loadAgentModelSettings`, `resolveResumeModelEffort`);
  `server/database/db.ts:170` — Anthropic backfill seeding of `schema` onto existing user rows.
