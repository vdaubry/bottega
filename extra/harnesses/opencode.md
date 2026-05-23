# Harness — OpenCode

The OpenCode provider implements the [harness contract](../../core/harness-contract.md)
against the `@opencode-ai/sdk`. Read that contract first: `LlmProvider`, the
unified vocabulary, and the streaming runtime are core; this doc covers only
what is *OpenCode-specific*. The shared spine — registration, mapper layer,
transcript mirroring as a pattern, per-user credentials, the capability matrix
mechanism — is written once in [`overview.md`](./overview.md); here we call out
where OpenCode diverges.

> Naming: the user sometimes calls this harness "OpenClaw." The repo, the
> provider name, the credential key, and the on-the-wire `Provider` union all
> use **`opencode`**. Use that everywhere.

## What it adds

A third concrete harness, registered under the provider name `opencode`. It is
the contract's hardest stress test because, unlike Claude and Codex (which spawn
a fresh subprocess per turn), OpenCode talks to a **long-lived `opencode serve`
HTTP server, one per user**. That single structural difference cascades into
every other concern: server pooling and teardown, a first-class session resource
that *is* the `provider_session_id`, an SSE event stream instead of a subprocess
stdout, a workspace-routing hazard that affects prompts/subscribes/aborts alike,
and a two-step abort that must stop both a local listener and an out-of-process
turn. Auth is a single per-user Zen-billing API key. Capabilities are all
`false`, plus one documented review-agent degradation. Every one of these is a
solved problem below.

## Authentication — per-user Zen API key

OpenCode auth is the simplest of the three: a **single API key** that bills
through OpenCode Zen, persisted per user. There is no OAuth dance and no
device-code PTY — just a key the user pastes in the settings panel.

The store
([`openCodeCredentials.ts`](../../reference/server/services/openCodeCredentials.ts))
writes the key in the exact on-disk shape `opencode serve` reads natively —
`{ "opencode": { "type": "api", "key": "<zen-key>" } }` — at
`~/.config/bottega/users/<userId>/opencode-data/opencode/auth.json` (mode `0600`,
ownership- and mode-checked on read, same posture as Claude/Codex). Because the
spawned server resolves this path itself via `XDG_DATA_HOME`, no token
translation is needed. `isOpenCodeAuthJson` is strict by design: it rejects any
file carrying more than the single `opencode` record, so a stale multi-provider
auth.json from an earlier draft can't route a turn through the wrong path.

The `ProviderCredentialStore` adapter
([`credentials/opencode.ts`](../../reference/server/services/credentials/opencode.ts))
wraps those helpers. Two pieces of its `buildSdkEnv` are load-bearing:

- It returns the **full XDG env** a spawned server inherits — `XDG_DATA_HOME` /
  `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` all pinned per user —
  after stripping the global `OPENCODE_*` keys (`buildOpenCodeSpawnEnv`), so the
  per-user auth.json is the only credential source. It also sets
  `OPENCODE_CONFIG=/dev/null` to block a worktree-local `opencode.json` from
  overriding the spawn, keeps `GH_CONFIG_DIR` pointed at the host so `gh` still
  authenticates despite the redirected `XDG_CONFIG_HOME`, and injects
  `OPENCODE_CONFIG_CONTENT` granting `external_directory: allow` (the `build`
  agent's tools touch task docs and per-user state outside the worktree;
  Bottega is the sole user of this server, so always-allow is correct).
- It tags **`BOTTEGA_USER_ID`** onto the env. This is how the HTTP provider
  resolves the user id back out of `ProviderRunOptions.env` — see below. It is a
  passthrough tag only; the server-pool spawn rebuilds its own env from scratch
  via `buildOpenCodeSpawnEnv(userId)`, so the tag never reaches the
  `opencode serve` subprocess.

Auth routes
([`routes/openCodeAuth.ts`](../../reference/server/routes/openCodeAuth.ts)) are
plain CRUD on the key: `GET /status`, `PUT /key`, `DELETE /key`, plus
`GET /models`. The contract subtlety is that **every mutation calls
`invalidateOpenCodeServer(userId)`** — a running server cached the old auth.json
at startup, so writing or clearing the key must tear it down (see the pool's
staleness handling). `GET /models` proxies the running server's
`GET /config/providers` so the settings UI never hardcodes Zen model IDs;
`listOpenCodeModels` spawns/reuses the user's server, reads the live `opencode`
catalog, and returns each model in the canonical persisted form
`opencode/<bareModelID>`.

