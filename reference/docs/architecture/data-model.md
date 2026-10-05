# Data model — SQLite schema, migrations, query helpers

The single SQLite file (`server/database/bottega.db`) holds **all** domain
metadata *and* every conversation transcript. There is no second datastore;
the Claude Agent SDK's own `.jsonl` files are private scratch the runtime never
reads. Row types live in `shared/types/db.ts` — import from there, never
redeclare a row shape.

## Tables (grouped by concern)

**Identity & access**
- `users` — account + `is_admin`, `is_technical` (gates the planification→
  implementation auto-chain), `api_key_hash` (sha256 of the `ccui_` key),
  `token_version` (bumped to invalidate all prior JWTs). See
  [`../auth/authentication.md`](../auth/authentication.md).
- `projects` — one row per git repo on disk (`repo_folder_path` UNIQUE);
  carries the switch-server config (`serve_symlink_path`,
  `systemd_service_name`, `app_url`, `active_worktree_task_id`,
  `subproject_path`) and `sensitive_areas` (nullable text): the per-project
  list the non-technical planning guardrail reads — blank means off. See
  [`../agents/prompt-templates.md`](../agents/prompt-templates.md).
- `project_members` — the many-to-many membership table that
  `hasProjectAccess` checks (the owner is also inserted as a member). See
  [`../auth/authorization.md`](../auth/authorization.md).

**Work items**
- `tasks` — belongs to a project; `status` ∈ `pending|in_progress|in_review|
  completed`; the **workflow flag** columns drive the agentic loop:
  `workflow_complete`, `workflow_blocked`, `workflow_blocked_reason`, `workflow_run_count`,
  `planification_complete`, `pr_agent_complete`, `refinement_complete`,
  `yolo_mode`. `base_branch` is nullable and records where the task branches
  from and merges into (`NULL` means the repo default). The task table knows
  nothing about epics — membership lives in `epic_tickets`, and epic reviewer
  ownership lives in `epic_agent_runs`. See
  [`../tasks/domain-model.md`](../tasks/domain-model.md) and
  [`../agents/agentic-loop.md`](../agents/agentic-loop.md).
- `epics` — a large feature developed through the staged pipeline; project
  scoped, with `status` (`active|completed|cancelled`), the stage flags
  `architecture_complete`/`specs_complete`/`stories_complete`/`review_complete`
  (the last is the specification-review gate orchestration starts behind; its
  ALTER backfills `1` for epics already under implementation), `slug` (stamped
  at creation, feeds the feature-branch name) and `feature_branch`. Plus the
  orchestration flags `orchestration_active` / `orchestration_blocked` /
  `orchestration_blocked_reason`: the autonomous stage is dormant between
  events, so "is this epic being driven?" cannot be read off a running row and
  has to be stored. Tickets join via the `epic_tickets` link table. See
  [`../epics/entity-and-conversations.md`](../epics/entity-and-conversations.md)
  and [`../epics/orchestrator.md`](../epics/orchestrator.md).
- `conversations` — a provider session. The base row carries **no owner
  FK** — just `owner_kind` (`task|epic`), the dispatch tag the runtime hands
  to the owner-adapter registry. Ownership lives in the link tables
  `task_conversations` / `epic_conversations` (one row each, PK
  `conversation_id`, `ON DELETE CASCADE` both ways); `conversationsDb`'s
  queries LEFT JOIN them so every returned row still exposes derived
  `task_id`/`epic_id`. `create`/`createForEpic` insert base row + link row in
  one transaction. Key columns: `claude_conversation_id` / `provider_session_id` (the session id),
  `provider` (`anthropic|openai|opencode`, NOT NULL DEFAULT `'anthropic'`),
  `model` + `effort` (stamped at creation, read back on resume — **never
  inferred**), `atlas_enabled` (Explore-initiated; Anthropic-only),
  `context_usage_json`, `name`.
