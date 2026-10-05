// The agent_type CHECK widening, exercised against the two table shapes a live
// database can hold: the epic rebuild's (#116 — before `epic-pr-review`) and
// the one the first widening left behind (#125 — before `epic-spec-review`).
// SQLite cannot alter a CHECK, so this is a full rebuild, and the things to
// prove are the same as for the epic rebuild: every row and id survives, the
// run -> conversation and run -> ticket links survive, every newer type is
// accepted, and a second pass is a no-op.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { widenAgentRunTypeCheck } from './db.js';

const BASE_TYPES = [
  'planification',
  'implementation',
  'refinement',
  'review',
  'pr',
  'yolo',
  'epic-architecture',
  'epic-specification',
  'epic-stories',
  'epic-orchestrator',
];

/** The live table, with the CHECK carrying exactly `types`. */
function schemaWithTypes(types: string[]): string {
  const typeList = types.map((t) => `'${t}'`).join(', ');
  return `
PRAGMA foreign_keys = ON;
CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
CREATE TABLE epics (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
CREATE TABLE task_agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  epic_id INTEGER,
  agent_type TEXT NOT NULL CHECK(agent_type IN (${typeList})),
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
CREATE INDEX idx_task_agent_runs_task_id ON task_agent_runs(task_id);
CREATE INDEX idx_task_agent_runs_epic_id ON task_agent_runs(epic_id);
INSERT INTO tasks (id, title) VALUES (42, 'T42');
INSERT INTO epics (id, name) VALUES (7, 'Nimbus');
INSERT INTO conversations (id, name) VALUES (11, 'c11'), (12, 'c12');
INSERT INTO task_agent_runs (id, task_id, epic_id, agent_type, status, conversation_id, provider, ticket_task_id, created_at, completed_at)
  VALUES (21, 42, NULL, 'pr', 'completed', 11, 'openai', NULL, '2026-08-16 10:00:00', '2026-08-16 10:05:00'),
         (22, NULL, 7, 'epic-orchestrator', 'completed', 12, 'anthropic', 42, '2026-08-16 11:00:00', NULL);
`;
}

/** The shape the epic rebuild (#116) produced. */
const EPIC_ERA_SCHEMA = schemaWithTypes(BASE_TYPES);
/** The shape the first widening (#125) produced — the live database before this one. */
const PR_REVIEW_ERA_SCHEMA = schemaWithTypes([...BASE_TYPES, 'epic-pr-review']);

function tableSql(db: Database.Database): string {
  return (
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='task_agent_runs'`)
      .get() as { sql: string }
  ).sql;
}

function openWith(schema: string): Database.Database {
  const db = new Database(':memory:');
  db.exec(schema);
  return db;
}

describe('widenAgentRunTypeCheck', () => {
  describe.each([
    ['the epic-rebuild shape (no epic-pr-review yet)', EPIC_ERA_SCHEMA],
    ['the epic-pr-review shape (no epic-spec-review yet)', PR_REVIEW_ERA_SCHEMA],
  ])('from %s', (_label, schema) => {
    it('rebuilds the table once, keeping every row, id and link', () => {
      const db = openWith(schema);
      expect(() =>
        db
          .prepare("INSERT INTO task_agent_runs (epic_id, agent_type) VALUES (7, 'epic-spec-review')")
          .run(),
      ).toThrow();

      widenAgentRunTypeCheck(db);

      const rows = db.prepare('SELECT * FROM task_agent_runs ORDER BY id').all() as Array<
        Record<string, unknown>
      >;
      expect(rows.map((r) => r.id)).toEqual([21, 22]);
      expect(rows[0]).toMatchObject({
        task_id: 42,
        epic_id: null,
        agent_type: 'pr',
        conversation_id: 11,
        provider: 'openai',
        completed_at: '2026-08-16 10:05:00',
      });
      expect(rows[1]).toMatchObject({
        task_id: null,
        epic_id: 7,
        agent_type: 'epic-orchestrator',
        conversation_id: 12,
        ticket_task_id: 42,
      });
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('accepts every newer type afterwards and still rejects an unknown one', () => {
      const db = openWith(schema);
      widenAgentRunTypeCheck(db);

      expect(() =>
        db
          .prepare(
            "INSERT INTO task_agent_runs (epic_id, agent_type, status, ticket_task_id) VALUES (7, 'epic-pr-review', 'running', 42)",
          )
          .run(),
      ).not.toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO task_agent_runs (epic_id, agent_type, status) VALUES (7, 'epic-spec-review', 'running')",
          )
          .run(),
      ).not.toThrow();
      expect(() =>
        db.prepare("INSERT INTO task_agent_runs (epic_id, agent_type) VALUES (7, 'epic-nope')").run(),
      ).toThrow();
      // The exactly-one-owner rule and the FKs came along.
      expect(() =>
        db.prepare("INSERT INTO task_agent_runs (task_id, epic_id, agent_type) VALUES (42, 7, 'pr')").run(),
      ).toThrow();
    });

    it('keeps the indexes the rest of the code relies on', () => {
      const db = openWith(schema);
      widenAgentRunTypeCheck(db);

      const indexes = (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_agent_runs'`)
          .all() as Array<{ name: string }>
      ).map((i) => i.name);
      expect(indexes).toContain('idx_task_agent_runs_task_id');
      expect(indexes).toContain('idx_task_agent_runs_epic_id');
    });

    it('is a no-op on a table whose CHECK already carries the newest type', () => {
      const db = openWith(schema);
      widenAgentRunTypeCheck(db);
      const after = tableSql(db);
      expect(after).toContain("'epic-pr-review'");
      expect(after).toContain("'epic-spec-review'");

      widenAgentRunTypeCheck(db);

      expect(tableSql(db)).toBe(after);
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM task_agent_runs').get() as { n: number }).n,
      ).toBe(2);
    });
  });
});
