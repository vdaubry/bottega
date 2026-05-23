# Harness — OpenAI Codex

The Codex provider implements the [harness contract](../../core/harness-contract.md)
against OpenAI's `@openai/codex-sdk`. Read that contract first: `LlmProvider`,
the unified vocabulary, and the streaming runtime are core; this doc only
covers what is *Codex-specific*. Shared mechanics — the capability matrix as a
concept, transcript mirroring as a pattern, per-user credential isolation,
subprocess auth — are written once in [`overview.md`](./overview.md); here we
only call out where Codex diverges.

## What it adds

A second concrete harness, registered under the provider name `openai`. It
proves the contract holds for a tool whose SDK is shaped nothing like Claude's:
no write-through transcript hook, no mid-turn tool-permission callback, no
streaming thinking deltas, a coarser usage report, and a thread/turn session
model instead of Claude's session-resume id. The integration is small but every
one of those gaps is a solved problem below.

## The provider

`CodexProvider` (see
[`reference/server/services/providers/openai/index.ts`](../../reference/server/services/providers/openai/index.ts))
wraps a `Codex` SDK client. `startTurn` calls `codex.startThread(opts)`;
`sendTurnMessage` calls `codex.resumeThread(resumeSessionId, opts)` — **the
`resumeSessionId` IS the Codex thread id** (more below). Both funnel into one
`runStreamed(prompt)` loop that yields `UnifiedMessage`s. Two Codex-specific
shaping decisions live in that loop:

- **Synthetic user message.** The Codex SDK never echoes the prompt back as an
  event, so the provider manufactures a `user` `UnifiedMessage` and yields it
  *first*, before the stream opens. Without it the transcript would have no
  user-side row for the turn. (`buildSyntheticUser` in `index.ts`.)
- **Session id from `thread.started`.** The provider watches for the first
  `thread.started` event, reads `thread_id` off it, and resolves
  `providerSessionId$`. Events before that point carry a `null`
  `providerSessionId`; the mirror buffers them and patches the id in once known
  (see Transcript mirroring).

Active threads are tracked in an in-process `Map` keyed by thread id so
`abortTurn` can find the `AbortController` and cancel; the entry is registered
the moment `providerSessionId$` resolves.

## The Codex session model

Codex speaks **thread → turn → item**. A *thread* is the durable conversation
(its id is what we persist as `provider_session_id`); a *turn* is one
request/response cycle; *items* are the assistant's outputs within a turn
(messages, reasoning, tool calls). The stream is a flat sequence of envelopes:
`thread.started`, `turn.started`/`turn.completed`/`turn.failed`,
`item.started`/`item.updated`/`item.completed`, and a stream-level `error`. We
map only `item.completed` for content — `item.started`/`item.updated` repeat the
same payload incrementally and would double up rows, so they are dropped. The
mapper is the **only** file that imports Codex SDK types; everything above it
sees `UnifiedMessage`.

## Options translation

`buildCodexThreadOptions` (see
[`codexOptionsBuilder.ts`](../../reference/server/services/providers/openai/codexOptionsBuilder.ts))
turns generic `ProviderRunOptions` into the SDK's `ThreadOptions`. The
non-obvious parts:

- **Permission mode → sandbox + approval pair.** Codex has no single
  permission knob; it takes a `sandboxMode` and an `approvalPolicy`. The builder
  maps Bottega's modes onto pairs: `default`→`workspace-write`/`untrusted`,
  `acceptEdits`→`workspace-write`/`never`, `bypassPermissions`→`danger-full-access`/`never`,
  `plan`→`read-only`/`on-request`. The orchestrator's runtime default is
  `bypassPermissions`, so most agent turns run full-access/no-approval.
- **Effort is top-level.** `effort` maps to `modelReasoningEffort` directly on
  `ThreadOptions`, not nested under a config object — confirmed by the SDK spike.
  Codex's effort scale (`minimal`/`low`/`medium`/`high`/`xhigh`) differs from
  Anthropic's; only values in `OPENAI_EFFORTS` pass through, anything else is
  dropped to undefined.
- **`model` is required, never defaulted.** Honoring the contract's
  explicit-model rule: the create-conversation schema and the agent-settings
  validator both gate `model` against `OPENAI_MODELS` upstream, so a Codex turn
  always carries a concrete model and never falls back to an SDK default.
- **`skipGitRepoCheck: true`** is hardcoded — Bottega worktree paths aren't
  always conventional git roots.

## Event mapping

`mapEvent` (see
[`mapEvent.ts`](../../reference/server/services/providers/openai/mapEvent.ts))
turns one `ThreadEvent` into zero-or-more `UnifiedMessage`s:

