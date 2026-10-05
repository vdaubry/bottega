// Talking to the SQLite engine itself: opening a connection with the busy
// timeout and pragmas every Bottega process needs, and recognising the one
// error class that is a property of the *environment* rather than of the code.
//
// Bottega is not the only process on its database file. On a development host the
// live service, any worktree dev server (whose `server/database/bottega.db`
// is a symlink to the live file), the sqlite3 CLI in a shell and `.backup`
// copies all open the same file, and SQLite arbitrates them with file locks.
// better-sqlite3 is synchronous: when a lock is held elsewhere a statement
// stalls the event loop for up to `timeout` ms and then throws a SqliteError
// with code SQLITE_BUSY ("database is locked").

import Database from 'better-sqlite3';

/**
 * How long a statement waits for a lock held by another connection before
 * throwing SQLITE_BUSY. better-sqlite3's default is 5 s. The wait is a
 * synchronous stall of the whole process, so this caps the worst case rather
 * than adding a delay that is always paid: the statement proceeds the moment
 * the lock frees. In WAL mode (below) only writer-vs-writer contention is
 * left, and a write transaction here lasts milliseconds — what reaches
 * seconds is another process's migration or maintenance on a 1.6 GB file,
 * which is worth waiting out rather than failing at 5 s.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 15_000;

/** A better-sqlite3 `SqliteError` whose code says "someone else holds the lock". */
export interface SqliteBusyError extends Error {
  code: string;
}

/**
 * Is this the SqliteError SQLite raises when another connection holds the
 * lock it needs — `SQLITE_BUSY` (a file lock, including the extended
 * `SQLITE_BUSY_*` codes) or `SQLITE_LOCKED` (a table lock, `SQLITE_LOCKED_*`)?
 * Both are transient and environmental, and the statement that hit them did
 * not run: retrying is the right answer, and a request boundary should say so
 * (503 + Retry-After) instead of treating it as a defect. Duck-typed on
 * `name` and `code` rather than `instanceof`, so it holds for an error thrown
 * by any copy of better-sqlite3 and across vitest realms.
 */
export function isSqliteBusyError(err: unknown): err is SqliteBusyError {
  if (typeof err !== 'object' || err === null) return false;
  const { name, code } = err as { name?: unknown; code?: unknown };
  return (
    name === 'SqliteError' &&
    typeof code === 'string' &&
    (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
  );
}

/**
 * Open a database the way every Bottega process should: the busy timeout
 * above, foreign keys on, and WAL journaling.
 *
 * WAL matters because in SQLite's default rollback-journal (`delete`) mode
 * readers and writers block each other around commits: a long SELECT in any
 * process (a backup, a scanning query in a shell, a worktree server's boot)
 * holds a shared lock that stops every writer's commit, and a commit in
 * progress stops every reader. On 2026-09-04 exactly that held the live file
 * long enough for an authenticated request's user lookup to throw SQLITE_BUSY,
 * which killed a server, and for the Codex transcript mirror to drop writes.
 * In WAL mode readers never block writers and writers never block readers;
 * only two writers contend, and they wait out the busy timeout instead of
 * colliding.
 *
 * The mode is recorded in the database header, so it is set once per file and
 * every later connection — including one another process opened earlier in
 * rollback mode — follows it on its next transaction. Switching needs a brief
 * exclusive lock, so it can fail while another connection is mid-read; that
 * is logged, not fatal, and the next boot retries. The operational side (the
 * `-wal` / `-shm` files, `.backup` as the way to copy the file) is in
 * `docs/architecture/data-model.md`.
 */
export function openDatabase(filePath: string): Database.Database {
  const db = new Database(filePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  db.pragma('foreign_keys = ON');
  const mode = enableWal(db);
  if (mode !== 'wal' && mode !== 'memory') {
    console.warn(
      `[db] journal_mode is "${mode}" — could not switch ${filePath} to WAL ` +
        '(another connection holds the file). Readers and writers block each ' +
        'other until a boot manages the switch.',
    );
  }
  return db;
}

/**
 * Best-effort `journal_mode = WAL`. Returns the mode actually in effect
 * afterwards: `wal` on success, `memory` for an in-memory database (which
 * has no journal to switch), or the previous mode when the switch could not
 * take its exclusive lock within the busy timeout.
 */
function enableWal(db: Database.Database): string {
  try {
    return String(db.pragma('journal_mode = WAL', { simple: true }));
  } catch (err) {
    if (!isSqliteBusyError(err)) throw err;
    return String(db.pragma('journal_mode', { simple: true }));
  }
}
