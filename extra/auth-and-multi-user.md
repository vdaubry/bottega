# Extra — Auth and multi-user

## What it adds

Turns Bottega from a single-operator tool into something a small company can
deploy: real **user accounts**, **login** that issues a long-lived token,
per-user **API keys** for scripted access, **project-membership authorization**
that scopes every task/project/agent-run to the people allowed to see it, an
**admin** panel for managing users and memberships, and one **role flag**
(`is_technical`) that changes loop behavior for non-technical users (they skip
the manual plan-review gate).

**Scope note up front — this is *app-level* auth: who is allowed to use
Bottega.** It is **not** the per-provider coding-harness credentials (Claude
OAuth, Codex, OpenCode Zen) an agent needs to actually run a turn. Those are a
different concern and live in the harness specs
([`harnesses/overview.md`](./harnesses/overview.md) and the per-tool files) and
in [`prompt-and-model-customization.md`](./prompt-and-model-customization.md).
The seam: this spec resolves *which user* a request belongs to; those specs
resolve *which provider credentials* that user runs agents with.

## Why it's an extra (not core)

Core assumes a single operator on a private box — every request is implicitly
"you," so there is nothing to authenticate or authorize. Multi-user is the
opinionated layer a company adds when more than one person shares a deployment;
skip it and core still works.

## The data model

Everything hangs off the `users` table and one join table. See
[`../reference/server/database/init.sql`](../reference/server/database/init.sql)
(the `users`, `projects`, `project_members` tables).

- **`users`** — `username` (unique), `password_hash` (bcrypt), `is_active`,
  `is_admin`, `is_technical`, `has_completed_onboarding`, `api_key_hash`,
  `api_key_last_used_at`, `token_version` (NOT NULL, default 1), plus
  `git_name` / `git_email` and `last_login`.
- **`project_members`** — a many-to-many `(project_id, user_id)` join, unique on
  the pair, cascade-deleted with either parent. This is the authorization
  primitive: **membership = access**, with no per-member roles (owner and added
  members have equal access; an admin bypasses the check entirely).
- `projects.user_id` records the **owner** (the creator), but it is not what
  gates access — `project_members` is. The two are kept consistent because
  project creation writes both atomically (below).

Core's `tasks`/`conversations`/`task_agent_runs` tables gain a `user_id` owner
column but are **authorized through the project**, not their own owner column —
see "What becomes user-scoped."

## Accounts and the bootstrap admin

- **First-run setup.** `GET /api/auth/status` returns `needsSetup: true` while
  there are zero users, so the UI shows a one-time registration form instead of
  a login form.
