// The request-side face of a locked database.
//
// better-sqlite3 calls are synchronous, so a lock held by another process
// surfaces as a *thrown* SqliteError in whatever function touched the
// database — inside the auth middleware, that was an uncaught exception (the
// middleware was `async`, so Express 4 never saw the throw; the rejected
// promise took the process down). A lock is neither a bug nor a bad
// credential. The right answer is "try again shortly": 503 with a Retry-After
// header, without logging anyone out and without killing every in-flight
// conversation on the box.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ApiError } from '../../shared/api/_common.js';
import { isSqliteBusyError } from '../database/sqlite.js';

/** Seconds a client should wait before retrying a 503 from a locked database. */
export const DATABASE_BUSY_RETRY_AFTER_SECONDS = 1;

/** The `{ error }` body of that 503. */
export const DATABASE_BUSY_ERROR = 'Database is busy, retry shortly.';

/** Answer a request the database lock stopped: 503 + Retry-After + `{ error }`. */
export function sendDatabaseBusy(res: Response): void {
  res.setHeader('Retry-After', String(DATABASE_BUSY_RETRY_AFTER_SECONDS));
  res.status(503).json({ error: DATABASE_BUSY_ERROR } satisfies ApiError);
}

/**
 * A synchronous handler — the kind every request-path database lookup is.
 * Deliberately not `RequestHandler`: an `async` function would turn the throw
 * this guard exists for into a rejected promise the guard can never see.
 */
export type SyncRequestHandler = (req: Request, res: Response, next: NextFunction) => void;

/**
 * Run a synchronous middleware with the database boundary in place. A
 * SQLITE_BUSY / SQLITE_LOCKED thrown inside it fails the request with a 503,
 * logged in one line without a stack (it is not a defect). Any other throw
 * goes to `next(err)`, so a genuine programming error still fails that one
 * request with Express's 500 and a logged stack — never the process.
 */
export function withDatabaseBusyGuard(handler: SyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    try {
      handler(req, res, next);
    } catch (err) {
      if (!isSqliteBusyError(err)) {
        next(err);
        return;
      }
      // `baseUrl + path`, never `originalUrl`: the query string can carry the
      // credential (`?token=`), and this line goes to the journal.
      console.warn(
        `[db] ${err.code} on ${req.method} ${req.baseUrl}${req.path} — answered 503 ` +
          `(Retry-After: ${DATABASE_BUSY_RETRY_AFTER_SECONDS}s): ${err.message}`,
      );
      sendDatabaseBusy(res);
    }
  };
}