- `task_agent_runs` — one row per **task** agent phase (`task_id` NOT NULL);
  `agent_type` (the six task types only) and `status` are CHECK-constrained;
  `conversation_id` links the run to its conversation (`ON DELETE SET NULL`).
  `driver` (`human|automation`) records who initiated the run and drives the
  run policies (prompt variant, auto-chain suppression, push muting).
  `provider` here is diagnostics-only — runtime reads the provider off the
  linked conversation. Adding an agent type means editing the CHECK in
  `init.sql` **and** a guarded table rebuild in `runMigrations` (the old
  `widenAgentRunTypeCheck` probe retired with the v2 split — each table now
  carries its own narrow type list).
- `epic_agent_runs` — one row per **epic** agent phase (`epic_id` NOT NULL,
  the five `epic-*` types). Same shape otherwise, plus `ticket_task_id`, set
  only on `epic-orchestrator` and `epic-pr-review` runs: the ticket that run
  supervises or reviews, which is *not* its owner (the owner is the epic).
- `epic_tickets` — the epic↔task membership link: `epic_id` (CASCADE),
  `task_id` (UNIQUE — a task belongs to at most one epic, CASCADE) and
  `position` (the orchestrator's execution order; no unique index — positions
  are a service-layer concern). Deleting an epic deletes the link rows only:
  the tickets, their worktrees and PRs outlive the container.
- `epic_runs` — **legacy**, from the v0 Epic Planning spike. Absent on fresh
  installs, kept (dead) on existing ones after `convertEpicRunsToEpics` folded
  it into `epics`.
- `task_artifacts` — PK `(task_id, kind)` (`plan|flowchart|architecture`),
  one self-contained HTML doc per kind, last-write-wins. The Explore view's
  store. See [`../atlas/schema-generation.md`](../atlas/schema-generation.md).

**Transcripts (the SDK sessionStore backend)**
- `messages` — one row per SDK transcript entry, PK
  `(project_key, session_id, subpath, uuid)`, ordered by `seq`. **The single
  source of truth for conversation messages.**
- `session_summaries` — incrementally-folded summary sidecar per session.
- The custom `SqliteSessionStore` registered with the SDK writes these. See
  [`../providers/claude.md`](../providers/claude.md).

**Settings**
- `app_settings` — global key/value (e.g. `internal_tool_name`,
  `github_pr_trigger`).
- `user_agent_model_settings` — per-user `Record<AgentType, {provider, model,
  effort}>` as JSON, plus the Anthropic-locked `schema` key. See
  [`../providers/connection-ui.md`](../providers/connection-ui.md).

## FKs & cascades

