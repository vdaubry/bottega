import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { backfillUserAgentModelSettings } from './db.js';
import {
  AGENT_TYPES_WITH_SETTINGS,
  DEFAULT_AGENT_MODEL_SETTINGS,
} from '../../shared/types/agentModelSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8'));
  return db;
}

function addUser(db: Database.Database, username: string): number {
  return Number(
    db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, 'hash').lastInsertRowid,
  );
}

function settingsFor(db: Database.Database, userId: number): Record<string, unknown> | null {
  const row = db
    .prepare('SELECT settings_json FROM user_agent_model_settings WHERE user_id = ?')
    .get(userId) as { settings_json: string } | undefined;
  return row ? JSON.parse(row.settings_json) : null;
}

describe('backfillUserAgentModelSettings', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  it('replicates the stored global config to every existing user', () => {
    const u1 = addUser(db, 'alice');
    const u2 = addUser(db, 'bob');
    const global = {
      ...DEFAULT_AGENT_MODEL_SETTINGS,
      planification: { provider: 'openai', model: 'gpt-5.5', effort: 'high' },
    };
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('agent_model_settings', ?)`).run(
      JSON.stringify(global),
    );

    backfillUserAgentModelSettings(db);

    for (const userId of [u1, u2]) {
      const s = settingsFor(db, userId);
      expect(s).not.toBeNull();
      expect(s!.planification).toEqual({ provider: 'openai', model: 'gpt-5.5', effort: 'high' });
      for (const agent of AGENT_TYPES_WITH_SETTINGS) {
        expect(s![agent]).toBeDefined();
      }
    }
  });

  it('replicates DEFAULT settings when no global config was ever set', () => {
    const u1 = addUser(db, 'alice');
    backfillUserAgentModelSettings(db);
    expect(settingsFor(db, u1)).toEqual(DEFAULT_AGENT_MODEL_SETTINGS);
  });

  it('is a no-op on the second run (sentinel guards it) and leaves later users unseeded', () => {
    const u1 = addUser(db, 'alice');
    backfillUserAgentModelSettings(db);
    expect(settingsFor(db, u1)).not.toBeNull();

    // A user created after the one-shot backfill must NOT be backfilled — they
    // seed from their first connected provider instead.
    const u2 = addUser(db, 'bob');
    backfillUserAgentModelSettings(db);
    expect(settingsFor(db, u2)).toBeNull();
  });

  it('does not overwrite a user who already has a settings row', () => {
    const u1 = addUser(db, 'alice');
    const existing = { ...DEFAULT_AGENT_MODEL_SETTINGS };
    existing.planification = { provider: 'anthropic', model: 'sonnet', effort: 'low' };
    db.prepare(
      `INSERT INTO user_agent_model_settings (user_id, settings_json) VALUES (?, ?)`,
    ).run(u1, JSON.stringify(existing));

    backfillUserAgentModelSettings(db);

    expect(settingsFor(db, u1)!.planification).toEqual({
      provider: 'anthropic',
      model: 'sonnet',
      effort: 'low',
    });
  });
});
