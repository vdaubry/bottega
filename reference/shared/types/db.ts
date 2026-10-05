// Row shapes for every table in `server/database/init.sql` (plus columns
// added by migrations in `server/database/db.js`). These are the
// authoritative DB-row types — every consumer (DB layer, route handlers,
// API response shapes) should import from here rather than redeclaring.
//
// Conventions:
//  - SQLite stores DATETIMEs as ISO strings via CURRENT_TIMESTAMP. Typed
//    as `string` here.
//  - SQLite stores BOOLEANs as integers (0 | 1). Typed as `0 | 1` to
//    reflect what `better-sqlite3` actually hands back. Convert at the
//    boundary when a caller wants `boolean`.
//  - CHECK-constrained TEXT columns become string-literal unions so
//    `tsc` catches typos in handler code.
//  - Optional columns added by ALTER TABLE migrations are declared
//    as nullable (`string | null`) when they can legitimately be NULL.

// ---- Enum-like CHECK columns -----------------------------------------------

// Re-exported so DB-row types can reference Provider without an extra import.
import type { Provider } from '../providers/types.js';
export type { Provider };

export type TaskStatus = 'pending' | 'in_progress' | 'in_review' | 'completed';

// Where a task's git worktree stands. Creation returns at once and the
// worktree (and the project's post-checkout hook) is set up in the background:
// `provisioning` until it finishes, then `ready` or `failed`. Nothing may start
// a conversation on a task that is not `ready`.
export type TaskWorktreeState = 'provisioning' | 'ready' | 'failed';

export type AgentType =
  | 'planification'
  | 'implementation'
  | 'refinement'
  | 'review'
  | 'pr'
  | 'yolo';

// Epic-scoped agent types — the staged epic pipeline (architecture document,
// technical specification, story split, specification review, autonomous
// orchestrator + per-ticket PR reviewer), plus `epic-delivery`: the epic's
// final pull request, which is NOT a pipeline stage (no flag, no gate — see
// `docs/epics/delivery.md`). Epic runs live in `epic_agent_runs`, whose own
// CHECK lists these values; `task_agent_runs` keeps the legacy pre-split list.
// Kept OUT of `AgentType` so every task-only consumer (the chaining state
// machine, task prompts, AgentSection) keeps a closed six-type union.
export type EpicAgentType =
  | 'epic-architecture'
  | 'epic-specification'
  | 'epic-stories'
  | 'epic-spec-review'
  | 'epic-orchestrator'
  | 'epic-pr-review'
  | 'epic-delivery'
  | 'epic-qa-scenarios'
  | 'epic-qa-execution'
  | 'epic-qa-fix';

// Who started a run and therefore reviews its output: a person, or an
// automation (the epic orchestrator today; any future driver tomorrow).
// Inherited by chained runs. Policy, not identity: it decides the
// planification prompt variant, the auto-chain, and push notifications.
export type AgentRunDriver = 'human' | 'automation';

export type AgentRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked';

export type SqliteBoolean = 0 | 1;

// ---- users -----------------------------------------------------------------

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  last_login: string | null;
  is_active: SqliteBoolean;
  is_admin: SqliteBoolean;
  git_name: string | null;
  git_email: string | null;
  has_completed_onboarding: SqliteBoolean;
  is_technical: SqliteBoolean;
  api_key_hash: string | null;
  api_key_last_used_at: string | null;
  // Bumped on logout/password-change to invalidate every prior JWT for this
  // user without touching JWT_SECRET. The signed token carries the version
  // it was issued under; the verify step rejects on mismatch.
  token_version: number;
}

// ---- projects --------------------------------------------------------------

export interface ProjectRow {
  id: number;
  user_id: number;
  name: string;
  repo_folder_path: string;
  subproject_path: string | null;
  // What "switch server" is serving. At most one is set: a ticket's worktree,
  // an epic's delivery worktree, or neither (the main checkout).
  active_worktree_task_id: number | null;
  active_worktree_epic_id: number | null;
  serve_symlink_path: string | null;
  systemd_service_name: string | null;
  app_url: string | null;
  // The non-technical planning guardrail: the parts of this application a
  // non-technical user must not change without a technical review, one
  // bullet per area. NULL or blank = off. Read by the non-technical
  // planification prompt only (see docs/agents/prompt-templates.md).
  sensitive_areas: string | null;
  created_at: string;
  updated_at: string;
}

// ---- project_members ------------------------------------------------------

export interface ProjectMemberRow {
  id: number;
  project_id: number;
  user_id: number;
  created_at: string;
}

