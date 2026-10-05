# Bottega

Web-based UI for the Claude Code CLI: a desktop/mobile interface for managing
projects, tasks, conversations, and agentic coding workflows.

> **Repo layout (spec-first).** `SPEC.md`, `core/`, and `extra/` sit at the
> repository root; the complete runnable application — and this `CLAUDE.md` —
> live under **`reference/`**. From the repo root the actual codebase is at
> `reference/`, so run all install/build/test/dev commands from there
> (`cd reference`).

## Documentation index — read the relevant docs *before* exploring code

`docs/` is a domain-organized reference written for a coding agent: each doc
summarizes what exists, where it lives, and the non-obvious invariants of one
subsystem, so you can scope and steer code exploration instead of spelunking
cold. **Before exploring code for a request, consult the table below and read
the docs whose "when to read" matches the task** — then dive into the cited
`file:line` anchors. `docs/project.md` is the narrative overview + folder map;
this table is the authoritative per-doc index.

> The table is built iteratively (one phase per folder). Rows are added as each
> domain's docs land — an unlisted subsystem just isn't documented *yet*; read
> its code directly.

| Doc | When to read |
|---|---|
| **[`docs/project.md`](docs/project.md)** | First — the system overview, the architecture diagram, and the folder map. |
| **[`docs/architecture/data-model.md`](docs/architecture/data-model.md)** | Anything touching SQLite: tables/columns, FKs & cascades, the init.sql + idempotent-ALTER migration model, the `xxxDb` query helpers, the row types in `shared/types/db.ts`. |
| **[`docs/architecture/websocket-protocol.md`](docs/architecture/websocket-protocol.md)** | Anything over `/ws`: the `?token=` auth, the 3 subscription channels, the broadcaster-factory-on-`app.locals` pattern, the heartbeat, the REST→`202`→WS streaming bridge. |
| **[`docs/architecture/repository-layout.md`](docs/architecture/repository-layout.md)** | Getting oriented: repo-root vs `reference/`, the `server/`/`src/`/`shared/`/`scripts/` map, the six-way `shared/` contract split (schemas vs api vs websocket vs types vs sdk vs providers), the TS-only guard, the pnpm scripts. |
| **[`docs/backend/rest-api.md`](docs/backend/rest-api.md)** | Adding/refactoring/debugging an HTTP endpoint: the cross-cutting conventions (auth, zod validation, `404`-not-`403`, status codes), the `index.ts` mount map, and the per-route-file endpoint catalog. |
| **[`docs/agents/worktree-provisioning.md`](docs/agents/worktree-provisioning.md)** | What makes a worktree *runnable* rather than merely checked out: the project's own `post-checkout` hook (git runs it inside `git worktree add`, for every worktree, whatever the stack), why Bottega deliberately owns none of it, `core.hooksPath` for committing the hook, per-stack examples, and the bare-checkout consequence (plus settings warning) for projects without one. |
| **[`docs/web-server/switch-server.md`](docs/web-server/switch-server.md)** | The "switch server" feature: pointing an NGINX-served symlink at a ticket worktree, an epic's delivery worktree, or the main checkout to live-preview a branch; the `ServeTarget` union + `EpicServeResolver` registry; and the `.bottega/switch.sh` activation-hook contract. |
| **[`docs/providers/overview.md`](docs/providers/overview.md)** | Anything multi-provider: the `LlmProvider` interface, the registry, `UnifiedMessage`, the capability matrix (the single Claude-gating mechanism), and the inline-Claude-fork nuance in `startConversation`. |
| **[`docs/providers/credentials.md`](docs/providers/credentials.md)** | Provider auth plumbing: the per-user `ProviderCredentialStore`, the global-auth-env-stripping invariant, where each provider's config dir lives, and the "connected providers" check. |
| **[`docs/providers/claude.md`](docs/providers/claude.md)** | The Anthropic backend: `AnthropicProvider` over `query()`, SQLite as the transcript source of truth, the per-user Claude OAuth PTY login, and the stale-subprocess 401 recovery. |
| **[`docs/providers/codex.md`](docs/providers/codex.md)** | The OpenAI Codex backend: the spawn-per-turn `Thread`, the dropped-feature set, the device-auth PTY flow, `CODEX_HOME`/auth.json, and in-band usage-limit errors. |
| **[`docs/providers/opencode.md`](docs/providers/opencode.md)** | The OpenCode backend: out-of-process HTTP+SSE, the per-user `opencode serve` pool (spawn/idle-reap/LRU/invalidation), workspace routing, server-side abort, and Zen-key auth. |
| **[`docs/providers/connection-ui.md`](docs/providers/connection-ui.md)** | The provider connection frontend: the three connect panels, the non-dismissable ConnectedProviders gate, the shared `ProviderModelPicker`, and the Agent Models tab (incl. the Anthropic-locked `schema` key). |
| **[`docs/conversations/lifecycle-and-streaming.md`](docs/conversations/lifecycle-and-streaming.md)** | Running a turn server-side: `startConversation` vs `sendMessage`, the unified `runStreamingLoop`, the in-memory session Maps, `composeOnComplete`, 401 recovery, and owner-specific Stop semantics. |
| **[`docs/conversations/features.md`](docs/conversations/features.md)** | The per-turn features layered on the loop — AskUserQuestion, thinking deltas, media, MCP-readiness wait, slash-command expansion, context-usage, title generation — and which are Anthropic-only. |
| **[`docs/conversations/chat-ui.md`](docs/conversations/chat-ui.md)** | The chat frontend: `ChatInterface` + `useSessionStreaming` (content-block parsing, abort, conversation-busy), message/status/list components, the composer affordances, the AskUserQuestion widget, and the start / PR-repair modals. |
| **[`docs/agents/agentic-loop.md`](docs/agents/agentic-loop.md)** | The agentic workflow: the six agent types, `startAgentRun`, the planification→implementation↔review→refinement→pr chaining state machine, DB-derived completion, per-user agent model settings, and YOLO mode. |
| **[`docs/agents/prompt-templates.md`](docs/agents/prompt-templates.md)** | Agent prompts: the `server/constants/prompts/*.md` defaults, `promptRenderer`'s default-vs-`~/.bottega` override model + `{{var}}` rendering, and the Agent Prompts settings editor + routes. |
| **[`docs/agents/worktrees-and-pr.md`](docs/agents/worktrees-and-pr.md)** | Git plumbing: the `worktree.ts` primitives ({repo}-worktrees/task-{id}, branch naming, status/commit), `prService` unified PR creation (manual button + PR agent), and the `complete-workflow`/`complete-pr` scripts. |
| **[`docs/agents/github-webhooks.md`](docs/agents/github-webhooks.md)** | The GitHub webhook: the HMAC-authed `/github` endpoint (raw body, mounted before `express.json`), branch→task parsing, the configurable @-trigger, PR-comment/review re-entry into the loop, and the gh-CLI injection guards. |
| **[`docs/agents/agent-ui.md`](docs/agents/agent-ui.md)** | The agent frontend: `AgentSection` (launch the agents, live status via `agent-run-updated`), the latest-run-by-id rule, `TodoList`, the run-phase trigger, and the Fix-CI entry point. |
| **[`docs/tasks/domain-model.md`](docs/tasks/domain-model.md)** | The projects→tasks→conversations domain: the task status lifecycle, the workflow-flag semantics that drive the agentic loop, the on-disk `~/.bottega` task-doc archive, and id-based URL routing. |
| **[`docs/tasks/board-and-screens.md`](docs/tasks/board-and-screens.md)** | The 4-screen flow: Dashboard (project cards + cross-project in-progress), BoardView (Kanban columns), TaskDetailView (doc + conversations + worktree/CI/PR/switch/explore controls), and the page wrappers. |
| **[`docs/auth/authentication.md`](docs/auth/authentication.md)** | Proving identity: JWT + `ccui_` API keys via `resolveToken`, the `JWT_SECRET` gate, `token_version` invalidation, the rolling 30-day refresh, login rate limiting, and the first-user-admin bootstrap. |
| **[`docs/auth/authorization.md`](docs/auth/authorization.md)** | Access control: the `project_members` membership model (`hasProjectAccess`), the 404-not-403 existence-hiding pattern, the orthogonal `requireAdmin` axis + admin panel, and `is_technical` (behaviour, not access). |
| **[`docs/atlas/schema-generation.md`](docs/atlas/schema-generation.md)** | The Explore backend: the in-process code-atlas MCP server (open_file/highlight/render_artifact), the WS UI-bridge with ack/timeout, `atlasInjection` gated on `atlas_enabled`, the Anthropic-only constraint, and `task_artifacts`. |
| **[`docs/atlas/explore-ide.md`](docs/atlas/explore-ide.md)** | The Explore frontend: `TaskIdePage` (`/ide`), the `atlasViewReducer` tab/file state, the CodeMirror viewer, the Schema tab + auto-generate-on-first-entry, and `useAtlasEvents` (the atlas WS channel + `atlas-ack`). |
| **[`docs/frontend/app-shell.md`](docs/frontend/app-shell.md)** | The app skeleton: the `App.tsx` provider-nesting contract + route table, the `ProtectedRoute` gate, the PWA/native bridge, and the REST client (`utils/api.ts`: namespaced calls, `authenticatedFetch`, `X-Refreshed-Token`). |
| **[`docs/frontend/state-and-realtime.md`](docs/frontend/state-and-realtime.md)** | Client state: `TaskContext` (domain state, selection, live-task tracking + `liveTaskIds` reconcile) + `WebSocketContext` (single socket, typed pub/sub, backoff reconnect) + the subscription hooks and the re-subscribe-on-reconnect convention. |
| **[`docs/backend/server-bootstrap.md`](docs/backend/server-bootstrap.md)** | Server startup: the JWT-secret gate, DB init, orphan-run recovery, the WS upgrade/`verifyClient` auth + heartbeat, the route mount map (raw-body webhook before `express.json`), and graceful SIGTERM/SIGINT shutdown. |
| **[`docs/backend/background-services.md`](docs/backend/background-services.md)** | Cross-cutting services: OneSignal push notifications, the `~/.bottega` filesystem archive (task docs / input_files / recordings), the `multer` upload middleware, and the first-run demo seeder. |
| **[`docs/epics/entity-and-conversations.md`](docs/epics/entity-and-conversations.md)** | The Epics subsystem as it exists today: the `epics` entity + stage flags, the owner-less `conversations` + link tables and the owner-adapter registry, the split `epic_agent_runs`/`epic_tickets`, the epic WS channel, the `~/.bottega` epic archive + isolation principle, `startEpicAgentRun` + the architecture stage, and the v0 `epic_runs` conversion. |
| **[`docs/epics/feature-branch.md`](docs/epics/feature-branch.md)** | Anything about where a ticket branches from or merges into: the `epic/{id}-{slug}` lifecycle, `resolveBaseBranch` + `tasks.base_branch`, the shared `taskService` creation/deletion path, the auto-sync-at-loop-entry rule, `--base` PRs, and the epic completion PR. |
| **[`docs/epics/technical-specification.md`](docs/epics/technical-specification.md)** | The specification stage and the in-process `bottega` MCP server every epic agent acts through: the per-agent-type tool catalog + row-derived injection, `mark_stage_complete` (flag only — why the summary argument was dropped), the two acceptance criteria the specification prompt is held to, the docs write gate (PreToolUse), and the `epic-updated` event. |
| **[`docs/epics/stories.md`](docs/epics/stories.md)** | The stories stage: the `create_task`/`list_epic_tasks`/`update_task`/`delete_task` MCP tools and their guards (the revision window, the list closing when work starts), why the ticket list — not a document — is the state, and the ticket-description isolation rule. |
| **[`docs/epics/spec-review.md`](docs/epics/spec-review.md)** | The specification review stage — the consistency gate between the tickets and autonomous implementation: the four kinds of finding and the seven checks, the one-file report in `review/`, the four-part conversation (review → settle with the user → apply the approved fixes at every level → sign off on their word), why this is the one agent that writes into `spec/`, `architecture/`, `docs/` and the tickets, the `review_complete` flag the orchestrator start gates on, and the backfill for epics already under way. |
| **[`docs/epics/ui.md`](docs/epics/ui.md)** | The Epics surface: the `Tasks \| Epics` board tab and epic routes, the epic page's Main \| Artifacts tabs, the agent rail incl. the PR-review row (run status vs the signed-off flag) and the "Mark complete" backstop route, the folded artifact browsers incl. mermaid-in-markdown scoping, tickets in execution order, and which WS channel carries what. |
| **[`docs/epics/orchestrator.md`](docs/epics/orchestrator.md)** | The autonomous implementation stage: why the orchestrator is a drop-in for the human, the dormant-between-events run model + per-ticket conversations, the `[bottega-event]` bridge (hooks, queue, counters), sequencing and epic completion, boot self-healing, and the tool catalog. |
| **[`docs/epics/delivery.md`](docs/epics/delivery.md)** | The epic's final pull request: why delivery is an agent with a section and NOT a stage (no flag, no gate, no sign-off), the `{repo}-worktrees/epic-{id}` delivery worktree and why the main checkout is off limits, the two entry points (the Delivery section's button and a GitHub `@`-mention on the final PR, via `parseEpicIdFromBranch`), and why "Open final PR" left the orchestration state machine. |
| **[`docs/epics/qa.md`](docs/epics/qa.md)** | The QA step after delivery: the scenario book (`qa/scenarios.csv`, its shared contract and structured write tools), the gated `'qa'` stage vs the stage-less execution agent, the delivery-worktree dev server + Playwright execution model, and the artifacts-tab table + CSV download. |
| **[`docs/epics/architecture-v2.md`](docs/epics/architecture-v2.md)** | The implemented task/epic decoupling design: the three layering rules, link-table data model (`epic_tickets`, `epic_agent_runs`, owner-less `conversations`), task service API + TaskEvents bus, `driver`, `base_branch`, epic-owned reviewer concurrency, and the boundary lint. Read BEFORE any change that touches both tasks and epics. |

