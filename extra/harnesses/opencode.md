# Harness — OpenCode Zen and OpenCode Go

The OpenCode Zen and OpenCode Go providers implements the [harness contract](../../core/harness-contract.md)
against the `@opencode-ai/sdk`. Read the harness contract first: `LlmProvider`, the
unified vocabulary, and the streaming runtime are core; this doc covers only
what is *OpenCode-specific*. The shared spine — registration, mapper layer,
transcript mirroring as a pattern, per-user credentials, the capability matrix
mechanism — is written once in [`overview.md`](./overview.md); here we call out
where OpenCode diverges.

Bottega supports _both_ OpenCode Zen and OpenCode Go, with identical keys, but
differing Provider dropdowns. In terms of OpenCode provider config JSON, this
means there's a provider named `"opencode"` _and_ a provider named `"opencode-go"`.
Both provider's json config should have the same API key. For simplicity, both
the `opencode` and `opencode-go` entries can can be stored in the same `auth.json`.

> Naming: the user sometimes calls these harnesses "OpenClaw." The repo, the
> provider name, the credential key, and the on-the-wire `Provider` union all
> use **`opencode`** (for the OpenCode Zen provider path) and **`opencode-go`**
> (for the OpenCode Go provider path). They should be separate `bottega`-level
> providers, **with separate model lists**.

## What it adds

A third and fourth concrete harness, registered under the provider names `opencode` and
`opencode-go`. It is the contract's hardest stress test because, unlike Claude
and Codex (which spawn a fresh subprocess per turn), OpenCode talks to a
**long-lived `opencode serve` HTTP server, one per user**. That single structural
difference cascades into every other concern: server pooling and teardown, a first-class
session resource that *is* the `provider_session_id`, an SSE event stream instead
of a subprocess stdout, a workspace-routing hazard that affects prompts/subscribes/
aborts alike, and a two-step abort that must stop both a local listener and an out-
of-process turn. Auth is a single per-user API key for both Zen (`opencode`) and
OpenCode Go (`opencode-go`). The `auth.json` will contain entries for each (with
the same API key, collected once in the UI). Capabilities are all
`false`, plus one documented review-agent degradation. Every one of these is a
solved problem below.

## Authentication — per-user Zen + Go API key

OpenCode auth is the simplest of the three: a **single API key** that bills
through OpenCode Zen _or_ OpenCode Go (depending on the contents you pass in the
`provider` field when starting a turn/session with the OpenCode server: `opencode`
will start a Zen session, and `opencode-go` will start a Go session), persisted per
user. There is no OAuth dance and no device-code PTY — just a key the user pastes
in the settings panel and the runtime `provider` arg to `@opencode-ai/sdk` that covers
both OpenCode Zen and OpenCode Go.

The store
([`openCodeCredentials.ts`](../../reference/server/services/openCodeCredentials.ts))
writes the key in the exact on-disk shape `opencode serve` reads natively —
`{ "opencode": { "type": "api", "key": "<opencode-key>" }, "opencode-go": { "type": "api",
"key": "<opencode-key>" } }` — at `~/.config/bottega/users/<userId>/opencode-data/opencode/auth.json`
(mode `0600`, ownership- and mode-checked on read, same posture as Claude/Codex).
Because the spawned server resolves this path itself via `XDG_DATA_HOME`, no token
translation is needed. `isOpenCodeAuthJson` (line 187) is strict by design: it requires
exactly both `opencode` and `opencode-go` keys with the same API key structure, rejecting
any file that doesn't match the dual-provider shape.

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
**two model endpoints**: `GET /models` (line 144) and `GET /models-go` (line 167).
The contract subtlety is that **every mutation calls
`invalidateOpenCodeServer(userId)`** — a running server cached the old auth.json
at startup, so writing or clearing the key must tear it down (see the pool's
staleness handling). Both model endpoints proxy the running server's
`GET /config/providers` so the settings UI never hardcodes model IDs;
`listOpenCodeModels(userId, providerName)` spawns/reuses the user's server, reads
the live catalog for the specified provider (`'opencode'` or `'opencode-go'`), and
returns each model in the canonical persisted form `opencode/<bareModelID>` or
`opencode-go/<bareModelID>`.

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

