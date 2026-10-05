// One-shot conversion of the v0 "Epic Planning" spike into real epics.
//
// The spike stored each architecture-diagram run as an unlinked `epic_runs`
// row: no epic entity, no conversation (conversations.task_id was NOT NULL),
// uploaded spec files serialized into `spec_json`, and the two mermaid diagrams
// in dedicated columns. Phase 2 introduced the `epics` entity, so those runs
// are folded into it: one epic per (project, name), its spec files written into
// the epic archive on disk. The v0 diagrams are NOT carried over: the
// architecture stage no longer produces a BEFORE/AFTER pair (it writes an
// architecture document), and the `epic_artifacts` table that once held them is
// gone from fresh installs. They only count towards `architecture_complete` —
// the stage had genuinely been run — and stay readable in the legacy table.
//
// The legacy table itself is deliberately left in place (dead, never written
// again): this migration only reads it. Fresh installs never create it, so the
// `no such table` path is the normal case there.

import type Database from 'better-sqlite3';
import { saveEpicSpecFile } from '../services/epics/epicArchive.js';
import { slugifyEpicName } from '../../shared/utils/slug.js';
import type { EpicSpecFile } from '../../shared/types/db.js';

const SENTINEL_KEY = 'epic_runs_converted';

interface LegacyEpicRunRow {
  id: number;
  project_id: number;
  user_id: number | null;
  name: string;
  spec_json: string;
  status: string;
  before_mermaid: string | null;
  after_mermaid: string | null;
  created_at: string;
  completed_at: string | null;
}

function markConverted(database: Database.Database): void {
  database
    .prepare(
      `INSERT OR REPLACE INTO app_settings (key, value, updated_at)
       VALUES (?, '1', CURRENT_TIMESTAMP)`,
    )
    .run(SENTINEL_KEY);
}

function parseSpecFiles(specJson: string): EpicSpecFile[] {
  try {
    const parsed: unknown = JSON.parse(specJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is EpicSpecFile =>
        !!f &&
        typeof f === 'object' &&
        typeof (f as EpicSpecFile).filename === 'string' &&
        typeof (f as EpicSpecFile).content === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Fold `epic_runs` rows into `epics` + archived spec files. Sentinel-guarded so
 * it runs exactly once; a no-op when the legacy table was never created.
 * Exported for testing.
 */
export function convertEpicRunsToEpics(database: Database.Database): void {
  const done = database
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(SENTINEL_KEY) as { value: string } | undefined;
  if (done) return;

  let runs: LegacyEpicRunRow[];
  try {
    runs = database
      .prepare(
        `SELECT id, project_id, user_id, name, spec_json, status,
                before_mermaid, after_mermaid, created_at, completed_at
           FROM epic_runs
          ORDER BY id ASC`,
      )
      .all() as LegacyEpicRunRow[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('no such table')) {
      // Fresh install: nothing to convert, and nothing will ever appear.
      markConverted(database);
      return;
    }
    console.error('Error reading epic_runs for conversion:', message);
    return;
  }

  if (runs.length === 0) {
    markConverted(database);
    return;
  }

  console.log(`Running migration: Converting ${runs.length} epic_runs row(s) into epics`);

  // One epic per (project, name): that pair is what the v0 UI treated as "the
  // same epic, re-run with notes".
  const groups = new Map<string, LegacyEpicRunRow[]>();
  for (const run of runs) {
    const key = `${run.project_id}:${run.name}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(run);
    else groups.set(key, [run]);
  }

  const insertEpic = database.prepare(
    `INSERT INTO epics (
       project_id, user_id, name, slug, status, architecture_complete,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
  );
  // Spec files are written to disk AFTER the DB transaction commits: a rolled
  // back transaction must not leave an archive behind for an epic id that no
  // longer exists.
  const pendingSpecWrites: Array<{
    projectId: number;
    epicId: number;
    files: EpicSpecFile[];
  }> = [];

  const convert = database.transaction(() => {
    for (const bucket of groups.values()) {
      // The latest run defines the epic's identity. The stage counts as
      // complete when any run produced a full diagram pair — the historical
      // fact the flag records.
      const latest = bucket[bucket.length - 1]!;
      const withDiagrams = bucket.some(
        (r) => r.status === 'completed' && !!r.before_mermaid && !!r.after_mermaid,
      );

      const info = insertEpic.run(
        latest.project_id,
        latest.user_id,
        latest.name,
        slugifyEpicName(latest.name),
        withDiagrams ? 1 : 0,
        latest.created_at,
        latest.completed_at ?? latest.created_at,
      );
      const epicId = Number(info.lastInsertRowid);

      const files = parseSpecFiles(latest.spec_json);
      if (files.length > 0) {
        pendingSpecWrites.push({ projectId: latest.project_id, epicId, files });
      }
    }
    markConverted(database);
  });

  convert();

  for (const { projectId, epicId, files } of pendingSpecWrites) {
    for (const file of files) {
      try {
        saveEpicSpecFile(projectId, epicId, file.filename, Buffer.from(file.content, 'utf8'));
      } catch (error) {
        // A filesystem failure must not undo an otherwise-good conversion: the
        // epic is already committed, and the user can re-upload the spec file.
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `Failed to archive spec file '${file.filename}' for epic ${epicId}:`,
          message,
        );
      }
    }
  }
}
