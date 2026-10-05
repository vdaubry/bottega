// The Phase 2 migration path, exercised against a genuinely OLD-shape database.
//
// This is the safety net for the riskiest step in the epic work: `conversations`
// is a PARENT table (`task_agent_runs.conversation_id` references it with
// ON DELETE SET NULL), so rebuilding it with foreign keys enabled would fire an
// implicit delete and silently null out every run -> conversation link. The
// tests below seed the pre-epic schema, run the real migration, and assert that
// nothing was lost.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The pre-Phase-2 schema, in the shape a migrated production database actually
// had it: `name`/`provider`/`model`/`effort`/`atlas_enabled` were ALTER-appended
// to `conversations`, and `provider` to `task_agent_runs`, so their ordinal
// positions differ from a fresh install's — which is exactly why the rebuild
// copies an explicit column list.
const OLD_SCHEMA = `
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
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE project_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(project_id, user_id)
);
CREATE TABLE tasks (
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
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  claude_conversation_id TEXT,
  session_path TEXT DEFAULT NULL,
  context_usage_json TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
ALTER TABLE conversations ADD COLUMN name TEXT DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic';
ALTER TABLE conversations ADD COLUMN provider_session_id TEXT DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN model TEXT DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN effort TEXT DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN atlas_enabled INTEGER NOT NULL DEFAULT 0;
CREATE TABLE task_artifacts (
  task_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  html TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, kind),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE TABLE task_agent_runs (
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
ALTER TABLE task_agent_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic';
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE user_agent_model_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE epic_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  notes TEXT DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'running'
      CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
  provider TEXT NOT NULL DEFAULT 'anthropic',
  model TEXT NOT NULL,
  effort TEXT DEFAULT NULL,
  result_text TEXT DEFAULT NULL,
  before_mermaid TEXT DEFAULT NULL,
  after_mermaid TEXT DEFAULT NULL,
  error TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME DEFAULT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
`;

const LEGACY_SETTINGS = {
  planification: { provider: 'anthropic', model: 'opus', effort: 'high' },
  implementation: { provider: 'anthropic', model: 'opus', effort: 'high' },
  refinement: { provider: 'anthropic', model: 'opus', effort: 'high' },
  review: { provider: 'anthropic', model: 'opus', effort: 'high' },
  pr: { provider: 'anthropic', model: 'opus', effort: 'high' },
  yolo: { provider: 'anthropic', model: 'opus', effort: 'high' },
  schema: { provider: 'anthropic', model: 'sonnet', effort: 'high' },
  // The v0 single epic key, with a model the user chose themselves.
  epic: { provider: 'anthropic', model: 'sonnet', effort: 'xhigh' },
};

let tmpDir: string;
let dbPath: string;
let archiveRoot: string;

function seedOldDatabase(): void {
  const db = new Database(dbPath);
  db.exec(OLD_SCHEMA);
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'alice', 'x')").run();
  db.prepare(
    "INSERT INTO projects (id, user_id, name, repo_folder_path) VALUES (7, 1, 'Proj', '/tmp/repo')",
  ).run();
  db.prepare("INSERT INTO tasks (id, project_id, user_id, title) VALUES (3, 7, 1, 'Ticket')").run();
  db.prepare(
    `INSERT INTO conversations (id, task_id, claude_conversation_id, name, provider, model, effort, atlas_enabled)
     VALUES (11, 3, 'sess-11', 'Named chat', 'anthropic', 'opus', 'high', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO task_agent_runs (id, task_id, agent_type, status, conversation_id, provider)
     VALUES (21, 3, 'planification', 'completed', 11, 'anthropic')`,
  ).run();
  db.prepare(
    `INSERT INTO user_agent_model_settings (user_id, settings_json) VALUES (1, ?)`,
  ).run(JSON.stringify(LEGACY_SETTINGS));

  const specJson = JSON.stringify([{ filename: 'spec.md', content: '# Functional spec' }]);
  const insertRun = db.prepare(
    `INSERT INTO epic_runs (id, project_id, user_id, name, spec_json, status, model, before_mermaid, after_mermaid, created_at)
     VALUES (?, 7, 1, ?, ?, ?, 'opus', ?, ?, ?)`,
  );
  // Two runs of the SAME epic: the first produced diagrams, the re-run failed.
  insertRun.run(1, 'Company Quests', specJson, 'completed', 'flowchart LR\n  A', 'flowchart LR\n  B', '2026-08-01 10:00:00');
  insertRun.run(2, 'Company Quests', specJson, 'failed', null, null, '2026-08-02 10:00:00');
  db.close();
}