How a turn talks to the server: The factory `createOpenCodeProvider(name)` (where
`name` is `'opencode'` or `'opencode-go'`) produces provider instances
([`opencode/index.ts`](../../reference/server/services/providers/opencode/index.ts))
that resolve the user id from `BOTTEGA_USER_ID` (`extractUserIdFromEnv`, line 83),
grab the handle, and drive the session over HTTP. Both `openCodeProvider` and
`openCodeGoProvider` are registered separately, sharing the same server pool.

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
  dimension**, so `effort` is always `null`
- Each turn is one `session.promptAsync` call on that id. Depending on whether
  the Bottega provider is OpenCode Zen or OpenCode Go, the model data is passed as
  `{ providerID: 'opencode', modelID }` (OpenCode Zen) OR `{ providerID: 'opencode-go',
  modelID }` (for OpenCode Go) — parsed from the canonical persisted
  form `opencode/<modelid>`/`opencode-go/<modelid>` by `parseOpenCodeModel` (line 69), which
  fails loud on a missing or malformed identifier (`InvalidOpenCodeModelError`) rather
  than letting the SDK default.

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

`createOpenCodeEventMapper(sessionId, providerName)`
([`opencode/mapEvent.ts`](../../reference/server/services/providers/opencode/mapEvent.ts))
is the only file allowed to import OpenCode SDK event types. It is a **stateful
factory** (one mapper per session) that accepts the provider name (`'opencode'` or
`'opencode-go'`) and stamps all emitted `UnifiedMessage` objects with the correct
`provider` field. The mapper keeps per-`messageID` buffers and coalesces OpenCode
events because OpenCode interleaves many `message.part.updated` events per assistant
turn — unlike Codex, where one `item.completed` carries the final text:

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

`mirrorOpenCodeEvent(sessionInfo, unified, providerName)`
([`opencode/messageMirror.ts`](../../reference/server/services/providers/opencode/messageMirror.ts))
converts each unified message back into the **Claude `SDKMessage` on-the-wire
entry shape** (`{ type, uuid, message: { id, content, usage? }, … }`) and appends
it via `sqliteSessionStore.append` — idempotent on `uuid`. The function accepts
a `providerName` parameter (`'opencode'` or `'opencode-go'`) and uses it to
correctly re-prefix assistant models and stamp the provider field. Because the entry
shape is Claude's, `loadTranscript` reuses Claude's reader
(`loadAnthropicTranscript`) wholesale and just **re-stamps the provider field
on the way out** — there is no OpenCode-specific reader, and reloaded OpenCode
conversations render through the same `/api/conversations/:id/messages` path as
Claude and Codex. The `unifiedToTranscriptEntry` function (line 57) handles both
`opencode/<modelID>` and `opencode-go/<modelID>` prefixes correctly, avoiding
double-prefixing, so context-usage attribution stays unambiguous.

Per the store-side subtlety noted in [`overview.md`](./overview.md), the
`provider: 'opencode'`/`provider: 'opencode-go'` tag on the append key keeps the
session-summary fold off these rows (the fold is typed for Claude's entry shape).
The mirror is invoked from the OpenCode conversation orchestrator's stream loop,
not from inside the provider — see
[`startOpenCodeConversation.ts`](../../reference/server/services/conversation/startOpenCodeConversation.ts)
(start path mirror loop ~L543–570, resume path `sendOpenCodeMessage` starts at
line 224 with mirror loop ~L328–343). That orchestrator also broadcasts each event
over WS as `ai-response` (plus a back-compat `claude-response`), drives
`activeSessions`, and runs the agent-run completion handler.

> One OpenCode-specific orchestration detail worth copying:
> `failLinkedAgentRunIfRunning` (line 199) pre-marks the linked agent run `failed`
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

Both `opencode` and `opencode-go` set **every** optional capability to `false`
([`capabilities.ts`](../../reference/shared/providers/capabilities.ts), the
`opencode` entry at line 27 and `opencode-go` entry at line 52), each gated via
the guards in
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
MCP browser capture); the agent runner skips it when the provider is `opencode` or
`opencode-go` (line 158: `agentType === 'review' && provider !== 'opencode' && provider !== 'opencode-go'`),
because Playwright capture isn't wired through OpenCode's worktree reflection — see
[`agentRunner.ts`](../../reference/server/services/agentRunner.ts) lines 154–169.
The OpenCode conversation orchestrator likewise drops `videoConfig` for these
turns. Review agents still *run* under OpenCode; they just lack browser video.

## What to build

