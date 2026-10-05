# WebSocket protocol — channels, auth, broadcasters, the REST→WS bridge

The streaming half of the app. A single `ws` server on path **`/ws`** carries
every live event (assistant tokens, status, agent-run updates, Explore UI
commands). The message contract is one discriminated union in
`shared/websocket/messages.ts` (`ClientToServerMessage` ∪
`ServerToClientMessage`, keyed on `type`). Wire format is **flat**:
`JSON.stringify({ type, ...rest })` — no `data` envelope (the `data` field on
`claude-response`/`claude-status`/`context-usage` is part of *those* payloads).

## Handshake & auth

Connect to `wss://…/ws?token=<jwt-or-ccui-key>`. The token is in the query
string because the browser `WebSocket` API can't set headers; it's the **same
credential as REST**. `verifyClient` (`server/websocket/verifyClient.ts`)
resolves it through the shared `authenticateWebSocket` (`middleware/auth.ts`)
and rejects the upgrade outright on failure (`401`) — an open socket is always
authenticated, and `req.user` is stamped on it. A locked database during the
lookup rejects with `503` + `Retry-After` instead of `401` (see
[`../backend/server-bootstrap.md`](../backend/server-bootstrap.md)); the
client's backoff reconnect covers both.

Per-message authorization still happens: every handler that touches a
conversation/task/session re-checks `hasProjectAccess` (admin OR project
member) before acting, mirroring REST. Unauthorized access is answered with a
benign "not found / not processing" reply, never a distinct error — the same
existence-hiding as the REST `404`-not-`403` pattern.

## The four subscription channels

`dispatch.ts` owns four per-connection `Map<WebSocket, Set<id>>`:

| Channel | Subscribe msg | Carries |
|---|---|---|
| **conversation** | `subscribe-conversation` (id) | streaming transcript: `claude-response`, `claude-status`, `claude-complete`, `claude-error`, `context-usage`, the `ask-user-question-*` family |
| **task** | `subscribe-task` (id) | task-level events: `conversation-added`/`-created`, `agent-run-updated`, `task-blocked`, `task-worktree-updated` (the background worktree setup moved — published from the `worktree-state-changed` TaskEvent in `index.ts`), liveness |
| **atlas** | `subscribe-atlas` (id) | Explore UI commands: `atlas-open-file`, `atlas-highlight`, `atlas-render-artifact` — a **separate** channel so whole-file payloads only reach open Explore views |
| **epic** | `subscribe-epic` (id) | what the task channel carries, for an epic: `agent-run-updated`, `epic-updated` (the row's status, stage flags **and orchestration state** — emitted by `mark_stage_complete`, epic CRUD incl. the human stage backstop, and every orchestrator transition; one builder, `services/epicEvents.ts`, so the three producers cannot disagree), `conversation-added`/`-name-updated`, streaming start/end. Epic *transcripts* stay on the conversation channel — an epic conversation is a normal conversation. See [`../epics/entity-and-conversations.md`](../epics/entity-and-conversations.md) |

Each subscribe is membership-checked at subscribe time and acked
(`*-subscribed`). `cleanupClientSubscriptions` drops all four on socket close.

## Broadcaster-factory-on-`app.locals` pattern

`dispatch.ts` holds the subscription Maps but exposes **no global broadcast
function**. Instead `make*` factories (`makeBroadcastToTaskSubscribers`,
`makeBroadcastToConversationSubscribers`, `makeBroadcastToAtlasSubscribers`,
`makeBroadcastToEpicSubscribers`)
each take the `WebSocketServer` and return a closure bound to that server +
the module's Maps. `index.ts` builds these once at startup and stashes them on
`app.locals` (`index.ts:157`), so **REST handlers fan out task/conversation
events** (e.g. `conversation-added` after `POST …/conversations`) by reading
`req.app.locals.broadcastTo…` — without re-walking subscriptions. The
broadcaster types (`BroadcastToTaskSubscribersFn`, etc.) are in
`shared/websocket/messages.ts`. The atlas factories also feed the atlas bridge
(`initAtlasBridge`, `index.ts:147`).

## Heartbeat

A 30 s `setInterval` (`index.ts:125`) pings every client; each connection
flips `isAlive=false` before the ping and back to `true` on `pong`. A
connection still `false` at the next tick is `terminate()`d — this reaps
half-open sockets (mobile sleep, dropped Wi-Fi) so subscription Maps don't leak
dead entries.

## The REST→`202`→WS streaming bridge

New conversations are created over **REST** (`POST …/conversations`); messages
to an *existing* conversation flow over WS via **`claude-command`** (the resume
path, `dispatch.ts:279`), with output streaming back as `claude-response` /
`streaming-started` / `streaming-ended`. One conversation = one in-flight turn:
a second `claude-command` while a turn is live is rejected with
`conversation-busy` (sent only to the issuing socket, `dispatch.ts:313`).

`POST …/conversations/:conversationId/messages` is a **thin REST bridge onto
this same WS path**: it returns `202` immediately and the reply streams over WS
+ persists to SQLite, so a REST-only client polls the detail endpoint while a
WS client watches the live stream — both observe the same turn. See
[`../backend/rest-api.md`](../backend/rest-api.md) for the REST side and
[`../conversations/lifecycle-and-streaming.md`](../conversations/lifecycle-and-streaming.md)
for the streaming loop.

## Key files

- `shared/websocket/messages.ts` — the full message union + broadcaster fn
  types (the contract; wins on any discrepancy).
- `server/websocket/dispatch.ts` — the 4 subscription Maps, the `make*`
  broadcaster factories, `dispatchClientMessage` (per-`type` routing + per-msg
  auth), `cleanupClientSubscriptions`.
- `server/websocket/broadcast.ts` — `broadcastToAll` (the only stateless
  helper).
- `server/websocket/verifyClient.ts` — the upgrade auth hook (`401` / `503` /
  `500`) and `getUpgradeToken`, which yields no token for a request target
  `new URL` rejects rather than throwing out of the `'upgrade'` listener.
- `server/websocket/connection.ts` — `makeConnectionHandler`: the per-socket
  wiring (the `'error'` guard that terminates a malformed client instead of
  crashing the process, path routing, the chat message loop, the `'close'`
  cleanup); tested over a real `WebSocketServer` in `connection.test.ts`.
  See [`../backend/server-bootstrap.md`](../backend/server-bootstrap.md).
- `server/index.ts:120` — `WebSocketServer` + `verifyClient`; `:125`
  heartbeat; `:157` the `app.locals` broadcaster wiring; `:249` where
  `makeConnectionHandler` is attached.
