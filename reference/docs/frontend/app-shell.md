# Frontend app shell — providers, routes, the REST client

The skeleton every screen mounts into: the context-provider nesting, the route
table, the auth gate, and the REST client. Domain state lives in
[`state-and-realtime.md`](./state-and-realtime.md).

## Provider nesting (order matters)

`src/main.tsx` mounts `<App/>` in `React.StrictMode` (so effects double-fire in
dev — several hooks guard against this). `src/App.tsx` nests the context providers
in a fixed order; later providers depend on earlier ones:

```
ThemeProvider → AppSettingsProvider → AuthProvider → WebSocketProvider
  → TaskContextProvider → ToastProvider → ProtectedRoute
    → ClaudeAuthProvider → ConnectedProvidersProvider → Router(Routes)
```

`ProtectedRoute` sits *above* the provider-gated app, and `ConnectedProviders`
must be inside `ClaudeAuthProvider` (its modal consumes `useClaudeAuth`) — see
[`../providers/connection-ui.md`](../providers/connection-ui.md).

## The ProtectedRoute gate

`src/components/ProtectedRoute.tsx` blocks the app on auth state: `isLoading` →
loading screen, `needsSetup` → `SetupForm` (first user), no `user` → `LoginForm`,
else render children. So routes never see an unauthenticated user. See
[`../auth/authentication.md`](../auth/authentication.md).

## Routes

`Routes` in `App.tsx` (`:77`+) — all id-based:

| Path | Page |
|---|---|
| `/` | DashboardPage |
| `/projects/:projectId` | BoardPage |
| `/projects/:projectId/tasks/:taskId` | TaskDetailPage |
| `/projects/:projectId/tasks/:taskId/ide` | TaskIdePage (Explore) |
| `/projects/:projectId/tasks/:taskId/chat/:conversationId` | ChatPage |
| `/admin` | AdminPage |
| `*` | redirect to `/` |

Page wrappers under `src/pages/` read params + `useTaskContext` and render the
matching component (see [`../tasks/board-and-screens.md`](../tasks/board-and-screens.md)).

## PWA / native bridge

`AppWrapper` (`App.tsx:30`) detects standalone/PWA display mode
(`display-mode: standalone`, iOS `navigator.standalone`, `android-app://`
referrer) and toggles a `pwa-mode` class on `<html>`/`<body>` for install-aware
styling. Push notifications are wired to OneSignal (backend side in
[`../backend/background-services.md`](../backend/background-services.md)).

## The REST client (`utils/api.ts`)

`authenticatedFetch<T>(url, options)` (`src/utils/api.ts:179`) is the one fetch
wrapper: it reads the `auth-token` from localStorage and sets the `Bearer` header
(skipping `Content-Type` for `FormData`), and on every response **captures
`X-Refreshed-Token`** and writes it back to localStorage — the client half of the
rolling-JWT refresh. The default export `api` (`:225`) groups calls into namespaces
(`api.auth`, `api.projects`, `api.tasks`, `api.conversations`, `api.agentRuns`,
`api.atlas`, `api.settings`, `api.admin`, …) so call sites read `api.tasks.create(…)`.

## ui/ primitives

`src/components/ui/` holds the small shadcn-style primitives
(`button`, `input`, `textarea`, `badge`, `scroll-area`) every screen composes from.

## Key files

- `src/main.tsx` — `StrictMode` root mount.
- `src/App.tsx:30` — `AppWrapper` (PWA detection); `:64` `App` (provider nesting + `Routes`).
- `src/components/ProtectedRoute.tsx` — the auth gate (loading / setup / login / app).
- `src/utils/api.ts:179` — `authenticatedFetch`; `:225` the namespaced `api` client.
- `src/components/ui/*` — shared primitives.
