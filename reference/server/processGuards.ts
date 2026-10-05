// Last-resort handlers for what nothing caught.
//
// Node's default for an uncaught exception or an unhandled rejection is to
// print it and exit, and for a programming error that is right: the process
// is in a state nobody reasoned about, and systemd restarts it. This module
// keeps that default for every error but one class.
//
// SQLITE_BUSY / SQLITE_LOCKED are different in kind. They are not a defect in
// this code but a property of the moment — another process (a worktree dev
// server, the sqlite3 CLI, a backup) holding the shared database file — and
// the statement that hit the lock did not run, so nothing is half-applied:
// SQLite statements are atomic, and better-sqlite3 rolls a transaction back
// when its function throws. Exiting would trade one failed operation for
// every in-flight conversation on the box, followed by a boot that sweeps
// their runs to `failed`. So for those two codes, and only those, the
// process logs and keeps serving. What is lost is bounded to the one
// operation that threw: a response that never went out (the client times out
// and retries) or a hook that stopped halfway — and the log line carries the
// stack so that site can be guarded properly.
//
// This is a backstop, not the fix. The request paths that can throw one are
// guarded where they run (`middleware/databaseBusy.ts`, `websocket/verifyClient.ts`)
// so the *request* fails with a 503. A busy error that reaches here came from
// somewhere with no request to fail — a timer, an event handler, a completion
// hook. Nothing else is survivable: a TypeError, a constraint violation, an
// SQLITE_CORRUPT still exit with code 1, exactly as before.

import { isSqliteBusyError } from './database/sqlite.js';
import type { SqliteBusyError } from './database/sqlite.js';

/** The slice of `process` the guards use — narrow so a test can hand in a fake. */
export interface GuardedProcess {
  on: (
    event: 'uncaughtException' | 'unhandledRejection',
    listener: (error: unknown, detail?: unknown) => void,
  ) => unknown;
  exit: (code: number) => void;
}

/** True when the process should survive this error rather than exit. */
export function isSurvivableError(err: unknown): err is SqliteBusyError {
  return isSqliteBusyError(err);
}

export function installProcessGuards(proc: GuardedProcess = process): void {
  proc.on('uncaughtException', (err, origin) => {
    if (isSurvivableError(err)) {
      console.error(
        `[process] ${err.code} reached the process (${String(origin)}) — kept serving. ` +
          'Guard the site that threw:',
        err,
      );
      return;
    }
    console.error(`[process] Fatal ${String(origin)}:`, err);
    proc.exit(1);
  });

  proc.on('unhandledRejection', (reason) => {
    if (isSurvivableError(reason)) {
      console.error(
        `[process] ${reason.code} reached the process (unhandledRejection) — kept serving. ` +
          'Guard the site that threw:',
        reason,
      );
      return;
    }
    console.error('[process] Fatal unhandledRejection:', reason);
    proc.exit(1);
  });
}
