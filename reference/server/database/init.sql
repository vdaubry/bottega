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

-- Epics table - Large features developed through a staged pipeline:
-- architecture diagrams -> technical specification -> story split -> orchestrated
-- implementation. Each stage is an agent run on an epic-scoped conversation.
-- The stage flags follow the task workflow-flag pattern: the current stage is
-- the first incomplete one, and every stage stays independently re-runnable.
-- `slug` is stamped at creation (sanitized name) so the feature branch name
-- `epic/{id}-{slug}` is deterministic and survives a rename.
CREATE TABLE IF NOT EXISTS epics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'completed', 'cancelled')),
    architecture_complete INTEGER NOT NULL DEFAULT 0,
    specs_complete INTEGER NOT NULL DEFAULT 0,
    stories_complete INTEGER NOT NULL DEFAULT 0,
    -- The specification review: the consistency gate between the tickets and
    -- autonomous implementation. Set by the review agent when nothing blocks
    -- (or by the human backstop); orchestration cannot start without it.
    review_complete INTEGER NOT NULL DEFAULT 0,
    -- The QA scenario book approved by the user (set by the QA scenario
    -- writer's sign-off, or the human backstop). The QA execution agent
    -- cannot start without it.
    qa_complete INTEGER NOT NULL DEFAULT 0,
    -- 'epic/{id}-{slug}' once the feature branch exists; NULL before ticketing.
    feature_branch TEXT DEFAULT NULL,
    -- Orchestration is a durable epic flag, not a run status: the orchestrator
    -- is dormant between events, so "is this epic being driven autonomously?"
    -- cannot be read off a running row. `blocked` halts the event bridge
    -- (escalation, pause) without leaving orchestration.
    orchestration_active INTEGER NOT NULL DEFAULT 0,
    orchestration_blocked INTEGER NOT NULL DEFAULT 0,
    orchestration_blocked_reason TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME DEFAULT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_epics_project_id ON epics(project_id);

-- Tasks table - Work items belonging to projects
-- Status: 'pending' (default), 'in_progress', 'in_review', 'completed'
-- workflow_complete: Boolean flag to stop agent loop when task is finished
-- workflow_blocked: Boolean flag to stop agent loop when user intervention needed
-- workflow_run_count: Counter for agent iterations (to prevent infinite loops)
-- planification_complete: Boolean flag to signal planification phase is done
-- pr_agent_complete: Boolean flag to signal PR agent has finished (CI passed)
-- yolo_mode: Boolean flag to use the single-agent YOLO workflow instead of the 5-step pipeline
-- Epic membership lives in `epic_tickets` (below), NOT on this table: the
-- task domain is complete and epic-agnostic (architecture-v2).
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    -- The branch this task forks from and merges into; NULL = the repo's
    -- default branch, resolved at use. Set at creation by whoever creates the
    -- task (the epic layer passes its feature branch). Auto-sync at loop
    -- entry applies exactly when base_branch is set.
    base_branch TEXT DEFAULT NULL,
    title TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'in_review', 'completed')),
    workflow_complete INTEGER DEFAULT 0 NOT NULL,
    workflow_blocked INTEGER DEFAULT 0 NOT NULL,
    -- Why the agent blocked, in its own words. Cleared on unblock; it is what
    -- an epic orchestrator is woken with.
    workflow_blocked_reason TEXT DEFAULT NULL,
    -- The worktree is set up in the background after creation: 'provisioning'
    -- until `git worktree add` (and the project's hook) finishes. No
    -- conversation may start until 'ready'. 'failed' keeps the task with the
    -- reason in worktree_error, for a retry or a delete.
    worktree_state TEXT NOT NULL DEFAULT 'ready' CHECK(worktree_state IN ('provisioning', 'ready', 'failed')),
    worktree_error TEXT DEFAULT NULL,
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

-- Durable write-ahead record for the one operation SQLite cannot transact
-- with: merging a pull request on GitHub. A row is written BEFORE asking
-- GitHub to merge. If the process dies after GitHub accepts the merge but
-- before `tasks.status` is updated, boot reconciliation can query this exact
-- PR URL and finish the local transition. Worktree cleanup is deliberately a
-- separate, retryable state: local housekeeping must never make an already
-- merged task look open again.
CREATE TABLE IF NOT EXISTS task_landings (
    task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    pr_url TEXT NOT NULL,
    head_branch TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'merge_requested'
        CHECK(state IN ('merge_requested', 'merged')),
    merge_commit_sha TEXT DEFAULT NULL,
    merge_requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    merged_at DATETIME DEFAULT NULL,
    cleanup_state TEXT NOT NULL DEFAULT 'pending'
        CHECK(cleanup_state IN ('pending', 'completed', 'failed')),
    -- 0 means no pre-merge worktree-safety checkpoint was recorded (for
    -- example, the PR was merged outside Bottega). Boot recovery must preserve
    -- that tree for a human instead of turning a warning into a later delete.
    cleanup_retryable INTEGER NOT NULL DEFAULT 1
        CHECK(cleanup_retryable IN (0, 1)),
    cleanup_error TEXT DEFAULT NULL,
    cleanup_updated_at DATETIME DEFAULT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_task_landings_reconcile
    ON task_landings(state, cleanup_state);

-- Conversations table — INFRASTRUCTURE: no owner columns. The owner lives in
-- the domain link tables below (task_conversations / epic_conversations),
-- which reference this table — never the other way round. `owner_kind` is a
-- dispatch tag for the runtime's owner-adapter registry, so an owner resolves
-- in one read instead of probing both link tables. Everything downstream
-- (transcripts, streaming, agent runs) is conversation-keyed and therefore
-- identical for both owners.
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('task', 'epic')),
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
    -- 'opus', 'gpt-5.5', 'opencode/kimi-k2.7-code'). Stamped at creation and
    -- read back on resume so every turn is deterministic — the model is
    -- never inferred or defaulted at the SDK boundary.
    model TEXT DEFAULT NULL,
    -- Provider reasoning effort, or NULL when the provider has none
    -- (OpenCode) or the conversation didn't choose one (manual chats).
    effort TEXT DEFAULT NULL,
    -- Conversations started from the Explore (IDE) view get the in-process
    -- code-atlas MCP server (open_file/highlight/render_artifact). Stamped at
    -- creation and read back on resume — the row is the source of truth, so
    -- the tools survive restarts and WS resume. Anthropic-only.
    atlas_enabled INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversations_claude_id ON conversations(claude_conversation_id);

