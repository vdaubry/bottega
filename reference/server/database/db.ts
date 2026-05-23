import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import type {
  AgentRunRow,
  AgentRunStatus,
  AgentType,
  AppSettingRow,
  ConversationRow,
  ProjectMemberRow,
  ProjectRow,
  Provider,
  TaskRow,
  TaskStatus,
  UserRow,
  UserAgentModelSettingsRow,
} from '../../shared/types/db.js';
import { DEFAULT_AGENT_MODEL_SETTINGS } from '../../shared/types/agentModelSettings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

const c = {
  info: (text: string) => `${colors.cyan}${text}${colors.reset}`,
  bright: (text: string) => `${colors.bright}${text}${colors.reset}`,
  dim: (text: string) => `${colors.dim}${text}${colors.reset}`,
};

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'bottega.db');
const INIT_SQL_PATH = path.join(__dirname, 'init.sql');

if (process.env.DATABASE_PATH) {
  const dbDir = path.dirname(DB_PATH);
  try {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`Created database directory: ${dbDir}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to create database directory ${dbDir}:`, message);
    throw error;
  }
}

// Legacy filename was `auth.db`, which misleadingly suggested the file held
// only auth data — in fact every domain table lives there too. Rename in
// place on first boot after the upgrade. Skipped when DATABASE_PATH is set
// (custom paths are the user's responsibility). Race-safe: vitest workers
// all import this module in parallel, so multiple processes may attempt the
// rename simultaneously — the loser sees ENOENT and falls through.
if (!process.env.DATABASE_PATH) {
  const legacyPath = path.join(__dirname, 'auth.db');
  if (fs.existsSync(legacyPath) && !fs.existsSync(DB_PATH)) {
    try {
      fs.renameSync(legacyPath, DB_PATH);
      console.log(`Renamed legacy DB: ${legacyPath} -> ${DB_PATH}`);
    } catch (err) {
      if (!fs.existsSync(DB_PATH)) throw err;
    }
  }
}

const db = new Database(DB_PATH);

db.pragma('foreign_keys = ON');

const appInstallPath = path.join(__dirname, '../..');
console.log('');
console.log(c.dim('═'.repeat(60)));
console.log(`${c.info('[INFO]')} App Installation: ${c.bright(appInstallPath)}`);
console.log(`${c.info('[INFO]')} Database: ${c.dim(path.relative(appInstallPath, DB_PATH))}`);
if (process.env.DATABASE_PATH) {
  console.log(`       ${c.dim('(Using custom DATABASE_PATH from environment)')}`);
}
console.log(c.dim('═'.repeat(60)));
console.log('');

interface ColumnInfoRow {
  name: string;
}

const lastInsertId = (rowid: number | bigint): number => Number(rowid);

/**
 * One-shot backfill: replicate the previous GLOBAL `agent_model_settings` blob
 * (or DEFAULT_AGENT_MODEL_SETTINGS when none was ever set) into a per-user row
 * for every existing user lacking one, so removing the global setting doesn't
 * change anyone's current behavior. Guarded by a sentinel app_settings key so
 * it runs exactly once — users created afterwards seed from their first
 * connected provider at connect-time instead. The global row is left intact
 * (it's the source we read here; no separate backup needed). Exported for
 * testing. `INSERT OR IGNORE` keeps it safe to run against users who already
 * have a row.
 */
