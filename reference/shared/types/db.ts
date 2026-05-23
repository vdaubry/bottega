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

export type AgentType =
  | 'planification'
  | 'implementation'
  | 'refinement'
  | 'review'
  | 'pr'
  | 'yolo';

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
  active_worktree_task_id: number | null;
  serve_symlink_path: string | null;
  systemd_service_name: string | null;
  app_url: string | null;
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
  title: string | null;
  status: TaskStatus;
  workflow_complete: SqliteBoolean;
  workflow_blocked: SqliteBoolean;
  workflow_run_count: number;
  planification_complete: SqliteBoolean;
  pr_agent_complete: SqliteBoolean;
  refinement_complete: SqliteBoolean;
  yolo_mode: SqliteBoolean;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---- conversations --------------------------------------------------------

export interface ConversationRow {
  id: number;
  task_id: number;
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
  // 'gpt-5.5', 'opencode/kimi-k2.6'). Stamped at creation, read back on
  // resume — never inferred. Null only on legacy rows that pre-date the
  // column and couldn't be backfilled.
  model: string | null;
  // Provider reasoning effort, or null when the provider has none (OpenCode)
  // or the conversation didn't pick one (manual chats).
  effort: string | null;
  created_at: string;
}

// ---- task_agent_runs ------------------------------------------------------

export interface AgentRunRow {
  id: number;
  task_id: number;
  agent_type: AgentType;
  status: AgentRunStatus;
  conversation_id: number | null;
  // Diagnostics column. Runtime never reads this — it always reads the
  // provider off the linked `conversations` row. NOT NULL DEFAULT 'anthropic'.
  provider: Provider;
  created_at: string;
  completed_at: string | null;
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