// ---- tasks -----------------------------------------------------------------

export interface TaskRow {
  id: number;
  project_id: number;
  user_id: number | null;
  // The branch this task forks from and merges into; NULL = the repo's
  // default branch, resolved at use (`resolveBaseBranch`). Set at creation by
  // whoever creates the task — the epic layer passes its feature branch.
  base_branch: string | null;
  title: string | null;
  status: TaskStatus;
  workflow_complete: SqliteBoolean;
  workflow_blocked: SqliteBoolean;
  /** Why the agent blocked, when it said. Cleared on unblock. */
  workflow_blocked_reason: string | null;
  worktree_state: TaskWorktreeState;
  /** Why the worktree setup failed (with the hook's last output lines). */
  worktree_error: string | null;
  workflow_run_count: number;
  planification_complete: SqliteBoolean;
  pr_agent_complete: SqliteBoolean;
  refinement_complete: SqliteBoolean;
  yolo_mode: SqliteBoolean;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// A write-ahead record for the remote PR merge. `tasks.status` remains the
// product-facing lifecycle; this row exists to reconcile the non-transactional
// GitHub side effect and retry local worktree housekeeping independently.
export interface TaskLandingRow {
  task_id: number;
  pr_url: string;
  head_branch: string;
  base_branch: string;
  state: 'merge_requested' | 'merged';
  merge_commit_sha: string | null;
  merge_requested_at: string;
  merged_at: string | null;
  cleanup_state: 'pending' | 'completed' | 'failed';
  cleanup_retryable: 0 | 1;
  cleanup_error: string | null;
  cleanup_updated_at: string | null;
  updated_at: string;
}

// ---- conversations --------------------------------------------------------

export interface ConversationRow {
  id: number;
  // Dispatch tag for the runtime's owner-adapter registry, not a foreign key:
  // the owner itself lives in the domain link tables (task_conversations /
  // epic_conversations), which reference this infrastructure table — never
  // the other way round (architecture-v2 step 5).
  owner_kind: 'task' | 'epic';
  // Owner ids, DERIVED by the query layer from the link tables (exactly one
  // is non-null, matching owner_kind). They are not physical columns.
  task_id: number | null;
  epic_id: number | null;
  claude_conversation_id: string | null;
  session_path: string | null;
  context_usage_json: string | null;
  // `name` was added via ALTER TABLE (db.js migration) — defaults to NULL.
  name: string | null;
  // Which LLM backend owns this conversation. NOT NULL DEFAULT 'anthropic',
  // so legacy rows that pre-date the column read back as 'anthropic'.
  provider: Provider;
  // Provider-agnostic session id (Claude session id / Codex thread id).
  // Nullable until the provider's first event reports it.
  provider_session_id: string | null;
  // Exact model this conversation runs (provider-specific id, e.g. 'opus',
  // 'gpt-6.1-sol', 'opencode/kimi-k2.7-code'). Stamped at creation, read back on
  // resume — never inferred. Null only on legacy rows that pre-date the
  // column and couldn't be backfilled.
  model: string | null;
  // Provider reasoning effort, or null when the provider has none (OpenCode)
  // or the conversation didn't pick one (manual chats).
  effort: string | null;
  // Explore-initiated conversations carry the in-process code-atlas MCP
  // server; resume re-injects it from this flag. Anthropic-only.
  atlas_enabled: SqliteBoolean;
  created_at: string;
}

// ---- task_artifacts -------------------------------------------------------

// Self-contained HTML artifact generated for the Explore view, one row per
// (task, kind). `html` is a complete standalone document; `kind` is one of
// 'plan' | 'flowchart' | 'architecture' (see ARTIFACT_KINDS in atlas.ts).
export interface TaskArtifactRow {
  task_id: number;
  kind: string;
  title: string | null;
  html: string;
  updated_at: string;
}

// Metadata-only projection (no html blob) used by the kind-switcher list query.
export type TaskArtifactSummaryRow = Omit<TaskArtifactRow, 'html'>;

// ---- task_agent_runs ------------------------------------------------------

// A TASK's agent run. Since the architecture-v2 step-5 table split, task runs
// and epic runs live in separate tables with separate row types; no surface
// mixes them (the task page lists task runs, the epic page epic runs).
export interface TaskAgentRunRow {
  id: number;
  task_id: number;
  agent_type: AgentType;
  status: AgentRunStatus;
  conversation_id: number | null;
  // Diagnostics column. Runtime never reads this — it always reads the
  // provider off the linked `conversations` row. NOT NULL DEFAULT 'anthropic'.
  provider: Provider;
  // Who drives this run (see AgentRunDriver). NOT NULL DEFAULT 'human'.
  driver: AgentRunDriver;
  created_at: string;
  completed_at: string | null;
}

// ---- epic_agent_runs ------------------------------------------------------

export interface EpicAgentRunRow {
  id: number;
  epic_id: number;
  agent_type: EpicAgentType;
  status: AgentRunStatus;
  conversation_id: number | null;
  provider: Provider;
  // The ticket this run is ABOUT (orchestrator: supervises; reviewer:
  // reviews). One meaning. No task-layer code can read it, because no
  // task-layer code reads this table.
  ticket_task_id: number | null;
  created_at: string;
  completed_at: string | null;
}

// ---- epic_tickets ---------------------------------------------------------

// Epic membership — epic-layer data, replacing tasks.epic_id/epic_order.
// UNIQUE(task_id) keeps "a task belongs to at most one epic"; deleting an
// epic deletes memberships, never tasks.
export interface EpicTicketRow {
  epic_id: number;
  task_id: number;
  position: number;
}

// One ticket of an epic, as the epic surfaces list it: the task row plus its
// position in the execution order.
export type EpicTicketWithTask = TaskRow & { position: number };

// ---- epics -----------------------------------------------------------------

// Container lifecycle only. "Blocked" is deliberately a flag (added by the
// orchestrator phase), not a status — CHECK changes force table rebuilds.
export type EpicStatus = 'active' | 'completed' | 'cancelled';

// One epic: a large feature developed through the staged pipeline
// (architecture → specification → stories → specification review →
// orchestrated implementation) on a dedicated feature branch. Stage flags
// mirror the task workflow-flag pattern: the current stage is derived (first
// false flag), each stage independently re-runnable.
export interface EpicRow {
  id: number;
  project_id: number;
  user_id: number | null;
  name: string;
  // sanitizeTitle(name) stamped at creation — deterministic feature-branch
  // naming (`epic/{id}-{slug}`), stable across renames.
  slug: string;
  status: EpicStatus;
  architecture_complete: SqliteBoolean;
  specs_complete: SqliteBoolean;
  stories_complete: SqliteBoolean;
  // The final gate before autonomous implementation: set by the specification
  // review agent when it finds nothing blocking across the functional spec,
  // the architecture document, the technical specification and the tickets
  // (or by the human backstop). Orchestration cannot start without it.
  review_complete: SqliteBoolean;
  // The QA scenario book approved: set by the QA scenario writer on the user's
  // explicit word (or by the human backstop). The QA execution agent cannot
  // start without it.
  qa_complete: SqliteBoolean;
  // 'epic/{id}-{slug}' once the branch exists (Phase 3 sets it at first
  // epic-ticket creation); NULL = ticketing not started.
  feature_branch: string | null;
  // Autonomous implementation. `active` is durable rather than derived from a
  // running row because the orchestrator is dormant between events; `blocked`
  // halts the event bridge (an escalation, or the user pausing) without
  // leaving orchestration.
  orchestration_active: SqliteBoolean;
  orchestration_blocked: SqliteBoolean;
  orchestration_blocked_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// One uploaded spec file. Historically the v0 spike stored these verbatim as
// `epic_runs.spec_json` (JSON Array<EpicSpecFile>); the one-shot conversion
// migration still parses that shape, and the upload route uses it in-memory
// before writing files to the epic archive.
export interface EpicSpecFile {
  filename: string;
  content: string;
}

// ---- messages (Claude Agent SDK transcript store) -------------------------

export interface MessageRow {
  project_key: string;
  session_id: string;
  subpath: string;
  uuid: string;
  seq: number;
  mtime: number;
  // Stored as BLOB containing UTF-8 JSON; `better-sqlite3` returns a
  // Buffer. Callers JSON.parse the contents as an SDK transcript entry.
  entry_json: Buffer;
}

export interface SessionSummaryRow {
  project_key: string;
  session_id: string;
  mtime: number;
  summary_json: Buffer;
}

// ---- app_settings ---------------------------------------------------------

export interface AppSettingRow {
  key: string;
  value: string;
  updated_at: string;
}

// ---- user_agent_model_settings --------------------------------------------

export interface UserAgentModelSettingsRow {
  user_id: number;
  /** JSON-encoded Record<AgentType, AgentModelSetting>. */
  settings_json: string;
  updated_at: string;
}
