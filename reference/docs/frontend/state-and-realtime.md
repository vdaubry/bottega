# Frontend state & realtime — TaskContext + WebSocketContext

Two contexts carry almost all client state: `TaskContext` (domain data +
selection + liveness) and `WebSocketContext` (the single socket + typed pub/sub).
The app shell that nests them is [`app-shell.md`](./app-shell.md); the wire
protocol is [`../architecture/websocket-protocol.md`](../architecture/websocket-protocol.md).

## WebSocketContext — one socket, typed pub/sub

`src/contexts/WebSocketContext.tsx` owns a **single** `/ws` connection for the
whole app (token passed on the URL, since handshakes can't set headers). It
exposes `{ isConnected, sendMessage, subscribe, unsubscribe, onDisconnect }`:

- **Typed pub/sub** — `subscribe(type, cb)` registers a callback in
  `subscribersRef` keyed by message type (`:282`); `socket.onmessage` (`:167`)
  fans each inbound message out to that type's bucket. `sendMessage(type, payload)`
  is the typed send.
- **Backoff reconnect** — on close it schedules a reconnect with exponential
  backoff + jitter (`calculateBackoff`, `:75`) up to `MAX_ATTEMPTS`, resetting the
  attempt counter on a clean open. `onDisconnect(cb)` lets consumers clear
  transient state immediately (e.g. `useSessionStreaming` drops "thinking").

**Subscriptions are not auto-restored by the socket** — each subscription hook
re-sends its `subscribe-*` after a reconnect (the re-subscribe convention below).

## The three subscription hooks

The server has three channels (conversation / task / atlas). One hook per channel
sends the `subscribe-*` on mount, tears it down on unmount, and **re-subscribes
after reconnect**:

- **`useConversationSubscription(conversationId)`** — `subscribe-conversation`;
  feeds `ChatInterface` (claude-response/-status/-complete/-error, context-usage).
- **`useTaskSubscription(taskId)`** (`src/hooks/useTaskSubscription.ts`) — folds
  `conversation-added` + `agent-run-updated` directly into `TaskContext` state for
  the live Task Detail page.
- **`useTasksLiveSubscriptions(taskIds[])`** — subscribes a *set* of tasks (idempotent
  delta send) so the Dashboard/Board "Live" badges light up between REST snapshots.
- **`useAtlasEvents(taskId)`** — the Explore channel (see
  [`../atlas/explore-ide.md`](../atlas/explore-ide.md)).

## TaskContext — domain state, selection, liveness

`src/contexts/TaskContextProvider` (`src/contexts/TaskContext.tsx:185`) holds
projects/tasks/conversations/agentRuns, the **selection** (`selectedProject` /
`selectedTask` / `activeConversation`, from which `currentView` is derived), and
the mutation actions (create/update/delete with optimistic updates).

It also owns **live-task tracking**: `liveTaskIds` (a `Set`, mirrored in
`liveTaskIdsRef`). Global `streaming-started` / `streaming-ended` listeners add/remove
a single id; `reconcileLiveTaskIds()` (`:715`) periodically **overwrites** the set
from the authoritative `/api/streaming-sessions` REST list — self-healing a missed
`streaming-started`/`-ended` that would otherwise leave a badge stuck on (the same
liveness reconcile the server side describes for `clearStreamingSessionsForTask`).

## Key files

- `src/contexts/WebSocketContext.tsx:167` — `onmessage` fan-out; `:282` `subscribe`; `:75` backoff.
- `src/contexts/TaskContext.tsx:185` — the provider; `:715` `reconcileLiveTaskIds`.
- `src/hooks/useConversationSubscription.ts` — conversation channel (+ reconnect re-subscribe).
- `src/hooks/useTaskSubscription.ts` — task channel → folds events into `TaskContext`.
- `src/hooks/useTasksLiveSubscriptions.ts` — the task-set live-badge subscription.
