// The `epic_agent_runs.agent_type` CHECK widening, against the shape
// `splitOwnerTables` actually left behind (architecture-v2 step 5): six epic
// types, no `epic-delivery`. The epic twin of `widenAgentRunTypeCheck.test.ts`
// — SQLite cannot alter a CHECK in place, so adding an epic agent type means
// rebuilding the table, and this is the net that says every row, id and link
// survives it.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { widenEpicAgentRunTypeCheck } from './db.js';

/** The six types the split wrote — the live database before this change. */
const SPLIT_ERA_TYPES = [
  'epic-architecture',
  'epic-specification',
  'epic-stories',
  'epic-spec-review',
  'epic-orchestrator',
  'epic-pr-review',
];

function schemaWithTypes(types: string[]): string {
  const typeList = types.map((t) => `'${t}'`).join(', ');
  return `
PRAGMA foreign_keys = ON;
CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
CREATE TABLE epics (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
CREATE TABLE epic_agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epic_id INTEGER NOT NULL,
  agent_type TEXT NOT NULL CHECK(agent_type IN (${typeList})),
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
  conversation_id INTEGER,
  provider TEXT NOT NULL DEFAULT 'anthropic',
  ticket_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (epic_id) REFERENCES epics(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);
CREATE INDEX idx_epic_agent_runs_epic_id ON epic_agent_runs(epic_id);
INSERT INTO tasks (id, title) VALUES (42, 'T42');
INSERT INTO epics (id, name) VALUES (7, 'Nimbus');
INSERT INTO conversations (id, name) VALUES (11, 'c11'), (12, 'c12');
INSERT INTO epic_agent_runs (id, epic_id, agent_type, status, conversation_id, provider, ticket_task_id, created_at, completed_at)
  VALUES (21, 7, 'epic-architecture', 'completed', 11, 'openai', NULL, '2026-08-16 10:00:00', '2026-08-16 10:05:00'),
         (22, 7, 'epic-pr-review', 'running', 12, 'anthropic', 42, '2026-08-16 11:00:00', NULL);
`;
}

const SPLIT_ERA_SCHEMA = schemaWithTypes(SPLIT_ERA_TYPES);

function tableSql(db: Database.Database): string {
  return (
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='epic_agent_runs'`)
      .get() as { sql: string }
  ).sql;
}

function openWith(schema: string): Database.Database {
  const db = new Database(':memory:');
  db.exec(schema);
  return db;
}

describe('widenEpicAgentRunTypeCheck', () => {
  it('rebuilds the table once, keeping every row, id and link', () => {
    const db = openWith(SPLIT_ERA_SCHEMA);
    expect(() =>
      db.prepare("INSERT INTO epic_agent_runs (epic_id, agent_type) VALUES (7, 'epic-delivery')").run(),
    ).toThrow();

    widenEpicAgentRunTypeCheck(db);

    const rows = db.prepare('SELECT * FROM epic_agent_runs ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
    expect(rows.map((r) => r.id)).toEqual([21, 22]);
    expect(rows[0]).toMatchObject({
      epic_id: 7,
      agent_type: 'epic-architecture',
      conversation_id: 11,
      provider: 'openai',
      completed_at: '2026-08-16 10:05:00',
    });
    expect(rows[1]).toMatchObject({
      epic_id: 7,
      agent_type: 'epic-pr-review',
      conversation_id: 12,
      ticket_task_id: 42,
    });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('accepts epic-delivery afterwards and still rejects an unknown type', () => {
    const db = openWith(SPLIT_ERA_SCHEMA);
    widenEpicAgentRunTypeCheck(db);

    // A delivery run is about the epic's OWN pull request, so `ticket_task_id`
    // stays null — unlike the orchestrator and the reviewer.
    expect(() =>
      db
        .prepare(
          "INSERT INTO epic_agent_runs (epic_id, agent_type, status) VALUES (7, 'epic-delivery', 'running')",
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db.prepare("INSERT INTO epic_agent_runs (epic_id, agent_type) VALUES (7, 'epic-nope')").run(),
    ).toThrow();
    // The FKs came along with the rebuild.
    expect(() =>
      db
        .prepare("INSERT INTO epic_agent_runs (epic_id, agent_type) VALUES (999, 'epic-delivery')")
        .run(),
    ).toThrow();
  });

  it('keeps the index the epic queries rely on', () => {
    const db = openWith(SPLIT_ERA_SCHEMA);
    widenEpicAgentRunTypeCheck(db);

    const indexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='epic_agent_runs'`)
        .all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain('idx_epic_agent_runs_epic_id');
  });

  it('is a no-op on a table whose CHECK already carries the newest type', () => {
    const db = openWith(SPLIT_ERA_SCHEMA);
    widenEpicAgentRunTypeCheck(db);
    const after = tableSql(db);

    widenEpicAgentRunTypeCheck(db);
    expect(tableSql(db)).toBe(after);
  });

  // A pre-split database has no `epic_agent_runs` at all; `splitOwnerTables`
  // creates it later in the same boot and this call must not blow up first.
  it('does nothing when the table does not exist yet', () => {
    const db = new Database(':memory:');
    expect(() => widenEpicAgentRunTypeCheck(db)).not.toThrow();
  });
  // The live databases this ships to are DELIVERY-era (seven types): the
  // idempotence probe is now 'epic-qa-execution', so they must be rebuilt
  // exactly once more, and both QA types must insert afterwards.
  it('re-widens a delivery-era table for the two QA types', () => {
    const db = openWith(schemaWithTypes([...SPLIT_ERA_TYPES, 'epic-delivery']));
    expect(() =>
      db
        .prepare("INSERT INTO epic_agent_runs (epic_id, agent_type) VALUES (7, 'epic-qa-scenarios')")
        .run(),
    ).toThrow();

    widenEpicAgentRunTypeCheck(db);

    expect(() =>
      db
        .prepare(
          "INSERT INTO epic_agent_runs (epic_id, agent_type, status) VALUES (7, 'epic-qa-scenarios', 'running')",
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO epic_agent_runs (epic_id, agent_type, status) VALUES (7, 'epic-qa-execution', 'pending')",
        )
        .run(),
    ).not.toThrow();
    // Idempotent from here: the CHECK now names the newest type.
    const after = tableSql(db);
    widenEpicAgentRunTypeCheck(db);
    expect(tableSql(db)).toBe(after);
  });
});