describe('Phase 2 migration against an old-shape database', () => {
  let db: Database.Database;
  let dbModule: typeof import('./db.js');

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-epic-migration-'));
    dbPath = path.join(tmpDir, 'bottega.db');
    archiveRoot = path.join(tmpDir, 'archive');
    process.env.DATABASE_PATH = dbPath;
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;

    seedOldDatabase();

    dbModule = await import('./db.js');
    await dbModule.initializeDatabase();
    db = dbModule.db;
  });

  afterAll(() => {
    db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
  });

  it('keeps every conversation row and its id, with ownership in the link table', () => {
    // The chain now runs all the way to the v2 step-5 split: the base row
    // survives with its id, `owner_kind` says whose it is, and the owner id
    // lives in `task_conversations`.
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = 11').get() as Record<
      string,
      unknown
    >;
    expect(conversation).toBeDefined();
    expect(conversation.owner_kind).toBe('task');
    // ALTER-appended columns survive the explicit-column-list copies.
    expect(conversation.name).toBe('Named chat');
    expect(conversation.model).toBe('opus');
    expect(conversation.atlas_enabled).toBe(1);
    const link = db
      .prepare('SELECT task_id FROM task_conversations WHERE conversation_id = 11')
      .get() as { task_id: number };
    expect(link.task_id).toBe(3);
  });

  it('does NOT null out the run -> conversation link (the whole point of the FK-off rebuilds)', () => {
    const run = db.prepare('SELECT * FROM task_agent_runs WHERE id = 21').get() as Record<
      string,
      unknown
    >;
    expect(run.conversation_id).toBe(11);
    expect(run.task_id).toBe(3);
    expect(run.provider).toBe('anthropic');
    expect(run.driver).toBe('human');
  });

  it('ends in the split shape: owner-less conversations, task-only task_agent_runs', () => {
    expect(() => db.prepare('INSERT INTO conversations DEFAULT VALUES').run()).toThrow();
    expect(() =>
      db.prepare("INSERT INTO task_agent_runs (agent_type) VALUES ('planification')").run(),
    ).toThrow();
    const runColumns = (
      db.prepare('PRAGMA table_info(task_agent_runs)').all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(runColumns).not.toContain('epic_id');
    expect(runColumns).not.toContain('ticket_task_id');
    const taskColumns = (
      db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(taskColumns).not.toContain('worktree_lease_conversation_id');
  });

  it('drops the obsolete lease from a current split database without losing tasks', () => {
    const current = new Database(':memory:');
    current.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE conversations (id INTEGER PRIMARY KEY);
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        title TEXT,
        worktree_lease_conversation_id INTEGER
          REFERENCES conversations(id) ON DELETE SET NULL
      );
      INSERT INTO conversations (id) VALUES (91);
      INSERT INTO tasks (id, title, worktree_lease_conversation_id)
        VALUES (42, 'Keep me', 91);
    `);

    expect(dbModule.dropObsoleteWorktreeLease(current)).toBe(true);
    expect(dbModule.dropObsoleteWorktreeLease(current)).toBe(false);
    expect(current.prepare('SELECT id, title FROM tasks').get()).toEqual({
      id: 42,
      title: 'Keep me',
    });
    expect(
      (current.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    ).not.toContain('worktree_lease_conversation_id');
    expect(current.pragma('foreign_key_check')).toEqual([]);
    current.close();
  });

  it('accepts the epic agent types — in the epic_agent_runs table', () => {
    const epicId = (db.prepare('SELECT id FROM epics LIMIT 1').get() as { id: number }).id;
    for (const agentType of [
      'epic-orchestrator',
      'epic-pr-review',
      'epic-spec-review',
    ]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO epic_agent_runs
               (epic_id, agent_type, status, ticket_task_id)
             VALUES (?, ?, 'running', NULL)`,
          )
          .run(epicId, agentType),
      ).not.toThrow();
    }
    expect(() =>
      db.prepare("INSERT INTO epic_agent_runs (epic_id, agent_type) VALUES (?, 'epic-nope')").run(epicId),
    ).toThrow();
  });

  it('adds the review_complete flag, unset for an epic whose implementation has not begun', () => {
    const columns = (db.prepare('PRAGMA table_info(epics)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toContain('review_complete');
    const epic = db.prepare('SELECT review_complete FROM epics LIMIT 1').get() as {
      review_complete: number;
    };
    expect(epic.review_complete).toBe(0);
  });

  it('adds the qa_complete flag, unset for EVERY existing epic — no backfill, unlike review_complete', () => {
    const columns = (db.prepare('PRAGMA table_info(epics)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toContain('qa_complete');
    // A QA that never ran is honestly incomplete: even an epic already under
    // way keeps 0 — nothing downstream is blocked but the QA-execution button.
    const rows = db.prepare('SELECT qa_complete FROM epics').all() as Array<{
      qa_complete: number;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.qa_complete === 0)).toBe(true);
  });

  it('accepts the two QA agent types after the CHECK widening', () => {
    const epicId = (db.prepare('SELECT id FROM epics LIMIT 1').get() as { id: number }).id;
    for (const agentType of ['epic-qa-scenarios', 'epic-qa-execution']) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO epic_agent_runs (epic_id, agent_type, status) VALUES (?, ?, 'pending')`,
          )
          .run(epicId, agentType),
      ).not.toThrow();
    }
  });

  it('seeds the two QA model keys for every existing user', () => {
    const row = db
      .prepare('SELECT settings_json FROM user_agent_model_settings WHERE user_id = 1')
      .get() as { settings_json: string };
    const settings = JSON.parse(row.settings_json) as Record<string, unknown>;

    expect(settings['epic-qa-scenarios']).toEqual({
      provider: 'anthropic',
      model: 'opus',
      effort: 'high',
    });
    expect(settings['epic-qa-execution']).toEqual({
      provider: 'anthropic',
      model: 'opus',
      effort: 'high',
    });
  });

  it('keeps the orchestrator ticket column — on the epic runs table', () => {
    const columns = db.prepare('PRAGMA table_info(epic_agent_runs)').all() as Array<{
      name: string;
    }>;

    expect(columns.map((column) => column.name)).toContain('ticket_task_id');
  });

  it('converts the legacy epic_runs into one epic per (project, name)', () => {
    const epics = db.prepare('SELECT * FROM epics').all() as Array<Record<string, unknown>>;
    expect(epics).toHaveLength(1);
    expect(epics[0]!.name).toBe('Company Quests');
    expect(epics[0]!.slug).toBe('company-quests');
    // The failed re-run must not erase the fact that the first run completed
    // the stage. The v0 diagrams themselves are not carried over: the
    // architecture stage writes a document now, and nothing creates the old
    // `epic_artifacts` table any more.
    expect(epics[0]!.architecture_complete).toBe(1);
    const artifactsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epic_artifacts'")
      .get();
    expect(artifactsTable).toBeUndefined();
  });

  it('archives the uploaded spec files on disk', () => {
    const epicId = (db.prepare('SELECT id FROM epics LIMIT 1').get() as { id: number }).id;
    const specPath = path.join(archiveRoot, 'projects', '7', 'epics', `epic-${epicId}`, 'spec', 'spec.md');
    expect(fs.readFileSync(specPath, 'utf8')).toBe('# Functional spec');
  });

  it('leaves the legacy epic_runs table in place (no data destruction)', () => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM epic_runs').get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("renames the v0 'epic' model key into the four stage keys, carrying the user's model", () => {
    const row = db
      .prepare('SELECT settings_json FROM user_agent_model_settings WHERE user_id = 1')
      .get() as { settings_json: string };
    const settings = JSON.parse(row.settings_json) as Record<string, unknown>;

    expect(settings['epic-architecture']).toEqual({
      provider: 'anthropic',
      model: 'sonnet',
      effort: 'xhigh',
    });
    expect(settings['epic-specification']).toEqual({
      provider: 'anthropic',
      model: 'opus',
      effort: 'high',
    });
    expect(settings['epic-stories']).toBeDefined();
    expect(settings['epic-orchestrator']).toBeDefined();
    expect(settings['epic-spec-review']).toEqual({
      provider: 'anthropic',
      model: 'opus',
      effort: 'high',
    });
    expect(settings['epic-pr-review']).toEqual({
      provider: 'anthropic',
      model: 'opus',
      effort: 'high',
    });
    expect(settings.epic).toBeUndefined();
  });

  it('is idempotent: a second migration pass changes nothing', async () => {
    const dbModule = await import('./db.js');
    await dbModule.initializeDatabase();

    expect((db.prepare('SELECT COUNT(*) AS n FROM epics').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT * FROM task_agent_runs WHERE id = 21').get() as { conversation_id: number }).conversation_id).toBe(11);
  });
});
