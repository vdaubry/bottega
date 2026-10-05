# Explore / code-atlas — the in-process MCP server & schema generation

The "Explore" feature renders a diagram (a code "schema") of a task's repo by
letting a Claude turn drive a read-only IDE through an **in-process MCP server**.
This is the backend; the UI is [`explore-ide.md`](./explore-ide.md).

## The code-atlas MCP server

`buildAtlasMcpServer({ taskId, userId })`
(`server/services/atlas/mcpServer.ts:64`) builds an **in-process** SDK MCP server
(`createSdkMcpServer`) exposing three tools to the model:

- **`open_file`** (`:75`) — open a workspace-relative file in the Explore viewer.
- **`highlight`** (`:105`) — paint highlight decorations on line ranges.
- **`render_artifact`** (`:158`) — validate + persist the generated diagram HTML
  to `task_artifacts` (`taskArtifactsDb`, keyed by `(task_id, kind)`), and push it
  to the view. **`render_artifact` persists even with no view open** — the others
  no-op (`NO_VIEW_NOTE`) when `getAtlasSubscriberCount(taskId) === 0`.

File reads go through `Workspace` (`atlas/workspace.ts`) — **read-only,
containment-enforced** (any path outside the task's repo root is rejected).

## The WS UI-bridge (ack/timeout)

The tools run server-side but act on the user's browser, so each tool call
**broadcasts a UI command and waits for the view to ack it actually applied**.
`sendAtlasEvent(taskId, command, timeoutMs)`
(`server/services/atlas/bridge.ts:57`) tags a `requestId`, broadcasts on the atlas
channel, and resolves on the first matching `atlas-ack` or rejects on timeout
(`ATLAS_ACK_TIMEOUT_MS = 5000`; artifacts get 15s). The bridge's broadcaster +
subscriber-counter are injected at boot via `initAtlasBridge` (`:42`,
`server/index.ts`); the WS dispatcher owns the subscription map and routes
`atlas-ack` back here (see [`../architecture/websocket-protocol.md`](../architecture/websocket-protocol.md)).

## atlasInjection — gated on the conversation row

`withAtlasMcpServer(mcpServers, { conversationId, taskId, userId })`
(`server/services/conversation/atlasInjection.ts`) merges the `code-atlas` server
into the SDK config **only when `conversation.atlas_enabled === 1`**. The
conversation row is the source of truth — stamped at creation by the Explore flow
— so WS resume and the 401-retry path re-inject the tools without the caller
knowing how the conversation was created.

## The Anthropic-only constraint

Generation runs on the user's **`schema`** agent-model setting (Settings → Agent
Models → Schema), which is **locked to Anthropic** (the in-process MCP server +
SDK tooling are Claude-only). `POST /api/tasks/:id/atlas/generate-artifact`
(`server/routes/atlas.ts:167`) creates an `anthropic` conversation flagged
`atlas_enabled` and runs the `atlas-artifact` prompt. It's idempotent:
`getOngoingAtlasGenerationConversationId` binds a re-entry to an in-flight
generation instead of spawning a duplicate. The schema-lock seeding is in
[`../providers/connection-ui.md`](../providers/connection-ui.md).

## Key files

- `server/services/atlas/mcpServer.ts:64` — `buildAtlasMcpServer`; `:75`/`:105`/`:158` the three tools.
- `server/services/atlas/bridge.ts:57` — `sendAtlasEvent` (ack/timeout); `:16` the timeout constant; `:42` `initAtlasBridge`.
- `server/services/atlas/workspace.ts` — the read-only, containment-enforced `Workspace`.
- `server/services/conversation/atlasInjection.ts` — `withAtlasMcpServer` (gated on `atlas_enabled`).
- `server/routes/atlas.ts:167` — the generate-artifact endpoint (Anthropic-only, idempotent).
- `server/constants/prompts/atlas-artifact.md` — the generation prompt.
