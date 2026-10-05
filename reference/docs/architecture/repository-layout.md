# Repository layout — where everything lives

Orient here before opening files: the repo root is *not* the app. The runnable
application — backend, frontend, shared contracts, scripts, docs, and the
autoloaded `CLAUDE.md` — all live under **`reference/`**. Run every
install/build/test/dev command from there (`cd reference`).

## Repo root vs `reference/`

```
<repo root>
  SPEC.md, core/, extra/   spec-first scaffolding (not the runnable app)
  README.md, LICENSE
  reference/               ← the actual application (everything below is here)
```

Inside `reference/`:

```
server/      Backend (Node + Express + ws + better-sqlite3), run by tsx
src/         Frontend (React 18 + Vite + Tailwind + CodeMirror)
shared/      Type/contract layer imported by BOTH halves (alias @shared/*)
scripts/     One-off + agent-invoked CLIs (run via tsx)
docs/        This documentation tree
public/      Static assets (incl. the PWA service worker)
CLAUDE.md    Autoloaded master index (AGENTS.md is a symlink to it)
```

## `server/` map

```
index.ts        Express + WS bootstrap, route mounting, startup/shutdown
cli.ts          Dev launcher
database/       init.sql + db.ts (schema, migrations, xxxDb helpers)
middleware/     auth, validate (zod boundary), upload
routes/         HTTP handlers — one file per resource (+ a co-located *.test.ts)
services/       Domain logic (conversation/*, providers/*, atlas/*, agentRunner, …)
websocket/      dispatch (channels + per-msg auth) + broadcast helpers
constants/      prompts/*.md (per agent type) + reusable template fragments
```

See [`../backend/rest-api.md`](../backend/rest-api.md) for the route catalog,
[`../backend/server-bootstrap.md`](../backend/server-bootstrap.md) for `index.ts`,
and [`data-model.md`](./data-model.md) for `database/`.

## `src/` map

```
App.tsx         React Router routes + the provider-context stack
main.tsx        Entry: PWA/native bridge, root render
contexts/       TaskContext, AuthContext, WebSocketContext, provider contexts
hooks/          useSessionStreaming, the subscribe-* hooks, useSlashCommands, …
pages/          One thin wrapper per route (binds URL params → context)
components/      UI: Dashboard, BoardView, TaskDetailView, ChatInterface, atlas/*, Admin/*
utils/api.ts    The namespaced REST client (authenticatedFetch, token refresh)
```

See [`../frontend/app-shell.md`](../frontend/app-shell.md) and
[`../frontend/state-and-realtime.md`](../frontend/state-and-realtime.md).

## The `shared/` contract split

`shared/` is the type-checked seam between frontend and backend, imported via
the `@shared/*` alias (`tsconfig.json` `paths`). **Six subfolders, each a
distinct kind of contract** — pick the right one when adding a type:

| Subfolder | What it holds |
|---|---|
| `schemas/` | **zod validators** — the runtime input boundary (`validate*` middleware parses `req` against these). |
| `api/` | **TypeScript request/response types** for REST (compile-time shapes; `_common.ts` has `ApiError`). |
| `websocket/` | the WS **message union** + broadcaster fn types (`messages.ts`). |
| `types/` | **DB row types** (`db.ts`) + agent-model-settings + atlas types. |
| `sdk/` | re-exports of `@anthropic-ai/claude-agent-sdk` transcript types (one import path for `SDKMessage`). |
| `providers/` | the provider-neutral surface (`types.ts`, `capabilities.ts`, `models.ts`) — see [`../providers/overview.md`](../providers/overview.md). |

**`schemas/` vs `api/`:** `schemas/*` validate *incoming* bytes at runtime;
`api/*` describe the *shapes* both sides agree on at compile time. A route adds
a zod schema in `schemas/`, infers its body type there, and the response type
lives in `api/`.

## TypeScript-only guard

Every source file is `.ts`/`.tsx`. `tsconfig.json` sets `allowJs: false`, and
a `pnpm guard-no-js` prelint hook (`scripts/guard-no-js.ts`) fails CI on any
new `.js`/`.jsx` outside `node_modules`/`dist`/`coverage` and a tiny `ALLOWLIST`
(browser-served files like `public/sw.js`). Never add JS source.

## pnpm scripts (run from `reference/`)

| Script | Does |
|---|---|
| `pnpm dev` | backend + frontend concurrently (Vite :5173, API :3002) |
| `pnpm server` / `pnpm client` | one half only (used internally by `dev`) |
| `pnpm build` | production build |
| `pnpm test:run` | Vitest, single run (`pnpm test` = watch) |
| `pnpm typecheck` | `tsc --noEmit` (TS is a checker; tsx runs the `.ts` directly) |
| `pnpm lint` | eslint (runs `guard-no-js` first) |

> The backend runs under `tsx` with no hot-reload — restart the dev server to
> pick up server changes; the frontend hot-reloads via Vite HMR.

## Key files

- `reference/tsconfig.json` — `allowJs:false`, the `@shared/*` / `@/*` path
  aliases.
- `reference/package.json` — the `scripts` table above + the dependency pins.
- `reference/scripts/guard-no-js.ts` — the TS-only CI guard + its `ALLOWLIST`.
- `reference/pnpm-workspace.yaml` — native-build allowlist (better-sqlite3,
  node-pty, sharp, …).
