import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  backfillUserAgentModelSettings,
  backfillSchemaModelKey,
  backfillEpicStageModelKeys,
  backfillReviewCompleteForStartedEpics,
  migrateRetiredOpenAiModels,
  migrateRetiredOpenAiEfforts,
} from './db.js';
import {
  AGENT_TYPES_WITH_SETTINGS,
  DEFAULT_AGENT_MODEL_SETTINGS,
  EPIC_DEFAULT_SETTING,
  EPIC_STAGE_DEFAULT_SETTING,
  SCHEMA_DEFAULT_SETTING,
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

describe('backfillSchemaModelKey', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  function seedRow(userId: number, settings: Record<string, unknown>): void {
    db.prepare(
      `INSERT INTO user_agent_model_settings (user_id, settings_json) VALUES (?, ?)`,
    ).run(userId, JSON.stringify(settings));
  }

  it('adds the Anthropic-default schema key to a row that lacks it', () => {
    const u1 = addUser(db, 'alice');
    // A pre-existing row from before the `schema` key existed (no `schema`).
    const legacy: Record<string, unknown> = {};
    for (const key of AGENT_TYPES_WITH_SETTINGS) {
      if (key === 'schema') continue;
      legacy[key] = { provider: 'openai', model: 'gpt-5.5', effort: 'high' };
    }
    seedRow(u1, legacy);

    backfillSchemaModelKey(db);

    const after = settingsFor(db, u1)!;
    expect(after.schema).toEqual(SCHEMA_DEFAULT_SETTING);
    // Existing per-agent entries are preserved untouched.
    expect(after.planification).toEqual({ provider: 'openai', model: 'gpt-5.5', effort: 'high' });
  });

  it('leaves a row that already contains schema unchanged', () => {
    const u1 = addUser(db, 'alice');
    const existing: Record<string, unknown> = {};
    for (const key of AGENT_TYPES_WITH_SETTINGS) {
      existing[key] = { provider: 'anthropic', model: 'opus', effort: 'high' };
    }
    // A user's own (non-default) schema choice must not be overwritten.
    existing.schema = { provider: 'anthropic', model: 'sonnet', effort: 'low' };
    seedRow(u1, existing);

    backfillSchemaModelKey(db);

    expect(settingsFor(db, u1)!.schema).toEqual({
      provider: 'anthropic',
      model: 'sonnet',
      effort: 'low',
    });
  });

  it('is idempotent (a second run is a no-op)', () => {
    const u1 = addUser(db, 'alice');
    const legacy: Record<string, unknown> = {};
    for (const key of AGENT_TYPES_WITH_SETTINGS) {
      if (key === 'schema') continue;
      legacy[key] = { provider: 'anthropic', model: 'opus', effort: 'high' };
    }
    seedRow(u1, legacy);

    backfillSchemaModelKey(db);
    const first = settingsFor(db, u1)!;
    backfillSchemaModelKey(db);
    const second = settingsFor(db, u1)!;
    expect(second).toEqual(first);
  });
});

