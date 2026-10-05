import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import type {
  AgentRunDriver,
  AgentRunStatus,
  AgentType,
  AppSettingRow,
  ConversationRow,
  ProjectMemberRow,
  ProjectRow,
  TaskAgentRunRow,
  TaskArtifactRow,
  TaskArtifactSummaryRow,
  TaskRow,
  TaskStatus,
  UserRow,
  UserAgentModelSettingsRow,
} from '../../shared/types/db.js';
import {
  DEFAULT_AGENT_MODEL_SETTINGS,
  EPIC_DEFAULT_SETTING,
  EPIC_STAGE_DEFAULT_SETTING,
  SCHEMA_DEFAULT_SETTING,
} from '../../shared/types/agentModelSettings.js';
import { convertEpicRunsToEpics } from './epicConversion.js';

import { db, lastInsertId } from './connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const INIT_SQL_PATH = path.join(__dirname, 'init.sql');

interface ColumnInfoRow {
  name: string;
}

/**
 * One-shot backfill: replicate the previous GLOBAL `agent_model_settings` blob
 * (or DEFAULT_AGENT_MODEL_SETTINGS when none was ever set) into a per-user row
 * for every existing user lacking one, so removing the global setting doesn't
 * change anyone's current behavior. Guarded by a sentinel app_settings key so
 * it runs exactly once — users created afterwards seed from their first
 * connected provider at connect-time instead. The global row is left intact
 * (it's the source we read here; no separate backup needed). Exported for
 * testing. `INSERT OR IGNORE` keeps it safe to run against users who already
 * have a row.
 */
