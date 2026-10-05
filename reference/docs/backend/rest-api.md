# REST API — catalog & conventions (internal/technical)

> **Audience: developers and agents working *on* this codebase** — adding,
> refactoring, or debugging endpoints. This is an *implementation* reference,
> not an external API guide. For each endpoint it names where the handler
> lives, which middleware/zod schema guards it, the service/db helpers it
> calls, the response/error shapes, and the side effects — so you can answer
> "how does this endpoint work, and what will I break if I change it?" without
> re-reading every file.
>
> **Adjacent docs.** The DB rows these endpoints read/write are in
> [`../architecture/data-model.md`](../architecture/data-model.md); the WebSocket
> half (and the REST→`202`→WS streaming bridge) in
> [`../architecture/websocket-protocol.md`](../architecture/websocket-protocol.md);
> server startup + the mount-time wiring in
> [`server-bootstrap.md`](./server-bootstrap.md).
>
> **Source of truth.** `shared/api/*.ts` (response/request types) and
> `shared/schemas/*.ts` (zod validators) are the authoritative, type-checked
> contracts. This doc explains and indexes them, but **those files win on any
> discrepancy** — when in doubt, read the schema/type, not this page.
>
> **"Ticket" = `task`.** External callers may speak of "tickets"; the codebase
> calls them `tasks` everywhere (routes, db, services). They are the same
> thing.

---

## 1. Conventions (read this first)

Every route follows the same cross-cutting rules. They are described once here
and not repeated per endpoint.

### Authentication