| Codex event/item | Unified output |
|---|---|
| `thread.started` | `system` (subtype `thread_started`), carries `thread_id` |
| `turn.started` | `system` (subtype `turn_started`) |
| `item.completed` → `agent_message` | `assistant` |
| `item.completed` → `reasoning` | `assistant_thinking` (whole, not delta) |
| `item.completed` → `command_execution` | `tool_use` (`Bash`) + `tool_result` pair |
| `item.completed` → `file_change` | `tool_use` (`FileChanges`) |
| `item.completed` → `mcp_tool_call` | `tool_use` (the tool's own name) |
| `item.completed` → `web_search` | `tool_use` (`WebSearch`) |
| `item.completed` → `todo_list` | `tool_use` (`TodoList`) |
| `item.completed` → `error` | `system` (subtype `item_error`) |
| `turn.completed` | `result` (aggregate `usage`) |
| `turn.failed` / stream `error` | `result` with `isError: true` |

Codex tool calls are normalized to Bottega's existing tool names (the table
above) so the UI renders Codex command-runs and edits with the same components
it uses for Claude. `command_execution` is the one that fans out to a pair —
the in-progress envelope yields just the `tool_use`; the completed envelope
yields `tool_use` + `tool_result`, marking `isError` on a non-zero exit code.
Unknown event/item types degrade to a `system` message rather than throwing.

## Transcript mirroring — the key difference from Claude

This is the headline divergence. Claude's SDK accepts a custom `sessionStore`
and writes the transcript through to SQLite for us (see
[`claude-code.md`](./claude-code.md)). **Codex has no such hook**, so the
provider must explicitly mirror its own events into the same `messages` table.
The rule from the contract still holds: SQLite is the single source of truth;
the SDK's own `~/.codex/sessions/*.jsonl` files are private scratch the runtime
never reads.

`mirrorCodexEvent` (see
[`messageMirror.ts`](../../reference/server/services/providers/openai/messageMirror.ts))
converts each `UnifiedMessage` into the on-disk transcript-entry shape the
existing conversation reader expects — deliberately the *same* shape Claude's
`SDKMessage` rows use (`{ type, uuid, message:{ id, content, usage? }, … }`) —
and appends it via the shared `sqliteSessionStore.append`. Because the reader is
provider-agnostic, reloaded Codex conversations render through the identical
`/api/conversations/:id/messages` path with no Codex-specific reader. Two
correctness details:

- **Idempotent on `uuid`.** `append` upserts on the session-store key, so a
  re-emitted event never duplicates a row. Tool-use and tool-result entries get
  suffixed uuids (`:tool_use`, `:tool_result`) to stay distinct.
- **Buffer-until-session-id.** The synthetic user message (and anything else
  emitted before `thread.started`) arrives with a `null` `providerSessionId`.
  The conversation runtime buffers those events and, the moment the thread id
  lands, replays them with the id patched in, then mirrors live thereafter. The
  mirror is invoked from the Codex conversation orchestrator's stream loop, not
  from inside the provider — see
  [`startCodexConversation.ts`](../../reference/server/services/conversation/startCodexConversation.ts)
  (the buffer/replay around the session-id capture, ~L500–535, and the resume
  path ~L294–308). `loadTranscript` reads those rows back and stamps
  `provider: 'openai'` on the way out.

## Capabilities and feature guards

Codex sets **every** optional capability to `false` (see
[`capabilities.ts`](../../reference/shared/providers/capabilities.ts), the
`openai` block) — the opposite of Claude's all-`true`. Each `false` corresponds
to a code path the runtime must skip via the guards in
[`featureGuards.ts`](../../reference/server/services/providers/featureGuards.ts):

- `supportsAskUserQuestion: false` — Codex has no `canUseTool`-style mid-turn
  hook. Codex agents are instructed *in the prompt* to ask questions in plain
  text; the orchestrator never wires the `AskUserQuestion` tool for an `openai`
  turn (`assertCapability` would throw if it tried).
- `supportsThinkingDelta: false` — Codex emits whole `reasoning` items, not
  Claude-style incremental `stream_event` partials. The thinking-delta
  accumulator path is gated off.
- `supportsContextUsageBreakdown: false` — `turn.completed` reports aggregate
  input/output tokens only, no per-tool breakdown. The live breakdown UI is
  skipped; the aggregate still flows through the context-usage tracker.
- `supportsMcpServers: false` — the Codex CLI has MCP via TOML config, but v1
  intentionally does not wire it into Bottega.
- `supportsImages: false` — image attachments are not supported in v1.

The single mechanism is the flag check at the call site: `hasCapability` /
`withCapability` for skips, `assertCapability` where a path must never reach an
unsupported provider.

## Authentication and per-user credentials

Codex auth is a **device-code** flow, distinct from Claude's. The two-difference
summary (full mechanics in [`overview.md`](./overview.md)):

