#!/usr/bin/env node

/**
 * One-shot data migration: drop the legacy `task_diagrams` table from an
 * existing SQLite database.
 *
 * The Explore view no longer renders Mermaid diagrams — it generates
 * self-contained HTML artifacts stored in the new `task_artifacts` table
 * (created by init.sql). The old `task_diagrams` rows are regenerable cache
 * data (the agent re-generates on demand), so there is nothing to migrate —
 * we just drop the dead table.
 *
 * Run after deploying the code that removes the Mermaid pipeline:
 *
 *   tsx scripts/data-migrations/drop-task-diagrams.ts          # full run
 *   tsx scripts/data-migrations/drop-task-diagrams.ts --dry-run # report only
 *
 * Idempotent: re-running on an already-cleaned DB is a no-op.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '..', '..', 'server', 'database', 'bottega.db');

const isDryRun = process.argv.includes('--dry-run');

function tableExists(db: DatabaseType, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function main(): void {
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = OFF');

  const exists = tableExists(db, 'task_diagrams');
  const rows = exists
    ? (db.prepare('SELECT COUNT(*) AS n FROM task_diagrams').get() as { n: number }).n
    : 0;

  console.log(`[drop-task-diagrams] DB: ${DB_PATH}`);
  console.log(`[drop-task-diagrams] task_diagrams table present: ${exists}`);
  console.log(`[drop-task-diagrams] task_diagrams rows: ${rows}`);

  if (isDryRun) {
    console.log('[drop-task-diagrams] --dry-run: no changes made');
    db.close();
    return;
  }

  db.exec('DROP TABLE IF EXISTS task_diagrams');
  db.pragma('foreign_keys = ON');

  console.log(`[drop-task-diagrams] task_diagrams table dropped: ${!tableExists(db, 'task_diagrams')}`);
  db.close();
  console.log('[drop-task-diagrams] done');
}

main();