Almost everything cascades from its parent: deleting a `user` cascades to its
`projects`, `project_members`, `tasks`; deleting a `project` cascades to
`tasks`, `project_members`; deleting a `task` cascades to its
`task_conversations`/`epic_tickets` link rows, `task_agent_runs` and
`task_artifacts`; deleting an `epic` cascades to its `epic_conversations`
link rows, `epic_agent_runs` and `epic_tickets`. **Conversation base rows do
not cascade from an owner** — a link row's death leaves the base row behind,
so the owning domain's delete service removes its conversations explicitly
(`conversationsDb.delete` per conversation, transcripts purged first). The
remaining **non-cascade** is `*_agent_runs.conversation_id` →
`conversations(id) ON DELETE SET NULL` (a deleted conversation leaves the
run row, just unlinked). `PRAGMA foreign_keys = ON` is set at connection
time, in `openDatabase()` (`server/database/sqlite.ts` — see
[Journal mode, locks, and copying the file](#journal-mode-locks-and-copying-the-file)).

> Rebuilding a table that others reference (`conversations` is the parent of
> `task_agent_runs`) must follow the SQLite 12-step procedure with
> `PRAGMA foreign_keys=OFF` and an **explicit column list** — with foreign keys
> on, the `DROP TABLE` fires an implicit delete that nulls every child link.
> `server/database/epicMigration.test.ts` is the regression net.

## Migration model

There is **no migration framework**. `initializeDatabase()` (`db.ts:614`):

1. `db.exec()` the full `init.sql` — every `CREATE TABLE IF NOT EXISTS` /
   `CREATE INDEX IF NOT EXISTS`, so a fresh DB lands on the current schema in
   one shot.
2. `runMigrations()` (`db.ts:175`) brings **existing** DBs forward with
   idempotent `PRAGMA table_info(...)` → "if column missing, `ALTER TABLE ADD
   COLUMN`" guards (and a few table-rebuild blocks for CHECK-constraint
   changes). Each step is safe to re-run; the function is the running log of
   every column added after the original schema.
3. One-shot data migrations run last, each guarded so it runs at most once:
   `backfillUserAgentModelSettings` (global→per-user agent settings),
   `backfillSchemaModelKey` (seed the Anthropic `schema` key),
   `backfillEpicStageModelKeys` (v0 `epic` key → the four `epic-*` stage keys)
   and `convertEpicRunsToEpics` (v0 `epic_runs` → `epics` + archived spec
   files). Last of all, `splitOwnerTables` — the architecture-v2 step-5
   owner-table split (probe: the `conversations` schema contains
   `owner_kind`; the new tables' *existence* proves nothing, because init.sql
   lays empty shells down before migrations run). Every epic-era migration
   above it is gated on the same probe — the post-split tables would look
   pre-epic to their shape checks and be corrupted by a re-run.

> When you add a column: put it in **both** `init.sql` (for fresh installs)
> **and** as a guarded `ALTER` in `runMigrations` (for existing DBs), then add
> the field to its row type in `shared/types/db.ts`. The legacy `auth.db`→
> `bottega.db` rename also happens here, on first boot.

## Journal mode, locks, and copying the file

The connection is opened by `openDatabase()` (`server/database/sqlite.ts`):
`PRAGMA foreign_keys = ON`, a **15 s busy timeout** (better-sqlite3's default
is 5 s) and **`PRAGMA journal_mode = WAL`**. Everything below follows from two
facts: this file has several processes on it at once — the live service,
worktree dev servers (a worktree's `server/database/bottega.db` is a symlink
to the live file), the `sqlite3` CLI in a shell, backups — and better-sqlite3
is synchronous, so a statement that has to wait for a lock stalls the whole
event loop and, after the busy timeout, throws a `SqliteError` with code
`SQLITE_BUSY` ("database is locked").

- **Why WAL.** In SQLite's default rollback-journal (`delete`) mode readers
  and writers block each other around commits: any process holding a read
  transaction open (a scanning query in a shell, a `.backup`, a boot-time
  migration) blocks every writer's commit, and a commit in progress blocks
  every reader. On 2026-09-04 a long read lock held by another process made
  an authenticated request's user lookup throw `SQLITE_BUSY` out of the auth
  middleware — uncaught, it killed that server — and made the live service's
  Codex transcript mirror drop two writes. In WAL mode readers never block
  writers and writers never block readers; only two *writers* contend, and
  they wait out the busy timeout rather than colliding. Measured with two
  processes on a `.backup` copy of the live file: a reader holding an open
  `SELECT` made a writer fail with `SQLITE_BUSY` after its timeout in
  `delete` mode, and commit in 1 ms in WAL.
- **The mode lives in the file, and every connection follows it.** It is set
  once (the first boot on this code), survives reopen, and a connection that
  opened the file *earlier* in rollback mode — the live service, while a
  worktree server on this code boots — switches on its own next transaction,
  transparently. So the live service needs no restart to adopt it: the first
  process on this code that opens the shared file flips it — a worktree
  server boot, or simply the test suite, since tests that import
  `connection.ts` open the worktree's symlink to the live file. The switch needs a
  brief exclusive lock; if another connection is mid-read at that instant it
  throws `SQLITE_BUSY`, which `openDatabase` logs and leaves for the next boot.
- **Three files, not one.** Beside `bottega.db` live `bottega.db-wal` (the
  write-ahead log: committed pages not yet folded into the main file) and
  `bottega.db-shm` (its shared-memory index). They exist while any
  connection is open and disappear when the last one closes; SQLite
  checkpoints the log back into the main file on its own (every ~1000
  pages). They belong to the **real** file: opened through a worktree's
  symlink, SQLite resolves the link and creates them next to
  `reference/server/database/bottega.db`, so every process shares one WAL —
  which is what keeps them consistent. Never delete a `-wal` file by hand
  while a process has the database open: it holds committed data.
- **Copy with `.backup`, never `cp`.** `cp bottega.db` copies the main file
  without the pages still in the `-wal`: a stale, possibly inconsistent
  snapshot. `sqlite3 bottega.db ".timeout 30000" ".backup /tmp/copy.db"`
  copies a consistent snapshot through the WAL, in 100-page steps that never
  block the live writers (~4 s for the current 1.6 GB; it restarts if a
  write lands mid-copy, so it can take longer on a busy file). The copy is
  itself in WAL mode. `VACUUM INTO` is the other correct option.
- **What is still contended.** Two writers — a worktree server running a
  migration while the live service writes — wait on each other for up to the
  busy timeout, then throw. The request boundaries answer that with a `503`
  (see [`../auth/authentication.md`](../auth/authentication.md)) and the
  process-level backstop (`server/processGuards.ts`) survives one that reaches
  it. `PRAGMA synchronous` stays at SQLite's default.

## Query helpers (`xxxDb`)

One helper object per table — the **only** layer that should hold SQL.
Handlers and services call these, never raw `db.prepare`. Since the v2 split
the helpers live in per-domain modules (`database/connection.ts` owns the
connection): task-domain helpers in `database/tasks.ts`, epic-domain helpers
in `database/epics.ts` (which only the epic layer may import — the boundary
lint enforces it), conversations in `database/conversations.ts`; `db.ts`
keeps the rest and re-exports the task/conversation helpers for its many
existing importers.

| Helper | Lives in | Covers |
|---|---|---|
| `userDb` | `db.ts` | users + auth fields, api-key lookup, `token_version` |
| `projectsDb` | `db.ts` | projects + web-server config |
| `projectMembersDb` | `db.ts` | membership add/remove/list |
| `tasksDb` | `tasks.ts` | tasks + the workflow flags; `getWithProject` (the auth join) |
| `taskAgentRunsDb` | `tasks.ts` | task runs; `getByTask`, `getByConversationId`, `getByStatus` (orphan recovery) |
| `conversationsDb` | `conversations.ts` | conversations (owner derived via the link-table JOIN); `getByTask`/`getByEpic`, `create`/`createForEpic`, `findByClaudeSessionId` |
| `taskArtifactsDb` | `db.ts` | Explore HTML artifacts (upsert by kind) |
| `epicsDb` | `epics.ts` | epics; `getWithProject` (the auth join), stage flags, feature branch, the orchestration flags + `listOrchestrating` (boot reconciliation) |
| `epicAgentRunsDb` | `epics.ts` | epic runs; queries plus atomic user-interrupt/turn-start transitions |
| `epicTicketsDb` | `epics.ts` | epic↔task membership; `attach`, `epicOf`, `listTickets` (JOIN tasks, execution order), `setPosition` |
| `appSettingsDb` | `db.ts` | global key/value |
| `userAgentModelSettingsDb` | `db.ts` | per-user agent model JSON |

## Key files

- `server/database/init.sql` — canonical schema for fresh installs.
- `server/database/sqlite.ts` — `openDatabase` (busy timeout, foreign keys,
  WAL) + `isSqliteBusyError`.
- `server/database/connection.ts` — the shared connection + `lastInsertId`.
- `server/database/tasks.ts` / `epics.ts` / `conversations.ts` — the
  per-domain helper modules.
- `server/database/db.ts` — `runMigrations` (the idempotent ALTER log),
  `initializeDatabase` (init.sql then migrate), `splitOwnerTables`, and the
  remaining helper exports.
- `shared/types/db.ts` — authoritative row types + the `AgentType` /
  `EpicAgentType` / `AgentRunStatus` / `TaskStatus` unions.
