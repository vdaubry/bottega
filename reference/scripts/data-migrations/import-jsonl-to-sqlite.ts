#!/usr/bin/env node

/**
 * One-shot data migration: import historical Claude SDK JSONL transcripts into
 * the SQLite SessionStore tables (`messages`, `session_summaries`).
 *
 * THIS IS THE ONLY FILE IN THE CODEBASE THAT IS ALLOWED TO READ JSONL.
 * Everything else goes through SqliteSessionStore.
 *
 * Why: the multi-user CLAUDE_CONFIG_DIR change scattered transcripts across
 * per-user directories, while the legacy global directory still holds all
 * pre-multi-user conversations. After this script + the live sessionStore
 * wiring, all conversations live in one shared SQLite database, accessible
 * to any project member.
 *
 * Discovery roots:
 *   1. Legacy global:    ~/.claude/projects/{encodedProjectPath}/
 *   2. Per-user:         /var/lib/ccui/users/{userId}/.claude/projects/{encodedProjectPath}/
 *
 * Anchoring: the SDK encodes project dirs with `path.replace(/[^a-zA-Z0-9]/g,
 * '-')` (see `resolveProjectKey` in conversationContentStore.js — single
 * source of truth). We pre-compute the set of "known" projectKeys from
 * `projects.repo_folder_path` plus all worktree path patterns derived from
 * `tasks.id`. Files in directories that don't match any known projectKey are
 * skipped (orphans).
 *
 * Idempotency: PK on `messages` is (project_key, session_id, subpath, uuid),
 * with INSERT ... ON CONFLICT DO UPDATE. Re-running is safe.
 *
 * Usage:
 *   tsx scripts/data-migrations/import-jsonl-to-sqlite.ts          # full run
 *   tsx scripts/data-migrations/import-jsonl-to-sqlite.ts --dry-run # report only
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { foldSessionSummary } from '@anthropic-ai/claude-agent-sdk';
import type { Statement } from 'better-sqlite3';
import { db, initializeDatabase } from '../../server/database/db.js';
import { resolveProjectKey } from '../../server/services/conversationContentStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');

const PER_USER_ROOT = '/var/lib/ccui/users';
const LEGACY_ROOT = path.join(os.homedir(), '.claude');

function buildKnownProjectKeyMap(): Map<string, string> {
  // Map<projectKey, projectFolderPath> — repo paths and all derivable worktree
  // paths. The migration anchors a JSONL dir name to the first matching
  // canonical filesystem path here.
  const map = new Map<string, string>();

  const projects = db.prepare('SELECT id, repo_folder_path FROM projects').all() as Array<{
    id: number;
    repo_folder_path: string | null;
  }>;
  for (const project of projects) {
    if (!project.repo_folder_path) continue;
    map.set(resolveProjectKey(project.repo_folder_path), project.repo_folder_path);
  }

  const tasks = db.prepare(`
      SELECT t.id AS task_id, p.repo_folder_path
      FROM tasks t
      JOIN projects p ON t.project_id = p.id
      WHERE p.repo_folder_path IS NOT NULL
    `).all() as Array<{ task_id: number; repo_folder_path: string }>;
  for (const row of tasks) {
    const worktreePath = path.join(`${row.repo_folder_path}-worktrees`, `task-${row.task_id}`);
    map.set(resolveProjectKey(worktreePath), worktreePath);
  }

  // Also: conversations.session_path may reference a path we wouldn't otherwise
  // discover (e.g. monorepo sub-paths). Pull every distinct value as a fallback.
  const sessionPaths = db.prepare(
    "SELECT DISTINCT session_path FROM conversations WHERE session_path IS NOT NULL AND session_path != ''"
  ).all() as Array<{ session_path: string }>;
  for (const row of sessionPaths) {
    map.set(resolveProjectKey(row.session_path), row.session_path);
  }

  return map;
}

function buildClaudecodeuiSessionIdSet(): Set<string> {
  // Crucial scope check: only sessions registered as claudecodeui conversations
  // get imported. The legacy ~/.claude/projects/ tree also holds JSONL from raw
  // `claude` CLI usage and other tools that share the same dir; without this
  // filter the migration would mass-import ~3-4x too many transcripts.
  const rows = db.prepare(
    "SELECT DISTINCT claude_conversation_id FROM conversations WHERE claude_conversation_id IS NOT NULL AND claude_conversation_id != ''"
  ).all() as Array<{ claude_conversation_id: string }>;
  return new Set(rows.map(r => r.claude_conversation_id));
}

async function* readJsonlEntries(filePath: string): AsyncGenerator<Record<string, unknown>> {
  const stream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  ${colors.yellow}skip line ${lineNo}: parse error (${message})${colors.reset}`);
    }
  }
}

// Statements prepared lazily inside main() — the messages/session_summaries
// tables don't exist until initializeDatabase() has run.
let insertMessage: Statement;
let upsertSummary: Statement;
let selectSummary: Statement;
let selectMaxSeq: Statement;

function prepareStatements(): void {
  insertMessage = db.prepare(`
    INSERT INTO messages (project_key, session_id, subpath, uuid, seq, mtime, entry_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_key, session_id, subpath, uuid) DO UPDATE SET
      seq = excluded.seq,
      mtime = excluded.mtime,
      entry_json = excluded.entry_json
  `);
  upsertSummary = db.prepare(`
    INSERT INTO session_summaries (project_key, session_id, mtime, summary_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_key, session_id) DO UPDATE SET
      mtime = excluded.mtime,
      summary_json = excluded.summary_json
  `);
  selectSummary = db.prepare(
    'SELECT summary_json FROM session_summaries WHERE project_key = ? AND session_id = ?'
  );
  selectMaxSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), -1) AS max_seq FROM messages WHERE project_key = ? AND session_id = ? AND subpath = ?'
  );
}

interface ImportSessionFileArgs {
  filePath: string;
  projectKey: string;
  sessionId: string;
  subpath: string;
}

async function importSessionFile({
  filePath,
  projectKey,
  sessionId,
  subpath,
}: ImportSessionFileArgs): Promise<{ entriesImported: number }> {
  const entries: Array<Record<string, unknown>> = [];
  for await (const entry of readJsonlEntries(filePath)) {
    entries.push(entry);
  }
  if (entries.length === 0) return { entriesImported: 0 };
  if (DRY_RUN) return { entriesImported: entries.length };

  const fileMtime = (await fs.promises.stat(filePath)).mtimeMs;
  const startSeqRow = selectMaxSeq.get(projectKey, sessionId, subpath) as
    | { max_seq: number }
    | undefined;
  let nextSeq = (startSeqRow?.max_seq ?? -1) + 1;

  const txn = db.transaction(() => {
    for (const entry of entries) {
      const seq = nextSeq++;
      const uuid = (entry.uuid && typeof entry.uuid === 'string' && entry.uuid.length > 0)
        ? entry.uuid
        : `__no_uuid:${Math.floor(fileMtime)}:${seq}`;
      insertMessage.run(
        projectKey,
        sessionId,
        subpath,
        uuid,
        seq,
        Math.floor(fileMtime),
        JSON.stringify(entry)
      );
    }

    if (subpath === '') {
      const prevRow = selectSummary.get(projectKey, sessionId) as
        | { summary_json: string }
        | undefined;
      const prev = prevRow ? JSON.parse(prevRow.summary_json) : undefined;
      const summary = foldSessionSummary(prev, { projectKey, sessionId }, entries as never, { mtime: Math.floor(fileMtime) });
      upsertSummary.run(projectKey, sessionId, Math.floor(fileMtime), JSON.stringify(summary));
    }
  });
  txn();

  return { entriesImported: entries.length };
}

interface ImportProjectDirArgs {
  rootLabel: string;
  projectDir: string;
  knownKeys: Map<string, string>;
  knownSessionIds: Set<string>;
}

interface ImportProjectDirStats {
  jsonlScanned: number;
  jsonlImported: number;
  entriesImported: number;
  sessionsImported: number;
  skippedNonCcui: number;
  orphan: boolean;
}

async function importProjectDir({
  rootLabel,
  projectDir,
  knownKeys,
  knownSessionIds,
}: ImportProjectDirArgs): Promise<ImportProjectDirStats> {
  const projectDirName = path.basename(projectDir);
  const anchoredPath = knownKeys.get(projectDirName);
  if (!anchoredPath) {
    return { jsonlScanned: 0, jsonlImported: 0, entriesImported: 0, sessionsImported: 0, skippedNonCcui: 0, orphan: true };
  }
  const projectKey = projectDirName;

  const stats: ImportProjectDirStats = { jsonlScanned: 0, jsonlImported: 0, entriesImported: 0, sessionsImported: 0, skippedNonCcui: 0, orphan: false };

  let mainEntries: fs.Dirent[];
  try {
    mainEntries = await fs.promises.readdir(projectDir, { withFileTypes: true });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT') return stats;
    throw err;
  }

  for (const dirent of mainEntries) {
    if (dirent.isFile() && dirent.name.endsWith('.jsonl')) {
      stats.jsonlScanned++;
      const sessionId = path.basename(dirent.name, '.jsonl');
      // Skip JSONL files that don't correspond to a claudecodeui conversation
      // (raw `claude` CLI sessions, other tools, etc.).
      if (!knownSessionIds.has(sessionId)) {
        stats.skippedNonCcui++;
        continue;
      }
      try {
        const result = await importSessionFile({
          filePath: path.join(projectDir, dirent.name),
          projectKey,
          sessionId,
          subpath: ''
        });
        if (result.entriesImported > 0) {
          stats.jsonlImported++;
          stats.entriesImported += result.entriesImported;
          stats.sessionsImported++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  ${colors.red}error in ${dirent.name}: ${message}${colors.reset}`);
      }
      continue;
    }

    if (dirent.isDirectory()) {
      // Subagent transcripts live under <projectDir>/<sessionId>/subagents/*.jsonl
      const sessionId = dirent.name;
      // Subagent transcripts only matter if their parent session is one of ours.
      if (!knownSessionIds.has(sessionId)) continue;
      const subagentsDir = path.join(projectDir, sessionId, 'subagents');
      let subFiles: string[];
      try {
        subFiles = await fs.promises.readdir(subagentsDir);
      } catch {
        continue;
      }
      for (const sf of subFiles) {
        if (!sf.endsWith('.jsonl')) continue;
        stats.jsonlScanned++;
        const subpath = path.join(sessionId, 'subagents', sf);
        try {
          const result = await importSessionFile({
            filePath: path.join(subagentsDir, sf),
            projectKey,
            sessionId,
            subpath
          });
          if (result.entriesImported > 0) {
            stats.jsonlImported++;
            stats.entriesImported += result.entriesImported;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`  ${colors.red}error in subagent ${sf}: ${message}${colors.reset}`);
        }
      }
    }
  }

  if (stats.sessionsImported > 0 || stats.entriesImported > 0) {
    console.log(
      `  ${colors.green}✓${colors.reset} ${rootLabel} ${colors.dim}${projectDirName}${colors.reset} ` +
      `→ ${stats.sessionsImported} session(s), ${stats.entriesImported} entries` +
      (stats.skippedNonCcui > 0 ? ` ${colors.dim}(${stats.skippedNonCcui} non-ccui skipped)${colors.reset}` : '')
    );
  }
  return stats;
}

interface ImportRootArgs {
  root: string;
  label: string;
  knownKeys: Map<string, string>;
  knownSessionIds: Set<string>;
}

interface ImportRootStats {
  jsonlScanned: number;
  jsonlImported: number;
  entriesImported: number;
  sessionsImported: number;
  skippedNonCcui: number;
  orphans: number;
  projectsScanned: number;
}

async function importRoot({ root, label, knownKeys, knownSessionIds }: ImportRootArgs): Promise<ImportRootStats> {
  const projectsRoot = path.join(root, 'projects');
  let dirs: fs.Dirent[];
  try {
    dirs = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
    if (code === 'ENOENT') {
      console.log(`${colors.dim}  ${projectsRoot} does not exist; skipping${colors.reset}`);
      return { jsonlScanned: 0, jsonlImported: 0, entriesImported: 0, sessionsImported: 0, skippedNonCcui: 0, orphans: 0, projectsScanned: 0 };
    }
    throw err;
  }

  const totals: ImportRootStats = { jsonlScanned: 0, jsonlImported: 0, entriesImported: 0, sessionsImported: 0, skippedNonCcui: 0, orphans: 0, projectsScanned: 0 };

  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    totals.projectsScanned++;
    const stats = await importProjectDir({
      rootLabel: label,
      projectDir: path.join(projectsRoot, dirent.name),
      knownKeys,
      knownSessionIds
    });
    if (stats.orphan) {
      totals.orphans++;
      continue;
    }
    totals.jsonlScanned += stats.jsonlScanned;
    totals.jsonlImported += stats.jsonlImported;
    totals.entriesImported += stats.entriesImported;
    totals.sessionsImported += stats.sessionsImported;
    totals.skippedNonCcui += stats.skippedNonCcui;
  }

  return totals;
}

async function main(): Promise<void> {
  console.log(`${colors.bold}${colors.cyan}JSONL → SQLite session migration${colors.reset}`);
  if (DRY_RUN) console.log(`${colors.yellow}DRY RUN — no rows will be written${colors.reset}`);
  console.log('');

  await initializeDatabase();
  prepareStatements();

  const knownKeys = buildKnownProjectKeyMap();
  const knownSessionIds = buildClaudecodeuiSessionIdSet();
  console.log(`${colors.dim}Anchored ${knownKeys.size} projectKey(s) from projects + worktrees + session_paths${colors.reset}`);
  console.log(`${colors.dim}Scoped to ${knownSessionIds.size} claudecodeui sessionId(s) from conversations table${colors.reset}`);
  console.log('');

  console.log(`${colors.bold}[1/2]${colors.reset} Legacy global root: ${LEGACY_ROOT}`);
  const legacy = await importRoot({ root: LEGACY_ROOT, label: 'legacy ', knownKeys, knownSessionIds });
  console.log('');

  console.log(`${colors.bold}[2/2]${colors.reset} Per-user roots: ${PER_USER_ROOT}/*/.claude`);
  const perUser: ImportRootStats = { jsonlScanned: 0, jsonlImported: 0, entriesImported: 0, sessionsImported: 0, skippedNonCcui: 0, orphans: 0, projectsScanned: 0 };
  let userDirs: fs.Dirent[];
  try {
    userDirs = await fs.promises.readdir(PER_USER_ROOT, { withFileTypes: true });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined;
    if (code !== 'ENOENT') throw err;
    userDirs = [];
  }
  for (const userDirent of userDirs) {
    if (!userDirent.isDirectory()) continue;
    const userRoot = path.join(PER_USER_ROOT, userDirent.name, '.claude');
    const stats = await importRoot({ root: userRoot, label: `user-${userDirent.name}`, knownKeys, knownSessionIds });
    perUser.jsonlScanned += stats.jsonlScanned;
    perUser.jsonlImported += stats.jsonlImported;
    perUser.entriesImported += stats.entriesImported;
    perUser.sessionsImported += stats.sessionsImported;
    perUser.skippedNonCcui += stats.skippedNonCcui;
    perUser.orphans += stats.orphans;
    perUser.projectsScanned += stats.projectsScanned;
  }

  console.log('');
  console.log(`${colors.bold}${colors.cyan}Summary${colors.reset}`);
  console.log(`  Legacy:   ${legacy.sessionsImported} sessions, ${legacy.entriesImported} entries (${legacy.orphans} orphan dir(s), ${legacy.skippedNonCcui} non-ccui jsonl skipped)`);
  console.log(`  Per-user: ${perUser.sessionsImported} sessions, ${perUser.entriesImported} entries (${perUser.orphans} orphan dir(s), ${perUser.skippedNonCcui} non-ccui jsonl skipped)`);
  console.log(`  ${colors.bold}Total: ${legacy.sessionsImported + perUser.sessionsImported} sessions, ${legacy.entriesImported + perUser.entriesImported} entries${colors.reset}`);
  console.log('');
  if (DRY_RUN) {
    console.log(`${colors.yellow}Dry run complete — re-run without --dry-run to write rows.${colors.reset}`);
  } else {
    console.log(`${colors.green}✓ Migration complete. Original JSONL files were not modified.${colors.reset}`);
  }
}

main().catch(err => {
  console.error(`${colors.red}Migration failed: ${err.stack || err.message}${colors.reset}`);
  process.exit(1);
});