## The server pool — why long-lived, and its lifecycle

This is the headline divergence from Claude and Codex. OpenCode is **not** a
spawn-per-turn SDK; it is an HTTP server. So Bottega keeps **one
`opencode serve` per user, warm across turns**, in an in-process pool
([`openCodeServerPool.ts`](../../reference/server/services/openCodeServerPool.ts)).
Every consumer — the provider, the REST routes, the model lister — goes through
`getOrSpawnOpenCodeServer(userId)`; nothing spawns `opencode serve` directly.
The pool's responsibilities:

- **Lazy spawn, keyed by user.** First use spawns; subsequent turns reuse the
  warm handle and bump `lastUsedAt`. A `pending` map de-dupes concurrent
  first-spawns for the same user into one in-flight promise.
- **Spawn hardening.** `opencode serve --hostname 127.0.0.1 --port <free>` with
  a freshly minted `OPENCODE_SERVER_PASSWORD` (Basic-auth gating *every*
  endpoint including `/event` SSE, so no other process on the box can reach a
  user's server), `detached: true` so the whole process group can be signalled
  on teardown (the binary forks workers), readiness detected by **grepping
  stdout** for the listening line (the JS SDK at 1.15.5 exposes no
  `/global/health`), and a one-shot retry on `EADDRINUSE` to survive the
  free-port race.
- **Idle reaping + LRU eviction.** A reaper (default 15-min idle) marks idle
  handles stale and terminates them; `OPENCODE_MAX_SERVERS` caps the pool with
  LRU eviction.
- **Staleness / invalidation.** A handle carries a `stale` flag. `invalidate`
  (called on every credential mutation, idle reap, and eviction) flips it and
  schedules a `SIGTERM`; `getOrSpawn` **awaits the in-flight shutdown** before
  spawning fresh, so the next turn always reads the current auth.json.
- **Teardown.** `terminate` signals the negative pid (the whole group) then the
  child, escalating `SIGTERM`→`SIGKILL` after 5s; process-exit handlers drain
  the whole pool. Sessions survive on disk under `XDG_DATA_HOME`, so the pool
  isn't load-bearing for data integrity — it's just good citizenship on a
  shared box.

How a turn talks to the server: `OpenCodeProvider`
([`opencode/index.ts`](../../reference/server/services/providers/opencode/index.ts))
resolves the user id from `BOTTEGA_USER_ID` (`extractUserIdFromEnv`), grabs the
handle, and drives the session over HTTP.

## The session model

OpenCode sessions are a **first-class server resource**, and the contract maps
cleanly onto them:

- `startTurn` calls `session.create({ query: { directory: cwd } })` **once**;
  the returned session id is captured and **persisted as `provider_session_id`**
  (and stamped on `claude_conversation_id` for back-compat). It resolves
  *synchronously* — before any SSE event lands — so the very first emitted
  `UnifiedMessage` already carries the id (the pre-session buffer in the
  orchestrator is kept only as a defensive no-op).
- `sendTurnMessage` skips `session.create` and reuses the `resumeSessionId`
  (which **is** the OpenCode session id). On resume the orchestrator re-reads
  the explicit `(provider, model)` off the conversation row — never inferred —
  so `parseOpenCodeModel` always has a value. OpenCode has **no effort
  dimension**, so `effort` is always `null`.
- Each turn is one `session.promptAsync` call on that id. The model is passed as
  `{ providerID: 'opencode', modelID }` — parsed from the canonical persisted
  form `opencode/<modelID>` by `parseOpenCodeModel`, which fails loud on a
  missing or malformed identifier (`InvalidOpenCodeModelError`) rather than
  letting the SDK default.

Three turn-shaping decisions deserve attention, all found live:

- **`promptAsync`, not `prompt`.** The synchronous `session.prompt` blocks until
  end-of-turn and trips Node's 5-minute `fetch` headers timeout
  (`UND_ERR_HEADERS_TIMEOUT`) on long turns. The fire-and-forget `promptAsync`
  returns immediately and the turn's output flows **exclusively over an SSE
  subscription** (`event.subscribe`) opened *before* the prompt fires, so no
  events between the prompt response and `session.idle` are missed.
- **Synthetic user message.** Like Codex, OpenCode never echoes the outgoing
  prompt as an event, so the provider manufactures a `user` `UnifiedMessage` and
  yields it first — otherwise the transcript has no user-side row for the turn.
- **Disable the built-in `question` tool, always.** OpenCode's `question` tool
  parks the turn at `tool: running` waiting on an answer API that Bottega has no
  UI for (`supportsAskUserQuestion: false`). Models reach for it on their own
  when a system prompt says "ask clarifying questions"; without
  `tools: { question: false }` the turn hangs until the idle reaper kills the
  server. Any `disallowedTools` from options are merged into the same map.

### The workspace-routing hazard

OpenCode's `WorkspaceRoutingMiddleware` resolves the target workspace **per HTTP
call** from `query.directory`, falling back to the *server's* `process.cwd()` —
which is Bottega's own worktree, not the task worktree. Get this wrong and the
agent silently explores/edits the wrong filesystem. So the provider passes
`query.directory: cwd` on **all three** workspace-scoped calls:

- `event.subscribe` — without it the subscription lands on the server's default
  bus while `promptAsync` publishes on the task-worktree bus, and Bottega
  listens forever, never seeing `session.idle`.
- `promptAsync` — without it a planning run explores the Bottega codebase and an
  implementation run writes files into the wrong worktree (found live in Phase
  12.3).
- `session.abort` — see below; the cancel must land on the same workspace's
  prompt service or the turn never stops.

This is why `ActiveOpenCodeSession` stores the turn's `directory`.

## Event mapping — OpenCode events → `UnifiedMessage`

`createOpenCodeEventMapper(sessionId)`
([`opencode/mapEvent.ts`](../../reference/server/services/providers/opencode/mapEvent.ts))
is the only file allowed to import OpenCode SDK event types. It is a **stateful
factory** (one mapper per session) because OpenCode interleaves many
`message.part.updated` events per assistant turn — unlike Codex, where one
`item.completed` carries the final text. The mapper keeps per-`messageID` buffers
and coalesces:

| OpenCode event/part | Unified output |
|---|---|
| `message.part.updated` → `text` part | buffered, no emit until flush |
| `message.part.updated` → `reasoning` part | buffered, no emit until flush |
| `message.part.updated` → `tool` part (pending/running) | `tool_use` only |
| `message.part.updated` → `tool` part (completed) | `tool_use` + `tool_result` |
| `message.part.updated` → `tool` part (error) | `tool_use` + `tool_result` (`isError`) |
| `message.part.updated` → `file` part | `tool_result` (file payload) |
| `message.part.updated` → `step-finish` part | `result` (aggregate usage) |
| `message.updated` (assistant, `finish` set) | flush coalesced `assistant` + `assistant_thinking` |
| `session.idle` | `result` (terminator) |
| `session.error` | `result` (`isError`) |
| everything else | `[]` (forward-compatible drop) |

Notable choices: text and reasoning parts accumulate in part-order and are
**flushed only when the parent `message.updated` carries `finish`** (one
`assistant` per turn, plus one whole `assistant_thinking` — there is no
delta streaming); user-role `message.updated` is dropped because the synthetic
user message already covers it; ids are derived from OpenCode's own part/message
ids with stable suffixes (`:use`, `:result`, `:thinking`) so the mirror's `uuid`
upsert stays idempotent. The default branch returns `[]` rather than throwing, so
new OpenCode event types (lsp, pty, tui, file-watch) don't break the stream.

### Stream consumption and the session filter

The provider's `streamUnified` loop
([`opencode/index.ts`](../../reference/server/services/providers/opencode/index.ts))
iterates the SSE stream and **filters to the current session id** — a shared
per-user server can have multiple in-flight conversations, so events for other
sessions must be dropped. The session id can appear under `properties.sessionID`,
`properties.info.sessionID`, **or** `properties.part.sessionID` (the last is
needed so a sub-agent's tool-part events don't sneak orphaned `tool_use` rows
through). The loop breaks on `session.idle` / `session.error` for *this* session,
and `sseMaxRetryAttempts: 1` stops the SDK's SSE layer from reconnecting forever
so the `finally` can fire. If the stream ends without a terminator (network drop,
server crash) the loop synthesises an `isError` `result` so the orchestrator's
failed-streaming path runs.

## Transcript mirroring — explicit, into the shared tables

Like Codex and unlike Claude, OpenCode's SDK offers **no write-through
`sessionStore` hook**, so the provider mirrors each emitted `UnifiedMessage` into
the same `messages` table by hand. The contract's rule holds: SQLite is the
single source of truth; OpenCode's own copy under `XDG_DATA_HOME` is private
scratch the runtime never reads.

`mirrorOpenCodeEvent`
([`opencode/messageMirror.ts`](../../reference/server/services/providers/opencode/messageMirror.ts))
converts each unified message back into the **Claude `SDKMessage` on-the-wire
entry shape** (`{ type, uuid, message: { id, content, usage? }, … }`) and appends
it via `sqliteSessionStore.append` — idempotent on `uuid`. Because the entry
shape is Claude's, `loadTranscript` reuses Claude's reader
(`loadAnthropicTranscript`) wholesale and just **re-stamps `provider: 'opencode'`
on the way out** — there is no OpenCode-specific reader, and reloaded OpenCode
conversations render through the same `/api/conversations/:id/messages` path as
Claude and Codex. The `assistant` `model` is re-prefixed to the canonical
`opencode/<modelID>` so context-usage attribution stays unambiguous.

Per the store-side subtlety noted in [`overview.md`](./overview.md), the
`provider: 'opencode'` tag on the append key keeps the session-summary fold off
these rows (the fold is typed for Claude's entry shape). The mirror is invoked
from the OpenCode conversation orchestrator's stream loop, not from inside the
provider — see
[`startOpenCodeConversation.ts`](../../reference/server/services/conversation/startOpenCodeConversation.ts)
(start path ~L451–554, resume path `sendOpenCodeMessage` ~L307–325). That
orchestrator also broadcasts each event over WS as `ai-response` (plus a
back-compat `claude-response`), drives `activeSessions`, and runs the
agent-run completion handler.

> One OpenCode-specific orchestration detail worth copying:
> `failLinkedAgentRunIfRunning` (~L183) pre-marks the linked agent run `failed`
> the instant a `result` with `isError: true` streams. OpenCode reports model
> errors as **SSE events, not HTTP errors**, so the stream ends *normally*;
> without this pre-mark the completion handler would see `running` → mark
> `completed` → auto-chain → the next agent fails the same way → runaway loop
> until the workflow run cap trips.

## Abort — two steps, workspace-scoped

`abortTurn(providerSessionId)`
([`opencode/index.ts`](../../reference/server/services/providers/opencode/index.ts))
must do **two** things, because the turn runs out-of-process on the server:

1. Flip the local `AbortController` — this only stops Bottega's SSE listener.
2. Call the server's `session.abort` endpoint, **passing the stored
   `query.directory`**. That endpoint is workspace-scoped by the same
   `WorkspaceRoutingMiddleware`; without the matching directory the cancel lands
   on the wrong workspace's prompt service and the real turn runs to completion
   (and writes its files). Found live by the abort E2E probe.

Active turns are tracked in an in-process `Map` keyed by session id, registered
the moment `providerSessionId$` resolves, so `abortTurn` can find the controller
and the directory. As the shared overview requires, the orchestrator's
`abortTurn` writes the linked agent-run row `failed` **synchronously** before
aborting, so the completion handler won't chain.

## Capabilities and the review-agent degradation

OpenCode sets **every** optional capability to `false`
([`capabilities.ts`](../../reference/shared/providers/capabilities.ts), the
`opencode` block), each gated via the guards in
[`featureGuards.ts`](../../reference/server/services/providers/featureGuards.ts):

- `supportsAskUserQuestion: false` — no `canUseTool` hook; agents ask in plain
  text, and the built-in `question` tool is force-disabled (above).
- `supportsThinkingDelta: false` — `ReasoningPart` arrives whole, not as deltas;
  the thinking accumulator is skipped.
- `supportsContextUsageBreakdown: false` — only aggregate token usage; the live
  per-tool breakdown UI is skipped (aggregate still flows through the tracker).
- `supportsMcpServers: false` — OpenCode ships its own MCP layer; v1 does not
  wire it into Bottega.
- `supportsImages: false` — text-only in v1; image attachments are silently
  stripped (the chat UI disables upload for OpenCode providers).

There is also one degradation **outside** the capability matrix, because it is a
property of the *agent role*, not the provider's wire features: the **review
agent runs in degraded mode under OpenCode — no Playwright MCP, no video
recording.** Bottega normally builds a `videoConfig` for review agents (Playwright
MCP browser capture); the agent runner skips it when the provider is `opencode`
(`agentType === 'review' && provider !== 'opencode'`), because Playwright capture
isn't wired through OpenCode's worktree reflection — see
[`agentRunner.ts`](../../reference/server/services/agentRunner.ts) ~L154–169.
The OpenCode conversation orchestrator likewise drops `videoConfig` for these
turns. Review agents still *run* under OpenCode; they just lack browser video.

## What to build

- [ ] An `OpenCodeProvider` implementing `LlmProvider`, registered as
      `opencode`, resolving the user id from `BOTTEGA_USER_ID` and driving the
      session over the per-user `opencode serve` via the pool.
- [ ] A per-user server pool (`getOrSpawnOpenCodeServer`): lazy spawn, password
      gating, stdout-grep readiness, free-port + `EADDRINUSE` retry, idle reaping,
      LRU eviction, stale-on-invalidate with await-shutdown-before-respawn, and
      process-group teardown.
- [ ] A session model: `session.create` once on start (id → `provider_session_id`,
      resolved synchronously), `promptAsync` per turn over an SSE subscription
      opened first, `query.directory` on every workspace-scoped call, a synthetic
      user message yielded first, and `tools: { question: false }`.
- [ ] A stateful event mapper (one per session) coalescing text/reasoning parts,
      emitting tool_use/tool_result pairs, terminating on `session.idle`/
      `session.error`, with a session-id filter and a non-dropping default.
- [ ] **Explicit transcript mirroring** into the shared `messages` table in
      Claude's entry shape (idempotent on `uuid`), with `loadTranscript` reusing
      the Claude reader and re-stamping `provider: 'opencode'`; plus the
      pre-mark-failed-on-isError guard against the auto-chain runaway loop.
- [ ] A two-step, workspace-scoped `abortTurn` (local controller + server-side
      `session.abort` with `query.directory`) and an in-memory active-turn map.
- [ ] A single-Zen-key credential store whose `buildSdkEnv` strips global
      `OPENCODE_*`, pins per-user XDG paths, sets `OPENCODE_CONFIG=/dev/null`, and
      tags `BOTTEGA_USER_ID`; auth routes that `invalidate` the pooled server on
      every mutation; a `/models` proxy of the live Zen catalog.
- [ ] Capabilities all `false` with the corresponding runtime paths gated off,
      plus the review-agent video degradation when the provider is `opencode`.

## Reference map

| Concern | File |
|---|---|
| Provider (session loop, SSE consume, abort, loadTranscript, model parse, model list) | `reference/server/services/providers/opencode/index.ts` |
| Per-user server pool (spawn/reuse/invalidate/reap/evict/teardown) | `reference/server/services/openCodeServerPool.ts` |
| Event mapper (stateful, part coalescing) | `reference/server/services/providers/opencode/mapEvent.ts` |
| Transcript mirror into `messages` | `reference/server/services/providers/opencode/messageMirror.ts` |
| Conversation orchestrator (mirror wiring, WS broadcast, isError pre-mark) | `reference/server/services/conversation/startOpenCodeConversation.ts` |
| Per-user Zen credentials + spawn env | `reference/server/services/openCodeCredentials.ts` |
| Credential-store adapter (`buildSdkEnv`, `BOTTEGA_USER_ID` tag) | `reference/server/services/credentials/opencode.ts` |
| Auth routes (`/status`, `/key`, `/models`; invalidate-on-mutation) | `reference/server/routes/openCodeAuth.ts` |
| Capability matrix (`opencode` flags all false) | `reference/shared/providers/capabilities.ts` |
| Feature guards | `reference/server/services/providers/featureGuards.ts` |
| Review-agent video degradation | `reference/server/services/agentRunner.ts` (~L154–169) |

## Boundaries (not in this spec)

- The `LlmProvider` contract, unified vocabulary, registry, runtime, and the
  capability-matrix mechanism itself →
  [`harness-contract.md`](../../core/harness-contract.md).
- Shared harness patterns (mirroring as a general technique, credential
  isolation, the cross-provider capability table, registration) →
  [`overview.md`](./overview.md).
- The Claude write-through `sessionStore` this provider works around, and the
  subprocess-per-turn model it contrasts with →
  [`claude-code.md`](./claude-code.md) and [`codex.md`](./codex.md).
- Which agent uses OpenCode, how a model is chosen per agent, and where the
  per-user Zen key comes from →
  [`prompt-and-model-customization.md`](../prompt-and-model-customization.md)
  and [`auth-and-multi-user.md`](../auth-and-multi-user.md).
- How a finished OpenCode turn drives the next agent →
  [`orchestration-loop.md`](../../core/orchestration-loop.md).
</content>
</invoke>