export function backfillUserAgentModelSettings(database: Database.Database): void {
  const backfilled = database
    .prepare(`SELECT value FROM app_settings WHERE key = 'user_agent_settings_backfilled'`)
    .get() as Pick<AppSettingRow, 'value'> | undefined;
  if (backfilled) return;

  console.log('Running migration: Backfilling per-user agent_model_settings from global config');
  const globalRow = database
    .prepare(`SELECT value FROM app_settings WHERE key = 'agent_model_settings'`)
    .get() as Pick<AppSettingRow, 'value'> | undefined;
  const globalJson = globalRow?.value ?? JSON.stringify(DEFAULT_AGENT_MODEL_SETTINGS);
  database
    .prepare(
      `INSERT OR IGNORE INTO user_agent_model_settings (user_id, settings_json)
       SELECT id, ? FROM users`,
    )
    .run(globalJson);
  database
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('user_agent_settings_backfilled', '1', CURRENT_TIMESTAMP)`,
    )
    .run();
}

const runMigrations = (): void => {
  try {
    const tableInfo = db.prepare('PRAGMA table_info(users)').all() as ColumnInfoRow[];
    const columnNames = tableInfo.map((col) => col.name);

    if (!columnNames.includes('git_name')) {
      console.log('Running migration: Adding git_name column');
      db.exec('ALTER TABLE users ADD COLUMN git_name TEXT');
    }

    if (!columnNames.includes('git_email')) {
      console.log('Running migration: Adding git_email column');
      db.exec('ALTER TABLE users ADD COLUMN git_email TEXT');
    }

    if (!columnNames.includes('has_completed_onboarding')) {
      console.log('Running migration: Adding has_completed_onboarding column');
      db.exec('ALTER TABLE users ADD COLUMN has_completed_onboarding BOOLEAN DEFAULT 0');
    }

    if (!columnNames.includes('is_technical')) {
      console.log('Running migration: Adding is_technical column');
      db.exec('ALTER TABLE users ADD COLUMN is_technical BOOLEAN DEFAULT 1');
    }

    const tasksTableInfo = db.prepare('PRAGMA table_info(tasks)').all() as ColumnInfoRow[];
    const taskColumnNames = tasksTableInfo.map((col) => col.name);

    if (!taskColumnNames.includes('status')) {
      console.log('Running migration: Adding status column to tasks');
      db.exec("ALTER TABLE tasks ADD COLUMN status TEXT DEFAULT 'pending'");
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
    }

    if (!taskColumnNames.includes('workflow_complete')) {
      console.log('Running migration: Adding workflow_complete column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN workflow_complete INTEGER DEFAULT 0 NOT NULL');
    }

    if (!taskColumnNames.includes('planification_complete')) {
      console.log('Running migration: Adding planification_complete column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN planification_complete INTEGER DEFAULT 0 NOT NULL');
    }

    if (!taskColumnNames.includes('completed_at')) {
      console.log('Running migration: Adding completed_at column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN completed_at DATETIME DEFAULT NULL');
      db.exec(`
        UPDATE tasks
        SET completed_at = updated_at
        WHERE status = 'completed' AND completed_at IS NULL
      `);
    }

    if (!taskColumnNames.includes('workflow_blocked')) {
      console.log('Running migration: Adding workflow_blocked column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN workflow_blocked INTEGER DEFAULT 0 NOT NULL');
    }

    if (!taskColumnNames.includes('workflow_run_count')) {
      console.log('Running migration: Adding workflow_run_count column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN workflow_run_count INTEGER DEFAULT 0 NOT NULL');
    }

    if (!taskColumnNames.includes('pr_agent_complete')) {
      console.log('Running migration: Adding pr_agent_complete column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN pr_agent_complete INTEGER DEFAULT 0 NOT NULL');
    }

    if (!taskColumnNames.includes('refinement_complete')) {
      console.log('Running migration: Adding refinement_complete column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN refinement_complete INTEGER DEFAULT 0 NOT NULL');
    }

    if (!taskColumnNames.includes('yolo_mode')) {
      console.log('Running migration: Adding yolo_mode column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN yolo_mode INTEGER DEFAULT 0 NOT NULL');
    }

    try {
      db.prepare('SELECT 1 FROM task_agent_runs LIMIT 1').get();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('no such table')) {
        console.log('Running migration: Creating task_agent_runs table');
        db.exec(`
          CREATE TABLE IF NOT EXISTS task_agent_runs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id INTEGER NOT NULL,
              agent_type TEXT NOT NULL CHECK(agent_type IN ('planification', 'implementation', 'review', 'pr')),
              status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
              conversation_id INTEGER,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              completed_at DATETIME,
              FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
              FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
          );
          CREATE INDEX IF NOT EXISTS idx_task_agent_runs_task_id ON task_agent_runs(task_id);
        `);
      }
    }

    try {
      const checkAgentType = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='task_agent_runs'`)
        .get() as { sql: string } | undefined;

      if (checkAgentType && !checkAgentType.sql.includes("'pr'")) {
        console.log('Running migration: Adding pr agent type to task_agent_runs');
        db.exec(`
          CREATE TABLE task_agent_runs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            agent_type TEXT NOT NULL CHECK(agent_type IN ('planification', 'implementation', 'review', 'pr')),
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
            conversation_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
          );
          INSERT INTO task_agent_runs_new SELECT * FROM task_agent_runs;
          DROP TABLE task_agent_runs;
          ALTER TABLE task_agent_runs_new RENAME TO task_agent_runs;
          CREATE INDEX idx_task_agent_runs_task_id ON task_agent_runs(task_id);
        `);
      }
    } catch (migrationError) {
      const message = migrationError instanceof Error ? migrationError.message : String(migrationError);
      console.error('Error migrating task_agent_runs for pr agent type:', message);
    }

    try {
      const checkAgentType = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='task_agent_runs'`)
        .get() as { sql: string } | undefined;

      if (checkAgentType && !checkAgentType.sql.includes("'refinement'")) {
        console.log('Running migration: Adding refinement agent type to task_agent_runs');
        db.exec(`
          CREATE TABLE task_agent_runs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            agent_type TEXT NOT NULL CHECK(agent_type IN ('planification', 'implementation', 'refinement', 'review', 'pr')),
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
            conversation_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
          );
          INSERT INTO task_agent_runs_new SELECT * FROM task_agent_runs;
          DROP TABLE task_agent_runs;
          ALTER TABLE task_agent_runs_new RENAME TO task_agent_runs;
          CREATE INDEX idx_task_agent_runs_task_id ON task_agent_runs(task_id);
        `);
      }
    } catch (migrationError) {
      const message = migrationError instanceof Error ? migrationError.message : String(migrationError);
      console.error('Error migrating task_agent_runs for refinement agent type:', message);
    }

    try {
      const checkAgentType = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='task_agent_runs'`)
        .get() as { sql: string } | undefined;

      if (checkAgentType && !checkAgentType.sql.includes("'yolo'")) {
        console.log('Running migration: Adding yolo agent type to task_agent_runs');
        db.exec(`
          CREATE TABLE task_agent_runs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            agent_type TEXT NOT NULL CHECK(agent_type IN ('planification', 'implementation', 'refinement', 'review', 'pr', 'yolo')),
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
            conversation_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
          );
          INSERT INTO task_agent_runs_new SELECT * FROM task_agent_runs;
          DROP TABLE task_agent_runs;
          ALTER TABLE task_agent_runs_new RENAME TO task_agent_runs;
          CREATE INDEX idx_task_agent_runs_task_id ON task_agent_runs(task_id);
        `);
      }
    } catch (migrationError) {
      const message = migrationError instanceof Error ? migrationError.message : String(migrationError);
      console.error('Error migrating task_agent_runs for yolo agent type:', message);
    }

    try {
      const checkStatus = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='task_agent_runs'`)
        .get() as { sql: string } | undefined;

      if (checkStatus && checkStatus.sql.includes("'paused'")) {
        console.log('Running migration: Dropping paused status from task_agent_runs');
        db.exec(`
          UPDATE task_agent_runs SET status = 'completed' WHERE status = 'paused';
          CREATE TABLE task_agent_runs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            agent_type TEXT NOT NULL CHECK(agent_type IN ('planification', 'implementation', 'refinement', 'review', 'pr', 'yolo')),
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
            conversation_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
          );
          INSERT INTO task_agent_runs_new SELECT * FROM task_agent_runs;
          DROP TABLE task_agent_runs;
          ALTER TABLE task_agent_runs_new RENAME TO task_agent_runs;
          CREATE INDEX idx_task_agent_runs_task_id ON task_agent_runs(task_id);
        `);
      }
    } catch (migrationError) {
      const message = migrationError instanceof Error ? migrationError.message : String(migrationError);
      console.error('Error migrating task_agent_runs to drop paused status:', message);
    }

    const convTableInfoUpdated = db
      .prepare('PRAGMA table_info(conversations)')
      .all() as ColumnInfoRow[];
    const convColumnNamesUpdated = convTableInfoUpdated.map((col) => col.name);

    if (!convColumnNamesUpdated.includes('session_path')) {
      console.log('Running migration: Adding session_path column to conversations');
      db.exec('ALTER TABLE conversations ADD COLUMN session_path TEXT DEFAULT NULL');
    }

    if (!convColumnNamesUpdated.includes('name')) {
      console.log('Running migration: Adding name column to conversations');
      db.exec('ALTER TABLE conversations ADD COLUMN name TEXT DEFAULT NULL');
    }

    if (!convColumnNamesUpdated.includes('context_usage_json')) {
      console.log('Running migration: Adding context_usage_json column to conversations');
      db.exec('ALTER TABLE conversations ADD COLUMN context_usage_json TEXT DEFAULT NULL');
    }

    if (!convColumnNamesUpdated.includes('provider')) {
      console.log('Running migration: Adding provider column to conversations (default anthropic)');
      db.exec("ALTER TABLE conversations ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic'");
    }

    if (!convColumnNamesUpdated.includes('provider_session_id')) {
      console.log('Running migration: Adding provider_session_id column to conversations');
      db.exec('ALTER TABLE conversations ADD COLUMN provider_session_id TEXT DEFAULT NULL');
    }

    // model / effort — the exact (model, effort) a conversation runs, so resume
    // is deterministic instead of relying on the SDK silently reusing or
    // defaulting a model. Backfill legacy rows: Anthropic/OpenAI get the
    // historical default model; OpenCode rows recover their real model from the
    // mirrored transcript (its catalog is dynamic, so there is no constant to
    // fall back to). effort stays NULL for legacy rows (provider default).
    if (!convColumnNamesUpdated.includes('model')) {
      console.log('Running migration: Adding model column to conversations');
      db.exec('ALTER TABLE conversations ADD COLUMN model TEXT DEFAULT NULL');
      try {
        db.exec("UPDATE conversations SET model = 'opus' WHERE model IS NULL AND provider = 'anthropic'");
        db.exec("UPDATE conversations SET model = 'gpt-5.5' WHERE model IS NULL AND provider = 'openai'");
        db.exec(
          `UPDATE conversations SET model = (
             SELECT json_extract(m.entry_json, '$.message.model')
             FROM messages m
             WHERE m.session_id = conversations.claude_conversation_id
               AND json_extract(m.entry_json, '$.message.model') LIKE 'opencode/%'
             ORDER BY m.seq DESC LIMIT 1
           )
           WHERE model IS NULL AND provider = 'opencode'
             AND claude_conversation_id IS NOT NULL`,
        );
      } catch (backfillError) {
        const message =
          backfillError instanceof Error ? backfillError.message : String(backfillError);
        console.error('Error backfilling conversations.model:', message);
      }
    }

    if (!convColumnNamesUpdated.includes('effort')) {
      console.log('Running migration: Adding effort column to conversations');
      db.exec('ALTER TABLE conversations ADD COLUMN effort TEXT DEFAULT NULL');
    }

    // task_agent_runs.provider — diagnostics only. Runtime always reads
    // the provider off the linked conversation row.
    const agentRunsTableInfo = db
      .prepare('PRAGMA table_info(task_agent_runs)')
      .all() as ColumnInfoRow[];
    const agentRunsColumnNames = agentRunsTableInfo.map((col) => col.name);
    if (agentRunsColumnNames.length > 0 && !agentRunsColumnNames.includes('provider')) {
      console.log('Running migration: Adding provider column to task_agent_runs (default anthropic)');
      db.exec("ALTER TABLE task_agent_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic'");
    }

    const projectsTableInfo = db
      .prepare('PRAGMA table_info(projects)')
      .all() as ColumnInfoRow[];
    const projectColumnNames = projectsTableInfo.map((col) => col.name);

    if (!projectColumnNames.includes('active_worktree_task_id')) {
      console.log('Running migration: Adding web server switching columns to projects');
      db.exec(`
        ALTER TABLE projects ADD COLUMN active_worktree_task_id INTEGER DEFAULT NULL;
        ALTER TABLE projects ADD COLUMN serve_symlink_path TEXT DEFAULT NULL;
        ALTER TABLE projects ADD COLUMN systemd_service_name TEXT DEFAULT NULL;
      `);
    }

    if (!projectColumnNames.includes('subproject_path')) {
      console.log('Running migration: Adding subproject_path column to projects for monorepo support');
      db.exec('ALTER TABLE projects ADD COLUMN subproject_path TEXT DEFAULT NULL');
    }

    if (!projectColumnNames.includes('app_url')) {
      console.log('Running migration: Adding app_url column to projects for "switch server" tab opening');
      db.exec('ALTER TABLE projects ADD COLUMN app_url TEXT DEFAULT NULL');
    }

    if (!columnNames.includes('is_admin')) {
      console.log('Running migration: Adding is_admin column to users');
      db.exec('ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT 0');
    }

    try {
      db.prepare('SELECT 1 FROM project_members LIMIT 1').get();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('no such table')) {
        console.log('Running migration: Creating project_members table');
        db.exec(`
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
        `);

        console.log('Running migration: Migrating existing project ownership to memberships');
        db.exec(`
          INSERT INTO project_members (project_id, user_id)
          SELECT id, user_id FROM projects WHERE user_id IS NOT NULL
        `);
      }
    }

    if (!columnNames.includes('api_key_hash')) {
      console.log('Running migration: Adding api_key_hash column to users');
      db.exec('ALTER TABLE users ADD COLUMN api_key_hash TEXT');
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key_hash
        ON users(api_key_hash) WHERE api_key_hash IS NOT NULL
      `);
    }

    if (!columnNames.includes('api_key_last_used_at')) {
      console.log('Running migration: Adding api_key_last_used_at column to users');
      db.exec('ALTER TABLE users ADD COLUMN api_key_last_used_at DATETIME');
    }

    if (!columnNames.includes('token_version')) {
      console.log('Running migration: Adding token_version column to users');
      db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1');
    }

    if (!taskColumnNames.includes('user_id')) {
      console.log('Running migration: Adding user_id column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
      db.exec(`
        UPDATE tasks
        SET user_id = (SELECT user_id FROM projects WHERE projects.id = tasks.project_id)
        WHERE user_id IS NULL
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)');
    }

    db.exec(`
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
      CREATE TABLE IF NOT EXISTS session_summaries (
        project_key  TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        mtime        INTEGER NOT NULL,
        summary_json BLOB NOT NULL,
        PRIMARY KEY (project_key, session_id)
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS user_agent_model_settings (
        user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        settings_json TEXT NOT NULL,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    backfillUserAgentModelSettings(db);

    console.log('Database migrations completed successfully');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error running migrations:', message);
    throw error;
  }
};

const initializeDatabase = async (): Promise<void> => {
  try {
    const initSQL = fs.readFileSync(INIT_SQL_PATH, 'utf8');
    db.exec(initSQL);
    console.log('Database initialized successfully');
    runMigrations();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error initializing database:', message);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// userDb
// ---------------------------------------------------------------------------

export interface CreatedUser {
  id: number;
  username: string;
}

// Subset of UserRow returned by getUserById/getFirstUser (no password_hash).
export type SafeUserRow = Pick<
  UserRow,
  'id' | 'username' | 'created_at' | 'last_login' | 'is_admin' | 'is_technical'
>;

export type AdminUserRow = Pick<
  UserRow,
  'id' | 'username' | 'created_at' | 'last_login' | 'is_active' | 'is_admin' | 'is_technical'
>;

export interface UserUpdates {
  username?: string;
  is_active?: 0 | 1 | boolean;
  is_admin?: 0 | 1 | boolean;
}

const userDb = {
  hasUsers: (): boolean => {
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    return row.count > 0;
  },

  createUser: (username: string, passwordHash: string): CreatedUser => {
    const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
    const result = stmt.run(username, passwordHash);
    return { id: lastInsertId(result.lastInsertRowid), username };
  },

  getUserByUsername: (username: string): UserRow | undefined => {
    return db
      .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
      .get(username) as UserRow | undefined;
  },

  updateLastLogin: (userId: number): void => {
    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
  },

  getUserById: (userId: number): SafeUserRow | undefined => {
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, is_admin, is_technical FROM users WHERE id = ? AND is_active = 1'
      )
      .get(userId) as SafeUserRow | undefined;
  },

  getFirstUser: (): SafeUserRow | undefined => {
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, is_admin, is_technical FROM users WHERE is_active = 1 LIMIT 1'
      )
      .get() as SafeUserRow | undefined;
  },

  getFirstAdmin: (): SafeUserRow | undefined => {
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, is_admin, is_technical FROM users WHERE is_active = 1 AND is_admin = 1 ORDER BY id ASC LIMIT 1'
      )
      .get() as SafeUserRow | undefined;
  },

  updateGitConfig: (userId: number, gitName: string | null, gitEmail: string | null): void => {
    db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(
      gitName,
      gitEmail,
      userId
    );
  },

  getGitConfig: (
    userId: number
  ): Pick<UserRow, 'git_name' | 'git_email'> | undefined => {
    return db
      .prepare('SELECT git_name, git_email FROM users WHERE id = ?')
      .get(userId) as Pick<UserRow, 'git_name' | 'git_email'> | undefined;
  },

  completeOnboarding: (userId: number): void => {
    db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?').run(userId);
  },

  hasCompletedOnboarding: (userId: number): boolean => {
    const row = db
      .prepare('SELECT has_completed_onboarding FROM users WHERE id = ?')
      .get(userId) as Pick<UserRow, 'has_completed_onboarding'> | undefined;
    return row?.has_completed_onboarding === 1;
  },

  updateIsTechnical: (userId: number, isTechnical: boolean): SafeUserRow | undefined => {
    db.prepare('UPDATE users SET is_technical = ? WHERE id = ?').run(isTechnical ? 1 : 0, userId);
    return userDb.getUserById(userId);
  },

  getAllUsers: (): AdminUserRow[] => {
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, is_active, is_admin, is_technical FROM users ORDER BY created_at DESC'
      )
      .all() as AdminUserRow[];
  },

  updateUser: (userId: number, updates: UserUpdates): SafeUserRow | undefined => {
    const allowedFields: ReadonlyArray<keyof UserUpdates> = ['username', 'is_active', 'is_admin'];
    const setClause: string[] = [];
    const values: unknown[] = [];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClause.push(`${field} = ?`);
        values.push(updates[field]);
      }
    }

    if (setClause.length === 0) {
      return userDb.getUserById(userId);
    }

    values.push(userId);
    const stmt = db.prepare(`UPDATE users SET ${setClause.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return userDb.getUserById(userId);
  },

  updatePassword: (userId: number, passwordHash: string): boolean => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
    return true;
  },

  deleteUser: (userId: number): boolean => {
    const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return result.changes > 0;
  },

  isAdmin: (userId: number): boolean => {
    const row = db
      .prepare('SELECT is_admin FROM users WHERE id = ?')
      .get(userId) as Pick<UserRow, 'is_admin'> | undefined;
    return row?.is_admin === 1;
  },

  setAdmin: (userId: number, isAdmin: boolean): SafeUserRow | undefined => {
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
    return userDb.getUserById(userId);
  },

  getTokenVersion: (userId: number): number | null => {
    const row = db
      .prepare('SELECT token_version FROM users WHERE id = ? AND is_active = 1')
      .get(userId) as Pick<UserRow, 'token_version'> | undefined;
    return row?.token_version ?? null;
  },

  bumpTokenVersion: (userId: number): number | null => {
    const stmt = db.prepare(
      'UPDATE users SET token_version = token_version + 1 WHERE id = ? RETURNING token_version'
    );
    const row = stmt.get(userId) as Pick<UserRow, 'token_version'> | undefined;
    return row?.token_version ?? null;
  },
};

// ---------------------------------------------------------------------------
// projectMembersDb
// ---------------------------------------------------------------------------

export interface ProjectMemberWithUserRow {
  id: number;
  username: string;
  created_at: string;
  is_admin: 0 | 1;
  joined_at: string;
}

const projectMembersDb = {
  addMember: (projectId: number, userId: number): boolean => {
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)'
    );
    const result = stmt.run(projectId, userId);
    return result.changes > 0;
  },

  removeMember: (projectId: number, userId: number): boolean => {
    const result = db
      .prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?')
      .run(projectId, userId);
    return result.changes > 0;
  },

  isMember: (projectId: number, userId: number): boolean => {
    const row = db
      .prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(projectId, userId);
    return !!row;
  },

  getProjectMembers: (projectId: number): ProjectMemberWithUserRow[] => {
    return db
      .prepare(
        `SELECT u.id, u.username, u.created_at, u.is_admin, pm.created_at as joined_at
         FROM project_members pm
         JOIN users u ON pm.user_id = u.id
         WHERE pm.project_id = ?
         ORDER BY pm.created_at ASC`
      )
      .all(projectId) as ProjectMemberWithUserRow[];
  },

  getUserProjects: (userId: number): ProjectRow[] => {
    return db
      .prepare(
        `SELECT p.*
         FROM projects p
         JOIN project_members pm ON p.id = pm.project_id
         WHERE pm.user_id = ?
         ORDER BY p.updated_at DESC`
      )
      .all(userId) as ProjectRow[];
  },

  getMemberCount: (projectId: number): number => {
    const row = db
      .prepare('SELECT COUNT(*) as count FROM project_members WHERE project_id = ?')
      .get(projectId) as { count: number };
    return row.count;
  },
};

// ---------------------------------------------------------------------------
// projectsDb
// ---------------------------------------------------------------------------

// `create` returns a hand-rolled summary (not a full ProjectRow) because the
// previous JS API made this shape part of the public contract.
export interface CreatedProject {
  id: number;
  userId: number;
  name: string;
  repoFolderPath: string;
  subprojectPath: string | null;
}

export interface ProjectUpdates {
  name?: string;
  repo_folder_path?: string;
  subproject_path?: string | null;
}

export interface WebServerConfig {
  serveSymlinkPath?: string | null | undefined;
  systemdServiceName?: string | null | undefined;
  // Public URL of the deployed app (e.g. https://app.example.com).
  // Opened in a new tab after a successful "switch server". Empty/null = no tab.
  appUrl?: string | null | undefined;
}

const projectsDb = {
  create: (
    userId: number,
    name: string,
    repoFolderPath: string,
    subprojectPath: string | null = null
  ): CreatedProject => {
    const insertProject = db.prepare(
      'INSERT INTO projects (user_id, name, repo_folder_path, subproject_path) VALUES (?, ?, ?, ?)'
    );
    const insertMember = db.prepare(
      'INSERT INTO project_members (project_id, user_id) VALUES (?, ?)'
    );

    const createWithMembership = db.transaction((): CreatedProject => {
      const result = insertProject.run(userId, name, repoFolderPath, subprojectPath);
      const projectId = lastInsertId(result.lastInsertRowid);
      insertMember.run(projectId, userId);
      return { id: projectId, userId, name, repoFolderPath, subprojectPath };
    });

    return createWithMembership();
  },

  getAll: (userId: number): ProjectRow[] => {
    return db
      .prepare(
        `SELECT p.* FROM projects p
         JOIN project_members pm ON p.id = pm.project_id
         WHERE pm.user_id = ?
         ORDER BY p.updated_at DESC`
      )
      .all(userId) as ProjectRow[];
  },

  getById: (id: number, userId: number): ProjectRow | undefined => {
    return db
      .prepare(
        `SELECT p.* FROM projects p
         JOIN project_members pm ON p.id = pm.project_id
         WHERE p.id = ? AND pm.user_id = ?`
      )
      .get(id, userId) as ProjectRow | undefined;
  },

  getByIdAdmin: (id: number): ProjectRow | undefined => {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  },

  getAllAdmin: (): ProjectRow[] => {
    return db
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
      .all() as ProjectRow[];
  },

  update: (
    id: number,
    userId: number,
    updates: ProjectUpdates
  ): ProjectRow | undefined | null => {
    const project = projectsDb.getById(id, userId);
    if (!project) {
      return null;
    }

    const allowedFields: ReadonlyArray<keyof ProjectUpdates> = [
      'name',
      'repo_folder_path',
      'subproject_path',
    ];
    const setClause: string[] = [];
    const values: unknown[] = [];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClause.push(`${field} = ?`);
        values.push(updates[field]);
      }
    }

    if (setClause.length === 0) {
      return project;
    }

    setClause.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`UPDATE projects SET ${setClause.join(', ')} WHERE id = ?`);
    stmt.run(...values);

    return projectsDb.getById(id, userId);
  },

  delete: (id: number, userId: number): boolean => {
    const project = projectsDb.getById(id, userId);
    if (!project) {
      return false;
    }

    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return result.changes > 0;
  },

  updateActiveWorktree: (
    id: number,
    userId: number,
    taskId: number | null
  ): ProjectRow | undefined | null => {
    const project = projectsDb.getById(id, userId);
    if (!project) {
      return null;
    }

    db.prepare(
      `UPDATE projects
       SET active_worktree_task_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(taskId, id);
    return projectsDb.getById(id, userId);
  },

  updateWebServerConfig: (
    id: number,
    userId: number,
    config: WebServerConfig
  ): ProjectRow | undefined | null => {
    const project = projectsDb.getById(id, userId);
    if (!project) {
      return null;
    }

    const { serveSymlinkPath, systemdServiceName, appUrl } = config;
    db.prepare(
      `UPDATE projects
       SET serve_symlink_path = ?, systemd_service_name = ?, app_url = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(serveSymlinkPath || null, systemdServiceName || null, appUrl || null, id);
    return projectsDb.getById(id, userId);
  },
};

// ---------------------------------------------------------------------------
// tasksDb
// ---------------------------------------------------------------------------

export interface CreatedTask {
  id: number;
  projectId: number;
  user_id: number | null;
  title: string | null;
  status: 'pending';
  yolo_mode: 0 | 1;
}

// Result of getAll (joins project name + repo path).
export type TaskWithProjectSummary = TaskRow & {
  project_name: string;
  repo_folder_path: string;
};

// Result of getWithProject (joins project owner + name + paths).
export type TaskWithProject = TaskRow & {
  project_user_id: number;
  project_name: string;
  repo_folder_path: string;
  subproject_path: string | null;
};

export interface TaskUpdates {
  title?: string | null;
  status?: TaskStatus;
  workflow_complete?: 0 | 1 | boolean;
  planification_complete?: 0 | 1 | boolean;
  refinement_complete?: 0 | 1 | boolean;
  completed_at?: string | null;
  yolo_mode?: 0 | 1 | boolean;
}

const tasksDb = {
  create: (
    projectId: number,
    title: string | null = null,
    yoloMode: boolean = false,
    userId: number | null = null
  ): CreatedTask => {
    const stmt = db.prepare(
      'INSERT INTO tasks (project_id, user_id, title, status, yolo_mode) VALUES (?, ?, ?, ?, ?)'
    );
    const yoloFlag: 0 | 1 = yoloMode ? 1 : 0;
    const result = stmt.run(projectId, userId, title, 'pending', yoloFlag);
    return {
      id: lastInsertId(result.lastInsertRowid),
      projectId,
      user_id: userId,
      title,
      status: 'pending',
      yolo_mode: yoloFlag,
    };
  },

  getAll: (userId: number, status: TaskStatus | null = null): TaskWithProjectSummary[] => {
    let query = `
      SELECT t.*, p.name as project_name, p.repo_folder_path
      FROM tasks t
      JOIN projects p ON t.project_id = p.id
      JOIN project_members pm ON p.id = pm.project_id
      WHERE pm.user_id = ?
    `;
    const params: unknown[] = [userId];

    if (status) {
      query += ' AND t.status = ?';
      params.push(status);
    }

    query += ' ORDER BY t.updated_at DESC LIMIT 50';

    return db.prepare(query).all(...params) as TaskWithProjectSummary[];
  },

  getByProject: (projectId: number): TaskRow[] => {
    return db
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as TaskRow[];
  },

  getById: (id: number): TaskRow | undefined => {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  },

  getWithProject: (taskId: number): TaskWithProject | undefined => {
    return db
      .prepare(
        `SELECT t.*,
                p.user_id AS project_user_id,
                p.name AS project_name,
                p.repo_folder_path,
                p.subproject_path
         FROM tasks t
         JOIN projects p ON t.project_id = p.id
         WHERE t.id = ?`
      )
      .get(taskId) as TaskWithProject | undefined;
  },

  update: (id: number, updates: TaskUpdates): TaskRow | null | undefined => {
    const allowedFields: ReadonlyArray<keyof TaskUpdates> = [
      'title',
      'status',
      'workflow_complete',
      'planification_complete',
      'refinement_complete',
      'completed_at',
      'yolo_mode',
    ];
    const setClause: string[] = [];
    const values: unknown[] = [];

    const currentTask = tasksDb.getById(id);

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClause.push(`${field} = ?`);
        values.push(updates[field]);
      }
    }

    if (updates.status !== undefined && currentTask) {
      if (updates.status === 'completed' && currentTask.status !== 'completed') {
        if (updates.completed_at === undefined) {
          setClause.push('completed_at = CURRENT_TIMESTAMP');
        }
      } else if (updates.status !== 'completed' && currentTask.status === 'completed') {
        setClause.push('completed_at = NULL');
      }
    }

    if (setClause.length === 0) {
      return tasksDb.getById(id);
    }

    setClause.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`UPDATE tasks SET ${setClause.join(', ')} WHERE id = ?`);
    const result = stmt.run(...values);

    if (result.changes === 0) {
      return null;
    }

    return tasksDb.getById(id);
  },

  updateStatus: (id: number, status: TaskStatus): TaskRow | null | undefined => {
    const validStatuses: TaskStatus[] = ['pending', 'in_progress', 'in_review', 'completed'];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
    }
    return tasksDb.update(id, { status });
  },

  delete: (id: number): boolean => {
    const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return result.changes > 0;
  },

  getOldCompletedTasks: (projectId: number, keepCount: number = 20): number[] => {
    const rows = db
      .prepare(
        `SELECT id FROM tasks
         WHERE project_id = ? AND status = 'completed'
         ORDER BY completed_at DESC
         LIMIT -1 OFFSET ?`
      )
      .all(projectId, keepCount) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  },

  blockWorkflow: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET workflow_blocked = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },

  unblockWorkflow: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET workflow_blocked = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },

  incrementRunCount: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET workflow_run_count = workflow_run_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },

  resetRunCount: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET workflow_run_count = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },

  markPrAgentComplete: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET pr_agent_complete = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },

  resetPrAgentComplete: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET pr_agent_complete = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },

  markRefinementComplete: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET refinement_complete = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },

  resetRefinementComplete: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET refinement_complete = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },
};

// ---------------------------------------------------------------------------
// conversationsDb
// ---------------------------------------------------------------------------

export interface CreatedConversation {
  id: number;
  task_id: number;
  claude_conversation_id: string | null;
  provider: Provider;
  provider_session_id: string | null;
  model: string;
  effort: string | null;
}

const conversationsDb = {
  // Every conversation is stamped with the exact (provider, model, effort) it
  // runs. `model` is required so resume is deterministic; `effort` is null when
  // the provider has none (OpenCode) or the caller didn't pick one (manual).
  create: (
    taskId: number,
    provider: Provider,
    model: string,
    effort: string | null,
  ): CreatedConversation => {
    const stmt = db.prepare(
      'INSERT INTO conversations (task_id, provider, model, effort) VALUES (?, ?, ?, ?)',
    );
    const result = stmt.run(taskId, provider, model, effort);
    return {
      id: lastInsertId(result.lastInsertRowid),
      task_id: taskId,
      claude_conversation_id: null,
      provider,
      provider_session_id: null,
      model,
      effort,
    };
  },

  getByTask: (taskId: number): ConversationRow[] => {
    return db
      .prepare('SELECT * FROM conversations WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId) as ConversationRow[];
  },

  getById: (id: number): ConversationRow | undefined => {
    return db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(id) as ConversationRow | undefined;
  },

  findByClaudeSessionId: (sessionId: string): ConversationRow | undefined => {
    return db
      .prepare('SELECT * FROM conversations WHERE claude_conversation_id = ? LIMIT 1')
      .get(sessionId) as ConversationRow | undefined;
  },

  updateClaudeId: (id: number, claudeConversationId: string | null): boolean => {
    const result = db
      .prepare('UPDATE conversations SET claude_conversation_id = ? WHERE id = ?')
      .run(claudeConversationId, id);
    return result.changes > 0;
  },

  // Provider-agnostic session id (Claude session id / Codex thread id).
  // Anthropic rows duplicate it from claude_conversation_id; Codex rows
  // are the only ones that depend on this column at runtime.
  updateProviderSessionId: (id: number, providerSessionId: string | null): boolean => {
    const result = db
      .prepare('UPDATE conversations SET provider_session_id = ? WHERE id = ?')
      .run(providerSessionId, id);
    return result.changes > 0;
  },

  // Re-stamp the (model, effort) a conversation runs on. Used on resume when
  // the resuming user's per-user agent settings override the original model
  // within the same provider, so the row stays authoritative for later turns.
  updateModelEffort: (id: number, model: string | null, effort: string | null): boolean => {
    const result = db
      .prepare('UPDATE conversations SET model = ?, effort = ? WHERE id = ?')
      .run(model, effort, id);
    return result.changes > 0;
  },

  updateSessionPath: (id: number, sessionPath: string | null): boolean => {
    const result = db
      .prepare('UPDATE conversations SET session_path = ? WHERE id = ?')
      .run(sessionPath, id);
    return result.changes > 0;
  },

  updateName: (id: number, name: string | null): boolean => {
    const result = db
      .prepare('UPDATE conversations SET name = ? WHERE id = ?')
      .run(name, id);
    return result.changes > 0;
  },

  updateContextUsage: (id: number, snapshot: unknown): boolean => {
    const json = snapshot == null ? null : JSON.stringify(snapshot);
    const result = db
      .prepare('UPDATE conversations SET context_usage_json = ? WHERE id = ?')
      .run(json, id);
    return result.changes > 0;
  },

  getContextUsage: (id: number): unknown => {
    const row = db
      .prepare('SELECT context_usage_json FROM conversations WHERE id = ?')
      .get(id) as Pick<ConversationRow, 'context_usage_json'> | undefined;
    if (!row || !row.context_usage_json) return null;
    try {
      return JSON.parse(row.context_usage_json);
    } catch {
      return null;
    }
  },

  delete: (id: number): boolean => {
    const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return result.changes > 0;
  },
};

// ---------------------------------------------------------------------------
// agentRunsDb
// ---------------------------------------------------------------------------

const agentRunsDb = {
  create: (
    taskId: number,
    agentType: AgentType,
    conversationId: number | null = null,
    provider: Provider = 'anthropic',
  ): AgentRunRow => {
    const stmt = db.prepare(
      `INSERT INTO task_agent_runs (task_id, agent_type, status, conversation_id, provider)
       VALUES (?, ?, 'running', ?, ?)`
    );
    const result = stmt.run(taskId, agentType, conversationId, provider);
    return {
      id: lastInsertId(result.lastInsertRowid),
      task_id: taskId,
      agent_type: agentType,
      status: 'running',
      conversation_id: conversationId,
      provider,
      created_at: new Date().toISOString(),
      completed_at: null,
    };
  },

  getByTask: (taskId: number): AgentRunRow[] => {
    return db
      .prepare(
        `SELECT * FROM task_agent_runs
         WHERE task_id = ?
         ORDER BY created_at DESC`
      )
      .all(taskId) as AgentRunRow[];
  },

  getById: (id: number): AgentRunRow | undefined => {
    return db
      .prepare('SELECT * FROM task_agent_runs WHERE id = ?')
      .get(id) as AgentRunRow | undefined;
  },

  getByTaskAndType: (taskId: number, agentType: AgentType): AgentRunRow | undefined => {
    return db
      .prepare(
        `SELECT * FROM task_agent_runs
         WHERE task_id = ? AND agent_type = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(taskId, agentType) as AgentRunRow | undefined;
  },

  getByStatus: (status: AgentRunStatus): AgentRunRow[] => {
    return db
      .prepare(
        `SELECT * FROM task_agent_runs
         WHERE status = ?
         ORDER BY created_at DESC`
      )
      .all(status) as AgentRunRow[];
  },

  updateStatus: (id: number, status: AgentRunStatus): AgentRunRow | undefined => {
    const validStatuses: AgentRunStatus[] = [
      'pending',
      'running',
      'completed',
      'failed',
      'blocked',
    ];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
    }

    const stmt =
      status === 'completed' || status === 'blocked'
        ? db.prepare(
            `UPDATE task_agent_runs
             SET status = ?, completed_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
        : db.prepare(
            `UPDATE task_agent_runs
             SET status = ?, completed_at = NULL
             WHERE id = ?`
          );
    stmt.run(status, id);
    return agentRunsDb.getById(id);
  },

  linkConversation: (id: number, conversationId: number | null): AgentRunRow | undefined => {
    db.prepare(
      `UPDATE task_agent_runs
       SET conversation_id = ?
       WHERE id = ?`
    ).run(conversationId, id);
    return agentRunsDb.getById(id);
  },

  // Look up the agent run that owns a given conversation. Used to keep
  // follow-up messages on the same model+effort the agent was started with.
  getByConversationId: (conversationId: number): AgentRunRow | undefined => {
    return db
      .prepare(
        `SELECT * FROM task_agent_runs
         WHERE conversation_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(conversationId) as AgentRunRow | undefined;
  },

  delete: (id: number): boolean => {
    const result = db.prepare('DELETE FROM task_agent_runs WHERE id = ?').run(id);
    return result.changes > 0;
  },
};

// ---------------------------------------------------------------------------
// appSettingsDb
// ---------------------------------------------------------------------------

// Per-agent provider/model/effort moved to per-user storage
// (`user_agent_model_settings`); it is no longer a global app-setting key.
// DEFAULT_AGENT_MODEL_SETTINGS is still used by the one-shot backfill above.
const APP_SETTINGS_DEFAULTS: Record<string, string> = {
  internal_tool_name: 'Bottega',
  github_pr_trigger: 'bottega',
};

const appSettingsDb = {
  getDefault: (key: string): string | null => APP_SETTINGS_DEFAULTS[key] ?? null,

  getValue: (key: string): string | null => {
    const row = db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(key) as Pick<AppSettingRow, 'value'> | undefined;
    if (row) return row.value;
    return APP_SETTINGS_DEFAULTS[key] ?? null;
  },

  getAll: (): Record<string, string> => {
    const rows = db
      .prepare('SELECT key, value FROM app_settings')
      .all() as Pick<AppSettingRow, 'key' | 'value'>[];
    const stored: Record<string, string> = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return { ...APP_SETTINGS_DEFAULTS, ...stored };
  },

  setValue: (key: string, value: string): string => {
    if (typeof value !== 'string') {
      throw new Error('app_settings value must be a string');
    }
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = CURRENT_TIMESTAMP`
    ).run(key, value);
    return value;
  },
};

// ---------------------------------------------------------------------------
// userAgentModelSettingsDb — per-user agent model settings (JSON blob per user)
// ---------------------------------------------------------------------------

const userAgentModelSettingsDb = {
  getRaw: (userId: number): string | null => {
    const row = db
      .prepare('SELECT settings_json FROM user_agent_model_settings WHERE user_id = ?')
      .get(userId) as Pick<UserAgentModelSettingsRow, 'settings_json'> | undefined;
    return row?.settings_json ?? null;
  },

  set: (userId: number, settingsJson: string): string => {
    if (typeof settingsJson !== 'string') {
      throw new Error('user_agent_model_settings value must be a string');
    }
    db.prepare(
      `INSERT INTO user_agent_model_settings (user_id, settings_json, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         settings_json = excluded.settings_json,
         updated_at = CURRENT_TIMESTAMP`
    ).run(userId, settingsJson);
    return settingsJson;
  },
};

export {
  db,
  initializeDatabase,
  userDb,
  projectsDb,
  projectMembersDb,
  tasksDb,
  conversationsDb,
  agentRunsDb,
  appSettingsDb,
  userAgentModelSettingsDb,
};

// Re-export the row types so `.js` consumers can JSDoc-import from this module
// after conversion (avoids scattering imports of `shared/types/db.js`).
export type {
  UserRow,
  ProjectRow,
  ProjectMemberRow,
  TaskRow,
  TaskStatus,
  ConversationRow,
  AgentRunRow,
  AgentType,
  AgentRunStatus,
  AppSettingRow,
  UserAgentModelSettingsRow,
};
