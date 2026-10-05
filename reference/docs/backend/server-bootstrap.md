# Server bootstrap — startup, WS upgrade, shutdown, route mounts

`server/index.ts` is the single backend entry point: it builds the Express app +
the WebSocket server, mounts every route, and runs the startup sequence. The HTTP
catalog is [`rest-api.md`](./rest-api.md); the WS internals are
[`../architecture/websocket-protocol.md`](../architecture/websocket-protocol.md).

## Startup sequence

`startServer()` (`:367`), in order:

1. **`ensureJwtSecret()`** (`:371`) — fail loud if `JWT_SECRET` is missing or the
   forbidden placeholder, *before* binding the port (no insecure boot). See
   [`../auth/authentication.md`](../auth/authentication.md).
2. **`await initializeDatabase()`** (`:373`) — run `init.sql` + the idempotent
   `ALTER` migrations (see [`../architecture/data-model.md`](../architecture/data-model.md)).
3. **`claimDatabaseOwnership()`** (`:382`) — decide whether steps 4–6 run at all.
   See [Crash recovery is gated on ownership](#crash-recovery-is-gated-on-ownership).
4. **Orphan-run recovery** — any `task_agent_runs` left `running` from a
   previous process (a crash/restart mid-turn) is marked `failed`. This is one of
   the three writers of `'failed'` and is what stops a dead run's chain from
   resuming on boot (see [`../agents/agentic-loop.md`](../agents/agentic-loop.md)).
5. **Landing reconciliation** — `reconcileTaskLandings()` repairs a persisted
   merge request whose PR reached MERGED while the process was dying, and
   continues large worktree cleanups in the background.
6. **Orchestration reconciliation** — every epic with `orchestration_active`
   and no block gets a `server-restarted` snapshot event, waking its
   orchestrator to re-read state rather than replaying the in-memory event queue
   the restart just dropped. This matters here because the service redeploys on
   every merge to main: pausing on restart would pause active epics constantly.
   See [`../epics/orchestrator.md`](../epics/orchestrator.md).
7. **`server.listen(PORT, '0.0.0.0')`** (`:416`).

## Crash recovery is gated on ownership

Steps 4–6 are each correct exactly once — when the process that *started* the
state they find is the one that died. They are written on the assumption that
this server is the only one on this database, and that assumption fails on a dev
box where the live service and a worktree dev server share one SQLite file: a
worktree's `server/database/bottega.db` is a symlink to the live one.

It fails destructively. On 2026-09-04 a worktree dev server booted for a QA pass
and swept two runs the live service was actively streaming (a review and an
implementation) to `failed`. Both kept streaming to a healthy finish, but the
completion hook then read `status !== 'running'`, took its "the user aborted"
branch, and stopped chaining — two workflows stalled silently. The same boot
also reconciled landings (which removes git worktrees) and would have woken the
live orchestrators.

So `claimDatabaseOwnership()` (`server/database/ownership.ts`) records this
process's pid in a lock file beside the database, and recovery runs only for the
server that holds it. The mechanics that matter:

- **The lock sits next to the resolved file, not the path as configured.**
  `realpathSync` collapses a worktree's symlink onto the live database, so both
  servers contend for one lock. Locking beside the link would give every
  worktree a private lock and guard nothing.
- **A dead owner is taken over.** `process.kill(pid, 0)` tests liveness; a lock
  left by a crash reads as free, so the restart path is unchanged and no
  operator config, env var, or systemd unit edit is involved.
- **An unreadable lock counts as no lock** — a file truncated by a crash
  mid-write must not wedge recovery shut on the one boot that needs it.
- **A non-owning server is otherwise unchanged.** It serves, reads, writes, and
  runs the agents you start on it; it just does not recover runs it is in no
  position to reason about. It says so loudly at boot, naming the owning pid.
- **Two accepted limits**, both strictly better than the unconditional sweep:
  pid reuse after a hard crash can skip recovery once (logged, and a graceful
  shutdown avoids it by releasing the lock), and two servers booting within
  milliseconds of each other onto the same dead owner can both take over.

**Step 2 is deliberately not gated.** A worktree server needs its own branch's
schema to boot, so migrations still run against whatever database it opened —
the residual hazard, and the reason the boot banner now prints the symlink
target (`server/database/connection.ts`). Export `DATABASE_PATH` to a copy to
work in isolation; setting it in the `.env` *file* is too late, since
`connection.ts` is imported before dotenv runs.

## The WebSocket server + upgrade

A single `WebSocketServer` is attached to the HTTP server (`:120`). Auth happens
in **`verifyClient`** (`server/websocket/verifyClient.ts`): it reads the `?token=`
query param (or `Authorization` header) through `getUpgradeToken` and runs
`authenticateWebSocket`; an unauthenticated handshake is rejected before upgrade
(`401`), and the resolved user is stashed on the request. The hook uses `ws`'s
callback form so a rejection can carry a status: a locked database (`SQLITE_BUSY`
thrown by the synchronous credential lookup) answers `503` with `Retry-After`, any
other throw `500` — `ws` runs this hook straight off the HTTP server's `upgrade`
event, where an escaping exception is an uncaught one. The broadcaster factories
(`makeBroadcastTo{Task,Conversation,Atlas}Subscribers`) are built from `wss` and
hung on `app.locals` so route handlers can broadcast; `initAtlasBridge` (`:147`)
injects the atlas broadcaster + subscriber counter.

Everything that happens on an accepted socket is installed by
`makeConnectionHandler` (`server/websocket/connection.ts`, wired at `:249`),
so it runs against a real `WebSocketServer` in `connection.test.ts` without
booting the app. Two rules there keep one bad client from taking the process
down, which is how the backend died twice on 2026-09-02:

- **Every accepted socket gets an `'error'` listener first.** `ws` reports a
  protocol violation (an unmasked frame, a bad close code) by emitting
  `'error'` on that socket, and an EventEmitter with no listener throws from
  the socket's data handler, where nothing catches it
  (`WS_ERR_EXPECTED_MASK`). The listener logs at warn level and
  `terminate()`s that socket only; its `'close'` event runs the usual
  subscription cleanup.
- **The upgrade never parses the request target unguarded.** Node's HTTP
  parser accepts targets `new URL` rejects (`http://[`), and `verifyClient`
  runs inside the server's `'upgrade'` listener, where a throw is equally
  fatal. `getUpgradeToken` yields no token for such a target, so the handshake
  fails authentication like any other.

## Heartbeat

A 30s `setInterval` (`HEARTBEAT_INTERVAL`, `:125`) pings every client and
`terminate()`s any that didn't pong since the last tick (`isAlive === false`),
reaping half-open sockets. The interval is cleared on `wss` close.

## Route mounts

The mount order encodes two invariants (`:178`–`:212`):

- **`/api/webhooks` is mounted with `express.raw` *before* `express.json()`**
  (`:178`/`:180`) — the GitHub webhook needs the raw body for HMAC (see
  [`../agents/github-webhooks.md`](../agents/github-webhooks.md)).
- Most routers mount behind `authenticateToken`; `/api/auth`, `/api/account`, and
  `/api/app-settings` are public-ish; **`/api/admin` adds `requireAdmin`** (`:212`).

Static SPA assets are served from `../public` via `express.static` (`:219`).

## Process-level guards

`installProcessGuards()` (`server/processGuards.ts`) registers the
`uncaughtException` / `unhandledRejection` handlers — there were none until
2026-09-04, when a single `SQLITE_BUSY` thrown out of the auth middleware ended
a server. The policy is deliberately narrow: an error nothing caught keeps the
process serving **only** if it is a busy/locked `SqliteError` — a transient
property of the shared file, and the statement that hit it did not run.
Anything else (a `TypeError`, a constraint violation, `SQLITE_CORRUPT`) is
logged and exits with code 1 exactly as Node would, so programming errors are
never swallowed. It is a backstop: the request paths that can throw are guarded
where they run (`middleware/databaseBusy.ts`, `websocket/verifyClient.ts`) and
fail the *request* with a `503`; a busy error that reaches the process came from
somewhere with no request to fail (a timer, a hook), and the log line carries
its stack so that site can be guarded too.

## Graceful shutdown

`SIGTERM` / `SIGINT` both route through `shutdown()` (`:438`), which releases
the database lock and calls `server.close()` to drain the HTTP server before
exiting — the path systemd uses on restart (the service is managed via systemd,
never by killing the node process). Releasing is what keeps the *next* boot on
the recovery path instead of reading a stale pid, and it no-ops unless this
process holds the lock: a dev server exiting must not hand the live service's
database away.

## Key files

- `server/index.ts:367` — `startServer` (secret gate → DB init → ownership → recovery → listen).
- `server/database/ownership.ts` — `claimDatabaseOwnership` / `releaseDatabaseOwnership`.
- `server/websocket/verifyClient.ts` — the upgrade auth hook (`401` / `503` on a locked database / `500`) and `getUpgradeToken`, which never lets an unparseable request target throw.
- `server/websocket/connection.ts` — `makeConnectionHandler` (the per-socket `'error'` guard, path routing, chat message loop, `'close'` cleanup); `connection.test.ts` drives it over a real socket.
- `server/processGuards.ts` — the last-resort handlers and the survive-only-`SQLITE_BUSY` policy.
- `server/index.ts:120` — the `WebSocketServer`; `:125` heartbeat.
- `server/index.ts:178` — the raw-body webhook mount; `:212` the admin router mount.
- `server/index.ts:438` — `shutdown()`, wired to `SIGTERM`/`SIGINT`.
- `server/websocket/dispatch.ts` — the broadcaster factories mounted on `app.locals`.