- **Per-user isolation via `CODEX_HOME`.** Every SDK invocation and every login
  subprocess runs with `CODEX_HOME=~/.config/bottega/users/{userId}/codex/`,
  and `buildCodexSdkEnv` strips every inherited `OPENAI_*`/`CODEX_*` key first
  so a server-global `OPENAI_API_KEY` can never leak into a user's turn. The
  per-user `auth.json` (mode 0600, ownership-checked) is the only credential
  source. See
  [`codexCredentials.ts`](../../reference/server/services/codexCredentials.ts)
  and the `ProviderCredentialStore` adapter in
  [`credentials/openai.ts`](../../reference/server/services/credentials/openai.ts).
- **Device-auth PTY, no code paste-back.** `codex login --device-auth` runs
  under `node-pty`; the CLI prints a constant URL *and* a rotating device code,
  both surfaced to the UI. The user enters the code in their browser; the CLI
  talks to OpenAI directly and writes `auth.json` on exit-0. Bottega only
  watches the subprocess — there is no "complete" endpoint, so the frontend
  polls `/status` (success = exit-0 + a usable `auth.json` on disk). See
  [`codexAuthFlow.ts`](../../reference/server/services/codexAuthFlow.ts) and the
  routes in [`codexAuth.ts`](../../reference/server/routes/codexAuth.ts)
  (`/status`, `/start`, `/cancel`, `/paste`, `DELETE /`). A `/paste` fallback
  accepts the JSON of a working `auth.json` directly. `auth.json` can hold
  either OAuth tokens or an `OPENAI_API_KEY`; the status reader supports both.

## What to build

- [ ] A `CodexProvider` implementing `LlmProvider`, registered as `openai`,
      wrapping the Codex SDK's `startThread`/`resumeThread` + `runStreamed`.
- [ ] A synthetic `user` message yielded first (the SDK doesn't echo the prompt).
- [ ] An options builder mapping permission mode → `sandboxMode`+`approvalPolicy`,
      `effort` → `modelReasoningEffort`, an always-explicit `model`, and
      `skipGitRepoCheck`.
- [ ] An event mapper: thread/turn/item envelopes → `UnifiedMessage`, mapping
      only `item.completed`, normalizing tool names, fanning `command_execution`
      out to a use/result pair.
- [ ] **Explicit transcript mirroring** into the shared `messages` table
      (no SDK write-through hook), idempotent on `uuid`, with buffer-and-replay
      of pre-session-id events.
- [ ] Capabilities all `false`, with the corresponding runtime paths gated off
      via feature guards.
- [ ] Per-user `CODEX_HOME` isolation + the device-auth PTY login flow and
      routes, with global auth-env stripping.

## Reference map

| Concern | File |
|---|---|
| Provider (thread/turn loop, synthetic user, abort registry, loadTranscript) | `reference/server/services/providers/openai/index.ts` |
| Options translation (sandbox/approval, effort, model) | `reference/server/services/providers/openai/codexOptionsBuilder.ts` |
| Event mapping (thread/turn/item → UnifiedMessage) | `reference/server/services/providers/openai/mapEvent.ts` |
| Transcript mirroring into `messages` | `reference/server/services/providers/openai/messageMirror.ts` |
| Mirror wiring + buffer/replay in the stream loop | `reference/server/services/conversation/startCodexConversation.ts` |
| Capability matrix (`openai` flags all false) | `reference/shared/providers/capabilities.ts` |
| Feature guards | `reference/server/services/providers/featureGuards.ts` |
| Per-user `CODEX_HOME` credentials | `reference/server/services/codexCredentials.ts` |
| Credential-store adapter | `reference/server/services/credentials/openai.ts` |
| Device-auth PTY login flow | `reference/server/services/codexAuthFlow.ts` |
| Auth routes | `reference/server/routes/codexAuth.ts` |
| Models + efforts / labels | `reference/shared/providers/models.ts`, `reference/shared/providers/openai/models.ts` |

## Boundaries (not in this spec)

- The `LlmProvider` contract, unified vocabulary, registry, runtime, and the
  capability-matrix mechanism itself → [`harness-contract.md`](../../core/harness-contract.md).
- Shared harness patterns (mirroring as a general technique, credential
  isolation, subprocess lifecycle, the cross-provider capability table) →
  [`overview.md`](./overview.md).
- The Claude write-through `sessionStore` this provider works around →
  [`claude-code.md`](./claude-code.md).
- Which agent uses Codex, and where the per-user credential comes from →
  [`prompt-and-model-customization.md`](../prompt-and-model-customization.md)
  and [`auth-and-multi-user.md`](../auth-and-multi-user.md).
- How a finished Codex turn drives the next agent →
  [`orchestration-loop.md`](../../core/orchestration-loop.md).