> **Machine/operator-specific context** (your instance URLs, deploy layout,
> manual-test fixtures, auth tokens) does not belong in this file — it goes in
> `CLAUDE.local.md`, which is gitignored and loads automatically alongside this
> file. Copy `CLAUDE.local.md.example` to `CLAUDE.local.md` and fill it in for
> your environment.

## Tech Stack

- **Frontend**: React 18, Vite, Tailwind CSS, CodeMirror
- **Backend**: Node.js, Express, WebSocket (ws)
- **Database**: SQLite (better-sqlite3) at `server/database/bottega.db`

**TypeScript-only.** Every source file is `.ts`/`.tsx` — `tsconfig.json` sets
`allowJs: false` and a `pnpm guard-no-js` prelint hook fails CI on any new
`.js`/`.jsx` outside `node_modules`/`dist`/`coverage`. Don't add JavaScript
files; if you genuinely need to (e.g. a third-party script that ships as
`.js`), update the allowlist in `scripts/guard-no-js.ts`.

## Data Architecture

### What SQLite stores (server/database/bottega.db)

The database stores **metadata only** — projects, tasks, conversations, users:

- `projects` — id, name, repo_folder_path
- `tasks` — id, project_id, title, status, workflow flags
- `conversations` — id, task_id, claude_conversation_id, session_path
- `task_agent_runs` — id, task_id, agent_type, status, conversation_id

