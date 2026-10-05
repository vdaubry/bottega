# Authorization — project membership, the 404 pattern, admin axis

Once a request is authenticated ([`authentication.md`](./authentication.md)),
*what it may do* is decided by two **orthogonal** axes: per-project membership and
a global admin flag.

## Project membership

Access to a project (and everything under it — tasks, conversations) is gated by
**membership**, not ownership. `hasProjectAccess(projectId, userId)`
(`server/services/projectService.ts`) is a thin check over the `project_members`
join table (`projectMembersDb.isMember`). The membership-scoped getters —
`getAllProjects`, `getProject`, `updateProject`, `deleteProject` — all run through
it, so a non-member simply never sees the project. There is no per-user "owner"
shortcut; a user must be an explicit member.

## The 404-not-403 existence-hiding pattern

Route handlers that touch a project-scoped resource return **`404 Not Found`**
(not `403 Forbidden`) when the caller isn't a member — e.g.
`server/routes/tasks.ts:197` returns `'Task not found'` after a failed
`hasProjectAccess`. This deliberately **hides existence**: a `403` would confirm
the resource exists, leaking that a project/task/conversation with that id is
real. Always pair a membership check with a `404`, never a `403`, in
project-scoped routes.

## The admin axis (orthogonal)

`is_admin` is a separate, global flag. The `requireAdmin` middleware
(`server/middleware/auth.ts:147`) runs *after* `authenticateToken` and `403`s
non-admins. The **admin panel** is mounted with both at the router level —
`app.use('/api/admin', authenticateToken, requireAdmin, adminRoutes)`
(`server/index.ts:217`) — so every admin endpoint is admin-only by construction.
Admin is independent of project membership: an admin isn't automatically a member
of every project (membership still governs project data); admin governs
**user/membership administration**.

## What admins do

`server/routes/admin.ts` (admin-only):
- **Create users** (`POST`, `:49`) — the only way to add an account after the
  first-user bootstrap; registration is otherwise closed.
- **Update/deactivate users** (`is_active`, `is_admin`).
- **Manage project membership** — `addMember` (`:204`) / `removeMember` against
  `project_members`.

Frontend: `src/pages/AdminPage.tsx` + `src/components/Admin/*`
(`UserList`, `UserForm`, `ProjectMembersEditor`); the page is reachable only when
`user.is_admin`.

## is_technical semantics

`is_technical` is **not** an access flag — it's a *behaviour* flag. A
non-technical user gets the `planification-nontechnical` prompt and the
**planification→implementation auto-chain** (technical users keep the manual-Run
gate). The decision tracks the user who *triggered* the run. See
[`../agents/agentic-loop.md`](../agents/agentic-loop.md). When the project's
*sensitive areas* list (`projects.sensitive_areas`, any member may edit it on
the project form) is non-empty, the non-technical prompt also carries the
escalation guardrail: a request touching a listed area is confirmed with the
user in plain language and, on escalation, the task is blocked until a
technical user takes over (see
[`../agents/prompt-templates.md`](../agents/prompt-templates.md)).

## Key files

- `server/services/projectService.ts` — `hasProjectAccess` + the membership-scoped getters.
- `server/middleware/auth.ts:147` — `requireAdmin` (the global admin gate).
- `server/index.ts:217` — the admin router mount (`authenticateToken` + `requireAdmin`).
- `server/routes/admin.ts:49` — create user; `:204` add project member.
- `src/pages/AdminPage.tsx` + `src/components/Admin/*` — the admin UI.
