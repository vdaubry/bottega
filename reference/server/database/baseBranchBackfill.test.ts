// The architecture-v2 step 2+3 column migrations, exercised against a
// mid-shape database: post-epic (owner columns, widened CHECK, epics with a
// feature branch and tickets attached) but pre-`driver` / pre-`base_branch`.
// The things to prove: both guarded ALTERs fire once, existing rows read the
// right defaults, and the base_branch backfill copies each ticket's epic
// feature branch while leaving standalone tasks NULL.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

const MID_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE users (
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
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  repo_folder_path TEXT UNIQUE NOT NULL,
  subproject_path TEXT DEFAULT NULL,
  active_worktree_task_id INTEGER DEFAULT NULL,
  serve_symlink_path TEXT DEFAULT NULL,
  systemd_service_name TEXT DEFAULT NULL,
  app_url TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE project_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, user_id)
);
CREATE TABLE epics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled')),
  architecture_complete INTEGER NOT NULL DEFAULT 0,
  specs_complete INTEGER NOT NULL DEFAULT 0,
  stories_complete INTEGER NOT NULL DEFAULT 0,
  review_complete INTEGER NOT NULL DEFAULT 0,
  feature_branch TEXT DEFAULT NULL,
  orchestration_active INTEGER NOT NULL DEFAULT 0,
  orchestration_blocked INTEGER NOT NULL DEFAULT 0,
  orchestration_blocked_reason TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME DEFAULT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  epic_id INTEGER REFERENCES epics(id) ON DELETE SET NULL,
  epic_order INTEGER DEFAULT NULL,
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
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  epic_id INTEGER,
  claude_conversation_id TEXT,
  session_path TEXT DEFAULT NULL,
  context_usage_json TEXT DEFAULT NULL,
  name TEXT DEFAULT NULL,
  provider TEXT NOT NULL DEFAULT 'anthropic',
  provider_session_id TEXT,
  model TEXT DEFAULT NULL,
  effort TEXT DEFAULT NULL,
  atlas_enabled INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK ((task_id IS NULL) + (epic_id IS NULL) = 1),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (epic_id) REFERENCES epics(id) ON DELETE CASCADE
);
CREATE TABLE task_agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  epic_id INTEGER,
  agent_type TEXT NOT NULL CHECK(agent_type IN ('planification', 'implementation', 'refinement', 'review', 'pr', 'yolo', 'epic-architecture', 'epic-specification', 'epic-stories', 'epic-orchestrator', 'epic-pr-review', 'epic-spec-review')),
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
  conversation_id INTEGER,
  provider TEXT NOT NULL DEFAULT 'anthropic',
  ticket_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  CHECK ((task_id IS NULL) + (epic_id IS NULL) = 1),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (epic_id) REFERENCES epics(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);
CREATE TABLE user_agent_model_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO app_settings (key, value) VALUES ('user_agent_settings_backfilled', '1');
INSERT INTO users (id, username, password_hash) VALUES (1, 'alice', 'x');
INSERT INTO projects (id, user_id, name, repo_folder_path) VALUES (7, 1, 'Proj', '/tmp/repo');
INSERT INTO epics (id, project_id, user_id, name, slug, feature_branch)
  VALUES (8, 7, 1, 'Nimbus', 'nimbus', 'epic/8-nimbus'),
         (9, 7, 1, 'Branchless', 'branchless', NULL);
INSERT INTO tasks (id, project_id, user_id, epic_id, epic_order, title)
  VALUES (3, 7, 1, NULL, NULL, 'Standalone'),
         (4, 7, 1, 8, 1, 'Ticket of Nimbus'),
         (5, 7, 1, 9, 1, 'Ticket of a branchless epic');
INSERT INTO task_agent_runs (id, task_id, agent_type, status) VALUES (21, 3, 'planification', 'completed');
`;

let tmpDir: string;
let dbPath: string;

describe('driver + base_branch migrations against a mid-shape database', () => {
  let db: Database.Database;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-basebranch-migration-'));
    dbPath = path.join(tmpDir, 'bottega.db');
    process.env.DATABASE_PATH = dbPath;

    const seed = new Database(dbPath);
    seed.exec(MID_SCHEMA);
    seed.close();

    const dbModule = await import('./db.js');
    await dbModule.initializeDatabase();
    db = dbModule.db;
  });

  afterAll(() => {
    db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
  });

  it("adds driver with DEFAULT 'human' — existing runs read back as human-driven", () => {
    const run = db.prepare('SELECT driver FROM task_agent_runs WHERE id = 21').get() as {
      driver: string;
    };
    expect(run.driver).toBe('human');
  });

  it('rejects a driver outside the CHECK', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO task_agent_runs (task_id, agent_type, status, driver) VALUES (3, 'pr', 'running', 'robot')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("backfills a ticket's base_branch from its epic's feature branch", () => {
    const ticket = db.prepare('SELECT base_branch FROM tasks WHERE id = 4').get() as {
      base_branch: string | null;
    };
    expect(ticket.base_branch).toBe('epic/8-nimbus');
  });

  it('leaves standalone tasks and branchless-epic tickets NULL (default branch, resolved at use)', () => {
    const standalone = db.prepare('SELECT base_branch FROM tasks WHERE id = 3').get() as {
      base_branch: string | null;
    };
    const branchless = db.prepare('SELECT base_branch FROM tasks WHERE id = 5').get() as {
      base_branch: string | null;
    };
    expect(standalone.base_branch).toBeNull();
    expect(branchless.base_branch).toBeNull();
  });

  it('is idempotent: a second migration pass changes nothing', async () => {
    const before = db.prepare('SELECT * FROM tasks ORDER BY id').all();
    const dbModule = await import('./db.js');
    await dbModule.initializeDatabase();
    const after = db.prepare('SELECT * FROM tasks ORDER BY id').all();
    expect(after).toEqual(before);
  });
});