**Schema:** `server/database/init.sql`

### Where messages are stored

**Messages live in SQLite**, in two tables:
- `messages` — one row per SDK transcript entry, PK `(project_key, session_id, subpath, uuid)`
- `session_summaries` — incrementally-folded summaries per session

We register a custom `SqliteSessionStore` (`server/services/sqliteSessionStore.ts`)
with the Claude Agent SDK via the `sessionStore` option. The SDK calls our
`append/load/...` methods for every conversation; SQLite is the single source of
truth. The SDK still writes its own `.jsonl` files under `CLAUDE_CONFIG_DIR` for
its private resume path, but **runtime code never reads them** — the only file
that knows JSONL exists is `scripts/data-migrations/import-jsonl-to-sqlite.ts`.

**Query conversation metadata:**
```bash
sqlite3 server/database/bottega.db "SELECT id, task_id, claude_conversation_id, session_path FROM conversations WHERE id = <ID>;"
```

**Inspect messages for a conversation:**
```bash
# Via API
curl http://localhost:3002/api/conversations/<ID>/messages

# Or directly in SQLite — project_key = repo_folder_path (or session_path) with /. → -
sqlite3 server/database/bottega.db "SELECT seq, json_extract(entry_json,'$.type') AS type FROM messages WHERE session_id = (SELECT claude_conversation_id FROM conversations WHERE id = <ID>) ORDER BY seq"
```

