// The SQLite connection, alone. Split out of db.ts (architecture-v2 step 5)
// so the per-owner query modules (tasks.ts / epics.ts / conversations.ts) can
// share it without importing the migration machinery — and without creating a
// cycle with db.ts, which re-exports them.

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { openDatabase } from './sqlite.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

const c = {
  info: (text: string) => `${colors.cyan}${text}${colors.reset}`,
  bright: (text: string) => `${colors.bright}${text}${colors.reset}`,
  dim: (text: string) => `${colors.dim}${text}${colors.reset}`,
};

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'bottega.db');

/**
 * The database file this process opened. Exported so boot can decide whether
 * it owns it (see `ownership.ts`) — the path as configured, not resolved.
 */
export const databasePath = DB_PATH;

if (process.env.DATABASE_PATH) {
  const dbDir = path.dirname(DB_PATH);
  try {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`Created database directory: ${dbDir}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to create database directory ${dbDir}:`, message);
    throw error;
  }
}

// Legacy filename was `auth.db`, which misleadingly suggested the file held
// only auth data — in fact every domain table lives there too. Rename in
// place on first boot after the upgrade. Skipped when DATABASE_PATH is set
// (custom paths are the user's responsibility). Race-safe: vitest workers
// all import this module in parallel, so multiple processes may attempt the
// rename simultaneously — the loser sees ENOENT and falls through.
if (!process.env.DATABASE_PATH) {
  const legacyPath = path.join(__dirname, 'auth.db');
  if (fs.existsSync(legacyPath) && !fs.existsSync(DB_PATH)) {
    try {
      fs.renameSync(legacyPath, DB_PATH);
      console.log(`Renamed legacy DB: ${legacyPath} -> ${DB_PATH}`);
    } catch (err) {
      if (!fs.existsSync(DB_PATH)) throw err;
    }
  }
}

// The busy timeout, foreign keys and WAL journaling are set in `openDatabase`
// — see sqlite.ts for why the file is opened the way it is.
export const db = openDatabase(DB_PATH);

const appInstallPath = path.join(__dirname, '../..');
console.log('');
console.log(c.dim('═'.repeat(60)));
console.log(`${c.info('[INFO]')} App Installation: ${c.bright(appInstallPath)}`);
console.log(`${c.info('[INFO]')} Database: ${c.dim(path.relative(appInstallPath, DB_PATH))}`);
if (process.env.DATABASE_PATH) {
  console.log(`       ${c.dim('(Using custom DATABASE_PATH from environment)')}`);
}
// A worktree's `server/database/bottega.db` is a symlink to the live file,
// so this banner otherwise reads exactly the same on a dev server as on the
// service it is quietly sharing a database with. Name the target.
try {
  const resolved = fs.realpathSync(DB_PATH);
  if (resolved !== path.resolve(DB_PATH)) {
    console.log(`       ${c.dim(`-> ${resolved}`)}`);
  }
} catch {
  // A path we cannot resolve is not worth failing a boot over.
}
console.log(
  `       ${c.dim(
    `journal_mode=${String(db.pragma('journal_mode', { simple: true }))}, ` +
      `busy_timeout=${String(db.pragma('busy_timeout', { simple: true }))}ms`,
  )}`,
);
console.log(c.dim('═'.repeat(60)));
console.log('');

export const lastInsertId = (rowid: number | bigint): number => Number(rowid);
