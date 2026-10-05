# Explore IDE — TaskIdePage, the tab reducer, the atlas WS channel

The frontend of Explore: a read-only IDE (`/ide`) the code-atlas MCP tools drive
to render a schema diagram. The backend is
[`schema-generation.md`](./schema-generation.md).

## TaskIdePage

`src/pages/TaskIdePage.tsx` is the `/projects/:projectId/tasks/:taskId/ide` route
(see [`../frontend/app-shell.md`](../frontend/app-shell.md)). Layout: a file tree
(`AtlasFileTree`, same repo resolution as conversations), a `CodeMirror` file
viewer (`AtlasFileViewer`), and a pinned **Schema** tab (`AtlasTabs`) showing the
rendered artifact. There is **no in-page model picker** — generation uses the
Anthropic-locked `schema` setting from Settings → Agent Models.

## The tab/view reducer

View state (which tabs are open, the active file/highlight, the schema artifact)
is a **pure reducer**, `atlasViewReducer` + `initialAtlasViewState`
(`src/components/atlas/atlasTabsReducer.ts`), driven via `useReducer`
(`TaskIdePage:75`). `SCHEMA_TAB_ID` is the always-present schema tab; file tabs are
`file:{path}`. Keeping it pure makes the open-file / highlight / set-artifact
transitions unit-testable independent of the WS plumbing.

## Schema tab — auto-generate on first entry

On entry the page lists the task's artifacts and `decideSchemaEntry(kinds)`
(`src/components/atlas/schemaEntryDecision.ts`) chooses: **show** the existing
`plan` artifact (idempotent re-entry, no wasted Claude turn) or **generate** one
(`api.atlas.generateArtifact`, `TaskIdePage:229`). A one-shot ref guards the
auto-generate against React strict-mode double effects. A regenerate widget offers
the concrete artifact kinds (no `auto`).

## useAtlasEvents — the atlas WS channel

`useAtlasEvents(taskId, handlers)` (`src/components/atlas/useAtlasEvents.ts:23`)
is the client end of the UI-bridge: it `subscribe-atlas`s the socket to the task
(`:33`), routes incoming `atlas-open-file` / `atlas-highlight` /
`atlas-render-artifact` commands to the page's handlers, and — crucially — **sends
the `atlas-ack` each command requires** (with the command's `requestId`), which is
what unblocks the server-side `sendAtlasEvent` promise. Render-artifact's handler
is async (returns once stored) and acks with detail. The hook resubscribes after a
WS reconnect.

## Key files

- `src/pages/TaskIdePage.tsx:229` — the `/ide` page (auto-generate entry, regenerate widget).
- `src/components/atlas/atlasTabsReducer.ts` — `atlasViewReducer` + `initialAtlasViewState`, `SCHEMA_TAB_ID`.
- `src/components/atlas/schemaEntryDecision.ts` — `decideSchemaEntry` (show vs generate).
- `src/components/atlas/useAtlasEvents.ts:23` — the atlas WS channel + `atlas-ack`.
- `src/components/atlas/{AtlasFileTree,AtlasFileViewer,AtlasTabs}.tsx` — tree / CodeMirror viewer / tabs.