### URL routing

URLs follow the pattern `/projects/:projectId/tasks/:taskId/chat/:conversationId`.
All IDs correspond to SQLite row IDs, so a URL like
`/projects/178/tasks/562/chat/2683` maps directly to row lookups:
```bash
sqlite3 server/database/bottega.db "SELECT * FROM conversations WHERE id = 2683;"
sqlite3 server/database/bottega.db "SELECT * FROM tasks WHERE id = 562;"
sqlite3 server/database/bottega.db "SELECT * FROM projects WHERE id = 178;"
```

## Third-Party APIs & Libraries

Before using any external API or library:
1. **Verify with Context7 MCP** — `resolve-library-id` → `get-library-docs`
2. **If insufficient**, use `WebFetch` on official docs
3. **Never assume** method names, parameters, or response formats

## API request validation

Every Express route handler that reads `req.body`, `req.params`, or `req.query`
must validate that input through a zod schema before touching it. Schemas live
next to their HTTP contracts in `shared/schemas/` (`auth.ts`, `admin.ts`,
`projects.ts`, `tasks.ts`, plus a `_common.ts` for shared shapes like
`IdParamsSchema`). Each schema also exports its inferred type via
`z.infer<typeof X>`, so backend handlers and frontend callers share a single
source of truth.

The boundary itself is three middleware factories in
`server/middleware/validate.ts`: `validateBody`, `validateParams`,
`validateQuery`. They run `schema.safeParse()` on the corresponding slice of
`req`, attach the parsed value to `req.validated.body/.params/.query`, and on
failure short-circuit with HTTP 400 and
`{ error: 'Validation failed', issues: ZodIssue[] }`. Handlers read fields off
`req.validated!.body as <BodyType>` (the field is `unknown` at the type level —
each route casts to the schema it asked for). When adding a new route, add a
schema to `shared/schemas/`, plug the matching `validate*` middleware in front
of the handler, and delete any ad-hoc shape checks that the schema now enforces.