- **Register is first-user-only.** `POST /api/auth/register` creates the very
  first account, **grants it admin**, and is closed forever after — a second
  registration returns 403 ("Registration is closed. Ask an admin to create
  your account."). The whole thing runs in a transaction that re-checks
  `hasUsers()` *inside* the transaction so two concurrent first-registers can't
  both win. See
  [`../reference/server/routes/auth.ts`](../reference/server/routes/auth.ts)
  (`/register`, lines ~61–123). Every later account is created by an admin
  (below).
- **Passwords are bcrypt.** Hash on write (`bcrypt.hash`, 12 salt rounds in the
  register path), compare on login (`bcrypt.compare`). Never store or log
  plaintext.

## Login and the non-expiring token

`POST /api/auth/login` verifies the bcrypt hash and returns a **JWT** plus the
safe user record. The token-lifetime design is deliberate and is the part most
likely to be reimplemented wrong:

- The JWT is signed with a 30-day `expiresIn`, but **every authenticated request
  hands back a freshly-signed 30-day token** in the `X-Refreshed-Token` response
  header (rolling refresh). A user who touches the app at least once a month is
  effectively never logged out — the token is "non-expiring" in practice.
- The JWT payload carries `{ userId, username, tokenVersion }`. On every verify
  the middleware compares the token's `tokenVersion` against the user's current
  `token_version` in the DB; a mismatch is rejected as invalid.
- **Logout / invalidation is a `token_version` bump, not a denylist.**
  `POST /api/auth/logout` calls `bumpTokenVersion(userId)`, which increments the
  column so *every* JWT ever issued to that user (on any device) fails its next
  verify. This is the server-side kill switch; clients also drop their local
  copy. The same bump is the right hook for "log out everywhere" on a password
  change.
- **`JWT_SECRET` must be real.** Read it once at startup and fail loud if it is
  missing, empty, or the known placeholder string — never silently fall back to
  a guessable default (`ensureJwtSecret` / `getJwtSecret`).

See [`../reference/server/middleware/auth.ts`](../reference/server/middleware/auth.ts)
(`resolveToken`, `signJwtForUser`, `generateToken`, the
`REFRESHED_TOKEN_HEADER` refresh block in `authenticateToken`) and
[`auth.ts` routes](../reference/server/routes/auth.ts) (`/login`, `/logout`).

## Per-user API keys

For scripts, CI, MCP, and `curl` — a long-lived credential that resolves to a
real user (there is **no** global shared key; every API caller has an identity).

- **Generate / regenerate:** `POST /api/account/api-key` mints
  `ccui_` + 32 random bytes (hex), stores **only `sha256(key)`** in
  `users.api_key_hash`, and returns the plaintext **exactly once**. Regenerating
  overwrites the previous hash (one active key per user).
- **Status / revoke:** `GET /api/account/api-key` returns `{ hasKey, lastUsedAt }`
  (never the key); `DELETE /api/account/api-key` nulls the hash.
- **Resolution:** the auth middleware recognizes a token by its `ccui_` prefix
  (`isApiKeyFormat`), hashes it, and looks up the owning active user
  (`findUserByApiKey`), best-effort touching `api_key_last_used_at`. API keys
  are **not** eligible for rolling refresh (they're already long-lived).

See [`../reference/server/services/userApiKey.ts`](../reference/server/services/userApiKey.ts)
(`generateApiKey`, `findUserByApiKey`, `isApiKeyFormat`, `getApiKeyStatus`,
`revokeApiKey`) and
[`../reference/server/routes/account.ts`](../reference/server/routes/account.ts).

## The auth middleware

One `authenticateToken` handler fronts every protected route and resolves a
Bearer token (or a `?token=` query param, for `<video>`/WebSocket clients that
can't set headers) to `req.user`. `resolveToken` handles **both** credential
kinds — `ccui_` API keys and JWTs — so the rest of the app never cares which was
used. A second handler, `requireAdmin`, gates admin-only routes and runs *after*
`authenticateToken`. WebSocket connections authenticate with the same
`resolveToken` logic (`authenticateWebSocket`), so WS auth mirrors REST auth.

See [`auth.ts` middleware](../reference/server/middleware/auth.ts)
(`authenticateToken`, `requireAdmin`, `authenticateWebSocket`).

> **Reference caveat — localhost bypass.** The reference middleware has a
> narrow localhost-only bypass for one internal endpoint (the web-server config
> probe), falling back to the first user. It is a deployment-specific
> convenience, not part of the contract — omit it unless you have the same need.

## Project-membership authorization

This is the heart of multi-user: **every project/task/agent-run/conversation
route is scoped to project membership.** The single chokepoint is
`hasProjectAccess(projectId, userId)` in
[`../reference/server/services/projectService.ts`](../reference/server/services/projectService.ts)
— it returns true if the user is an admin **or** a member of the project. The
companion helpers (`getAllProjects`, `getProject`, `updateProject`,
`deleteProject`) take the admin-vs-member fork once so callers don't repeat it
(admins use the `*Admin` DB queries that skip the membership join).

What this means concretely:

- **Project creation registers the owner as a member atomically.**
  `projectsDb.create` inserts the project row *and* the
  `project_members` row in one transaction (see `create` in
  [`../reference/server/database/db.ts`](../reference/server/database/db.ts),
  ~line 831). Forget this and the creator instantly loses access to their own
  project.
- **List endpoints are filtered by membership**, not "all rows": `projectsDb.getAll`
  / `tasksDb.getAll` JOIN through `project_members` on the requesting `user_id`.
  Admins get the unfiltered `getAllAdmin` set.
- **Every task/agent-run route re-checks `hasProjectAccess`** after resolving the
  task's project, returning 403 (or 404) on failure. The check appears ~18 times
  in [`../reference/server/routes/tasks.ts`](../reference/server/routes/tasks.ts)
  and on every handler in
  [`../reference/server/routes/agent-runs.ts`](../reference/server/routes/agent-runs.ts)
  — auditing all fan-out paths matters here, not just the obvious CRUD ones.
- **WebSocket actions are authorized the same way.** Before acting on a
  `claude-command` / abort / resume, the dispatcher walks
  conversation → task → project and calls `hasProjectAccess`; unauthorized
  actions are dropped with a log line. See `authorizeConversationAccess` /
  `authorizeSessionAccess` in
  [`../reference/server/websocket/dispatch.ts`](../reference/server/websocket/dispatch.ts).

## The admin panel and `is_admin`

Admins are users with `is_admin = 1`; the bootstrap user gets it, and an admin
can grant it to others. All admin routes mount behind
`authenticateToken, requireAdmin` (`/api/admin/*` in
[`../reference/server/index.ts`](../reference/server/index.ts)).

- **User management** (`/api/admin/users`): list all users, create a user
  (username + password, optional `is_admin`), update (rename, reset password,
  toggle `is_active`/`is_admin`), and delete — **with the guard that an admin
  cannot delete their own account**. See
  [`../reference/server/routes/admin.ts`](../reference/server/routes/admin.ts).
- **Project membership** (`/api/admin/projects`, `/projects/:id/members`): list
  projects with member counts, add/remove members, with the guard that the
  **last member of a project cannot be removed** (so no project is orphaned).
- **UI:** a two-tab page (Users / Project Memberships) — see
  [`../reference/src/pages/AdminPage.tsx`](../reference/src/pages/AdminPage.tsx)
  and [`../reference/src/components/Admin/`](../reference/src/components/Admin/)
  (`UserList`, `UserForm`, `ProjectMembersEditor`). Non-admins are redirected
  away client-side; the server `requireAdmin` is the real guard.

Responses use a **safe user shape** — `password_hash` and `api_key_hash` are
never serialized out of any endpoint.

## The `is_technical` role and its one behavioral effect

`is_technical` (default 1) is the only role flag that changes the orchestration
loop, and it does exactly one thing: **non-technical users skip the
human-review gate after planning.** Core always stops after the planning agent
so a human can read the plan and press Run for implementation
([`../core/orchestration-loop.md`](../core/orchestration-loop.md) defers this
exception here). For a non-technical user that gate is friction, so:

1. **Auto-advance.** When a planning (`planification`) run completes, the
   chaining handler checks the **acting user's** `is_technical`. If they are
   non-technical (`is_technical === 0`) — and the task isn't blocked or at the
   iteration cap — it auto-starts the implementation agent (on the same ~1s
   settle delay as every other chained start). Technical users keep the manual
   gate. The decision tracks the user who *triggered planning* (carried on the
   streaming context), falling back to the task owner only when context has no
   user. See the `agentType === 'planification'` branch in
   [`../reference/server/services/conversation/agentRunLifecycle.ts`](../reference/server/services/conversation/agentRunLifecycle.ts)
   (`handleAgentChaining`, lines ~138–167).
2. **Prompt variant.** A non-technical run also uses a different planning
   prompt (`planification-nontechnical` instead of `planification`), selected
   by the same `is_technical` resolution at run start. See
   `generatePlanificationMessage` in
   [`../reference/server/constants/agentPrompts.ts`](../reference/server/constants/agentPrompts.ts)
   and the `actorIsTechnical` resolution in
   [`../reference/server/services/agentRunner.ts`](../reference/server/services/agentRunner.ts)
   (~lines 86–88).

A user toggles their own `is_technical` via `PUT /api/auth/profile`
([`auth.ts` routes](../reference/server/routes/auth.ts)).

## Rate limiting on auth routes

The unauthenticated `register`/`login` routes carry a per-IP throttle
(`express-rate-limit`) to blunt brute-force: a generous window/max (env-tunable
`LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MIN`) with
`skipSuccessfulRequests: true`, so a correct login never eats the budget. See
the `loginRateLimiter` at the top of
[`../reference/server/routes/auth.ts`](../reference/server/routes/auth.ts).

## Onboarding flags

- **`has_completed_onboarding`** — flipped to 1 not by a dedicated route but as
  a side effect of the user **connecting their first agent provider** (the
  app's real first-use milestone). See `completeOnboarding` /
  `hasCompletedOnboarding` in
  [`../reference/server/database/db.ts`](../reference/server/database/db.ts),
  called from the agent-model-settings service. The provider-connect flow and
  the first-login modal belong to
  [`prompt-and-model-customization.md`](./prompt-and-model-customization.md);
  this spec only owns the flag and its column.
- `is_technical` doubles as an onboarding signal — a fresh non-technical user
  starts auto-advancing past the plan gate immediately.

## What becomes user-scoped

When you layer this on core, these stop being implicitly "the operator's" and
become per-user / membership-gated:

- **All `/api/*` routes** mount behind `authenticateToken`; `req.user` is always
  present downstream.
- **Projects** are listed/read/written through membership (`hasProjectAccess`);
  creation auto-members the creator.
- **Tasks, agent runs, conversations** inherit their project's membership — every
  handler resolves the task's project and re-checks access.
- **WebSocket commands** (chat, abort, resume) re-check access per message.
- **Agent runs and prompts** resolve the *acting user* (for `is_technical` and,
  via the model-customization extra, for per-user provider credentials).
- **`/api/admin/*`** additionally requires `requireAdmin`.

## What to build

- [ ] `users` columns: `password_hash`, `is_active`, `is_admin`, `is_technical`,
      `has_completed_onboarding`, `api_key_hash`, `api_key_last_used_at`,
      `token_version`; the `project_members` join table; `user_id` owner columns
      on `projects`/`tasks`.
- [ ] `POST /api/auth/register` (first-user-only, grants admin, transactional
      re-check), `POST /api/auth/login` (bcrypt), `GET /api/auth/status`,
      `GET /api/auth/user`, `PUT /api/auth/profile` (toggle `is_technical`),
      `POST /api/auth/logout` (`token_version` bump).
- [ ] JWT with `tokenVersion` in the payload, verified against the DB column;
      rolling `X-Refreshed-Token` refresh; loud `JWT_SECRET` validation at boot.
- [ ] Per-user API keys: `ccui_` plaintext shown once, `sha256` stored,
      generate/status/revoke routes, prefix-based resolution in the middleware.
- [ ] `authenticateToken` (JWT + API key) and `requireAdmin` middleware; matching
      WebSocket auth.
- [ ] `hasProjectAccess` + the admin/member fork helpers, applied to every
      project/task/agent-run/conversation route **and** the WS dispatcher.
- [ ] Atomic owner-membership on project create; membership-filtered list
      queries.
- [ ] Admin routes: user CRUD (self-delete guard) + project membership
      (last-member guard); the two-tab admin UI.
- [ ] The `is_technical` auto-advance after planning + the non-technical planning
      prompt variant.
- [ ] Per-IP rate limit on `register`/`login`.

## Reference map

| Concern | File |
|---|---|
| Login / register / logout / profile / status | `reference/server/routes/auth.ts` |
| API-key routes | `reference/server/routes/account.ts` |
| Admin user + membership routes | `reference/server/routes/admin.ts` |
| Auth + admin middleware, JWT, token-version, WS auth | `reference/server/middleware/auth.ts` |
| API-key mint/hash/resolve | `reference/server/services/userApiKey.ts` |
| `hasProjectAccess` + access-scoped project helpers | `reference/server/services/projectService.ts` |
| Schema (users, project_members, token_version, is_technical, api_key_hash) | `reference/server/database/init.sql` |
| Owner-membership on create, membership-filtered queries | `reference/server/database/db.ts` |
| Non-technical auto-advance after planning | `reference/server/services/conversation/agentRunLifecycle.ts` |
| Non-technical planning prompt selection | `reference/server/constants/agentPrompts.ts`, `reference/server/services/agentRunner.ts` |
| WebSocket per-action access checks | `reference/server/websocket/dispatch.ts` |
| Admin UI | `reference/src/pages/AdminPage.tsx`, `reference/src/components/Admin/` |

## Boundaries (not in this spec)

- **Per-provider coding-harness credentials** (Claude OAuth / Codex / OpenCode
  Zen) — how a resolved user actually authenticates an agent turn →
  [`harnesses/overview.md`](./harnesses/overview.md) and the per-tool harness
  specs.
- **Per-user provider/model selection**, the provider-connect flow, and the
  first-login provider modal that flips `has_completed_onboarding` →
  [`prompt-and-model-customization.md`](./prompt-and-model-customization.md).
- The loop itself — chaining, the iteration cap, the plan gate this extra
  bypasses → [`../core/orchestration-loop.md`](../core/orchestration-loop.md).
- Project/task/worktree mechanics this layer authorizes →
  [`../core/task-and-workspace.md`](../core/task-and-workspace.md).
