// The `projects.sensitive_areas` migration against a projects table from
// before the column existed, then the round-trip the non-technical guardrail
// depends on: the column is added nullable, the create/update helpers persist
// and clear it, and the task-with-project join carries it to startAgentRun.
// Same recipe as baseBranchBackfill.test.ts: seed a legacy shape on a temp
// file, point DATABASE_PATH at it, then let the real module migrate it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

const LEGACY_PROJECTS = `
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  repo_folder_path TEXT UNIQUE NOT NULL,
  subproject_path TEXT DEFAULT NULL,
  active_worktree_task_id INTEGER DEFAULT NULL,
  serve_symlink_path TEXT DEFAULT NULL,
  systemd_service_name TEXT DEFAULT NULL,
  active_worktree_epic_id INTEGER DEFAULT NULL,
  app_url TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

let tmpDir: string;
let dbPath: string;

describe('projects.sensitive_areas migration and round-trip', () => {
  let dbModule: typeof import('./db.js');

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-sensitive-areas-migration-'));
    dbPath = path.join(tmpDir, 'bottega.db');
    process.env.DATABASE_PATH = dbPath;

    const seed = new Database(dbPath);
    seed.exec(LEGACY_PROJECTS);
    seed.close();

    dbModule = await import('./db.js');
    await dbModule.initializeDatabase();
  });

  afterAll(() => {
    dbModule?.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
  });

  it('adds the column, nullable, to a projects table from before it existed', () => {
    const columns = dbModule.db
      .prepare('PRAGMA table_info(projects)')
      .all() as Array<{ name: string; notnull: number }>;
    const column = columns.find((c) => c.name === 'sensitive_areas');
    expect(column).toBeDefined();
    expect(column!.notnull).toBe(0);
  });

  it('persists the list on create, clears it on update, and joins it onto the task', () => {
    const user = dbModule.userDb.createUser('alice', 'x');
    const created = dbModule.projectsDb.create(
      user.id,
      'Shop',
      '/tmp/shop',
      null,
      '- the orders tables and every query that reads them',
    );
    expect(created.sensitiveAreas).toBe('- the orders tables and every query that reads them');
    expect(dbModule.projectsDb.getById(created.id, user.id)?.sensitive_areas).toBe(
      '- the orders tables and every query that reads them',
    );

    // A project created without a list reads back as null (guardrail off).
    const plain = dbModule.projectsDb.create(user.id, 'Blog', '/tmp/blog');
    expect(dbModule.projectsDb.getById(plain.id, user.id)?.sensitive_areas).toBeNull();

    const taskId = Number(
      dbModule.db
        .prepare('INSERT INTO tasks (project_id, user_id, title) VALUES (?, ?, ?)')
        .run(created.id, user.id, 'Copy button').lastInsertRowid,
    );
    expect(dbModule.tasksDb.getWithProject(taskId)?.sensitive_areas).toBe(
      '- the orders tables and every query that reads them',
    );

    dbModule.projectsDb.update(created.id, user.id, { sensitive_areas: '- checkout' });
    expect(dbModule.tasksDb.getWithProject(taskId)?.sensitive_areas).toBe('- checkout');

    dbModule.projectsDb.update(created.id, user.id, { sensitive_areas: null });
    expect(dbModule.projectsDb.getById(created.id, user.id)?.sensitive_areas).toBeNull();
    expect(dbModule.tasksDb.getWithProject(taskId)?.sensitive_areas).toBeNull();
  });
});
