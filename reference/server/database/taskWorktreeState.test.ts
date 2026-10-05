// `tasks.worktree_state` / `worktree_error`: the migration against a tasks
// table from before the columns existed, then the rules the background
// worktree setup depends on — a task row says whether its worktree is usable,
// and no conversation can be born on one that is not.
// Same recipe as sensitiveAreasMigration.test.ts: seed a legacy shape on a
// temp file, point DATABASE_PATH at it, then let the real module migrate it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

const LEGACY_TASKS = `
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  user_id INTEGER,
  base_branch TEXT DEFAULT NULL,
  title TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'in_review', 'completed')),
  workflow_complete INTEGER DEFAULT 0 NOT NULL,
  workflow_blocked INTEGER DEFAULT 0 NOT NULL,
  workflow_blocked_reason TEXT DEFAULT NULL,
  workflow_run_count INTEGER DEFAULT 0 NOT NULL,
  planification_complete INTEGER DEFAULT 0 NOT NULL,
  pr_agent_complete INTEGER DEFAULT 0 NOT NULL,
  refinement_complete INTEGER DEFAULT 0 NOT NULL,
  yolo_mode INTEGER DEFAULT 0 NOT NULL,
  completed_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO tasks (project_id, title) VALUES (1, 'Existing task');
`;

let tmpDir: string;
let dbPath: string;

describe('tasks.worktree_state', () => {
  let dbModule: typeof import('./db.js');

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-worktree-state-migration-'));
    dbPath = path.join(tmpDir, 'bottega.db');
    process.env.DATABASE_PATH = dbPath;

    const seed = new Database(dbPath);
    seed.exec(LEGACY_TASKS);
    seed.close();

    dbModule = await import('./db.js');
    await dbModule.initializeDatabase();
  });

  afterAll(() => {
    dbModule?.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
  });

  it('adds both columns, and an existing task — whose worktree already exists — is ready', () => {
    const columns = (
      dbModule.db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['worktree_state', 'worktree_error']));

    const existing = dbModule.tasksDb.getById(1)!;
    expect(existing.worktree_state).toBe('ready');
    expect(existing.worktree_error).toBeNull();
  });

  it('rejects a state outside provisioning / ready / failed', () => {
    expect(() =>
      dbModule.db.prepare("UPDATE tasks SET worktree_state = 'deleted' WHERE id = 1").run(),
    ).toThrow();
  });

  it('refuses a conversation on a task that is not ready, and writes nothing', () => {
    const { tasksDb, conversationsDb, TaskWorktreeNotReadyError } = dbModule;
    const task = tasksDb.create(1, 'New', false, null, null, 'provisioning');
    const conversationsBefore = dbModule.db
      .prepare('SELECT COUNT(*) AS n FROM conversations')
      .get() as { n: number };

    expect(() => conversationsDb.create(task.id, 'anthropic', 'opus', 'high')).toThrow(
      TaskWorktreeNotReadyError,
    );

    tasksDb.setWorktreeState(task.id, 'failed', 'hook exited with code 1');
    expect(() => conversationsDb.create(task.id, 'anthropic', 'opus', 'high')).toThrow(
      /setup failed/,
    );

    const conversationsAfter = dbModule.db
      .prepare('SELECT COUNT(*) AS n FROM conversations')
      .get() as { n: number };
    expect(conversationsAfter.n).toBe(conversationsBefore.n);
  });

  it('lets conversations start once the task is ready', () => {
    const { tasksDb, conversationsDb } = dbModule;
    const task = tasksDb.create(1, 'New', false, null, null, 'provisioning');
    tasksDb.setWorktreeState(task.id, 'ready');

    const conversation = conversationsDb.create(task.id, 'anthropic', 'opus', 'high');

    expect(conversationsDb.getByTask(task.id).map((c) => c.id)).toEqual([conversation.id]);
  });

  it('stores the error only while failed', () => {
    const { tasksDb } = dbModule;
    const task = tasksDb.create(1, 'New', false, null, null, 'provisioning');

    expect(tasksDb.setWorktreeState(task.id, 'failed', 'boom')!.worktree_error).toBe('boom');
    const retried = tasksDb.setWorktreeState(task.id, 'provisioning', 'ignored')!;
    expect(retried.worktree_state).toBe('provisioning');
    expect(retried.worktree_error).toBeNull();
  });

  it('fails exactly the setups a restart interrupted', () => {
    const { tasksDb } = dbModule;
    const interrupted = tasksDb.create(1, 'Mid-setup', false, null, null, 'provisioning');
    const ready = tasksDb.create(1, 'Done', false, null, null, 'ready');
    // Earlier tests left provisioning rows too; all of them were interrupted.
    const stillProvisioning = (
      dbModule.db
        .prepare("SELECT id FROM tasks WHERE worktree_state = 'provisioning'")
        .all() as Array<{ id: number }>
    ).map((r) => r.id);

    const failed = tasksDb.failInterruptedWorktreeSetups('restarted');

    expect(failed.sort()).toEqual(stillProvisioning.sort());
    expect(failed).toContain(interrupted.id);
    expect(tasksDb.getById(interrupted.id)).toMatchObject({
      worktree_state: 'failed',
      worktree_error: 'restarted',
    });
    expect(tasksDb.getById(ready.id)!.worktree_state).toBe('ready');
    expect(tasksDb.failInterruptedWorktreeSetups('restarted')).toEqual([]);
  });
});
