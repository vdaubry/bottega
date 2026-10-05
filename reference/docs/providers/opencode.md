# OpenCode provider — out-of-process HTTP+SSE, the per-user server pool

The `opencode` backend is the odd one out: it is **not** an in-process SDK that
spawns a subprocess per turn. Bottega runs a long-lived **`opencode serve`** HTTP
server per user and talks to it over HTTP + Server-Sent Events. A turn is:
`session.create` (once) → `session.promptAsync` (fire-and-forget) → consume the
SSE `/event` stream until `session.idle`.

## OpenCodeProvider

`OpenCodeProvider` (`server/services/providers/opencode/index.ts:390`) implements
`LlmProvider`:

- `startTurn` → `getOrSpawnOpenCodeServer(userId)` → `session.create({directory: cwd})`
  → run the session. `sendTurnMessage` skips `session.create` and reuses
  `resumeSessionId`.
- Output streams via `client.event.subscribe()` (an SSE long-poll), filtered to
  **this session id** (a shared server may host several in-flight conversations),
  mapped by `createOpenCodeEventMapper`.
- **Workspace routing is load-bearing.** OpenCode's endpoints are
  *workspace-scoped*: `query.directory` MUST be passed on `session.create`,
  `promptAsync`, `event.subscribe`, **and** `session.abort`, or the call lands on
  the server's default workspace (the Bottega worktree) instead of the task
  worktree — the agent then explores/edits the wrong filesystem, or the abort
  misses. See the long in-code comments at `opencode/index.ts:290` and `:463`.
- `promptAsync` (not the synchronous `prompt`) is used so long turns don't trip
  Node's 5-minute `fetch` headers timeout.
- The built-in `question` tool is **always disabled**. Bottega instead registers
  its portable `ask_user` and owner tools as a per-turn remote MCP server, and
  the operator's own `~/.claude.json` servers (Playwright included) alongside
  it via `client.mcp.add` — see `shared/providers/operatorMcpServers.ts`. The
  durable question row aborts the current prompt and resumes the same OpenCode
  session after the standard Bottega wizard is answered.

The live conversation path delegates through **`startOpenCodeConversation.ts`**
(`startConversation.ts:72`), which broadcasts each `UnifiedMessage` as
`ai-response` and calls `failLinkedAgentRunIfRunning`
(`conversation/agentRunLifecycle.ts:45`) when the SSE stream closes before
`session.idle` (the synthetic error `result`).

### A failing LLM call is a `session.status`, never a `session.error`

`session.error` has never once been published on this box. When the model
provider fails, OpenCode's `SessionProcessor` retries internally and reports
each attempt as `session.status` with
`{type:'retry', attempt, message, next}` — and `next` is an **absolute
epoch-ms timestamp** (`next: Date.now() + backoff` in its retry policy), not a
delay. Do not compare it to a duration.

Retrying is normal and usually transient, so the stream tolerates it. What it
does not tolerate is the backoff doubling away (2s → 4 → 8 → … → 512s) while
Bottega streams nothing: `streamUnified` gives up as soon as a scheduled wait
exceeds `RETRY_WAIT_LIMIT_MS` (2 min), calls `session.abort` so OpenCode stops
retrying behind us, and yields an error `result` carrying the upstream message.
The threshold sits in the gap between the two outages on record — 2026-08-25
14:56 recovered on attempt 7 having never waited more than 64s, while ticket
#1664's PR agent at 21:01 was at 128s and doubling, produced zero tokens, and
sat silent for fifteen minutes.

## The per-user server pool

`openCodeServerPool.ts` keeps one `opencode serve` warm per user. Every consumer
goes through `getOrSpawnOpenCodeServer(userId)`
(`openCodeServerPool.ts:455`) — never spawns directly. Key behaviours:

- **Lazy spawn + readiness:** spawned on first use; ready when the stdout line
  `opencode server listening` appears (the SDK's `/global/health` isn't exposed
  at 1.15.5).
- **Idle reap:** a 15-minute idle timer (`reapIdle`) tears the server down.
- **LRU eviction:** capped at `OPENCODE_MAX_SERVERS`; port-race retry on
  `EADDRINUSE`.
- **Invalidation on credential change:** the running server cached the user's
  `auth.json` at startup, so any Zen-key mutation calls
  `invalidateOpenCodeServer(userId)` (`openCodeServerPool.ts:471`) to mark the
  handle stale and SIGTERM it — the next call awaits shutdown and spawns fresh.
  Every `/api/opencode-auth` key write/delete ends with this
  (`routes/openCodeAuth.ts:105` / `:131`).
- **Server-side abort:** `OpenCodeProvider.abortTurn` flips the local
  `AbortController` *and* fires `session.abort` (with `directory`) so the
  out-of-process turn actually stops.

`OPENCODE_SERVER_PASSWORD` gates every endpoint (including `/event` SSE) so no
other process on `127.0.0.1` can reach a user's server.

## Models (the live Zen catalog) & Zen-key auth

OpenCode auth is a **single Zen-billing API key**, stored at
`~/.config/bottega/users/{userId}/opencode-data/opencode/auth.json` as
`{ "opencode": { "type": "api", "key": "<zen-key>" } }` — the native shape
`opencode serve` reads (`openCodeCredentials.ts`). There is **no PTY login**;
the key is entered directly via `PUT /api/opencode-auth/key`.

Models are **never hardcoded** — `OPENCODE_MODELS` is an empty array
(`shared/providers/models.ts:50`); the catalog is fetched live per-user via
`listOpenCodeModels(userId)` (`opencode/index.ts:535`) → `GET /config/providers`
on the user's server, surfaced to the UI through `GET /api/opencode-auth/models`.
Persistence uses the canonical form **`opencode/<modelID>`**; `parseOpenCodeModel`
(`opencode/index.ts:64`) strips the prefix before the SDK call. (Hardcoding this
list once caused a marquee run to fail on a model Zen no longer served — see
`feedback_no_guessing_external_lists` in memory.) Ask-user and MCP capability
flags are supplied by Bottega; stream-detail and image flags remain false.
Details in [`overview.md`](./overview.md). Env-stripping invariant:
[`credentials.md`](./credentials.md).

## Key files

- `server/services/providers/opencode/index.ts:390` — `OpenCodeProvider`;
  `:64` `parseOpenCodeModel`; `:535` `listOpenCodeModels`.
- `server/services/providers/opencode/mapEvent.ts` — `createOpenCodeEventMapper`.
- `server/services/openCodeServerPool.ts:455` — `getOrSpawnOpenCodeServer`;
  `:471` `invalidateOpenCodeServer`.
- `server/services/openCodeCredentials.ts` — Zen-key auth.json + XDG paths.
- `server/services/conversation/startOpenCodeConversation.ts` (forked from
  `startConversation.ts:72`) — the live OpenCode conversation branch.
- `server/routes/openCodeAuth.ts` — `/api/opencode-auth` status/key/models endpoints.