export function backfillUserAgentModelSettings(database: Database.Database): void {
  const backfilled = database
    .prepare(`SELECT value FROM app_settings WHERE key = 'user_agent_settings_backfilled'`)
    .get() as Pick<AppSettingRow, 'value'> | undefined;
  if (backfilled) return;

  console.log('Running migration: Backfilling per-user agent_model_settings from global config');
  const globalRow = database
    .prepare(`SELECT value FROM app_settings WHERE key = 'agent_model_settings'`)
    .get() as Pick<AppSettingRow, 'value'> | undefined;
  const globalJson = globalRow?.value ?? JSON.stringify(DEFAULT_AGENT_MODEL_SETTINGS);
  database
    .prepare(
      `INSERT OR IGNORE INTO user_agent_model_settings (user_id, settings_json)
       SELECT id, ? FROM users`,
    )
    .run(globalJson);
  database
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('user_agent_settings_backfilled', '1', CURRENT_TIMESTAMP)`,
    )
    .run();
}

/**
 * Add the Anthropic-default `schema` model entry to every existing
 * `user_agent_model_settings` row that lacks one. Separate from (and run after)
 * `backfillUserAgentModelSettings`: that one-shot is sentinel-guarded so it
 * won't touch users who already had a row, yet `loadAgentModelSettings` now
 * throws on ANY missing key — so without this migration every already-seeded
 * user would suddenly be unresolvable (breaking all their agent runs). This is
 * idempotent (skips rows that already carry `schema`), preserves each user's
 * existing per-agent entries, and is keyed off the per-row JSON so it correctly
 * handles users created at different times. Exported for testing.
 */
export function backfillSchemaModelKey(database: Database.Database): void {
  const rows = database
    .prepare('SELECT user_id, settings_json FROM user_agent_model_settings')
    .all() as Array<Pick<UserAgentModelSettingsRow, 'user_id' | 'settings_json'>>;

  const update = database.prepare(
    `UPDATE user_agent_model_settings
       SET settings_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?`,
  );

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.settings_json);
    } catch {
      // A row with unparseable JSON is already broken; the loud loader will
      // surface it. Don't mask it by rewriting here.
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const blob = parsed as Record<string, unknown>;
    if (blob.schema !== undefined) continue;

    blob.schema = { ...SCHEMA_DEFAULT_SETTING };
    update.run(JSON.stringify(blob), row.user_id);
  }
}

/**
 * Replace the v0 single `epic` model key with the per-epic-agent keys
 * (`epic-architecture`, `epic-specification`, `epic-stories`,
 * `epic-spec-review`, `epic-orchestrator`, `epic-pr-review`, `epic-delivery`) in every
 * `user_agent_model_settings` row. Same rationale and shape as `backfillSchemaModelKey` above:
 * `loadAgentModelSettings` throws on ANY missing key, so shipping a new key
 * without this backfill would make every already-seeded user unresolvable.
 *
 * `epic-architecture` inherits the user's old `epic` entry (it runs the very
 * same workload the v0 spike did — their chosen model is preserved); the
 * judgment-heavy stages seed to `EPIC_STAGE_DEFAULT_SETTING`. The stale `epic`
 * key is dropped because the settings PUT schema is `.strict()` and would 400
 * on a round-trip that still carried it. Idempotent (a row already holding
 * every key and no `epic` is untouched — a later-added key such as
 * `epic-pr-review` is seeded on its own), preserves every other entry, leaves
 * unparseable rows to the loud loader. Exported for testing.
 */
const EPIC_STAGE_KEYS_TO_SEED = [
  'epic-specification',
  'epic-stories',
  'epic-spec-review',
  'epic-orchestrator',
  'epic-pr-review',
  'epic-delivery',
  'epic-qa-scenarios',
  'epic-qa-execution',
  'epic-qa-fix',
] as const;

/**
 * Every value `task_agent_runs.agent_type` admits. Single source for the CHECK
 * the rebuild below writes, so adding an agent type is one edit here (plus the
 * matching init.sql line for fresh installs). APPEND new types: the rebuild's
 * idempotence probe is the LAST entry, so an existing database is rebuilt
 * exactly once per newly added type.
 */
const AGENT_RUN_TYPES = [
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
  'epic-pr-review',
  'epic-spec-review',
] as const;

/** The most recently added agent type — the rebuild's idempotence probe. */
const NEWEST_AGENT_RUN_TYPE = AGENT_RUN_TYPES[AGENT_RUN_TYPES.length - 1]!;

/**
 * Rebuild `task_agent_runs` with the agent_type CHECK carrying every value in
 * `AGENT_RUN_TYPES`. Idempotent: a table whose constraint already names the
 * newest type is left alone. Same row-count and FK-violation guards as the
 * epic-scope rebuild, same explicit column list (`provider` and
 * `ticket_task_id` were added by earlier migrations). Exported for testing.
 */
export function widenAgentRunTypeCheck(database: Database.Database): void {
  const schema = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='task_agent_runs'`)
    .get() as { sql: string } | undefined;
  if (!schema || schema.sql.includes(`'${NEWEST_AGENT_RUN_TYPE}'`)) return;

  console.log(
    `Running migration: Widening task_agent_runs.agent_type for ${NEWEST_AGENT_RUN_TYPE}`,
  );
  const countBefore = (
    database.prepare('SELECT COUNT(*) AS n FROM task_agent_runs').get() as { n: number }
  ).n;
  const violationsBefore = countFkViolations(database, 'task_agent_runs');
  const typeList = AGENT_RUN_TYPES.map((t) => `'${t}'`).join(', ');
  database.pragma('foreign_keys = OFF');
  try {
    database.exec(`
      CREATE TABLE task_agent_runs_new (
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
      INSERT INTO task_agent_runs_new (
        id, task_id, epic_id, agent_type, status, conversation_id, provider, ticket_task_id,
        created_at, completed_at
      )
      SELECT
        id, task_id, epic_id, agent_type, status, conversation_id, provider, ticket_task_id,
        created_at, completed_at
      FROM task_agent_runs;
      DROP TABLE task_agent_runs;
      ALTER TABLE task_agent_runs_new RENAME TO task_agent_runs;
      CREATE INDEX IF NOT EXISTS idx_task_agent_runs_task_id ON task_agent_runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_agent_runs_epic_id ON task_agent_runs(epic_id);
    `);
    const countAfter = (
      database.prepare('SELECT COUNT(*) AS n FROM task_agent_runs').get() as { n: number }
    ).n;
    if (countAfter !== countBefore) {
      throw new Error(
        `task_agent_runs rebuild changed the row count (${countBefore} -> ${countAfter})`,
      );
    }
    const violationsAfter = countFkViolations(database, 'task_agent_runs');
    if (violationsAfter > violationsBefore) {
      throw new Error(
        `task_agent_runs rebuild introduced ${violationsAfter - violationsBefore} foreign key violation(s)`,
      );
    }
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

/**
 * Every value `epic_agent_runs.agent_type` admits. Single source for the CHECK
 * `widenEpicAgentRunTypeCheck` writes, so adding an epic agent type is one edit
 * here (plus the matching init.sql line for fresh installs). APPEND new types:
 * the rebuild's idempotence probe is the LAST entry, so an existing database is
 * rebuilt exactly once per newly added type.
 */
const EPIC_AGENT_RUN_TYPES = [
  'epic-architecture',
  'epic-specification',
  'epic-stories',
  'epic-spec-review',
  'epic-orchestrator',
  'epic-pr-review',
  'epic-delivery',
  'epic-qa-scenarios',
  'epic-qa-execution',
  // Keep this one LAST: the newest type is the rebuild's idempotence probe.
  'epic-qa-fix',
] as const;

/** The most recently added epic agent type — the rebuild's idempotence probe. */
const NEWEST_EPIC_AGENT_RUN_TYPE = EPIC_AGENT_RUN_TYPES[EPIC_AGENT_RUN_TYPES.length - 1]!;

/**
 * Rebuild `epic_agent_runs` with the agent_type CHECK carrying every value in
 * `EPIC_AGENT_RUN_TYPES`. The epic twin of `widenAgentRunTypeCheck`:
 * `splitOwnerTables` created this table with the six types that existed then,
 * and SQLite cannot alter a CHECK in place. Idempotent — a table whose
 * constraint already names the newest type is left alone, so a fresh install
 * (born widened from init.sql) skips it. Same row-count and FK-violation guards
 * as every other rebuild. Exported for testing.
 */
export function widenEpicAgentRunTypeCheck(database: Database.Database): void {
  const schema = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='epic_agent_runs'`)
    .get() as { sql: string } | undefined;
  // No table yet: a pre-split database gets it from `splitOwnerTables`, which
  // runs later in `runMigrations` and writes the current type list itself.
  if (!schema || schema.sql.includes(`'${NEWEST_EPIC_AGENT_RUN_TYPE}'`)) return;

  console.log(
    `Running migration: Widening epic_agent_runs.agent_type for ${NEWEST_EPIC_AGENT_RUN_TYPE}`,
  );
  const countBefore = (
    database.prepare('SELECT COUNT(*) AS n FROM epic_agent_runs').get() as { n: number }
  ).n;
  const violationsBefore = countFkViolations(database, 'epic_agent_runs');
  const typeList = EPIC_AGENT_RUN_TYPES.map((t) => `'${t}'`).join(', ');
  database.pragma('foreign_keys = OFF');
  try {
    database.exec(`
      CREATE TABLE epic_agent_runs_new (
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
      INSERT INTO epic_agent_runs_new (
        id, epic_id, agent_type, status, conversation_id, provider, ticket_task_id,
        created_at, completed_at
      )
      SELECT
        id, epic_id, agent_type, status, conversation_id, provider, ticket_task_id,
        created_at, completed_at
      FROM epic_agent_runs;
      DROP TABLE epic_agent_runs;
      ALTER TABLE epic_agent_runs_new RENAME TO epic_agent_runs;
      CREATE INDEX IF NOT EXISTS idx_epic_agent_runs_epic_id ON epic_agent_runs(epic_id);
    `);
    const countAfter = (
      database.prepare('SELECT COUNT(*) AS n FROM epic_agent_runs').get() as { n: number }
    ).n;
    if (countAfter !== countBefore) {
      throw new Error(
        `epic_agent_runs rebuild changed the row count (${countBefore} -> ${countAfter})`,
      );
    }
    const violationsAfter = countFkViolations(database, 'epic_agent_runs');
    if (violationsAfter > violationsBefore) {
      throw new Error(
        `epic_agent_runs rebuild introduced ${violationsAfter - violationsBefore} foreign key violation(s)`,
      );
    }
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

/**
 * The specification review is a gate BEFORE implementation, so an epic whose
 * implementation already began is past it: its tickets cannot be re-planned
 * (the story tools close once work starts), and making the user run a review
 * of documents nothing can act on — or click the backstop just to keep the
 * stage rail honest — would be noise. Those epics get `review_complete = 1`;
 * an epic whose tickets are all still pending keeps 0 and goes through the
 * gate. "Began" is the same two signals the story tools read: the durable
 * `orchestration_active` flag, or any ticket that has left `pending`.
 * Idempotent by construction (only called when the column is first added, and
 * only ever sets 1). Exported for testing.
 */
export function backfillReviewCompleteForStartedEpics(database: Database.Database): number {
  const result = database
    .prepare(
      `UPDATE epics
         SET review_complete = 1
       WHERE stories_complete = 1
         AND review_complete = 0
         AND (
           orchestration_active = 1
           OR EXISTS (
             SELECT 1 FROM tasks t
              WHERE t.epic_id = epics.id AND t.status != 'pending'
           )
         )`,
    )
    .run();
  if (result.changes > 0) {
    console.log(
      `Running migration: Marked the specification review complete for ${result.changes} epic(s) already under implementation`,
    );
  }
  return result.changes;
}

export function backfillEpicStageModelKeys(database: Database.Database): void {
  const rows = database
    .prepare('SELECT user_id, settings_json FROM user_agent_model_settings')
    .all() as Array<Pick<UserAgentModelSettingsRow, 'user_id' | 'settings_json'>>;

  const update = database.prepare(
    `UPDATE user_agent_model_settings
       SET settings_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?`,
  );

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.settings_json);
    } catch {
      // A row with unparseable JSON is already broken; the loud loader will
      // surface it. Don't mask it by rewriting here.
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const blob = parsed as Record<string, unknown>;

    let changed = false;
    const legacy = blob.epic;
    if (blob['epic-architecture'] === undefined) {
      const carried =
        legacy && typeof legacy === 'object' && !Array.isArray(legacy)
          ? (legacy as Record<string, unknown>)
          : null;
      blob['epic-architecture'] = carried ? { ...carried } : { ...EPIC_DEFAULT_SETTING };
      changed = true;
    }
    for (const key of EPIC_STAGE_KEYS_TO_SEED) {
      if (blob[key] === undefined) {
        blob[key] = { ...EPIC_STAGE_DEFAULT_SETTING };
        changed = true;
      }
    }
    if (legacy !== undefined) {
      delete blob.epic;
      changed = true;
    }

    if (changed) update.run(JSON.stringify(blob), row.user_id);
  }
}

/**
 * Rewrite retired OpenAI model ids in `user_agent_model_settings` to their
 * successor. `loadAgentModelSettings` validates every entry against
 * `OPENAI_MODELS` and fails loud on an unknown id, so dropping a model from
 * that enum without rewriting persisted entries would make every user who had
 * selected it unresolvable (breaking all their agent runs). Idempotent (only
 * rows carrying a retired id are rewritten), preserves each entry's effort,
 * and leaves unparseable rows to the loud loader. Exported for testing.
 *
 * Conversations rows are intentionally NOT rewritten: resume reads the model
 * off the conversation row without re-validating it against the enum, and the
 * retired id keeps working upstream for as long as OpenAI serves it.
 */
const RETIRED_OPENAI_MODELS: Record<string, string> = {
  'gpt-5.5': 'gpt-6.1-sol',
  'gpt-5.6-sol': 'gpt-6.1-sol',
  'gpt-5.4': 'gpt-6.1-sol',
  'gpt-5.4-mini': 'gpt-6.1-sol',
  'gpt-6-sol': 'gpt-6.1-sol',
};

export function migrateRetiredOpenAiModels(database: Database.Database): void {
  const rows = database
    .prepare('SELECT user_id, settings_json FROM user_agent_model_settings')
    .all() as Array<Pick<UserAgentModelSettingsRow, 'user_id' | 'settings_json'>>;

  const update = database.prepare(
    `UPDATE user_agent_model_settings
       SET settings_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?`,
  );

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.settings_json);
    } catch {
      // A row with unparseable JSON is already broken; the loud loader will
      // surface it. Don't mask it by rewriting here.
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const blob = parsed as Record<string, unknown>;

    let changed = false;
    for (const entry of Object.values(blob)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const setting = entry as Record<string, unknown>;
      if (setting.provider !== 'openai' || typeof setting.model !== 'string') continue;
      const replacement = RETIRED_OPENAI_MODELS[setting.model];
      if (!replacement) continue;
      setting.model = replacement;
      changed = true;
    }
    if (changed) update.run(JSON.stringify(blob), row.user_id);
  }
}

/**
 * Rewrite retired OpenAI reasoning efforts in `user_agent_model_settings` to
 * their successor. The exact counterpart of `migrateRetiredOpenAiModels` above,
 * for the other half of the pair: `loadAgentModelSettings` validates the effort
 * against `OPENAI_EFFORTS` too, so narrowing that list without rewriting
 * persisted entries makes every user who had selected a dropped effort
 * unresolvable.
 *
 * `minimal` and `low` were dropped when GPT-6 Astra joined `OPENAI_MODELS`:
 * the list is the intersection every OpenAI model accepts, and Astra's
 * documented `reasoning.effort` range starts at `low` while rejecting the Codex
 * CLI's `minimal`. Both map to `medium` — the new floor, so a run gets the
 * nearest surviving level rather than a silent escalation in cost.
 *
 * Only `provider: 'openai'` entries are touched: `low` is still a valid
 * Anthropic effort and several users have Anthropic rows carrying it.
 * Idempotent, preserves each entry's model, and leaves unparseable rows to the
 * loud loader. Conversations rows are NOT rewritten, for the same reason as the
 * model migration. Exported for testing.
 */
const RETIRED_OPENAI_EFFORTS: Record<string, string> = {
  minimal: 'medium',
  low: 'medium',
};

export function migrateRetiredOpenAiEfforts(database: Database.Database): void {
  const rows = database
    .prepare('SELECT user_id, settings_json FROM user_agent_model_settings')
    .all() as Array<Pick<UserAgentModelSettingsRow, 'user_id' | 'settings_json'>>;

  const update = database.prepare(
    `UPDATE user_agent_model_settings
       SET settings_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?`,
  );

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.settings_json);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const blob = parsed as Record<string, unknown>;

    let changed = false;
    for (const entry of Object.values(blob)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const setting = entry as Record<string, unknown>;
      if (setting.provider !== 'openai' || typeof setting.effort !== 'string') continue;
      const replacement = RETIRED_OPENAI_EFFORTS[setting.effort];
      if (!replacement) continue;
      setting.effort = replacement;
      changed = true;
    }
    if (changed) update.run(JSON.stringify(blob), row.user_id);
  }
}

/**
 * The architecture-v2 step-5 owner-table split, in one guarded pass:
 *
 *  - `epic_agent_runs` is created and every epic-owned row of
 *    `task_agent_runs` copied into it WITH ITS ID (open pages and historical
 *    links survive; the two sequences then diverge, which is fine because no
 *    surface mixes them);
 *  - `task_agent_runs` is rebuilt task-only (task_id NOT NULL, the CHECK
 *    narrowed to the six task agent types, `epic_id`/`ticket_task_id`
 *    dropped);
 *  - `task_conversations` / `epic_conversations` are created and backfilled
 *    from the owner columns; `conversations` is rebuilt owner-less with the
 *    `owner_kind` dispatch tag;
 *  - `epic_tickets` is created and backfilled from `tasks.epic_id` /
 *    `epic_order` (a NULL position falls back to the task id, preserving the
 *    old `epic_order IS NULL, epic_order, id` ordering);
 *  - `tasks` is rebuilt without the epic columns.
 *
 * Runs with foreign keys OFF (both `tasks` and `conversations` are parent
 * tables — a plain DROP would cascade), explicit column lists (ALTER-added
 * columns sit at different ordinals on migrated databases), and the same
 * row-count / link-count / FK-violation invariants as every earlier rebuild.
 * Idempotent: keyed on `epic_agent_runs` not existing yet, which is also the
 * fresh-install signature (init.sql creates the whole new shape up front).
 * Exported for testing.
 */
export function splitOwnerTables(database: Database.Database): void {
  const conversationsSchema = (
    database
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='conversations'`)
      .get() as { sql: string } | undefined
  )?.sql;
  const alreadySplit = !!conversationsSchema?.includes('owner_kind');
  if (alreadySplit) return;

  console.log('Running migration: Splitting owner tables (architecture-v2 step 5)');

  // init.sql runs before migrations, so on an old database its
  // CREATE IF NOT EXISTS has just laid down EMPTY new-shape tables. Drop the
  // shells so the CREATEs below own the real thing — and refuse to proceed
  // if any of them somehow holds rows (a half-split database needs a human).
  for (const shell of [
    'epic_agent_runs',
    'task_conversations',
    'epic_conversations',
    'epic_tickets',
  ]) {
    const exists = database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(shell);
    if (!exists) continue;
    const rows = (database.prepare(`SELECT COUNT(*) AS n FROM ${shell}`).get() as { n: number }).n;
    if (rows > 0) {
      throw new Error(
        `owner-table split found a non-empty ${shell} on a pre-split database — refusing to continue`,
      );
    }
    database.exec(`DROP TABLE ${shell}`);
  }

  const count = (sql: string): number =>
    (database.prepare(sql).get() as { n: number }).n;

  const runsBefore = count('SELECT COUNT(*) AS n FROM task_agent_runs');
  const epicRunsBefore = count('SELECT COUNT(*) AS n FROM task_agent_runs WHERE epic_id IS NOT NULL');
  const linkedRunsBefore = count(
    'SELECT COUNT(*) AS n FROM task_agent_runs WHERE conversation_id IS NOT NULL',
  );
  const conversationsBefore = count('SELECT COUNT(*) AS n FROM conversations');
  const taskConversationsBefore = count(
    'SELECT COUNT(*) AS n FROM conversations WHERE task_id IS NOT NULL',
  );
  const tasksBefore = count('SELECT COUNT(*) AS n FROM tasks');
  const ticketsBefore = count('SELECT COUNT(*) AS n FROM tasks WHERE epic_id IS NOT NULL');
  const violationsBefore =
    countFkViolations(database, 'task_agent_runs') +
    countFkViolations(database, 'conversations') +
    countFkViolations(database, 'tasks');

  database.pragma('foreign_keys = OFF');
  try {
    database.exec(`
      -- 1. Epic runs move to their own table, ids preserved.
      CREATE TABLE epic_agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epic_id INTEGER NOT NULL,
        agent_type TEXT NOT NULL CHECK(agent_type IN ('epic-architecture', 'epic-specification', 'epic-stories', 'epic-spec-review', 'epic-orchestrator', 'epic-pr-review')),
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
        conversation_id INTEGER,
        provider TEXT NOT NULL DEFAULT 'anthropic',
        ticket_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (epic_id) REFERENCES epics(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
      );
      INSERT INTO epic_agent_runs (
        id, epic_id, agent_type, status, conversation_id, provider, ticket_task_id,
        created_at, completed_at
      )
      SELECT
        id, epic_id, agent_type, status, conversation_id, provider, ticket_task_id,
        created_at, completed_at
      FROM task_agent_runs WHERE epic_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_epic_agent_runs_epic_id ON epic_agent_runs(epic_id);

      -- 2. task_agent_runs rebuilt task-only.
      CREATE TABLE task_agent_runs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        agent_type TEXT NOT NULL CHECK(agent_type IN ('planification', 'implementation', 'refinement', 'review', 'pr', 'yolo')),
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
        conversation_id INTEGER,
        provider TEXT NOT NULL DEFAULT 'anthropic',
        driver TEXT NOT NULL DEFAULT 'human' CHECK(driver IN ('human', 'automation')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
      );
      INSERT INTO task_agent_runs_new (
        id, task_id, agent_type, status, conversation_id, provider, driver,
        created_at, completed_at
      )
      SELECT
        id, task_id, agent_type, status, conversation_id, provider, driver,
        created_at, completed_at
      FROM task_agent_runs WHERE task_id IS NOT NULL;
      DROP TABLE task_agent_runs;
      ALTER TABLE task_agent_runs_new RENAME TO task_agent_runs;
      CREATE INDEX IF NOT EXISTS idx_task_agent_runs_task_id ON task_agent_runs(task_id);

      -- 3. Ownership moves into link tables.
      CREATE TABLE task_conversations (
        conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
      );
      INSERT INTO task_conversations (conversation_id, task_id)
        SELECT id, task_id FROM conversations WHERE task_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_task_conversations_task_id ON task_conversations(task_id);

      CREATE TABLE epic_conversations (
        conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE
      );
      INSERT INTO epic_conversations (conversation_id, epic_id)
        SELECT id, epic_id FROM conversations WHERE epic_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_epic_conversations_epic_id ON epic_conversations(epic_id);

      -- 4. conversations rebuilt owner-less, with the dispatch tag.
      CREATE TABLE conversations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('task', 'epic')),
        claude_conversation_id TEXT,
        session_path TEXT DEFAULT NULL,
        context_usage_json TEXT DEFAULT NULL,
        name TEXT DEFAULT NULL,
        provider TEXT NOT NULL DEFAULT 'anthropic',
        provider_session_id TEXT,
        model TEXT DEFAULT NULL,
        effort TEXT DEFAULT NULL,
        atlas_enabled INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO conversations_new (
        id, owner_kind, claude_conversation_id, session_path, context_usage_json,
        name, provider, provider_session_id, model, effort, atlas_enabled, created_at
      )
      SELECT
        id,
        CASE WHEN task_id IS NOT NULL THEN 'task' ELSE 'epic' END,
        claude_conversation_id, session_path, context_usage_json,
        name, provider, provider_session_id, model, effort, atlas_enabled, created_at
      FROM conversations;
      DROP TABLE conversations;
      ALTER TABLE conversations_new RENAME TO conversations;
      CREATE INDEX IF NOT EXISTS idx_conversations_claude_id ON conversations(claude_conversation_id);

      -- 5. Epic membership moves into epic_tickets.
      CREATE TABLE epic_tickets (
        epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (epic_id, task_id)
      );
      INSERT INTO epic_tickets (epic_id, task_id, position)
        SELECT epic_id, id, COALESCE(epic_order, id) FROM tasks WHERE epic_id IS NOT NULL;

      -- 6. tasks rebuilt without the epic columns.
      CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        base_branch TEXT DEFAULT NULL,
        title TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'in_review', 'completed')),
        workflow_complete INTEGER DEFAULT 0 NOT NULL,
        workflow_blocked INTEGER DEFAULT 0 NOT NULL,
        workflow_run_count INTEGER DEFAULT 0 NOT NULL,
        planification_complete INTEGER DEFAULT 0 NOT NULL,
        pr_agent_complete INTEGER DEFAULT 0 NOT NULL,
        refinement_complete INTEGER DEFAULT 0 NOT NULL,
        yolo_mode INTEGER DEFAULT 0 NOT NULL,
        completed_at DATETIME DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      INSERT INTO tasks_new (
        id, project_id, user_id, base_branch, title,
        status, workflow_complete, workflow_blocked, workflow_run_count,
        planification_complete, pr_agent_complete, refinement_complete, yolo_mode,
        completed_at, created_at, updated_at
      )
      SELECT
        id, project_id, user_id, base_branch, title,
        status, workflow_complete, workflow_blocked, workflow_run_count,
        planification_complete, pr_agent_complete, refinement_complete, yolo_mode,
        completed_at, created_at, updated_at
      FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
    `);

    // Invariants: nothing lost, nothing invented.
    const taskRunsAfter = count('SELECT COUNT(*) AS n FROM task_agent_runs');
    const epicRunsAfter = count('SELECT COUNT(*) AS n FROM epic_agent_runs');
    if (taskRunsAfter + epicRunsAfter !== runsBefore || epicRunsAfter !== epicRunsBefore) {
      throw new Error(
        `owner-table split changed the run count (${runsBefore} -> ${taskRunsAfter} task + ${epicRunsAfter} epic)`,
      );
    }
    const linkedRunsAfter =
      count('SELECT COUNT(*) AS n FROM task_agent_runs WHERE conversation_id IS NOT NULL') +
      count('SELECT COUNT(*) AS n FROM epic_agent_runs WHERE conversation_id IS NOT NULL');
    if (linkedRunsAfter !== linkedRunsBefore) {
      throw new Error(
        `owner-table split dropped run -> conversation links (${linkedRunsBefore} -> ${linkedRunsAfter})`,
      );
    }
    const conversationsAfter = count('SELECT COUNT(*) AS n FROM conversations');
    if (conversationsAfter !== conversationsBefore) {
      throw new Error(
        `owner-table split changed the conversation count (${conversationsBefore} -> ${conversationsAfter})`,
      );
    }
    const taskLinks = count('SELECT COUNT(*) AS n FROM task_conversations');
    const epicLinks = count('SELECT COUNT(*) AS n FROM epic_conversations');
    if (taskLinks !== taskConversationsBefore || taskLinks + epicLinks !== conversationsBefore) {
      throw new Error(
        `owner-table split lost conversation ownership (${taskLinks} task + ${epicLinks} epic of ${conversationsBefore})`,
      );
    }
    const tasksAfter = count('SELECT COUNT(*) AS n FROM tasks');
    if (tasksAfter !== tasksBefore) {
      throw new Error(`owner-table split changed the task count (${tasksBefore} -> ${tasksAfter})`);
    }
    const ticketsAfter = count('SELECT COUNT(*) AS n FROM epic_tickets');
    if (ticketsAfter !== ticketsBefore) {
      throw new Error(
        `owner-table split lost epic memberships (${ticketsBefore} -> ${ticketsAfter})`,
      );
    }
    const violationsAfter =
      countFkViolations(database, 'task_agent_runs') +
      countFkViolations(database, 'epic_agent_runs') +
      countFkViolations(database, 'conversations') +
      countFkViolations(database, 'task_conversations') +
      countFkViolations(database, 'epic_conversations') +
      countFkViolations(database, 'epic_tickets') +
      countFkViolations(database, 'tasks');
    if (violationsAfter > violationsBefore) {
      throw new Error(
        `owner-table split introduced ${violationsAfter - violationsBefore} foreign key violation(s)`,
      );
    }
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

/**
 * Foreign key violations touching one table. Used to verify a table rebuild:
 * the count must not GROW (a long-lived database can carry pre-existing
 * orphans from before foreign keys were enforced, and a migration is not the
 * place to delete user rows).
 */
function countFkViolations(database: Database.Database, table: string): number {
  return (database.pragma(`foreign_key_check(${table})`) as unknown[]).length;
}

/** Remove the retired worktree-occupancy pointer from an already-split DB. */
export function dropObsoleteWorktreeLease(database: Database.Database): boolean {
  const taskColumns = (
    database.prepare('PRAGMA table_info(tasks)').all() as ColumnInfoRow[]
  ).map((col) => col.name);
  if (!taskColumns.includes('worktree_lease_conversation_id')) return false;

  console.log('Running migration: Removing worktree lease column from tasks');
  database.exec('ALTER TABLE tasks DROP COLUMN worktree_lease_conversation_id');
  return true;
}

const runMigrations = (): void => {
  try {
    // Has the architecture-v2 step-5 owner-table split already happened (or
    // is this a fresh install born in the new shape)? Every epic-era legacy
    // migration below is gated on this: they probe for pre-split shapes, and
    // the post-split tables would otherwise LOOK pre-epic to them (no
    // epic_id anywhere) and be corrupted by a re-run.
    //
    // Probed off the CONVERSATIONS shape, not off the new tables' existence:
    // init.sql runs before migrations and its CREATE IF NOT EXISTS lays the
    // new (empty) tables down even on an old database, but it never touches
    // an existing `conversations` — so `owner_kind` is present exactly when
    // the split has really happened (or the install was born split).
    const v2SplitDone = !!(
      db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='conversations'`)
        .get() as { sql: string } | undefined
    )?.sql.includes('owner_kind');

    const tableInfo = db.prepare('PRAGMA table_info(users)').all() as ColumnInfoRow[];
    const columnNames = tableInfo.map((col) => col.name);

    if (!columnNames.includes('git_name')) {
      console.log('Running migration: Adding git_name column');
      db.exec('ALTER TABLE users ADD COLUMN git_name TEXT');
    }

    if (!columnNames.includes('git_email')) {
      console.log('Running migration: Adding git_email column');
      db.exec('ALTER TABLE users ADD COLUMN git_email TEXT');
    }

    if (!columnNames.includes('has_completed_onboarding')) {
      console.log('Running migration: Adding has_completed_onboarding column');
      db.exec('ALTER TABLE users ADD COLUMN has_completed_onboarding BOOLEAN DEFAULT 0');
    }

    if (!columnNames.includes('is_technical')) {
      console.log('Running migration: Adding is_technical column');
      db.exec('ALTER TABLE users ADD COLUMN is_technical BOOLEAN DEFAULT 1');
    }

    const tasksTableInfo = db.prepare('PRAGMA table_info(tasks)').all() as ColumnInfoRow[];
    const taskColumnNames = tasksTableInfo.map((col) => col.name);

    if (!taskColumnNames.includes('status')) {
      console.log('Running migration: Adding status column to tasks');
      db.exec("ALTER TABLE tasks ADD COLUMN status TEXT DEFAULT 'pending'");
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
    }

    if (!taskColumnNames.includes('workflow_complete')) {
      console.log('Running migration: Adding workflow_complete column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN workflow_complete INTEGER DEFAULT 0 NOT NULL');
    }

    if (!taskColumnNames.includes('planification_complete')) {
      console.log('Running migration: Adding planification_complete column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN planification_complete INTEGER DEFAULT 0 NOT NULL');
    }

    if (!taskColumnNames.includes('completed_at')) {
      console.log('Running migration: Adding completed_at column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN completed_at DATETIME DEFAULT NULL');
      db.exec(`
        UPDATE tasks
        SET completed_at = updated_at
        WHERE status = 'completed' AND completed_at IS NULL
      `);
    }

    if (!taskColumnNames.includes('workflow_blocked')) {
      console.log('Running migration: Adding workflow_blocked column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN workflow_blocked INTEGER DEFAULT 0 NOT NULL');
    }

    if (!taskColumnNames.includes('workflow_run_count')) {
      console.log('Running migration: Adding workflow_run_count column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN workflow_run_count INTEGER DEFAULT 0 NOT NULL');
    }

    if (!taskColumnNames.includes('pr_agent_complete')) {
      console.log('Running migration: Adding pr_agent_complete column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN pr_agent_complete INTEGER DEFAULT 0 NOT NULL');
    }

    if (!taskColumnNames.includes('refinement_complete')) {
      console.log('Running migration: Adding refinement_complete column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN refinement_complete INTEGER DEFAULT 0 NOT NULL');
    }

    if (!taskColumnNames.includes('yolo_mode')) {
      console.log('Running migration: Adding yolo_mode column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN yolo_mode INTEGER DEFAULT 0 NOT NULL');
    }

    // `task_landings` was introduced with the durable merge saga. Early
    // installations had retryable cleanup state but no way to distinguish an
    // externally merged PR whose worktree never passed our safety checkpoint.
    const landingColumnNames = (
      db.prepare('PRAGMA table_info(task_landings)').all() as ColumnInfoRow[]
    ).map((col) => col.name);
    if (!landingColumnNames.includes('cleanup_retryable')) {
      console.log('Running migration: Adding cleanup_retryable to task_landings');
      db.exec(
        'ALTER TABLE task_landings ADD COLUMN cleanup_retryable INTEGER NOT NULL DEFAULT 1 CHECK(cleanup_retryable IN (0, 1))',
      );
    }

    try {
      db.prepare('SELECT 1 FROM task_agent_runs LIMIT 1').get();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('no such table')) {
        console.log('Running migration: Creating task_agent_runs table');
        db.exec(`
          CREATE TABLE IF NOT EXISTS task_agent_runs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id INTEGER NOT NULL,
              agent_type TEXT NOT NULL CHECK(agent_type IN ('planification', 'implementation', 'review', 'pr')),
              status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
              conversation_id INTEGER,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              completed_at DATETIME,
              FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
              FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
          );
          CREATE INDEX IF NOT EXISTS idx_task_agent_runs_task_id ON task_agent_runs(task_id);
        `);
      }
    }

    try {
      const checkAgentType = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='task_agent_runs'`)
        .get() as { sql: string } | undefined;

      if (checkAgentType && !checkAgentType.sql.includes("'pr'")) {
        console.log('Running migration: Adding pr agent type to task_agent_runs');
        db.exec(`
          CREATE TABLE task_agent_runs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            agent_type TEXT NOT NULL CHECK(agent_type IN ('planification', 'implementation', 'review', 'pr')),
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
            conversation_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
          );
          INSERT INTO task_agent_runs_new SELECT * FROM task_agent_runs;
          DROP TABLE task_agent_runs;
          ALTER TABLE task_agent_runs_new RENAME TO task_agent_runs;
          CREATE INDEX idx_task_agent_runs_task_id ON task_agent_runs(task_id);
        `);
      }
    } catch (migrationError) {
      const message = migrationError instanceof Error ? migrationError.message : String(migrationError);
      console.error('Error migrating task_agent_runs for pr agent type:', message);
    }

    try {
      const checkAgentType = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='task_agent_runs'`)
        .get() as { sql: string } | undefined;

      if (checkAgentType && !checkAgentType.sql.includes("'refinement'")) {
        console.log('Running migration: Adding refinement agent type to task_agent_runs');
        db.exec(`
          CREATE TABLE task_agent_runs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            agent_type TEXT NOT NULL CHECK(agent_type IN ('planification', 'implementation', 'refinement', 'review', 'pr')),
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
            conversation_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
          );
          INSERT INTO task_agent_runs_new SELECT * FROM task_agent_runs;
          DROP TABLE task_agent_runs;
          ALTER TABLE task_agent_runs_new RENAME TO task_agent_runs;
          CREATE INDEX idx_task_agent_runs_task_id ON task_agent_runs(task_id);
        `);
      }
    } catch (migrationError) {
      const message = migrationError instanceof Error ? migrationError.message : String(migrationError);
      console.error('Error migrating task_agent_runs for refinement agent type:', message);
    }

    try {
      const checkAgentType = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='task_agent_runs'`)
        .get() as { sql: string } | undefined;

      if (checkAgentType && !checkAgentType.sql.includes("'yolo'")) {
        console.log('Running migration: Adding yolo agent type to task_agent_runs');
        db.exec(`
          CREATE TABLE task_agent_runs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            agent_type TEXT NOT NULL CHECK(agent_type IN ('planification', 'implementation', 'refinement', 'review', 'pr', 'yolo')),
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
            conversation_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
          );
          INSERT INTO task_agent_runs_new SELECT * FROM task_agent_runs;
          DROP TABLE task_agent_runs;
          ALTER TABLE task_agent_runs_new RENAME TO task_agent_runs;
          CREATE INDEX idx_task_agent_runs_task_id ON task_agent_runs(task_id);
        `);
      }
    } catch (migrationError) {
      const message = migrationError instanceof Error ? migrationError.message : String(migrationError);
      console.error('Error migrating task_agent_runs for yolo agent type:', message);
    }

    try {
      const checkStatus = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='task_agent_runs'`)
        .get() as { sql: string } | undefined;

      if (checkStatus && checkStatus.sql.includes("'paused'")) {
        console.log('Running migration: Dropping paused status from task_agent_runs');
        db.exec(`
          UPDATE task_agent_runs SET status = 'completed' WHERE status = 'paused';
          CREATE TABLE task_agent_runs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            agent_type TEXT NOT NULL CHECK(agent_type IN ('planification', 'implementation', 'refinement', 'review', 'pr', 'yolo')),
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'blocked')),
            conversation_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
          );
          INSERT INTO task_agent_runs_new SELECT * FROM task_agent_runs;
          DROP TABLE task_agent_runs;
          ALTER TABLE task_agent_runs_new RENAME TO task_agent_runs;
          CREATE INDEX idx_task_agent_runs_task_id ON task_agent_runs(task_id);
        `);
      }
    } catch (migrationError) {
      const message = migrationError instanceof Error ? migrationError.message : String(migrationError);
      console.error('Error migrating task_agent_runs to drop paused status:', message);
    }

    const convTableInfoUpdated = db
      .prepare('PRAGMA table_info(conversations)')
      .all() as ColumnInfoRow[];
    const convColumnNamesUpdated = convTableInfoUpdated.map((col) => col.name);

    if (!convColumnNamesUpdated.includes('session_path')) {
      console.log('Running migration: Adding session_path column to conversations');
      db.exec('ALTER TABLE conversations ADD COLUMN session_path TEXT DEFAULT NULL');
    }

    if (!convColumnNamesUpdated.includes('name')) {
      console.log('Running migration: Adding name column to conversations');
      db.exec('ALTER TABLE conversations ADD COLUMN name TEXT DEFAULT NULL');
    }

    if (!convColumnNamesUpdated.includes('context_usage_json')) {
      console.log('Running migration: Adding context_usage_json column to conversations');
      db.exec('ALTER TABLE conversations ADD COLUMN context_usage_json TEXT DEFAULT NULL');
    }

    if (!convColumnNamesUpdated.includes('provider')) {
      console.log('Running migration: Adding provider column to conversations (default anthropic)');
      db.exec("ALTER TABLE conversations ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic'");
    }

    if (!convColumnNamesUpdated.includes('provider_session_id')) {
      console.log('Running migration: Adding provider_session_id column to conversations');
      db.exec('ALTER TABLE conversations ADD COLUMN provider_session_id TEXT DEFAULT NULL');
    }

    // model / effort — the exact (model, effort) a conversation runs, so resume
    // is deterministic instead of relying on the SDK silently reusing or
    // defaulting a model. Backfill legacy rows: Anthropic/OpenAI get the
    // historical default model; OpenCode rows recover their real model from the
    // mirrored transcript (its catalog is dynamic, so there is no constant to
    // fall back to). effort stays NULL for legacy rows (provider default).
    if (!convColumnNamesUpdated.includes('model')) {
      console.log('Running migration: Adding model column to conversations');
      db.exec('ALTER TABLE conversations ADD COLUMN model TEXT DEFAULT NULL');
      try {
        db.exec("UPDATE conversations SET model = 'opus' WHERE model IS NULL AND provider = 'anthropic'");
        db.exec("UPDATE conversations SET model = 'gpt-5.5' WHERE model IS NULL AND provider = 'openai'");
        db.exec(
          `UPDATE conversations SET model = (
             SELECT json_extract(m.entry_json, '$.message.model')
             FROM messages m
             WHERE m.session_id = conversations.claude_conversation_id
               AND json_extract(m.entry_json, '$.message.model') LIKE 'opencode/%'
             ORDER BY m.seq DESC LIMIT 1
           )
           WHERE model IS NULL AND provider = 'opencode'
             AND claude_conversation_id IS NOT NULL`,
        );
      } catch (backfillError) {
        const message =
          backfillError instanceof Error ? backfillError.message : String(backfillError);
        console.error('Error backfilling conversations.model:', message);
      }
    }

    if (!convColumnNamesUpdated.includes('effort')) {
      console.log('Running migration: Adding effort column to conversations');
      db.exec('ALTER TABLE conversations ADD COLUMN effort TEXT DEFAULT NULL');
    }

    // atlas_enabled — conversations started from the Explore (IDE) view carry
    // the in-process code-atlas MCP server; resume reads the flag off the row.
    if (!convColumnNamesUpdated.includes('atlas_enabled')) {
      console.log('Running migration: Adding atlas_enabled column to conversations');
      db.exec('ALTER TABLE conversations ADD COLUMN atlas_enabled INTEGER NOT NULL DEFAULT 0');
    }

    // task_agent_runs.provider — diagnostics only. Runtime always reads
    // the provider off the linked conversation row.
    const agentRunsTableInfo = db
      .prepare('PRAGMA table_info(task_agent_runs)')
      .all() as ColumnInfoRow[];
    const agentRunsColumnNames = agentRunsTableInfo.map((col) => col.name);
    if (agentRunsColumnNames.length > 0 && !agentRunsColumnNames.includes('provider')) {
      console.log('Running migration: Adding provider column to task_agent_runs (default anthropic)');
      db.exec("ALTER TABLE task_agent_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic'");
    }

    const projectsTableInfo = db
      .prepare('PRAGMA table_info(projects)')
      .all() as ColumnInfoRow[];
    const projectColumnNames = projectsTableInfo.map((col) => col.name);

    if (!projectColumnNames.includes('active_worktree_task_id')) {
      console.log('Running migration: Adding web server switching columns to projects');
      db.exec(`
        ALTER TABLE projects ADD COLUMN active_worktree_task_id INTEGER DEFAULT NULL;
        ALTER TABLE projects ADD COLUMN serve_symlink_path TEXT DEFAULT NULL;
        ALTER TABLE projects ADD COLUMN systemd_service_name TEXT DEFAULT NULL;
      `);
    }

    if (!projectColumnNames.includes('subproject_path')) {
      console.log('Running migration: Adding subproject_path column to projects for monorepo support');
      db.exec('ALTER TABLE projects ADD COLUMN subproject_path TEXT DEFAULT NULL');
    }

    // What "switch server" is currently serving, when it is an EPIC's delivery
    // worktree rather than a ticket's. A second nullable column rather than a
    // kind+id pair because `active_worktree_task_id` is the task layer's and
    // must stay exactly what it is; at most one of the two is ever set, which
    // `switchServedTarget` enforces by writing both on every switch.
    if (!projectColumnNames.includes('active_worktree_epic_id')) {
      console.log('Running migration: Adding active_worktree_epic_id column to projects');
      db.exec('ALTER TABLE projects ADD COLUMN active_worktree_epic_id INTEGER DEFAULT NULL');
    }

    if (!projectColumnNames.includes('app_url')) {
      console.log('Running migration: Adding app_url column to projects for "switch server" tab opening');
      db.exec('ALTER TABLE projects ADD COLUMN app_url TEXT DEFAULT NULL');
    }

    // The per-project "sensitive areas" list: the parts of the application a
    // non-technical user must not change without a technical review. Read by
    // the non-technical planification prompt only; NULL or blank = guardrail off.
    if (!projectColumnNames.includes('sensitive_areas')) {
      console.log('Running migration: Adding sensitive_areas column to projects (non-technical planning guardrail)');
      db.exec('ALTER TABLE projects ADD COLUMN sensitive_areas TEXT DEFAULT NULL');
    }

    if (!columnNames.includes('is_admin')) {
      console.log('Running migration: Adding is_admin column to users');
      db.exec('ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT 0');
    }

    try {
      db.prepare('SELECT 1 FROM project_members LIMIT 1').get();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('no such table')) {
        console.log('Running migration: Creating project_members table');
        db.exec(`
          CREATE TABLE IF NOT EXISTS project_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(project_id, user_id)
          );
          CREATE INDEX IF NOT EXISTS idx_project_members_project_id ON project_members(project_id);
          CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON project_members(user_id);
        `);

        console.log('Running migration: Migrating existing project ownership to memberships');
        db.exec(`
          INSERT INTO project_members (project_id, user_id)
          SELECT id, user_id FROM projects WHERE user_id IS NOT NULL
        `);
      }
    }

    if (!columnNames.includes('api_key_hash')) {
      console.log('Running migration: Adding api_key_hash column to users');
      db.exec('ALTER TABLE users ADD COLUMN api_key_hash TEXT');
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key_hash
        ON users(api_key_hash) WHERE api_key_hash IS NOT NULL
      `);
    }

    if (!columnNames.includes('api_key_last_used_at')) {
      console.log('Running migration: Adding api_key_last_used_at column to users');
      db.exec('ALTER TABLE users ADD COLUMN api_key_last_used_at DATETIME');
    }

    if (!columnNames.includes('token_version')) {
      console.log('Running migration: Adding token_version column to users');
      db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1');
    }

    if (!taskColumnNames.includes('user_id')) {
      console.log('Running migration: Adding user_id column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
      db.exec(`
        UPDATE tasks
        SET user_id = (SELECT user_id FROM projects WHERE projects.id = tasks.project_id)
        WHERE user_id IS NULL
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)');
    }

    // ---- Epics -------------------------------------------------------------
    // Everything in this section must run AFTER the per-column `conversations`
    // and `task_agent_runs` ALTERs above: the two table rebuilds below copy an
    // explicit column list that includes those ALTER-added columns.

    try {
      db.prepare('SELECT 1 FROM epics LIMIT 1').get();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('no such table')) {
        console.log('Running migration: Creating epics table');
        db.exec(`
          CREATE TABLE IF NOT EXISTS epics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            slug TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
                CHECK(status IN ('active', 'completed', 'cancelled')),
            architecture_complete INTEGER NOT NULL DEFAULT 0,
            specs_complete INTEGER NOT NULL DEFAULT 0,
            stories_complete INTEGER NOT NULL DEFAULT 0,
            feature_branch TEXT DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME DEFAULT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_epics_project_id ON epics(project_id);
        `);
      }
    }

    // Which ticket an orchestrator run supervises (Phase 7). A plain nullable
    // column beside the owner columns — an orchestrator run belongs to the
    // epic, and this records the ticket it is driving.
    const agentRunTicketColumns = (
      db.prepare('PRAGMA table_info(task_agent_runs)').all() as ColumnInfoRow[]
    ).map((col) => col.name);
    if (!v2SplitDone && !agentRunTicketColumns.includes('ticket_task_id')) {
      console.log('Running migration: Adding ticket_task_id column to task_agent_runs');
      db.exec(
        'ALTER TABLE task_agent_runs ADD COLUMN ticket_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL',
      );
    }

    // Orchestration flags (Phase 7). Plain guarded ALTERs — the current ticket
    // and the bridge counters are derived or in-memory, so these three columns
    // are all the orchestrator needs to persist.
    const epicOrchestrationColumns = (
      db.prepare('PRAGMA table_info(epics)').all() as ColumnInfoRow[]
    ).map((col) => col.name);

    if (!epicOrchestrationColumns.includes('orchestration_active')) {
      console.log('Running migration: Adding orchestration columns to epics');
      db.exec('ALTER TABLE epics ADD COLUMN orchestration_active INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE epics ADD COLUMN orchestration_blocked INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE epics ADD COLUMN orchestration_blocked_reason TEXT DEFAULT NULL');
    }

    const tasksEpicColumns = (
      db.prepare('PRAGMA table_info(tasks)').all() as ColumnInfoRow[]
    ).map((col) => col.name);

    if (!v2SplitDone && !tasksEpicColumns.includes('epic_id')) {
      console.log('Running migration: Adding epic_id column to tasks');
      db.exec(
        'ALTER TABLE tasks ADD COLUMN epic_id INTEGER REFERENCES epics(id) ON DELETE SET NULL',
      );
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id)');
    }

    if (!v2SplitDone && !tasksEpicColumns.includes('epic_order')) {
      console.log('Running migration: Adding epic_order column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN epic_order INTEGER DEFAULT NULL');
    }

    // tasks.base_branch — what this task forks from and merges into
    // (architecture-v2 step 3). Backfilled from the owning epic's feature
    // branch so existing epic tickets keep their base; standalone tasks stay
    // NULL (= the repo's default branch, resolved at use).
    if (!tasksEpicColumns.includes('base_branch')) {
      console.log('Running migration: Adding base_branch column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN base_branch TEXT DEFAULT NULL');
      db.exec(`
        UPDATE tasks
        SET base_branch = (SELECT feature_branch FROM epics WHERE epics.id = tasks.epic_id)
        WHERE epic_id IS NOT NULL
          AND (SELECT feature_branch FROM epics WHERE epics.id = tasks.epic_id) IS NOT NULL
      `);
    }

    // The specification-review gate (a fourth stage flag). Placed after BOTH
    // the orchestration columns and the `tasks.epic_id` ALTER: the backfill
    // reads `orchestration_active` and joins tickets through `tasks.epic_id`.
    // Re-read the column list — the orchestration block above may have just
    // added columns since `epicOrchestrationColumns` was taken.
    const epicReviewColumns = (
      db.prepare('PRAGMA table_info(epics)').all() as ColumnInfoRow[]
    ).map((col) => col.name);
    if (!epicReviewColumns.includes('review_complete')) {
      console.log('Running migration: Adding review_complete column to epics');
      db.exec('ALTER TABLE epics ADD COLUMN review_complete INTEGER NOT NULL DEFAULT 0');
      backfillReviewCompleteForStartedEpics(db);
    }

    // The QA-scenarios sign-off (fifth stage flag). Deliberately NO backfill,
    // unlike review_complete: a QA that never ran is honestly incomplete, and
    // nothing downstream is blocked by a 0 except the new QA-execution button.
    if (!epicReviewColumns.includes('qa_complete')) {
      console.log('Running migration: Adding qa_complete column to epics');
      db.exec('ALTER TABLE epics ADD COLUMN qa_complete INTEGER NOT NULL DEFAULT 0');
    }

    // conversations: task-scoped -> task-OR-epic-scoped. This is a rebuild of a
    // PARENT table (task_agent_runs.conversation_id references it with
    // ON DELETE SET NULL), so it follows the SQLite 12-step procedure with
    // foreign_keys OFF — a plain DROP with foreign keys ON would fire the
    // implicit delete and null out every run->conversation link. The INSERT
    // lists columns explicitly: the ALTER-added ones sit at different ordinal
    // positions on a migrated database than on a fresh one.
    const conversationsSchema = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='conversations'`)
      .get() as { sql: string } | undefined;

    if (!v2SplitDone && conversationsSchema && !conversationsSchema.sql.includes('epic_id')) {
      console.log('Running migration: Rebuilding conversations for task-or-epic scope');
      // Baselines: the rebuild must preserve every conversation and every
      // run->conversation link (the failure mode this whole dance exists to
      // prevent), and must not introduce new foreign key violations.
      const conversationCountBefore = (
        db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }
      ).n;
      const linkedRunsBefore = (
        db
          .prepare('SELECT COUNT(*) AS n FROM task_agent_runs WHERE conversation_id IS NOT NULL')
          .get() as { n: number }
      ).n;
      const violationsBefore = countFkViolations(db, 'conversations');
      db.pragma('foreign_keys = OFF');
      try {
        db.exec(`
          CREATE TABLE conversations_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER,
            epic_id INTEGER,
            claude_conversation_id TEXT,
            session_path TEXT DEFAULT NULL,
            context_usage_json TEXT DEFAULT NULL,
            name TEXT DEFAULT NULL,
            provider TEXT NOT NULL DEFAULT 'anthropic',
            provider_session_id TEXT,
            model TEXT DEFAULT NULL,
            effort TEXT DEFAULT NULL,
            atlas_enabled INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            CHECK ((task_id IS NULL) + (epic_id IS NULL) = 1),
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (epic_id) REFERENCES epics(id) ON DELETE CASCADE
          );
          INSERT INTO conversations_new (
            id, task_id, epic_id, claude_conversation_id, session_path,
            context_usage_json, name, provider, provider_session_id, model,
            effort, atlas_enabled, created_at
          )
          SELECT
            id, task_id, NULL, claude_conversation_id, session_path,
            context_usage_json, name, provider, provider_session_id, model,
            effort, atlas_enabled, created_at
          FROM conversations;
          DROP TABLE conversations;
          ALTER TABLE conversations_new RENAME TO conversations;
          CREATE INDEX IF NOT EXISTS idx_conversations_task_id ON conversations(task_id);
          CREATE INDEX IF NOT EXISTS idx_conversations_epic_id ON conversations(epic_id);
          CREATE INDEX IF NOT EXISTS idx_conversations_claude_id ON conversations(claude_conversation_id);
        `);
        const conversationCountAfter = (
          db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }
        ).n;
        const linkedRunsAfter = (
          db
            .prepare('SELECT COUNT(*) AS n FROM task_agent_runs WHERE conversation_id IS NOT NULL')
            .get() as { n: number }
        ).n;
        if (conversationCountAfter !== conversationCountBefore) {
          throw new Error(
            `conversations rebuild changed the row count (${conversationCountBefore} -> ${conversationCountAfter})`,
          );
        }
        if (linkedRunsAfter !== linkedRunsBefore) {
          throw new Error(
            `conversations rebuild dropped agent-run links (${linkedRunsBefore} -> ${linkedRunsAfter})`,
          );
        }
        const violationsAfter = countFkViolations(db, 'conversations');
        if (violationsAfter > violationsBefore) {
          throw new Error(
            `conversations rebuild introduced ${violationsAfter - violationsBefore} foreign key violation(s)`,
          );
        }
      } finally {
        db.pragma('foreign_keys = ON');
      }
    }

    // Epic-scope index for the pre-split shape only.
    if (!v2SplitDone) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id)');
    }

    // task_agent_runs: task-scoped -> task-OR-epic-scoped, and the agent_type
    // CHECK widened to carry all four epic agent types at once (later phases
    // wire them up without another rebuild). Same explicit-column-list caution:
    // `provider` was ALTER-added above.
    const agentRunsSchema = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='task_agent_runs'`)
      .get() as { sql: string } | undefined;

    if (!v2SplitDone && agentRunsSchema && !agentRunsSchema.sql.includes('epic_id')) {
      console.log('Running migration: Rebuilding task_agent_runs for task-or-epic scope');
      const runCountBefore = (
        db.prepare('SELECT COUNT(*) AS n FROM task_agent_runs').get() as { n: number }
      ).n;
      const runViolationsBefore = countFkViolations(db, 'task_agent_runs');
      db.pragma('foreign_keys = OFF');
      try {
        db.exec(`
          CREATE TABLE task_agent_runs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER,
            epic_id INTEGER,
            agent_type TEXT NOT NULL CHECK(agent_type IN ('planification', 'implementation', 'refinement', 'review', 'pr', 'yolo', 'epic-architecture', 'epic-specification', 'epic-stories', 'epic-orchestrator')),
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
          INSERT INTO task_agent_runs_new (
            id, task_id, epic_id, agent_type, status, conversation_id, provider, ticket_task_id,
            created_at, completed_at
          )
          SELECT
            id, task_id, NULL, agent_type, status, conversation_id, provider, ticket_task_id,
            created_at, completed_at
          FROM task_agent_runs;
          DROP TABLE task_agent_runs;
          ALTER TABLE task_agent_runs_new RENAME TO task_agent_runs;
          CREATE INDEX IF NOT EXISTS idx_task_agent_runs_task_id ON task_agent_runs(task_id);
          CREATE INDEX IF NOT EXISTS idx_task_agent_runs_epic_id ON task_agent_runs(epic_id);
        `);
        const runCountAfter = (
          db.prepare('SELECT COUNT(*) AS n FROM task_agent_runs').get() as { n: number }
        ).n;
        if (runCountAfter !== runCountBefore) {
          throw new Error(
            `task_agent_runs rebuild changed the row count (${runCountBefore} -> ${runCountAfter})`,
          );
        }
        const runViolationsAfter = countFkViolations(db, 'task_agent_runs');
        if (runViolationsAfter > runViolationsBefore) {
          throw new Error(
            `task_agent_runs rebuild introduced ${runViolationsAfter - runViolationsBefore} foreign key violation(s)`,
          );
        }
      } finally {
        db.pragma('foreign_keys = ON');
      }
    }

    // task_agent_runs: widen the agent_type CHECK to admit every epic agent
    // type added after the epic rebuild ('epic-pr-review', then
    // 'epic-spec-review'). SQLite cannot alter a CHECK in place, so this is the
    // same rebuild as above, keyed on the constraint text: a fresh install
    // arrives from init.sql already widened and skips it; a database whose
    // CHECK predates the newest type runs it exactly once.
    if (!v2SplitDone) widenAgentRunTypeCheck(db);

    // task_agent_runs.driver — who started the run (architecture-v2 step 2).
    // Placed AFTER the rebuilds above so an old database is rebuilt on its
    // pre-driver shape first, then gains the column; a fresh install arrives
    // from init.sql already carrying it.
    const agentRunDriverColumns = (
      db.prepare('PRAGMA table_info(task_agent_runs)').all() as ColumnInfoRow[]
    ).map((col) => col.name);
    if (!agentRunDriverColumns.includes('driver')) {
      console.log('Running migration: Adding driver column to task_agent_runs');
      db.exec(
        "ALTER TABLE task_agent_runs ADD COLUMN driver TEXT NOT NULL DEFAULT 'human' CHECK(driver IN ('human', 'automation'))",
      );
    }

    if (!v2SplitDone) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_conversations_epic_id ON conversations(epic_id);
        CREATE INDEX IF NOT EXISTS idx_task_agent_runs_epic_id ON task_agent_runs(epic_id);
      `);
    }

    // The architecture-v2 step-5 owner-table split. Runs exactly once, after
    // every required pre-split column exists.
    splitOwnerTables(db);

    // epic_agent_runs: widen the agent_type CHECK for every epic agent type
    // added after `splitOwnerTables` froze its list ('epic-delivery'). Placed
    // AFTER the split so a pre-split database gets the table created first (on
    // the split's historical six-type list) and is widened in the same boot;
    // a fresh install arrives widened from init.sql and skips it on the probe.
    widenEpicAgentRunTypeCheck(db);

    // The former PR-review worktree lease was a task-table pointer whose
    // liveness depended on an in-memory streaming session. Reviewer ownership
    // now lives entirely in epic_agent_runs. Fresh and pre-split databases are
    // already born without it; this guarded DROP cleans current split installs.
    dropObsoleteWorktreeLease(db);

    // tasks.workflow_blocked_reason — why the agent stopped, set by
    // `scripts/block-workflow.ts`. The epic orchestrator is woken with this
    // text, so a block is a report rather than a silent flag (mirrors
    // `epics.orchestration_blocked_reason`). Placed AFTER the split for the
    // same reason `driver` is: `splitOwnerTables` rebuilds `tasks` from a
    // fixed column list and would drop a column added before it.
    const blockedReasonColumns = (
      db.prepare('PRAGMA table_info(tasks)').all() as ColumnInfoRow[]
    ).map((col) => col.name);
    if (!blockedReasonColumns.includes('workflow_blocked_reason')) {
      console.log('Running migration: Adding workflow_blocked_reason column to tasks');
      db.exec('ALTER TABLE tasks ADD COLUMN workflow_blocked_reason TEXT DEFAULT NULL');
    }

    // tasks.worktree_state / worktree_error — the worktree is set up after the
    // task is created, so the row says whether it is usable yet. Existing rows
    // already have their worktree: they default to 'ready'. Placed after the
    // split for the same reason as workflow_blocked_reason.
    const worktreeStateColumns = (
      db.prepare('PRAGMA table_info(tasks)').all() as ColumnInfoRow[]
    ).map((col) => col.name);
    if (!worktreeStateColumns.includes('worktree_state')) {
      console.log('Running migration: Adding worktree_state/worktree_error columns to tasks');
      db.exec(
        "ALTER TABLE tasks ADD COLUMN worktree_state TEXT NOT NULL DEFAULT 'ready' CHECK(worktree_state IN ('provisioning', 'ready', 'failed'))",
      );
    }
    if (!worktreeStateColumns.includes('worktree_error')) {
      db.exec('ALTER TABLE tasks ADD COLUMN worktree_error TEXT DEFAULT NULL');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        project_key TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        subpath     TEXT NOT NULL DEFAULT '',
        uuid        TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        mtime       INTEGER NOT NULL,
        entry_json  BLOB NOT NULL,
        PRIMARY KEY (project_key, session_id, subpath, uuid)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_seq
        ON messages(project_key, session_id, subpath, seq);
      CREATE TABLE IF NOT EXISTS session_summaries (
        project_key  TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        mtime        INTEGER NOT NULL,
        summary_json BLOB NOT NULL,
        PRIMARY KEY (project_key, session_id)
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS user_agent_model_settings (
        user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        settings_json TEXT NOT NULL,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    backfillUserAgentModelSettings(db);
    // Must run after the per-user backfill above (which seeds the row) and
    // before any settings load, so the loud loader never trips on a pre-existing
    // row that predates the `schema` model key.
    backfillSchemaModelKey(db);
    // Same rationale as the `schema` backfill — the per-stage epic keys are
    // required by the loud loader (and replace the v0 `epic` key).
    backfillEpicStageModelKeys(db);
    // After the backfills above (they can materialize rows still carrying
    // retired ids) and before any settings load, for the same loud-loader reason.
    migrateRetiredOpenAiModels(db);
    // Same rationale, for the effort half of the pair (see the function's doc).
    migrateRetiredOpenAiEfforts(db);
    // One-shot: fold v0 `epic_runs` rows into real epics. Runs last — it needs
    // the epics table created above, and it writes spec files to the archive.
    // Sentinel-guarded, and a no-op when the legacy table was never created.
    convertEpicRunsToEpics(db);

    console.log('Database migrations completed successfully');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error running migrations:', message);
    throw error;
  }
};

const initializeDatabase = async (): Promise<void> => {
  try {
    const initSQL = fs.readFileSync(INIT_SQL_PATH, 'utf8');
    db.exec(initSQL);
    console.log('Database initialized successfully');
    runMigrations();
    // An `answered` portable question means its answers were submitted but no
    // continuation turn had been accepted yet (`askUserQuestion.ts` resolves
    // the row on acceptance). After a process restart no provider turn
    // survives: resolve an older answered row when a newer pending round
    // exists, otherwise reopen the latest answer so it can be submitted again
    // instead of remaining stuck.
    db.transaction(() => {
      db.prepare(
        `UPDATE conversation_questions AS answered
         SET status = 'resolved', resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP)
         WHERE answered.status = 'answered'
           AND EXISTS (
             SELECT 1 FROM conversation_questions AS pending
             WHERE pending.conversation_id = answered.conversation_id
               AND pending.status = 'pending'
           )`,
      ).run();
      db.prepare(
        `UPDATE conversation_questions
         SET status = 'pending', answers_json = NULL, answered_at = NULL
         WHERE status = 'answered'`,
      ).run();
    })();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error initializing database:', message);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// userDb
// ---------------------------------------------------------------------------

export interface CreatedUser {
  id: number;
  username: string;
}

// Subset of UserRow returned by getUserById/getFirstUser (no password_hash).
export type SafeUserRow = Pick<
  UserRow,
  'id' | 'username' | 'created_at' | 'last_login' | 'is_admin' | 'is_technical'
>;

export type AdminUserRow = Pick<
  UserRow,
  'id' | 'username' | 'created_at' | 'last_login' | 'is_active' | 'is_admin' | 'is_technical'
>;

export interface UserUpdates {
  username?: string;
  is_active?: 0 | 1 | boolean;
  is_admin?: 0 | 1 | boolean;
}

const userDb = {
  hasUsers: (): boolean => {
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    return row.count > 0;
  },

  createUser: (username: string, passwordHash: string): CreatedUser => {
    const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
    const result = stmt.run(username, passwordHash);
    return { id: lastInsertId(result.lastInsertRowid), username };
  },

  getUserByUsername: (username: string): UserRow | undefined => {
    return db
      .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
      .get(username) as UserRow | undefined;
  },

  updateLastLogin: (userId: number): void => {
    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
  },

  getUserById: (userId: number): SafeUserRow | undefined => {
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, is_admin, is_technical FROM users WHERE id = ? AND is_active = 1'
      )
      .get(userId) as SafeUserRow | undefined;
  },

  getFirstUser: (): SafeUserRow | undefined => {
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, is_admin, is_technical FROM users WHERE is_active = 1 LIMIT 1'
      )
      .get() as SafeUserRow | undefined;
  },

  getFirstAdmin: (): SafeUserRow | undefined => {
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, is_admin, is_technical FROM users WHERE is_active = 1 AND is_admin = 1 ORDER BY id ASC LIMIT 1'
      )
      .get() as SafeUserRow | undefined;
  },

  updateGitConfig: (userId: number, gitName: string | null, gitEmail: string | null): void => {
    db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(
      gitName,
      gitEmail,
      userId
    );
  },

  getGitConfig: (
    userId: number
  ): Pick<UserRow, 'git_name' | 'git_email'> | undefined => {
    return db
      .prepare('SELECT git_name, git_email FROM users WHERE id = ?')
      .get(userId) as Pick<UserRow, 'git_name' | 'git_email'> | undefined;
  },

  completeOnboarding: (userId: number): void => {
    db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?').run(userId);
  },

  hasCompletedOnboarding: (userId: number): boolean => {
    const row = db
      .prepare('SELECT has_completed_onboarding FROM users WHERE id = ?')
      .get(userId) as Pick<UserRow, 'has_completed_onboarding'> | undefined;
    return row?.has_completed_onboarding === 1;
  },

  updateIsTechnical: (userId: number, isTechnical: boolean): SafeUserRow | undefined => {
    db.prepare('UPDATE users SET is_technical = ? WHERE id = ?').run(isTechnical ? 1 : 0, userId);
    return userDb.getUserById(userId);
  },

  getAllUsers: (): AdminUserRow[] => {
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, is_active, is_admin, is_technical FROM users ORDER BY created_at DESC'
      )
      .all() as AdminUserRow[];
  },

  updateUser: (userId: number, updates: UserUpdates): SafeUserRow | undefined => {
    const allowedFields: ReadonlyArray<keyof UserUpdates> = ['username', 'is_active', 'is_admin'];
    const setClause: string[] = [];
    const values: unknown[] = [];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClause.push(`${field} = ?`);
        values.push(updates[field]);
      }
    }

    if (setClause.length === 0) {
      return userDb.getUserById(userId);
    }

    values.push(userId);
    const stmt = db.prepare(`UPDATE users SET ${setClause.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return userDb.getUserById(userId);
  },

  updatePassword: (userId: number, passwordHash: string): boolean => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
    return true;
  },

  deleteUser: (userId: number): boolean => {
    const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return result.changes > 0;
  },

  isAdmin: (userId: number): boolean => {
    const row = db
      .prepare('SELECT is_admin FROM users WHERE id = ?')
      .get(userId) as Pick<UserRow, 'is_admin'> | undefined;
    return row?.is_admin === 1;
  },

  setAdmin: (userId: number, isAdmin: boolean): SafeUserRow | undefined => {
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
    return userDb.getUserById(userId);
  },

  getTokenVersion: (userId: number): number | null => {
    const row = db
      .prepare('SELECT token_version FROM users WHERE id = ? AND is_active = 1')
      .get(userId) as Pick<UserRow, 'token_version'> | undefined;
    return row?.token_version ?? null;
  },

  bumpTokenVersion: (userId: number): number | null => {
    const stmt = db.prepare(
      'UPDATE users SET token_version = token_version + 1 WHERE id = ? RETURNING token_version'
    );
    const row = stmt.get(userId) as Pick<UserRow, 'token_version'> | undefined;
    return row?.token_version ?? null;
  },
};

// ---------------------------------------------------------------------------
// projectMembersDb
// ---------------------------------------------------------------------------

export interface ProjectMemberWithUserRow {
  id: number;
  username: string;
  created_at: string;
  is_admin: 0 | 1;
  joined_at: string;
}

const projectMembersDb = {
  addMember: (projectId: number, userId: number): boolean => {
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)'
    );
    const result = stmt.run(projectId, userId);
    return result.changes > 0;
  },

  removeMember: (projectId: number, userId: number): boolean => {
    const result = db
      .prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?')
      .run(projectId, userId);
    return result.changes > 0;
  },

  isMember: (projectId: number, userId: number): boolean => {
    const row = db
      .prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(projectId, userId);
    return !!row;
  },

  getProjectMembers: (projectId: number): ProjectMemberWithUserRow[] => {
    return db
      .prepare(
        `SELECT u.id, u.username, u.created_at, u.is_admin, pm.created_at as joined_at
         FROM project_members pm
         JOIN users u ON pm.user_id = u.id
         WHERE pm.project_id = ?
         ORDER BY pm.created_at ASC`
      )
      .all(projectId) as ProjectMemberWithUserRow[];
  },

  getUserProjects: (userId: number): ProjectRow[] => {
    return db
      .prepare(
        `SELECT p.*
         FROM projects p
         JOIN project_members pm ON p.id = pm.project_id
         WHERE pm.user_id = ?
         ORDER BY p.updated_at DESC`
      )
      .all(userId) as ProjectRow[];
  },

  getMemberCount: (projectId: number): number => {
    const row = db
      .prepare('SELECT COUNT(*) as count FROM project_members WHERE project_id = ?')
      .get(projectId) as { count: number };
    return row.count;
  },
};

// ---------------------------------------------------------------------------
// projectsDb
// ---------------------------------------------------------------------------

// `create` returns a hand-rolled summary (not a full ProjectRow) because the
// previous JS API made this shape part of the public contract.
export interface CreatedProject {
  id: number;
  userId: number;
  name: string;
  repoFolderPath: string;
  subprojectPath: string | null;
  sensitiveAreas: string | null;
}

export interface ProjectUpdates {
  name?: string;
  repo_folder_path?: string;
  subproject_path?: string | null;
  // null clears the list — the non-technical guardrail is then off.
  sensitive_areas?: string | null;
}

export interface WebServerConfig {
  serveSymlinkPath?: string | null | undefined;
  systemdServiceName?: string | null | undefined;
  // Public URL of the deployed app (e.g. https://app.example.com).
  // Opened in a new tab after a successful "switch server". Empty/null = no tab.
  appUrl?: string | null | undefined;
}

const projectsDb = {
  create: (
    userId: number,
    name: string,
    repoFolderPath: string,
    subprojectPath: string | null = null,
    sensitiveAreas: string | null = null
  ): CreatedProject => {
    const insertProject = db.prepare(
      'INSERT INTO projects (user_id, name, repo_folder_path, subproject_path, sensitive_areas) VALUES (?, ?, ?, ?, ?)'
    );
    const insertMember = db.prepare(
      'INSERT INTO project_members (project_id, user_id) VALUES (?, ?)'
    );

    const createWithMembership = db.transaction((): CreatedProject => {
      const result = insertProject.run(userId, name, repoFolderPath, subprojectPath, sensitiveAreas);
      const projectId = lastInsertId(result.lastInsertRowid);
      insertMember.run(projectId, userId);
      return { id: projectId, userId, name, repoFolderPath, subprojectPath, sensitiveAreas };
    });

    return createWithMembership();
  },

  getAll: (userId: number): ProjectRow[] => {
    return db
      .prepare(
        `SELECT p.* FROM projects p
         JOIN project_members pm ON p.id = pm.project_id
         WHERE pm.user_id = ?
         ORDER BY p.updated_at DESC`
      )
      .all(userId) as ProjectRow[];
  },

  getById: (id: number, userId: number): ProjectRow | undefined => {
    return db
      .prepare(
        `SELECT p.* FROM projects p
         JOIN project_members pm ON p.id = pm.project_id
         WHERE p.id = ? AND pm.user_id = ?`
      )
      .get(id, userId) as ProjectRow | undefined;
  },

  getByIdAdmin: (id: number): ProjectRow | undefined => {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  },

  getAllAdmin: (): ProjectRow[] => {
    return db
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
      .all() as ProjectRow[];
  },

  update: (
    id: number,
    userId: number,
    updates: ProjectUpdates
  ): ProjectRow | undefined | null => {
    const project = projectsDb.getById(id, userId);
    if (!project) {
      return null;
    }

    const allowedFields: ReadonlyArray<keyof ProjectUpdates> = [
      'name',
      'repo_folder_path',
      'subproject_path',
      'sensitive_areas',
    ];
    const setClause: string[] = [];
    const values: unknown[] = [];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClause.push(`${field} = ?`);
        values.push(updates[field]);
      }
    }

    if (setClause.length === 0) {
      return project;
    }

    setClause.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`UPDATE projects SET ${setClause.join(', ')} WHERE id = ?`);
    stmt.run(...values);

    return projectsDb.getById(id, userId);
  },

  delete: (id: number, userId: number): boolean => {
    const project = projectsDb.getById(id, userId);
    if (!project) {
      return false;
    }

    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return result.changes > 0;
  },

  /**
   * Record what the project's serving symlink now points at: a ticket worktree,
   * an epic's delivery worktree, or the main checkout (both null).
   *
   * BOTH columns are written on every call, which is what keeps "at most one is
   * set" true without a CHECK constraint — switching from a task to an epic has
   * to clear the task, and a reset has to clear both.
   */
  updateActiveWorktree: (
    id: number,
    userId: number,
    taskId: number | null,
    epicId: number | null = null
  ): ProjectRow | undefined | null => {
    const project = projectsDb.getById(id, userId);
    if (!project) {
      return null;
    }

    db.prepare(
      `UPDATE projects
       SET active_worktree_task_id = ?, active_worktree_epic_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(taskId, epicId, id);
    return projectsDb.getById(id, userId);
  },

  updateWebServerConfig: (
    id: number,
    userId: number,
    config: WebServerConfig
  ): ProjectRow | undefined | null => {
    const project = projectsDb.getById(id, userId);
    if (!project) {
      return null;
    }

    const { serveSymlinkPath, systemdServiceName, appUrl } = config;
    db.prepare(
      `UPDATE projects
       SET serve_symlink_path = ?, systemd_service_name = ?, app_url = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(serveSymlinkPath || null, systemdServiceName || null, appUrl || null, id);
    return projectsDb.getById(id, userId);
  },
};

// ---------------------------------------------------------------------------
// taskArtifactsDb
// ---------------------------------------------------------------------------

const taskArtifactsDb = {
  get: (taskId: number, kind: string): TaskArtifactRow | undefined => {
    return db
      .prepare('SELECT * FROM task_artifacts WHERE task_id = ? AND kind = ?')
      .get(taskId, kind) as TaskArtifactRow | undefined;
  },

  // Metadata only (no html blob) — feeds the kind switcher. Stable ordering by
  // kind so the switcher segments don't reshuffle between fetches.
  list: (taskId: number): TaskArtifactSummaryRow[] => {
    return db
      .prepare(
        'SELECT task_id, kind, title, updated_at FROM task_artifacts WHERE task_id = ? ORDER BY kind',
      )
      .all(taskId) as TaskArtifactSummaryRow[];
  },

  // Last-write-wins single-statement upsert keyed on (task_id, kind): the
  // newest generation of a given kind replaces the previous one of that kind,
  // while distinct kinds coexist.
  upsert: (
    taskId: number,
    artifact: { kind: string; title: string | null; html: string },
  ): void => {
    db.prepare(
      `INSERT INTO task_artifacts (task_id, kind, title, html, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(task_id, kind) DO UPDATE SET
         title = excluded.title,
         html = excluded.html,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(taskId, artifact.kind, artifact.title, artifact.html);
  },
};

// ---------------------------------------------------------------------------
// appSettingsDb
// ---------------------------------------------------------------------------

// Per-agent provider/model/effort moved to per-user storage
// (`user_agent_model_settings`); it is no longer a global app-setting key.
// DEFAULT_AGENT_MODEL_SETTINGS is still used by the one-shot backfill above.
const APP_SETTINGS_DEFAULTS: Record<string, string> = {
  internal_tool_name: 'Bottega',
  github_pr_trigger: 'bottega',
};

const appSettingsDb = {
  getDefault: (key: string): string | null => APP_SETTINGS_DEFAULTS[key] ?? null,

  getValue: (key: string): string | null => {
    const row = db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(key) as Pick<AppSettingRow, 'value'> | undefined;
    if (row) return row.value;
    return APP_SETTINGS_DEFAULTS[key] ?? null;
  },

  getAll: (): Record<string, string> => {
    const rows = db
      .prepare('SELECT key, value FROM app_settings')
      .all() as Pick<AppSettingRow, 'key' | 'value'>[];
    const stored: Record<string, string> = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return { ...APP_SETTINGS_DEFAULTS, ...stored };
  },

  setValue: (key: string, value: string): string => {
    if (typeof value !== 'string') {
      throw new Error('app_settings value must be a string');
    }
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = CURRENT_TIMESTAMP`
    ).run(key, value);
    return value;
  },
};

// ---------------------------------------------------------------------------
// userAgentModelSettingsDb — per-user agent model settings (JSON blob per user)
// ---------------------------------------------------------------------------

const userAgentModelSettingsDb = {
  getRaw: (userId: number): string | null => {
    const row = db
      .prepare('SELECT settings_json FROM user_agent_model_settings WHERE user_id = ?')
      .get(userId) as Pick<UserAgentModelSettingsRow, 'settings_json'> | undefined;
    return row?.settings_json ?? null;
  },

  set: (userId: number, settingsJson: string): string => {
    if (typeof settingsJson !== 'string') {
      throw new Error('user_agent_model_settings value must be a string');
    }
    db.prepare(
      `INSERT INTO user_agent_model_settings (user_id, settings_json, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         settings_json = excluded.settings_json,
         updated_at = CURRENT_TIMESTAMP`
    ).run(userId, settingsJson);
    return settingsJson;
  },
};

export {
  db,
  initializeDatabase,
  userDb,
  projectsDb,
  projectMembersDb,
  taskArtifactsDb,
  appSettingsDb,
  userAgentModelSettingsDb,
};

// The per-owner query modules (architecture-v2 step 5). Task and
// conversation helpers are re-exported here for the broad task-side surface;
// the EPIC helpers are deliberately NOT — `server/database/epics.js` may only
// be imported by `server/services/epics/**` and `server/routes/epics.ts`
// (enforced by lint), so an accidental `epicsDb` import cannot hide behind
// this module.
export { tasksDb, taskAgentRunsDb, TaskWorktreeNotReadyError } from './tasks.js';
export type {
  CreatedTask,
  TaskUpdates,
  TaskWithProject,
  TaskWithProjectSummary,
} from './tasks.js';
export { conversationsDb } from './conversations.js';
export type { CreatedConversation } from './conversations.js';

// Re-export the row types so `.js` consumers can JSDoc-import from this module
// after conversion (avoids scattering imports of `shared/types/db.js`).
export type {
  UserRow,
  ProjectRow,
  ProjectMemberRow,
  TaskRow,
  TaskStatus,
  ConversationRow,
  AgentRunDriver,
  TaskAgentRunRow,
  AgentType,
  AgentRunStatus,
  AppSettingRow,
  UserAgentModelSettingsRow,
};