- **`authenticateToken`** (`server/middleware/auth.ts:99`) accepts **either** a
  per-user `ccui_` API key **or** a JWT, supplied as `Authorization: Bearer <…>`
  **or** as `?token=<…>` (the query form exists for `<video>`/WebSocket clients
  that can't set headers). Both forms resolve through `resolveToken`
  (`auth.ts:60`): a `ccui_`-prefixed value is hashed and matched against
  `users.api_key_hash`; anything else is verified as a JWT (signature +
  `token_version`). On success `req.user` is set. **The same `ccui_` key used to
  create a task drives every endpoint below — there is no separate "external
  API" surface or key.**
- **`requireAdmin`** (`auth.ts:147`) gates `/api/admin` — it runs after
  `authenticateToken` and 403s non-admins.
- **`/api/webhooks`** does **not** use `authenticateToken`. It is mounted with
  `express.raw()` *before* `express.json()` so it can verify the GitHub
  **HMAC signature** over the raw body (`webhooks.ts`). `/api/webhooks/health`
  is unauthenticated.
- **Public (no `authenticateToken`) mounts:** `/api/auth`, `/api/app-settings`,
  `/api/account`, `/api/webhooks` (HMAC instead), `/health`. Everything else in
  the mount map below is behind `authenticateToken`.

### Input validation boundary

Handlers never read `req.body/params/query` raw. Three middleware factories in
`server/middleware/validate.ts` — **`validateBody`**, **`validateParams`**,
**`validateQuery`** — run a zod schema from `shared/schemas/*.ts`, attach the
parsed value to `req.validated.{body,params,query}`, and on failure
short-circuit with:

```
400 { "error": "Validation failed", "issues": ZodIssue[] }
```

`req.validated` is typed `unknown`; each handler casts to the schema it asked
for (e.g. `req.validated!.params as IdParams`). Some older handlers
(`conversations.ts` `/conversations/:id*`, `agent-runs.ts`) still parse ids
with `parseInt` + `isNaN` → `400 { error: 'Invalid … ID' }` instead of a zod
schema; new code should prefer the zod path.

### Response & error envelope

- **Success: bare objects/arrays — no `{ data }` wrapper.** A few list routes
  wrap in a named key (`GET /api/tasks` → `{ tasks }`); most return the row or
  array directly.
- **Errors: `{ error: string }`** (`ApiError`, `shared/api/_common.ts`),
  occasionally with a machine-readable `code` (e.g. `CONVERSATION_BUSY`,
  `PROVIDER_CREDENTIALS_MISSING`) and/or extra fields.
- Typed request/response contracts live in `shared/api/*.ts`.

### Authorization pattern (task-scoped routes)

The repeated three-step guard, used by every task/conversation/agent-run route:

```
tasksDb.getWithProject(taskId)        // → 404 { error: 'Task not found' } if null
hasProjectAccess(project_id, userId)  // → 404 (same body) if not a member
```

**`404` is used deliberately (never `403`)** so a caller can't probe which task
ids exist by reading status codes. The membership model is the project_members
table (see [`authorization.md`](../auth/authorization.md)); the project owner is
always a member.

### Status-code conventions

| Code | Meaning here |
|---|---|
| `200` | OK (incl. "exists but not ready" status envelopes, e.g. `/plan`) |
| `201` | Resource created (task, conversation, agent-run, …) |
| `202` | Accepted-async — work kicked off, poll/stream for the result (`POST …/messages`) |
| `400` | Validation failed / bad id |
| `403` | Admin-only route, or provider credentials missing (`PROVIDER_CREDENTIALS_MISSING`) |
| `404` | Not found **or** no access (existence-hiding) |
| `409` | Conflict / busy (agent already running, conversation streaming, uncommitted worktree changes, a worktree not set up yet — no conversation or agent can start until it is) |
| `500` | Unhandled server error |
| `503` | Database locked by another process (`SQLITE_BUSY`) at the auth boundary — comes with `Retry-After: 1`; retry, the credential is fine |

---

## 2. Mount map

From `server/index.ts:184–217`. Routers mounted at bare `/api` (tasks, atlas,
conversations, agent-runs, webServer) declare their own full paths internally.

| Prefix | Router file | Middleware (after global CORS/json) |
|---|---|---|
| `/api/webhooks` | `routes/webhooks.ts` | `express.raw()` + HMAC (no `authenticateToken`) |
| `/health` | inline (`index.ts`) | none |
| `/api/auth` | `routes/auth.ts` | none (login/register are the entry points) |
| `/api/app-settings` | `routes/appSettings.ts` | none |
| `/api/account` | `routes/account.ts` | none (key mgmt; see file) |
| `/api/claude-auth` | `routes/claudeAuth.ts` | `authenticateToken` |
| `/api/codex-auth` | `routes/codexAuth.ts` | `authenticateToken` |
| `/api/opencode-auth` | `routes/openCodeAuth.ts` | `authenticateToken` |
| `/api/commands` | `routes/commands.ts` | `authenticateToken` |
| `/api/projects` | `routes/projects.ts` | `authenticateToken` |
| `/api` | `routes/tasks.ts` | `authenticateToken` |
| `/api` | `routes/atlas.ts` | `authenticateToken` |
| `/api` | `routes/conversations.ts` | `authenticateToken` |
| `/api` | `routes/agent-runs.ts` | `authenticateToken` |
| `/api` | `routes/webServer.ts` | `authenticateToken` |
| `/api/settings` | `routes/settings.ts` | `authenticateToken` |
| `/api/user-agent-model-settings` | `routes/userAgentModelSettings.ts` | `authenticateToken` |
| `/api/admin` | `routes/admin.ts` | `authenticateToken` + `requireAdmin` |
| `/api/streaming-sessions` | inline (`index.ts:219`) | `authenticateToken` |
| `/api/projects/:id/files` | inline (`index.ts:226`) | `authenticateToken` |
| `/api/transcribe` | inline (`index.ts:318`) | `authenticateToken` |

---

## 3. Endpoint catalog

Format per endpoint: `METHOD /path` · zod schema · handler `file:line` · key
helpers · notable response/side effects. Auth is `authenticateToken` unless the
mount map says otherwise. Bodies/responses link to `shared/api/*.ts`.

### auth (`routes/auth.ts`, mount `/api/auth`)

| Endpoint | Schema | Handler | Notes |
|---|---|---|---|
| `GET /status` | — | `auth.ts:45` | Whether any user exists (first-run bootstrap gate). |
| `POST /register` | `RegisterBodySchema` | `auth.ts:61` | Creates a user; gated so it can't be used to self-provision once seeded (see file). |
| `POST /login` | `LoginBodySchema` | `auth.ts:125` | Verifies bcrypt password → issues a 30-day JWT. |
| `GET /user` | — | `auth.ts:165` | Current `req.user` echo. |
| `PUT /profile` | profile schema | `auth.ts:173` | Update git name/email etc. |
| `POST /logout` | — | `auth.ts:195` | Bumps `token_version` → invalidates all prior JWTs. |

> JWTs last 30 days; the per-user `ccui_` API key never expires. Prefer the API
> key for scripts/agents (see `CLAUDE.local.md`).

### account / API keys (`routes/account.ts`, mount `/api/account`)

| Endpoint | Handler | Notes |
|---|---|---|
| `GET /api-key` | `account.ts:20` | Whether a key exists + last-used metadata (never the plaintext). |
| `POST /api-key` | `account.ts:36` | (Re)generate → returns the plaintext **once**; stores only `sha256`. Same generator as `userApiKey.generateApiKey`. |
| `DELETE /api-key` | `account.ts:50` | Revoke the key. |

### app-settings (`routes/appSettings.ts`, mount `/api/app-settings`)

| Endpoint | Schema | Handler | Notes |
|---|---|---|---|
| `GET /` | — | `appSettings.ts:32` | `GetAppSettingsResponse`. |
| `PUT /` | app-settings schema | `appSettings.ts:42` | Update global `app_settings` rows. |

### settings — prompt overrides (`routes/settings.ts`, mount `/api/settings`)

| Endpoint | Handler | Notes |
|---|---|---|
| `GET /prompts` | `settings.ts:25` | List per-user prompt template overrides. |
| `GET /prompts/:name` | `settings.ts:46` | One override (or the default). |
| `PUT /prompts/:name` | `settings.ts:78` | Upsert a `~/.bottega/prompts/*.md` override. |
| `DELETE /prompts/:name` | `settings.ts:128` | Revert to the packaged default. |

### user-agent-model-settings (`routes/userAgentModelSettings.ts`, mount `/api/user-agent-model-settings`)

| Endpoint | Handler | Notes |
|---|---|---|
| `GET /` | `userAgentModelSettings.ts:36` | Per-user `Record<AgentType, AgentModelSetting>` + the `schema` model key. |
| `PUT /` | `userAgentModelSettings.ts:49` | Update; validator locks the `schema` key to an Anthropic provider. |
| `GET /connected-providers` | `userAgentModelSettings.ts:64` | Which of anthropic/openai/opencode the user has credentials for. |

### provider auth — Claude / Codex / OpenCode

Per-user provider credential lifecycle. See
[`claude.md`](../providers/claude.md) and
[`opencode.md`](../providers/opencode.md).

**Claude** (`routes/claudeAuth.ts`, mount `/api/claude-auth`): `GET /status`
(:88), `POST /start` (:123, opens the login PTY), `POST /complete` (:147),
`POST /cancel` (:187), `DELETE /` (:204, disconnect).

**Codex/OpenAI** (`routes/codexAuth.ts`, mount `/api/codex-auth`):
`GET /status` (:72), `POST /start` (:102), `POST /cancel` (:120),
`POST /paste` (:132, paste the OAuth code), `DELETE /` (:198).

**OpenCode** (`routes/openCodeAuth.ts`, mount `/api/opencode-auth`):
`GET /status` (:64), `PUT /key` (:82, store the Zen key), `DELETE /key` (:126),
`GET /models` (:144, the upstream Zen catalog).

### projects (`routes/projects.ts`, mount `/api/projects`)

| Endpoint | Schema | Handler | Notes |
|---|---|---|---|
| `GET /` | — | `projects.ts:35` | Projects the user is a member of. `ListProjectsResponse`. |
| `POST /` | create-project schema | `projects.ts:46` | Create a project row pointing at a repo path; optional `subprojectPath`, `sensitiveAreas`. |
| `GET /:id` | `IdParamsSchema` | `projects.ts:83` | One project (membership-checked). |
| `PUT /:id` | update schema | `projects.ts:104` | Update name/paths/serve config; `sensitiveAreas` blank or null clears the guardrail list. |
| `DELETE /:id` | `IdParamsSchema` | `projects.ts:148` | Delete the project. |
| `POST /:id/upload` | — | `projects.ts:169` | Multipart upload scoped to the project. |

### tasks (`routes/tasks.ts`, mount `/api`)

All task routes use the `getWithProject → hasProjectAccess → 404` guard.

| Endpoint | Schema | Handler | Response / notes |
|---|---|---|---|
| `GET /tasks` | `ListTasksQuerySchema` | `tasks.ts:81` | `{ tasks }` across all projects; `?status=`. |
| `GET /projects/:projectId/tasks` | `ProjectIdParamsSchema` | `tasks.ts:101` | Array, scoped to project. |
| `POST /projects/:projectId/tasks` | `ProjectIdParamsSchema` + `CreateTaskBodySchema` | `tasks.ts:125` | **201** `CreateTaskResponse`. Delegates to `taskService.createTaskWithWorktree`: task row + task doc, and the git worktree is set up **in the background** — the reply comes at once with `worktree_state: 'provisioning'` (see [`../tasks/domain-model.md`](../tasks/domain-model.md#worktree-setup-state)). **Starts no agent.** Epic fields were removed in architecture-v2 step 3 — epic tickets are created through `POST /epics/:id/tasks`, which ensures the feature branch and passes it as the task's `base_branch` (the response then carries `base_branch` and any branch `warning`). |
| `GET /tasks/:id` | `IdParamsSchema` | `tasks.ts:184` | `GetTaskResponse = TaskRow`. The stable typed contract — don't overload it (that's why phases is a separate sub-resource). |
| `PUT /tasks/:id` | `IdParamsSchema` + `UpdateTaskBodySchema` | `tasks.ts:211` | Update title/status/`workflow_complete`. On `completed` it reconciles stale streaming liveness. |
| `DELETE /tasks/:id` | `IdParamsSchema` | `tasks.ts:294` | Removes worktree, purges messages, deletes doc; may swing the web-server symlink back to main (`DeleteTaskResponse`). |
| `GET /tasks/:id/documentation` | `IdParamsSchema` | `tasks.ts:378` | `{ content }` — the raw task doc (seeded at create; **not** a readiness signal). |
| **`GET /tasks/:id/phases`** | `IdParamsSchema` | `tasks.ts:432` | **NEW.** `GetTaskPhasesResponse`. See §3a. |
| **`GET /tasks/:id/plan`** | `IdParamsSchema` | `tasks.ts:507` | **NEW.** `GetTaskPlanResponse`. See §3a. |
| `PUT /tasks/:id/documentation` | `IdParamsSchema` + `UpdateTaskDocBodySchema` | `tasks.ts:551` | Overwrite the task doc. |
| `GET /tasks/:id/attachments` | `IdParamsSchema` | `tasks.ts:586` | List input files. |
| `POST /tasks/:id/attachments` | `IdParamsSchema` | `tasks.ts:613` | Multipart upload → **201**. |
| `DELETE /tasks/:id/attachments/:filename` | `TaskAttachmentParamsSchema` | `tasks.ts:657` | Delete one input file. |
| `DELETE /projects/:projectId/tasks/cleanup-old-completed` | `ProjectIdParamsSchema` + `CleanupOldCompletedQuerySchema` | `tasks.ts:696` | Bulk-delete old completed tasks, keeping `?keep` (default 20). |
| `PUT /tasks/:id/workflow-complete` | `IdParamsSchema` + `WorkflowCompleteBodySchema` | `tasks.ts:766` | Set/clear `workflow_complete`; on set, force-completes stuck runs + marks refinement/PR complete. |
| `POST /tasks/:id/resume` | `IdParamsSchema` + `ResumeTaskBodySchema` | `tasks.ts:816` | Unblock a `workflow_blocked` task; optional inline implementation restart. `400` if not blocked. |
| `GET /tasks/:id/review-recording` | `IdParamsSchema` | `tasks.ts:884` | Streams the webm review recording (range requests). |
| `GET /tasks/:id/worktree` | `IdParamsSchema` | `tasks.ts:954` | Git worktree status; ahead/behind are measured against the task's base branch (returned as `baseBranch`, with `mainBranch` kept as a deprecated alias). |
| `POST /tasks/:id/sync` | `IdParamsSchema` | `tasks.ts:983` | Merge the task's base branch into its worktree (repo default, or the epic's feature branch). Echoes `baseBranch`; a failed merge is aborted before answering. |
| `POST /tasks/:id/pull-request` | `IdParamsSchema` + `CreatePullRequestBodySchema` | `tasks.ts:1010` | Create/update the PR. |
| `GET /tasks/:id/pull-request` | `IdParamsSchema` | `tasks.ts:1050` | PR + CI snapshot (`GetPRResponse`). |
| `POST /tasks/:id/merge-cleanup` | `IdParamsSchema` | `tasks.ts:1079` | Merge + clean up worktree; may swing the symlink. |
| `POST /tasks/:id/push-changes` | `IdParamsSchema` + `PushChangesBodySchema` | `tasks.ts:1136` | Commit + push the worktree branch. |
| `DELETE /tasks/:id/worktree` | `IdParamsSchema` + `DiscardWorktreeQuerySchema` | `tasks.ts:1170` | Discard the worktree; **409** with `hasChanges:true` if uncommitted unless `?force=true`, and **409** while the worktree is still being set up. |
| `POST /tasks/:id/worktree/retry` | `IdParamsSchema` | `tasks.ts` | Retry a **failed** worktree setup (**409** otherwise): clears what the failed attempt left, sets it up again in the background, replies with the row back at `provisioning`. |

#### 3a. The two new read endpoints in detail

**`GET /api/tasks/:id/phases`** → `GetTaskPhasesResponse`
(`shared/api/tasks.ts`). Helpers: `taskAgentRunsDb.getByTask` (already
`created_at DESC`), `conversationsDb.getByTask` (also `created_at DESC` — the
sidebar order), `tasksDb.getById` (for the workflow flags). Returns the five
workflow phases **in fixed order**:

| `phase` (`AgentType`) | `label` | status source |
|---|---|---|
| `planification` | Classification | newest `planification` run, else `planification_complete` flag → `completed`, else `not_started` |
| `implementation` | Implementation | newest `implementation` run, else `not_started` |
| `review` | Code Review | newest `review` run, else `not_started` |
| `refinement` | Refinement | newest `refinement` run, else `refinement_complete` flag → `completed`, else `not_started` |
| `pr` | Pull Request | newest `pr` run, else `pr_agent_complete` flag → `completed`, else `not_started` |

Each phase carries `conversation_ids: number[]` — the `conversation_id`s of all
that phase's runs (deduped, ordered by the conversation sidebar order). The
single-pass `yolo` `AgentType` is **excluded** (not a phase). `status` is
`'not_started' | AgentRunStatus` (`pending|running|completed|failed|blocked`).
The user's original "request" phase **is** the `pr` phase — there is no
synthetic standalone-chat phase. The defining table is the `PHASE_CONFIG`
constant above the handler (`tasks.ts`).

**`GET /api/tasks/:id/plan`** → `GetTaskPlanResponse`. Readiness is gated on
**`task.planification_complete`**, *not* file existence — `readTaskDoc` always
returns *something* (the description is seeded into the doc at create time,
`tasks.ts:170`). The planification phase overwrites the doc with the structured
plan and then sets `planification_complete` (`scripts/complete-plan.ts:50`), so
that flag is the truthful "ready" signal.
- not ready → `200 { status: 'not_ready', content: null }` (the seeded doc is
  **not** leaked).
- ready → `200 { status: 'ready', content: <markdown> }`.
- ticket missing / no access → `404` (the authorize step), as everywhere.

> **Why `200` + a status field (not `404`/`400`) for "not ready":** it's
> polling-friendly, matches how mainstream APIs model a still-generating
> artifact, and cleanly separates "ticket exists, plan pending" from a genuine
> ticket-not-found `404`.

### conversations (`routes/conversations.ts`, mount `/api`)

| Endpoint | Schema | Handler | Notes |
|---|---|---|---|
| `GET /tasks/:taskId/conversations` | manual `parseInt` | `conversations.ts:44` | List a task's conversations (`created_at DESC`). |
| `POST /tasks/:taskId/conversations` | `CreateConversationBodySchema` | `conversations.ts:109` | **201.** Pre-create (no `message`) or create + **start** a session. Stamps `provider`/`model`; runs the Claude credential gate only for anthropic; via `conversationHandlers.ts`. |
| `GET /conversations/:id` | manual `parseInt` | `conversations.ts:115` | Row + `metadata.tokenUsage` (`GetConversationResponse`). |
| `DELETE /conversations/:id` | manual `parseInt` | `conversations.ts:178` | Purge messages + delete row. |
| `PATCH /conversations/:id` | manual | `conversations.ts:241` | Rename (`{ name }`; `null`/`''` clears). |
| `PATCH /conversations/:id/claude-id` | manual | `conversations.ts:305` | Stamp the Claude session id. |
| `GET /conversations/:id/context-usage` | manual | `conversations.ts:368` | Persisted context-usage snapshot; `404` if none yet. |
| `GET /conversations/:id/images/:fileName` | `ConversationImageParamsSchema` | `conversations.ts:478` | A model-generated image from the conversation's image store; `<img>` callers authenticate with `?token=`. `404` without conversation access or when absent. |
| `GET /conversations/:id/messages` | manual `parseInt` | `conversations.ts:412` | **Polymorphic on `?limit`:** with `limit` → paginated envelope; without → bare array. |
| **`GET /tasks/:taskId/conversations/:conversationId`** | `TaskConversationParamsSchema` + `MessagesQuerySchema` | `conversations.ts:493` | **NEW.** See §3b. |
| **`POST /tasks/:taskId/conversations/:conversationId/messages`** | `TaskConversationParamsSchema` + `PostMessageBodySchema` | `conversations.ts:565` | **NEW.** See §3b. |

#### 3b. The two new nested conversation endpoints in detail

These mirror the user's proposed `GET/POST /ticket/{id}/conversation/{cid}` as
RESTful sub-resources of a task. The conversation ids come from
`GET /api/tasks/:id/phases`. Both enforce **nesting**: the conversation must
have `task_id === :taskId`, else `404` (cross-task existence-hiding).

**`GET /tasks/:taskId/conversations/:conversationId`** →
`GetTaskConversationResponse = { conversation, messages, total, hasMore }`.
- Authorize the task, then `conversationsDb.getById` + the nesting check.
- `claude_conversation_id` null → `200 { conversation, messages: [], total: 0,
  hasMore: false }`.
- Else `conversationContentStore.getSessionMessages(claudeId, session_path ||
  repo_folder_path, limit ?? null, offset ?? 0, { userId })`. Because that
  helper returns a **bare array** when `limit` is omitted, the handler
  normalizes it into the `{ messages, total, hasMore }` envelope so this route's
  response shape is stable regardless of `?limit`.

**`POST /tasks/:taskId/conversations/:conversationId/messages`** →
**`202`** `PostMessageResponse = { status:'accepted', task_id, conversation_id,
messages_before }`. This is the **REST bridge to the WS `claude-command` resume
path** (`sendMessage`).
- Body: `PostMessageBodySchema` (`{ message: min(1), permissionMode?, images? }`).
  Resume reads `provider`/`model` off the conversation row, so the body needs
  no provider/model.
- Guards (in order): task authorize → nesting `404` → **`409
  CONVERSATION_NOT_STARTED`** if `claude_conversation_id` is null (start a new
  conversation via `POST /tasks/:taskId/conversations` instead) → **`409`
  `ConversationBusyResponse` (`code: CONVERSATION_BUSY`)** if
  `getActiveStreamingByConversation(id)` (one conversation = one in-flight turn,
  mirroring the WS `conversation-busy` rejection at `dispatch.ts:315` and the
  agent-run `409`).
- `messages_before` = the current message count (so the poller knows the offset
  to read new messages from).
- **Fire-and-forget:** `sendMessage(id, message, { broadcastFn,
  broadcastToTaskSubscribersFn, userId, images, permissionMode || 'bypassPermissions' })`
  is called **without awaiting completion** (turns can run tools for minutes); a
  `.catch` logs and broadcasts a `claude-error` so a post-202 failure still
  reaches WS subscribers + is persisted. `broadcastFn` is wired from
  `req.app.locals.broadcastToConversationSubscribers`,
  `broadcastToTaskSubscribersFn` from `req.app.locals.broadcastToTaskSubscribers`
  (the same pattern as `agent-runs.ts:95–105`).
- The caller then **polls** `GET …/conversations/:conversationId?offset=<messages_before>`
  for the reply, or subscribes to the conversation over WebSocket.

### agent-runs — the phase-start ("Run") endpoint (`routes/agent-runs.ts`, mount `/api`)

| Endpoint | Handler | Notes |
|---|---|---|
| `GET /tasks/:taskId/agent-runs` | `agent-runs.ts:33` | List a task's runs (`created_at DESC`). |
| `POST /tasks/:taskId/agent-runs` | `agent-runs.ts:58` | **Start a phase.** Body `{ agentType }` ∈ planification/implementation/refinement/review/pr/yolo. **201** with the run. **409** if a phase is already running (`AgentRunConflictResponse`). **403** `PROVIDER_CREDENTIALS_MISSING` if the configured provider isn't connected. This is the API equivalent of the UI "Run" button — task creation starts nothing. |
| `GET /agent-runs/:id` | `agent-runs.ts:139` | One run. |
| `PUT /agent-runs/:id/complete` | `agent-runs.ts:168` | Force-mark a run completed. |
| `PUT /agent-runs/:id/link-conversation` | `agent-runs.ts:201` | Link a `conversation_id` to a run. |
| `DELETE /agent-runs/:id` | `agent-runs.ts:242` | Delete a run. |

### atlas — Explore / code-atlas (`routes/atlas.ts`, mount `/api`)

`GET /tasks/:id/atlas/tree` (:70), `GET …/atlas/file` (:88),
`GET …/atlas/artifacts` (:114), `GET …/atlas/artifact/:kind` (:138, the stored
HTML artifact), `POST …/atlas/generate-artifact` (:167, starts an Anthropic-only
artifact generation; idempotent via `getOngoingAtlasGenerationConversationId`).
See [`domain-model.md`](../tasks/domain-model.md), the Explore docs in
[`atlas/`](../atlas/schema-generation.md), and the Explore note in
`../project.md`.

### web-server / switch (`routes/webServer.ts`, mount `/api`)

`GET /projects/:id/web-server` (:26), `PUT …/web-server/config` (:53),
`POST …/web-server/switch` (:91, repoint the NGINX symlink at a worktree / main +
run the `.bottega/switch.sh` hook), `GET …/web-server/verify` (:131). Full
contract in [`switch-server.md`](../web-server/switch-server.md).

### commands (`routes/commands.ts`, mount `/api/commands`)

`POST /list` (:90) — slash-command discovery for a project/worktree.

### admin (`routes/admin.ts`, mount `/api/admin`, `requireAdmin`)

User CRUD: `GET /users` (:36), `POST /users` (:49), `PUT /users/:id` (:87),
`DELETE /users/:id` (:133). Project membership: `GET /projects` (:163),
`GET /projects/:id/members` (:180), `POST /projects/:id/members` (:204),
`DELETE /projects/:projectId/members/:userId` (:239). User creation is
admin-only — a core part of the security posture (see
[`authorization.md`](../auth/authorization.md)).

### webhooks (`routes/webhooks.ts`, mount `/api/webhooks`)

`POST /github` (:101) — GitHub webhook receiver, **HMAC-signature** authed over
the raw body (no `authenticateToken`). On a PR-comment trigger it re-enters the
agentic loop for the linked task. `GET /health` (:325) — unauthenticated
liveness (`{ status: 'ok', … }`).

### inline routes (`server/index.ts`)

`GET /health` (:189, unauth), `GET /api/streaming-sessions` (:219, the caller's
active streaming sessions), `GET /api/projects/:id/files` (:226, file tree),
`POST /api/transcribe` (:318, OpenAI voice transcription).

---

## 4. The agentic lifecycle & WebSocket protocol (pointers)

The tasks / agent-runs / conversations endpoints only make sense against the
**workflow state machine** and the **streaming WS half** — both now have
dedicated docs, so they're not re-explained here:

- **Agentic lifecycle** — the six `AgentType`s, `startAgentRun`, the
  planification→implementation↔review→refinement→pr chaining, the
  `workflow_*` task flags, and `MAX_WORKFLOW_RUNS`:
  [`../agents/agentic-loop.md`](../agents/agentic-loop.md).
- **WebSocket protocol** — the `?token=` handshake, the three subscribe channels,
  the client/server message families, and the **REST→`202`→WS streaming bridge**
  (`POST …/conversations/:id/messages` is a thin wrapper onto the `claude-command`
  resume path): [`../architecture/websocket-protocol.md`](../architecture/websocket-protocol.md)
  + the streaming narrative in
  [`../conversations/lifecycle-and-streaming.md`](../conversations/lifecycle-and-streaming.md).

Note: a new conversation is created over **REST** (`POST /tasks/:taskId/conversations`);
messages to an *existing* conversation flow over **WS** (`claude-command`), with
the `202` REST message endpoint bridging onto that same path.

---

## 5. Source-of-truth pointers

- **`shared/api/*.ts`** — request/response TypeScript contracts (e.g.
  `tasks.ts`, `conversations.ts`, `agent-runs.ts`, `_common.ts`'s `ApiError`).
- **`shared/schemas/*.ts`** — zod validators wired in via `validate*` (e.g.
  `_common.ts`'s `IdParamsSchema` / `TaskConversationParamsSchema`,
  `conversations.ts`'s `PostMessageBodySchema` / `MessagesQuerySchema`).
- **`shared/types/db.ts`** — DB row types + the `AgentType` / `AgentRunStatus`
  enums the phase model is built on.
- **`shared/websocket/messages.ts`** — the WS message union.

These are type-checked at build time; **they win over this prose on any
discrepancy.** When you change an endpoint, update the schema/type first, then
reconcile this doc.