## pnpm scripts

This project uses **pnpm** (pinned via `packageManager` in `package.json` and
provisioned by Corepack — run `corepack enable` once after cloning).

- `pnpm dev` — frontend + backend concurrently (Vite on :5173, API on :3002)
- `pnpm server` / `pnpm client` — backend / frontend only (used internally by `pnpm dev`)
- `pnpm build` — production build
- `pnpm test:run` — unit + integration tests (single run)

Backend (`tsx`) does **not** hot-reload — restart the dev server to pick up
backend changes. Frontend changes hot-reload via Vite HMR.

## Deployment

Bottega runs as a systemd **user** unit (`~/.config/systemd/user/bottega.service`),
**not** a system unit — so plain `systemctl`/`journalctl` can't see it. Always use
the `--user` scope: `systemctl --user status bottega`, `journalctl --user -u bottega`.
Box-specific deploy details (paths, the sibling services it orchestrates) live in
`CLAUDE.local.md`.

## Testing Instructions

- Always add or update tests for the code you change, even if nobody asked.
- Fix any failing test until the whole suite is green.

```bash
pnpm test              # watch mode
pnpm test:run          # single run
pnpm test:coverage     # with coverage report
```

There is no Playwright e2e suite — UI flows are validated manually via the
Playwright MCP server and protected by the unit/integration suite (`pnpm test:run`).

## Manual Testing with Playwright MCP

Use the Playwright MCP server to validate UI work after implementing features.

**Authentication.** Two ways to authenticate as a real user:
1. **JWT** — `POST /api/auth/login` with `{ username, password }` returns a
   non-expiring JWT. Send it as `Authorization: Bearer <jwt>`, or as
   `?token=<jwt>` for `<video>` tags / WebSocket handshakes that can't set headers.
2. **Per-user API key** — generate from Settings → Account (plaintext shown once;
   only `sha256(key)` is stored). Send as `Authorization: Bearer ccui_<…>`. Every
   API caller has a real identity — there is no global shared key.

For MCP-driven UI testing, seed a token into localStorage before navigating, then
`browser_navigate` to `http://localhost:5173/` and the Dashboard loads
authenticated:
```js
// in mcp__playwright__browser_evaluate, once per session:
localStorage.setItem('auth-token', '<your JWT or API key>');
```

**App structure (4-screen flow):** Dashboard (project cards) → Board View
(Pending / In Progress / Completed Kanban) → Task Detail (docs + conversation
list) → Chat Interface.

**Don't mistake "Loading…" for an error.** The first `browser_snapshot` after
`browser_navigate` often shows `"Loading..."` plus WebSocket warnings — that's
normal startup while the app establishes its WebSocket and fetches data. Wait a
few seconds and snapshot again.

**Forcing a long-running conversation** (for mid-stream reload / streaming /
abort / reconnect tests), prompt: *"Run a bash loop from 1 to 60. At each
iteration, print the current number, then sleep 1 second. Use the Bash tool."* —
~60s of predictable streaming output that's trivial to inspect mid-turn.

| Playwright MCP command | Purpose |
|---------|---------|
| `browser_navigate` | Go to a URL |
| `browser_snapshot` | Capture page state (returns element refs) |
| `browser_click` | Click an element by ref |
| `browser_type` | Type text into an input |
| `browser_press_key` | Press a keyboard key |
| `browser_wait_for` | Wait for text/time |
| `browser_console_messages` | Check for errors |