- [x] A factory `createOpenCodeProvider(name)` producing `LlmProvider` instances,
      registered as both `opencode` and `opencode-go`, resolving the user id from
      `BOTTEGA_USER_ID` and driving sessions over the shared per-user `opencode serve`
      via the pool.
- [x] A per-user server pool (`getOrSpawnOpenCodeServer`): lazy spawn, password
      gating, stdout-grep readiness, free-port + `EADDRINUSE` retry, idle reaping,
      LRU eviction, stale-on-invalidate with await-shutdown-before-respawn, and
      process-group teardown.
- [x] A session model: `session.create` once on start (id → `provider_session_id`,
      resolved synchronously), `promptAsync` per turn over an SSE subscription
      opened first, `query.directory` on every workspace-scoped call, a synthetic
      user message yielded first, and `tools: { question: false }`.
- [x] A stateful event mapper (one per session, parameterized by provider name)
      coalescing text/reasoning parts, emitting tool_use/tool_result pairs, terminating
      on `session.idle`/`session.error`, with a session-id filter and a non-dropping default.
- [x] **Explicit transcript mirroring** into the shared `messages` table in
      Claude's entry shape (idempotent on `uuid`), parameterized by provider name,
      with `loadTranscript` reusing the Claude reader and re-stamping the provider field;
      plus the pre-mark-failed-on-isError guard against the auto-chain runaway loop.
- [x] A two-step, workspace-scoped `abortTurn` (local controller + server-side
      `session.abort` with `query.directory`) and an in-memory active-turn map.
- [x] A dual-entry credential store (`opencode` + `opencode-go` with same API key)
      whose `buildSdkEnv` strips global `OPENCODE_*`, pins per-user XDG paths, sets
      `OPENCODE_CONFIG=/dev/null`, and tags `BOTTEGA_USER_ID`; auth routes that
      `invalidate` the pooled server on every mutation; **two model endpoints**
      (`/models` for Zen, `/models-go` for Go) proxying the live catalogs.
- [x] Capabilities all `false` for both `opencode` and `opencode-go` with the
      corresponding runtime paths gated off, plus the review-agent video degradation
      when the provider is `opencode` or `opencode-go`.

## Reference map

| Concern | File | Key Lines |
|---|---|---|
| Provider factory, model parsing, model listing | `reference/server/services/providers/opencode/index.ts` | `parseOpenCodeModel` (69), `createOpenCodeProvider` (519), `listOpenCodeModels` (557), exports (523-524) |
| Per-user server pool (spawn/reuse/invalidate/reap/evict/teardown) | `reference/server/services/openCodeServerPool.ts` | `getOrSpawnOpenCodeServer` (455), `invalidateOpenCodeServer` (471) |
| Event mapper (stateful, part coalescing, provider-stamped) | `reference/server/services/providers/opencode/mapEvent.ts` | `createOpenCodeEventMapper` (73) |
| Transcript mirror (provider-parameterized) | `reference/server/services/providers/opencode/messageMirror.ts` | `mirrorOpenCodeEvent` (156), `unifiedToTranscriptEntry` (57) |
| Conversation orchestrator (mirror wiring, WS broadcast, isError pre-mark) | `reference/server/services/conversation/startOpenCodeConversation.ts` | `failLinkedAgentRunIfRunning` (199), `sendOpenCodeMessage` (224), `startOpenCodeConversation` (373) |
| Dual-provider credentials (auth.json with both keys) | `reference/server/services/openCodeCredentials.ts` | `OpenCodeAuthJson` interface (182), `isOpenCodeAuthJson` (187), `setOpenCodeKey` (246) |
| Credential-store adapter (`buildSdkEnv`, `BOTTEGA_USER_ID` tag) | `reference/server/services/credentials/opencode.ts` | `buildSdkEnv` implementation |
| Auth routes (`/status`, `/key`, `/models`, `/models-go`) | `reference/server/routes/openCodeAuth.ts` | `/models` (144), `/models-go` (167), `/key` (82), `/status` (64) |
| Capability matrix (both providers all false) | `reference/shared/providers/capabilities.ts` | `CAPABILITIES_BY_PROVIDER` (16), `opencode` (27), `opencode-go` (52) |
| Feature guards | `reference/server/services/providers/featureGuards.ts` | Capability-based guards |
| Review-agent video degradation | `reference/server/services/agentRunner.ts` | Line 158: dual-provider check |

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
