// Edge cases of the one-shot v0 conversion. The happy path (grouping, the
// architecture flag, archived spec files) is covered end-to-end against a real
// old-shape database in `epicMigration.test.ts`. There is deliberately no
// `epic_artifacts` table in this fixture: the conversion must not touch one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { convertEpicRunsToEpics } from './epicConversion.js';

const SENTINEL = 'epic_runs_converted';

function sentinelValue(db: Database.Database): string | undefined {
  return (
    db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SENTINEL) as
      | { value: string }
      | undefined
  )?.value;
}

describe('convertEpicRunsToEpics', () => {
  let db: Database.Database;
  let archiveRoot: string;

  beforeEach(() => {
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-conversion-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE epics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        user_id INTEGER,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        architecture_complete INTEGER NOT NULL DEFAULT 0,
        specs_complete INTEGER NOT NULL DEFAULT 0,
        stories_complete INTEGER NOT NULL DEFAULT 0,
        feature_branch TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME DEFAULT NULL
      );
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(archiveRoot, { recursive: true, force: true });
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
  });

  function createLegacyTable(): void {
    db.exec(`
      CREATE TABLE epic_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        user_id INTEGER,
        name TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        provider TEXT NOT NULL DEFAULT 'anthropic',
        model TEXT NOT NULL,
        effort TEXT,
        result_text TEXT,
        before_mermaid TEXT,
        after_mermaid TEXT,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME DEFAULT NULL
      );
    `);
  }

  it('marks itself done on a fresh install where the legacy table never existed', () => {
    convertEpicRunsToEpics(db);

    expect(sentinelValue(db)).toBe('1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM epics').get()).toEqual({ n: 0 });
  });

  it('marks itself done when the legacy table is empty', () => {
    createLegacyTable();

    convertEpicRunsToEpics(db);

    expect(sentinelValue(db)).toBe('1');
  });

  it('never runs twice: rows added to the legacy table afterwards are ignored', () => {
    createLegacyTable();
    db.prepare(
      `INSERT INTO epic_runs (project_id, user_id, name, spec_json, status, model)
       VALUES (7, 1, 'First', '[]', 'completed', 'opus')`,
    ).run();

    convertEpicRunsToEpics(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM epics').get()).toEqual({ n: 1 });

    db.prepare(
      `INSERT INTO epic_runs (project_id, user_id, name, spec_json, status, model)
       VALUES (7, 1, 'Second', '[]', 'completed', 'opus')`,
    ).run();
    convertEpicRunsToEpics(db);

    expect(db.prepare('SELECT COUNT(*) AS n FROM epics').get()).toEqual({ n: 1 });
  });

  it('separates runs of the same name in different projects', () => {
    createLegacyTable();
    const insert = db.prepare(
      `INSERT INTO epic_runs (project_id, user_id, name, spec_json, status, model)
       VALUES (?, 1, 'Shared name', '[]', 'completed', 'opus')`,
    );
    insert.run(7);
    insert.run(8);

    convertEpicRunsToEpics(db);

    const epics = db.prepare('SELECT project_id FROM epics ORDER BY project_id').all();
    expect(epics).toEqual([{ project_id: 7 }, { project_id: 8 }]);
  });

  it('survives unparseable spec_json (the epic still converts)', () => {
    createLegacyTable();
    db.prepare(
      `INSERT INTO epic_runs (project_id, user_id, name, spec_json, status, model)
       VALUES (7, 1, 'Broken spec', 'not json{', 'completed', 'opus')`,
    ).run();

    expect(() => convertEpicRunsToEpics(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM epics').get()).toEqual({ n: 1 });
  });
});
