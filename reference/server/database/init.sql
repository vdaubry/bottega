-- Initialize Bottega database (auth + projects + tasks + conversations + messages).
PRAGMA foreign_keys = ON;

-- Users table (multi-user system with admin support)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    is_admin BOOLEAN DEFAULT 0,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0,
    is_technical BOOLEAN DEFAULT 1,
    api_key_hash TEXT,
    api_key_last_used_at DATETIME,
    token_version INTEGER NOT NULL DEFAULT 1
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
-- Note: idx_users_api_key_hash unique partial index is created in migration (db.js)

-- Projects table - User-created projects pointing to repo folders
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    repo_folder_path TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_repo_folder_path ON projects(repo_folder_path);

-- Project Members table - Many-to-many relationship between users and projects
CREATE TABLE IF NOT EXISTS project_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_project_members_project_id ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON project_members(user_id);

-- Tasks table - Work items belonging to projects
-- Status: 'pending' (default), 'in_progress', 'in_review', 'completed'
-- workflow_complete: Boolean flag to stop agent loop when task is finished
-- workflow_blocked: Boolean flag to stop agent loop when user intervention needed
-- workflow_run_count: Counter for agent iterations (to prevent infinite loops)
-- planification_complete: Boolean flag to signal planification phase is done
-- pr_agent_complete: Boolean flag to signal PR agent has finished (CI passed)
-- yolo_mode: Boolean flag to use the single-agent YOLO workflow instead of the 5-step pipeline
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'in_review', 'completed')),
    workflow_complete INTEGER DEFAULT 0 NOT NULL,
    workflow_blocked INTEGER DEFAULT 0 NOT NULL,
    workflow_run_count INTEGER DEFAULT 0 NOT NULL,
    planification_complete INTEGER DEFAULT 0 NOT NULL,
    pr_agent_complete INTEGER DEFAULT 0 NOT NULL,
    refinement_complete INTEGER DEFAULT 0 NOT NULL,
    yolo_mode INTEGER DEFAULT 0 NOT NULL,
    completed_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
-- Note: idx_tasks_status and idx_tasks_user_id indexes are created in migration (db.js)

-- Conversations table - Links Claude sessions to tasks
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    claude_conversation_id TEXT,
    session_path TEXT DEFAULT NULL,
    context_usage_json TEXT DEFAULT NULL,
    -- Which LLM backend owns this conversation. Anthropic-only deploys read
    -- legacy rows as 'anthropic' via a NOT NULL DEFAULT. Codex conversations
    -- write 'openai'.
    provider TEXT NOT NULL DEFAULT 'anthropic',
    -- Provider-agnostic session id. For Anthropic this duplicates
    -- claude_conversation_id; for OpenAI this carries the Codex thread id.
    -- Kept as a parallel column so legacy Anthropic rows never get rewritten.
    provider_session_id TEXT,
    -- The exact model this conversation runs (provider-specific id, e.g.
    -- 'opus', 'gpt-5.5', 'opencode/kimi-k2.6'). Stamped at creation and
    -- read back on resume so every turn is deterministic — the model is
    -- never inferred or defaulted at the SDK boundary.
    model TEXT DEFAULT NULL,
    -- Provider reasoning effort, or NULL when the provider has none
    -- (OpenCode) or the conversation didn't choose one (manual chats).
    effort TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversations_task_id ON conversations(task_id);
CREATE INDEX IF NOT EXISTS idx_conversations_claude_id ON conversations(claude_conversation_id);

-- Task Agent Runs table - Tracks automated agent runs for tasks
-- Agent types: 'planification', 'implementation', 'refinement', 'review', 'pr', 'yolo'
-- Status: 'pending', 'running', 'completed', 'failed', 'blocked'
CREATE TABLE IF NOT EXISTS task_agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    agent_type TEXT NOT NULL CHECK(agent_type IN ('planification', 'implementation', 'refinement', 'review', 'pr', 'yolo')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
    conversation_id INTEGER,
    -- Provider used for this run; diagnostics only — runtime always reads
    -- the provider off the linked conversation row.
    provider TEXT NOT NULL DEFAULT 'anthropic',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_task_agent_runs_task_id ON task_agent_runs(task_id);

-- Session storage tables (Claude Agent SDK custom sessionStore backend)
-- The SDK calls our SqliteSessionStore.append/load/... instead of writing JSONL
-- transcripts that our app would have to read back. The two tables below are
-- the single source of truth for conversation transcripts; the SDK's own
-- on-disk JSONL files are now its private scratch space and are never read by
-- this codebase.
--
-- messages: one row per SDK transcript entry. Idempotent on uuid (the SDK uses
-- uuid as the dedup key); entries without a uuid get a synthetic key.
CREATE TABLE IF NOT EXISTS messages (
    project_key TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    subpath     TEXT NOT NULL DEFAULT '',
    uuid        TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    mtime       INTEGER NOT NULL,
    entry_json  BLOB NOT NULL,
    PRIMARY KEY (project_key, session_id, subpath, uuid)
);

CREATE INDEX IF NOT EXISTS idx_messages_seq
    ON messages(project_key, session_id, subpath, seq);

-- session_summaries: incrementally-maintained summary sidecar per session,
-- folded inside SqliteSessionStore.append() via SDK's foldSessionSummary().
CREATE TABLE IF NOT EXISTS session_summaries (
    project_key  TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    mtime        INTEGER NOT NULL,
    summary_json BLOB NOT NULL,
    PRIMARY KEY (project_key, session_id)
);

-- Global application settings (key/value, single-instance scope).
-- e.g. internal_tool_name (display title), github_pr_trigger (@-mention).
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Per-user agent model settings. Each row holds one user's full
-- Record<AgentType, {provider, model, effort}> as JSON. Replaces the global
-- `app_settings.agent_model_settings` blob so each user runs agents on a
-- provider/model they have credentials for. Seeded on first provider-connect
-- (new users) or backfilled from the old global config (existing users).
CREATE TABLE IF NOT EXISTS user_agent_model_settings (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings_json TEXT NOT NULL,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);