describe('migrateRetiredOpenAiModels', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  function seedRow(userId: number, settingsJson: string): void {
    db.prepare(
      `INSERT INTO user_agent_model_settings (user_id, settings_json) VALUES (?, ?)`,
    ).run(userId, settingsJson);
  }

  it('rewrites every retired openai id to gpt-6.1-sol, preserving effort and other providers', () => {
    const u1 = addUser(db, 'alice');
    const settings: Record<string, unknown> = {
      ...DEFAULT_AGENT_MODEL_SETTINGS,
      review: { provider: 'openai', model: 'gpt-5.5', effort: 'medium' },
      pr: { provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' },
      implementation: { provider: 'openai', model: 'gpt-5.4', effort: 'xhigh' },
      refinement: { provider: 'openai', model: 'gpt-5.4-mini', effort: 'medium' },
      'epic-architecture': { provider: 'openai', model: 'gpt-6-sol', effort: 'high' },
      planification: { provider: 'openai', model: 'gpt-6-astra', effort: 'high' },
      // Same retired string under another provider must NOT be rewritten —
      // the id namespace is per-provider.
      yolo: { provider: 'opencode', model: 'gpt-5.5', effort: null },
    };
    seedRow(u1, JSON.stringify(settings));

    migrateRetiredOpenAiModels(db);

    const after = settingsFor(db, u1)!;
    expect(after.review).toEqual({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'medium' });
    expect(after.pr).toEqual({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' });
    expect(after.implementation).toEqual({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'xhigh' });
    expect(after.refinement).toEqual({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'medium' });
    expect(after['epic-architecture']).toEqual({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' });
    // A current id is left exactly as it was.
    expect(after.planification).toEqual({ provider: 'openai', model: 'gpt-6-astra', effort: 'high' });
    expect(after.yolo).toEqual({ provider: 'opencode', model: 'gpt-5.5', effort: null });
    expect(after.schema).toEqual(DEFAULT_AGENT_MODEL_SETTINGS.schema);
  });

  it('is a no-op on rows with no retired id (and idempotent on rewritten ones)', () => {
    const u1 = addUser(db, 'alice');
    seedRow(
      u1,
      JSON.stringify({
        ...DEFAULT_AGENT_MODEL_SETTINGS,
        review: { provider: 'openai', model: 'gpt-5.5', effort: 'high' },
      }),
    );

    migrateRetiredOpenAiModels(db);
    const first = settingsFor(db, u1)!;
    migrateRetiredOpenAiModels(db);
    const second = settingsFor(db, u1)!;
    expect(second).toEqual(first);
    expect(first.review).toEqual({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' });
  });

  it('leaves unparseable rows for the loud loader instead of rewriting them', () => {
    const u1 = addUser(db, 'alice');
    seedRow(u1, 'not json{');

    migrateRetiredOpenAiModels(db);

    const row = db
      .prepare('SELECT settings_json FROM user_agent_model_settings WHERE user_id = ?')
      .get(u1) as { settings_json: string };
    expect(row.settings_json).toBe('not json{');
  });
});

describe('migrateRetiredOpenAiEfforts', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  function seedRow(userId: number, settingsJson: string): void {
    db.prepare(
      `INSERT INTO user_agent_model_settings (user_id, settings_json) VALUES (?, ?)`,
    ).run(userId, settingsJson);
  }

  it('rewrites openai minimal/low efforts to medium, preserving the model', () => {
    const u1 = addUser(db, 'alice');
    seedRow(
      u1,
      JSON.stringify({
        ...DEFAULT_AGENT_MODEL_SETTINGS,
        review: { provider: 'openai', model: 'gpt-5.6-sol', effort: 'minimal' },
        pr: { provider: 'openai', model: 'gpt-5.4', effort: 'low' },
        yolo: { provider: 'openai', model: 'gpt-5.4-mini', effort: 'xhigh' },
      }),
    );

    migrateRetiredOpenAiEfforts(db);

    const after = settingsFor(db, u1)!;
    expect(after.review).toEqual({ provider: 'openai', model: 'gpt-5.6-sol', effort: 'medium' });
    expect(after.pr).toEqual({ provider: 'openai', model: 'gpt-5.4', effort: 'medium' });
    // A surviving effort is left exactly as it was.
    expect(after.yolo).toEqual({ provider: 'openai', model: 'gpt-5.4-mini', effort: 'xhigh' });
  });

  it("leaves anthropic 'low' alone — it is still a valid Anthropic effort", () => {
    const u1 = addUser(db, 'alice');
    seedRow(
      u1,
      JSON.stringify({
        ...DEFAULT_AGENT_MODEL_SETTINGS,
        implementation: { provider: 'anthropic', model: 'sonnet', effort: 'low' },
        yolo: { provider: 'opencode', model: 'opencode/big-pickle', effort: null },
      }),
    );

    migrateRetiredOpenAiEfforts(db);

    const after = settingsFor(db, u1)!;
    expect(after.implementation).toEqual({ provider: 'anthropic', model: 'sonnet', effort: 'low' });
    expect(after.yolo).toEqual({ provider: 'opencode', model: 'opencode/big-pickle', effort: null });
  });

  it('is a no-op on rows with no retired effort (and idempotent on rewritten ones)', () => {
    const u1 = addUser(db, 'alice');
    seedRow(
      u1,
      JSON.stringify({
        ...DEFAULT_AGENT_MODEL_SETTINGS,
        review: { provider: 'openai', model: 'gpt-6-astra', effort: 'low' },
      }),
    );

    migrateRetiredOpenAiEfforts(db);
    const first = settingsFor(db, u1)!;
    migrateRetiredOpenAiEfforts(db);
    const second = settingsFor(db, u1)!;
    expect(second).toEqual(first);
    expect(first.review).toEqual({ provider: 'openai', model: 'gpt-6-astra', effort: 'medium' });
  });

  it('leaves unparseable rows for the loud loader instead of rewriting them', () => {
    const u1 = addUser(db, 'alice');
    seedRow(u1, 'not json{');

    migrateRetiredOpenAiEfforts(db);

    const row = db
      .prepare('SELECT settings_json FROM user_agent_model_settings WHERE user_id = ?')
      .get(u1) as { settings_json: string };
    expect(row.settings_json).toBe('not json{');
  });
});


describe('backfillEpicStageModelKeys', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  function seedRow(userId: number, settings: Record<string, unknown>): void {
    db.prepare(
      `INSERT INTO user_agent_model_settings (user_id, settings_json) VALUES (?, ?)`,
    ).run(userId, JSON.stringify(settings));
  }

  const EPIC_STAGE_KEYS = [
    'epic-architecture',
    'epic-specification',
    'epic-stories',
    'epic-spec-review',
    'epic-orchestrator',
  ] as const;

  it('adds every epic stage key to a row that predates them', () => {
    const u1 = addUser(db, 'alice');
    // A pre-existing row from before any epic key existed.
    const legacy: Record<string, unknown> = {};
    for (const key of AGENT_TYPES_WITH_SETTINGS) {
      if ((EPIC_STAGE_KEYS as readonly string[]).includes(key)) continue;
      legacy[key] = { provider: 'openai', model: 'gpt-5.6-sol', effort: 'high' };
    }
    seedRow(u1, legacy);

    backfillEpicStageModelKeys(db);

    const after = settingsFor(db, u1)!;
    expect(after['epic-architecture']).toEqual(EPIC_DEFAULT_SETTING);
    expect(after['epic-specification']).toEqual(EPIC_STAGE_DEFAULT_SETTING);
    expect(after['epic-stories']).toEqual(EPIC_STAGE_DEFAULT_SETTING);
    expect(after['epic-spec-review']).toEqual(EPIC_STAGE_DEFAULT_SETTING);
    expect(after['epic-orchestrator']).toEqual(EPIC_STAGE_DEFAULT_SETTING);
    // Existing per-agent entries are preserved untouched.
    expect(after.planification).toEqual({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
  });

  it("carries the v0 `epic` entry over to epic-architecture and drops the old key", () => {
    const u1 = addUser(db, 'alice');
    const existing: Record<string, unknown> = {};
    for (const key of AGENT_TYPES_WITH_SETTINGS) {
      if ((EPIC_STAGE_KEYS as readonly string[]).includes(key)) continue;
      existing[key] = { provider: 'anthropic', model: 'opus', effort: 'high' };
    }
    // The user's own (non-default) v0 epic choice must survive the rename.
    existing.epic = { provider: 'anthropic', model: 'sonnet', effort: 'low' };
    seedRow(u1, existing);

    backfillEpicStageModelKeys(db);

    const after = settingsFor(db, u1)!;
    expect(after['epic-architecture']).toEqual({
      provider: 'anthropic',
      model: 'sonnet',
      effort: 'low',
    });
    // The stale key would break the strict PUT schema on the next save.
    expect(after.epic).toBeUndefined();
  });

  it('seeds only the missing stage key on a row that predates it (the epic-spec-review case)', () => {
    const u1 = addUser(db, 'alice');
    const existing: Record<string, unknown> = {};
    for (const key of AGENT_TYPES_WITH_SETTINGS) {
      if (key === 'epic-spec-review') continue;
      existing[key] = { provider: 'anthropic', model: 'sonnet', effort: 'low' };
    }
    seedRow(u1, existing);

    backfillEpicStageModelKeys(db);

    const after = settingsFor(db, u1)!;
    expect(after['epic-spec-review']).toEqual(EPIC_STAGE_DEFAULT_SETTING);
    // Every key the user already had keeps their choice.
    expect(after['epic-pr-review']).toEqual({ provider: 'anthropic', model: 'sonnet', effort: 'low' });
    expect(after['epic-stories']).toEqual({ provider: 'anthropic', model: 'sonnet', effort: 'low' });
  });

  it('leaves a row that already carries every stage key unchanged', () => {
    const u1 = addUser(db, 'alice');
    const existing: Record<string, unknown> = {};
    for (const key of AGENT_TYPES_WITH_SETTINGS) {
      existing[key] = { provider: 'anthropic', model: 'opus', effort: 'high' };
    }
    existing['epic-specification'] = { provider: 'anthropic', model: 'sonnet', effort: 'low' };
    seedRow(u1, existing);

    backfillEpicStageModelKeys(db);

    expect(settingsFor(db, u1)!['epic-specification']).toEqual({
      provider: 'anthropic',
      model: 'sonnet',
      effort: 'low',
    });
  });

  it('leaves unparseable settings JSON alone (the loud loader owns it)', () => {
    const u1 = addUser(db, 'alice');
    db.prepare(
      `INSERT INTO user_agent_model_settings (user_id, settings_json) VALUES (?, ?)`,
    ).run(u1, 'not json{');

    backfillEpicStageModelKeys(db);

    const row = db
      .prepare('SELECT settings_json FROM user_agent_model_settings WHERE user_id = ?')
      .get(u1) as { settings_json: string };
    expect(row.settings_json).toBe('not json{');
  });
});

describe('backfillReviewCompleteForStartedEpics', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    // This backfill is historical: it only ever runs on pre-split databases,
    // where epic membership still lived on the task row. Recreate that shape.
    db.exec(
      'ALTER TABLE tasks ADD COLUMN epic_id INTEGER REFERENCES epics(id) ON DELETE SET NULL',
    );
  });
  afterEach(() => {
    db.close();
  });

  function addEpic(
    flags: { stories_complete: number; orchestration_active?: number; review_complete?: number },
  ): number {
    const user = addUser(db, `u${Math.random()}`);
    const projectId = Number(
      db
        .prepare('INSERT INTO projects (user_id, name, repo_folder_path) VALUES (?, ?, ?)')
        .run(user, 'P', `/tmp/${Math.random()}`).lastInsertRowid,
    );
    return Number(
      db
        .prepare(
          `INSERT INTO epics (project_id, user_id, name, slug, stories_complete, orchestration_active, review_complete)
           VALUES (?, ?, 'E', 'e', ?, ?, ?)`,
        )
        .run(
          projectId,
          user,
          flags.stories_complete,
          flags.orchestration_active ?? 0,
          flags.review_complete ?? 0,
        ).lastInsertRowid,
    );
  }

  function addTicket(epicId: number, status: string): void {
    const epic = db.prepare('SELECT project_id, user_id FROM epics WHERE id = ?').get(epicId) as {
      project_id: number;
      user_id: number;
    };
    db.prepare(
      'INSERT INTO tasks (project_id, user_id, title, status, epic_id) VALUES (?, ?, ?, ?, ?)',
    ).run(epic.project_id, epic.user_id, 'T', status, epicId);
  }

  function reviewFlag(epicId: number): number {
    return (db.prepare('SELECT review_complete FROM epics WHERE id = ?').get(epicId) as {
      review_complete: number;
    }).review_complete;
  }

  it('marks the review complete for an epic whose tickets already left pending', () => {
    const epic = addEpic({ stories_complete: 1 });
    addTicket(epic, 'completed');
    addTicket(epic, 'in_progress');

    expect(backfillReviewCompleteForStartedEpics(db)).toBe(1);
    expect(reviewFlag(epic)).toBe(1);
  });

  it('marks it for an epic under orchestration even before any ticket moved', () => {
    const epic = addEpic({ stories_complete: 1, orchestration_active: 1 });
    addTicket(epic, 'pending');

    expect(backfillReviewCompleteForStartedEpics(db)).toBe(1);
    expect(reviewFlag(epic)).toBe(1);
  });

  it('leaves an epic whose tickets are all pending to go through the gate', () => {
    const epic = addEpic({ stories_complete: 1 });
    addTicket(epic, 'pending');
    addTicket(epic, 'pending');

    expect(backfillReviewCompleteForStartedEpics(db)).toBe(0);
    expect(reviewFlag(epic)).toBe(0);
  });

  it('never marks an epic whose stories stage is not signed off, whatever its tickets did', () => {
    const epic = addEpic({ stories_complete: 0 });
    addTicket(epic, 'in_progress');

    expect(backfillReviewCompleteForStartedEpics(db)).toBe(0);
    expect(reviewFlag(epic)).toBe(0);
  });

  it('is idempotent', () => {
    const epic = addEpic({ stories_complete: 1 });
    addTicket(epic, 'completed');

    expect(backfillReviewCompleteForStartedEpics(db)).toBe(1);
    expect(backfillReviewCompleteForStartedEpics(db)).toBe(0);
    expect(reviewFlag(epic)).toBe(1);
  });
});