-- TASK DOMAIN: which task owns a conversation. Deleting the conversation or
-- the task removes the link; the base conversation row is removed explicitly
-- by the owning domain's delete service (no longer implied by FKs).
CREATE TABLE IF NOT EXISTS task_conversations (
    conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_conversations_task_id ON task_conversations(task_id);

-- EPIC DOMAIN: which epic owns a conversation.
CREATE TABLE IF NOT EXISTS epic_conversations (
    conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_epic_conversations_epic_id ON epic_conversations(epic_id);

-- Provider-neutral questions. Unlike the old Claude canUseTool promise, this
-- row survives a server/browser restart and keeps the owner run waiting.
CREATE TABLE IF NOT EXISTS conversation_questions (
    id TEXT PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    provider_tool_use_id TEXT,
    questions_json TEXT NOT NULL,
    answers_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'answered', 'resolved', 'cancelled')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    answered_at DATETIME,
    resolved_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_conversation_questions_conversation
    ON conversation_questions(conversation_id, created_at DESC);
-- An answered row remains durable while its continuation turn is running, but
-- that turn may legitimately ask a second round of questions. Only the next
-- unanswered round is unique per conversation.
DROP INDEX IF EXISTS idx_conversation_questions_one_pending;
CREATE UNIQUE INDEX idx_conversation_questions_one_pending
    ON conversation_questions(conversation_id) WHERE status = 'pending';

-- EPIC DOMAIN: epic membership, replacing tasks.epic_id/epic_order.
-- UNIQUE(task_id) keeps "a task belongs to at most one epic"; deleting an
-- epic deletes memberships, never tasks.
CREATE TABLE IF NOT EXISTS epic_tickets (
    epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (epic_id, task_id)
);

-- Self-contained HTML artifacts generated for the Explore view. Machine-written
-- by the render_artifact MCP tool; one row per (task, kind), upserted
-- last-write-wins, restored when the Explore view loads. A task can hold one
-- 'plan', one 'flowchart', and one 'architecture' artifact simultaneously.
CREATE TABLE IF NOT EXISTS task_artifacts (
    task_id    INTEGER NOT NULL,
    kind       TEXT NOT NULL,          -- 'plan' | 'flowchart' | 'architecture'
    title      TEXT,
    html       TEXT NOT NULL,          -- self-contained HTML document
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (task_id, kind),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- TASK DOMAIN: a task's agent runs. Epic runs live in `epic_agent_runs`
-- (below) since the architecture-v2 step-5 split; no surface mixes the two.
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
    -- Who started this run and therefore reviews its output: a person, or an
    -- automation (the epic orchestrator today; any future driver tomorrow).
    -- Inherited by chained runs. Policy, not identity: it decides the
    -- planification prompt variant, the auto-chain, and push notifications.
    driver TEXT NOT NULL DEFAULT 'human' CHECK(driver IN ('human', 'automation')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_task_agent_runs_task_id ON task_agent_runs(task_id);

-- EPIC DOMAIN: an epic's agent runs — the staged pipeline plus the
-- per-ticket orchestrator and PR reviewer conversations.
CREATE TABLE IF NOT EXISTS epic_agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epic_id INTEGER NOT NULL,
    agent_type TEXT NOT NULL CHECK(agent_type IN ('epic-architecture', 'epic-specification', 'epic-stories', 'epic-spec-review', 'epic-orchestrator', 'epic-pr-review', 'epic-delivery', 'epic-qa-scenarios', 'epic-qa-execution', 'epic-qa-fix')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
    conversation_id INTEGER,
    provider TEXT NOT NULL DEFAULT 'anthropic',
    -- The ticket this run is ABOUT (orchestrator: supervises; reviewer:
    -- reviews). One meaning. No task-layer code can read it, because no
    -- task-layer code reads this table. Reviewer ownership and resumability
    -- are represented by this epic-domain run, not by task state.
    ticket_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (epic_id) REFERENCES epics(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_epic_agent_runs_epic_id ON epic_agent_runs(epic_id);

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
-- NOTE: the v0 `epic_runs` table is intentionally absent here. Fresh installs
-- never get it; existing databases keep theirs (dead, read once by the one-shot
-- `convertEpicRunsToEpics` migration in db.ts, then left untouched).
