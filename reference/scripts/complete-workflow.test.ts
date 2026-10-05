/**
 * `complete-workflow.ts` is how an agent ends its implementation loop: the
 * prompts hand it `tsx scripts/complete-workflow.ts <taskId>`, and the loop
 * keeps re-running until the row that call flips says to stop. The exit code
 * and the `workflow_complete` column are therefore the entire contract — so
 * this suite runs the real CLI and reads the database it leaves behind.
 *
 * It replaces a version that mocked `../server/database/db.js` and then
 * asserted on the mock ("expect(parseInt('007', 10)).toBe(7)"): it never
 * imported the script, so it would have stayed green through any regression
 * in it. The script can't be imported — top-level await, `process.argv`,
 * `process.exit` — so spawn it, the way `agent-invoked-scripts.test.ts` does.
 * That sibling suite guards a different invariant (every agent-invoked script
 * resolves its imports from a foreign cwd); behaviour belongs here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(appRoot, 'node_modules', '.bin', 'tsx');
const script = path.join(appRoot, 'scripts', 'complete-workflow.ts');
const INIT_SQL_PATH = path.join(appRoot, 'server', 'database', 'init.sql');

// No row carries this id in a database seeded by this file.
const MISSING_TASK_ID = '2147483647';

// A spawn costs ~0.6s; two of them plus a loaded box shouldn't trip the
// 5s default.
const TEST_TIMEOUT_MS = 60_000;

let sandbox: string;
let databasePath: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-complete-workflow-'));
  databasePath = path.join(sandbox, 'bottega.db');
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

interface ScriptRun {
  status: number | null;
  output: string;
}

/**
 * The real command an agent runs, against the sandbox database. Never the
 * live one: `DATABASE_PATH` has to reach the process as an environment
 * variable, since `connection.ts` reads it at import time — a value in a
 * `.env` file arrives too late.
 */
function runScript(...args: string[]): ScriptRun {
  const result = spawnSync(tsx, [script, ...args], {
    cwd: appRoot,
    encoding: 'utf8',
    timeout: TEST_TIMEOUT_MS,
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
      BOTTEGA_ARCHIVE_ROOT: path.join(sandbox, 'archive'),
    },
  });
  expect(result.error, `spawning the script failed: ${String(result.error)}`).toBeUndefined();
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * One pending task in the sandbox database, with the user and project its
 * foreign keys need. Creating the schema from `init.sql` is what the script's
 * own `initializeDatabase()` does on the way in; it runs the migrations over
 * this file a moment later either way.
 */
function seedTask(title = 'Implement the thing'): number {
  const db = new Database(databasePath);
  try {
    db.exec(fs.readFileSync(INIT_SQL_PATH, 'utf8'));
    const user = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run('seed-user', 'not-a-real-hash');
    const project = db
      .prepare('INSERT INTO projects (user_id, name, repo_folder_path) VALUES (?, ?, ?)')
      .run(user.lastInsertRowid, 'Seed project', path.join(sandbox, 'repo'));
    const task = db
      .prepare('INSERT INTO tasks (project_id, user_id, title) VALUES (?, ?, ?)')
      .run(project.lastInsertRowid, user.lastInsertRowid, title);
    return Number(task.lastInsertRowid);
  } finally {
    db.close();
  }
}

/** `workflow_complete` as it stands on disk, which is what the loop reads. */
function readWorkflowComplete(taskId: number): number | undefined {
  const db = new Database(databasePath, { readonly: true });
  try {
    const row = db.prepare('SELECT workflow_complete FROM tasks WHERE id = ?').get(taskId) as
      | { workflow_complete: number }
      | undefined;
    return row?.workflow_complete;
  } finally {
    db.close();
  }
}

describe('complete-workflow.ts', () => {
  it(
    'marks a task complete and exits 0',
    () => {
      const taskId = seedTask('Implement the thing');
      expect(readWorkflowComplete(taskId)).toBe(0);

      const { status, output } = runScript(String(taskId));

      expect(status, output).toBe(0);
      expect(output).toContain('Workflow marked as complete!');
      expect(output).toContain('Implement the thing');
      expect(readWorkflowComplete(taskId)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is idempotent: a second run reports the task is already complete and exits 0',
    () => {
      const taskId = seedTask();
      expect(runScript(String(taskId)).status).toBe(0);

      const { status, output } = runScript(String(taskId));

      expect(status, output).toBe(0);
      expect(output).toContain(`Task ${taskId} workflow is already marked as complete`);
      expect(output).not.toContain('Workflow marked as complete!');
      expect(readWorkflowComplete(taskId)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exits 1 when no task carries the id',
    () => {
      const { status, output } = runScript(MISSING_TASK_ID);

      expect(status, output).toBe(1);
      expect(output).toContain(`Task with ID ${MISSING_TASK_ID} not found`);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exits 1 on a non-numeric task id, without touching a task',
    () => {
      const taskId = seedTask();

      const { status, output } = runScript('not-a-number');

      expect(status, output).toBe(1);
      expect(output).toContain('Task ID must be a number');
      expect(readWorkflowComplete(taskId)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exits 1 with usage when no task id is given',
    () => {
      const { status, output } = runScript();

      expect(status, output).toBe(1);
      expect(output).toContain('Task ID is required');
      expect(output).toContain('Usage: tsx scripts/complete-workflow.ts <taskId>');
    },
    TEST_TIMEOUT_MS,
  );
});
