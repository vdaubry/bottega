#!/usr/bin/env node

/**
 * One-shot data migration: drop the custom-agents schema from an existing
 * SQLite database.
 *
 * This script removes:
 *   - The `agents` table (and its indexes)
 *   - The `agent_id` and `triggered_by` columns from `conversations`
 *   - The `idx_conversations_agent_id` index
 *
 * It also deletes any orphan rows in `conversations` that have no `task_id`
 * (those were custom-agent conversations with `task_id IS NULL`).
 *
 * Run after deploying the code that removes the custom-agents feature:
 *
 *   tsx scripts/data-migrations/drop-custom-agents.ts          # full run
 *   tsx scripts/data-migrations/drop-custom-agents.ts --dry-run # report only
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

function columnNames(db: DatabaseType, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map(c => c.name);
}

function main(): void {
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = OFF');

  const countOf = (sql: string): number =>
    (db.prepare(sql).get() as { n: number }).n;

  const counts = {
    agentsBefore: tableExists(db, 'agents')
      ? countOf('SELECT COUNT(*) AS n FROM agents')
      : 0,
    conversationsBefore: countOf('SELECT COUNT(*) AS n FROM conversations'),
    orphanConversations: 0
  };

  if (columnNames(db, 'conversations').includes('agent_id')) {
    counts.orphanConversations = countOf(
      'SELECT COUNT(*) AS n FROM conversations WHERE task_id IS NULL'
    );
  }

  console.log(`[drop-custom-agents] DB: ${DB_PATH}`);
  console.log(`[drop-custom-agents] agents rows: ${counts.agentsBefore}`);
  console.log(`[drop-custom-agents] conversations rows: ${counts.conversationsBefore}`);
  console.log(`[drop-custom-agents] orphan (no task_id) conversations: ${counts.orphanConversations}`);

  if (isDryRun) {
    console.log('[drop-custom-agents] --dry-run: no changes made');
    db.close();
    return;
  }

  const conversationsHasAgentId = columnNames(db, 'conversations').includes('agent_id');
  const conversationsHasTriggeredBy = columnNames(db, 'conversations').includes('triggered_by');

  const tx = db.transaction(() => {
    if (conversationsHasAgentId || conversationsHasTriggeredBy) {
      // Rebuild conversations without agent_id / triggered_by, dropping orphans.
      // Use the same column order as the post-cleanup init.sql schema.
      db.exec(`
        CREATE TABLE conversations_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL,
          claude_conversation_id TEXT,
          session_path TEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          name TEXT DEFAULT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
      `);

      const hasName = columnNames(db, 'conversations').includes('name');
      const selectCols = hasName
        ? 'id, task_id, claude_conversation_id, session_path, created_at, name'
        : 'id, task_id, claude_conversation_id, session_path, created_at, NULL';
      db.exec(`
        INSERT INTO conversations_new (id, task_id, claude_conversation_id, session_path, created_at, name)
        SELECT ${selectCols}
        FROM conversations
        WHERE task_id IS NOT NULL;
      `);

      db.exec('DROP TABLE conversations');
      db.exec('ALTER TABLE conversations_new RENAME TO conversations');
      db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_task_id ON conversations(task_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_claude_id ON conversations(claude_conversation_id)');
      db.exec('DROP INDEX IF EXISTS idx_conversations_agent_id');
    }

    db.exec('DROP INDEX IF EXISTS idx_agents_project_id');
    db.exec('DROP INDEX IF EXISTS idx_agents_schedule_enabled');
    db.exec('DROP TABLE IF EXISTS agents');
  });

  tx();
  db.pragma('foreign_keys = ON');

  const after = countOf('SELECT COUNT(*) AS n FROM conversations');
  console.log(`[drop-custom-agents] conversations rows after: ${after} (removed ${counts.conversationsBefore - after})`);
  console.log(`[drop-custom-agents] agents table dropped: ${!tableExists(db, 'agents')}`);

  db.close();
  console.log('[drop-custom-agents] done');
}

main();
