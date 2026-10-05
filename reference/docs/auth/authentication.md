# Authentication — JWTs, ccui_ API keys, the resolveToken path

How a request proves who it is. Every request must carry a credential — there is
**no IP/localhost bypass** (the backend sees `127.0.0.1` for every request behind
nginx→Vite, so an IP exception would be no auth at all). *Who can do what* once
authenticated is [`authorization.md`](./authorization.md).

## Two credential types, one resolver

`server/middleware/auth.ts` authenticates both via `resolveToken` (`:60`):

- **`ccui_` API key** — `isApiKeyFormat` → `findUserByApiKey`
  (`server/services/userApiKey.ts`): only `sha256(key)` is stored
  (`api_key_hash`); the plaintext is shown once at generation. Long-lived, **never
  refreshed**.
- **JWT** — `jwt.verify` with `JWT_SECRET`, then a `tokenVersion` check (below).

`authenticateToken` reads the credential from the `Authorization: Bearer` header
**or** a `?token=` query param (for `<video>`/WebSocket handshakes that can't set
headers), sets `req.user`, and returns `401` on absence/failure.
`authenticateWebSocket` (`:170`) reuses `resolveToken` for the `/ws` handshake.

## A locked database answers 503 — not 401, and not a crash

Both lookups are synchronous better-sqlite3 reads, and the database file is
shared with other processes (worktree dev servers, the `sqlite3` CLI, backups).
When one of them holds a lock past the busy timeout the read throws a
`SqliteError` with code `SQLITE_BUSY` — which, out of an `async` middleware,
was an unhandled rejection that killed a server on 2026-09-04.
`authenticateToken` and `requireAdmin` now run behind `withDatabaseBusyGuard`
(`server/middleware/databaseBusy.ts`): a busy/locked error answers `503` with
`Retry-After: 1` and `{ error }`, logged in one line; any other throw goes to
`next(err)` (Express's `500`) instead of the process. The WebSocket upgrade
does the same in `server/websocket/verifyClient.ts`. The status matters
client-side: only a `401` means the credential was rejected, and `AuthContext`
drops the stored token on nothing else. See
[`../architecture/data-model.md`](../architecture/data-model.md) for why the
lock happens and what WAL mode leaves of it.

## The JWT_SECRET gate

`JWT_SECRET` is **required and must not be the placeholder**
(`bottega-dev-secret-change-in-production`). `ensureJwtSecret()` is called at
startup to fail loud if it's missing/unsafe (`:34`) — a guessable secret would let
anyone forge tokens.

## token_version invalidation

Each JWT embeds the user's `tokenVersion`; `resolveToken` rejects it unless it
still matches `userDb.getTokenVersion` (`:74`). `POST /api/auth/logout` bumps the
version (`bumpTokenVersion`), so **every** previously-issued JWT for that user
fails immediately, from any device — server-side logout, not just a client token
drop. (Password change bumps it too.)

## Rolling 30-day refresh

A JWT lasts 30 days. On every successful **JWT** request the middleware re-signs a
fresh 30-day token and returns it in the `X-Refreshed-Token` header (`:119`), so a
user who touches the app at least once per 30 days is never logged out. API keys
are already long-lived and are not refreshed.

## Login, rate limiting & first-user bootstrap

`server/routes/auth.ts`:
- `POST /login` (`:125`) — bcrypt-compare, issue a JWT via `generateToken`.
- `POST /register` (`:61`) — **only works when the DB has zero users**
  (`hasUsers()` guard, re-checked inside a transaction); the first registrant is
  made admin (`setAdmin`). After that, registration is `403` — accounts are
  admin-created (see [`authorization.md`](./authorization.md)).
- Both are wrapped in `loginRateLimiter` (`express-rate-limit`, per-IP,
  successful logins don't eat the budget) to throttle brute-force.
- `GET /status` reports `needsSetup` (no users yet) so the UI shows setup vs login.

## Frontend

`src/contexts/AuthContext.tsx` holds the token (localStorage `auth-token`),
captures `X-Refreshed-Token` from responses, and gates the app via
`ProtectedRoute` (see [`../frontend/app-shell.md`](../frontend/app-shell.md)).
`SetupForm` (first-user) vs `LoginForm` is chosen off `GET /status`. On boot it
verifies the stored token with `GET /api/auth/user`: only a `401` clears the
token; a `503` (locked database) or a network failure keeps it and sets
`error`, so a transient server problem never logs anyone out.

## Key files

- `server/middleware/auth.ts:60` — `resolveToken`; `:34` `ensureJwtSecret`; `:119` rolling refresh; `:170` WS auth.
- `server/middleware/databaseBusy.ts` — `withDatabaseBusyGuard` (SQLITE_BUSY → `503` + `Retry-After`).
- `server/services/userApiKey.ts` — `generateApiKey` / `findUserByApiKey` (sha256-hashed `ccui_` keys).
- `server/routes/auth.ts:61` — `register` (first-user-admin); `:125` `login`; `:195` `logout` (version bump).
- `src/contexts/AuthContext.tsx` + `src/components/{LoginForm,SetupForm}.tsx` — the frontend auth state + screens.
