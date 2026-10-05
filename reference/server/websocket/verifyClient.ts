// Authenticating the WebSocket upgrade.
//
// `ws` calls this hook from the HTTP server's `upgrade` event, outside any
// Express layer: whatever it throws is an uncaught exception. The credential
// lookup behind it is a synchronous better-sqlite3 read, which throws
// SQLITE_BUSY when another process holds the database file. So the boundary
// lives here: a lock answers the handshake with 503 + Retry-After (the browser
// client reconnects with backoff), an unexpected error with 500, and a bad
// credential with 401 — the process itself is never what fails.

import type { IncomingMessage } from 'http';
import type { VerifyClientCallbackAsync } from 'ws';
import { authenticateWebSocket } from '../middleware/auth.js';
import type { WebSocketUser } from '../middleware/auth.js';
import {
  DATABASE_BUSY_ERROR,
  DATABASE_BUSY_RETRY_AFTER_SECONDS,
} from '../middleware/databaseBusy.js';
import { isSqliteBusyError } from '../database/sqlite.js';

/** The upgrade request, once `verifyClient` has stamped the user on it. */
export interface AuthenticatedUpgradeRequest extends IncomingMessage {
  user?: WebSocketUser;
}

/** The request path alone — never the query string, which carries the token. */
export function getSafeRequestPath(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? '', 'http://localhost').pathname;
  } catch {
    return '[invalid-url]';
  }
}

/**
 * The credential of an upgrade request: `?token=` first (a browser
 * `WebSocket` can't set headers), then a bearer `Authorization` header.
 *
 * Node's HTTP parser accepts request targets that `new URL` rejects
 * (`http://[`, `http://a:99999/ws`), and this hook runs inside the HTTP
 * server's `'upgrade'` listener, where a throw is fatal to the process — the
 * second way a malformed client could take the backend down. An unparseable
 * target therefore yields no token, and the handshake fails authentication
 * like any other.
 */
export function getUpgradeToken(req: IncomingMessage): string | undefined {
  let url: URL;
  try {
    url = new URL(req.url ?? '', 'http://localhost');
  } catch {
    return undefined;
  }
  return url.searchParams.get('token') || req.headers.authorization?.split(' ')[1];
}

/**
 * The `ws` `verifyClient` hook, in its two-argument (callback) form so a
 * rejection can carry a status code and headers — the one-argument form can
 * only ever say 401.
 */
export const verifyClient: VerifyClientCallbackAsync<AuthenticatedUpgradeRequest> = (info, cb) => {
  const req = info.req;
  console.log('WebSocket connection attempt to:', getSafeRequestPath(req.url));

  const token = getUpgradeToken(req);

  let user: WebSocketUser | null;
  try {
    user = authenticateWebSocket(token);
  } catch (err) {
    if (isSqliteBusyError(err)) {
      console.warn(
        `[WS] ${err.code} while authenticating the upgrade — answered 503 ` +
          `(Retry-After: ${DATABASE_BUSY_RETRY_AFTER_SECONDS}s): ${err.message}`,
      );
      cb(false, 503, DATABASE_BUSY_ERROR, {
        'Retry-After': String(DATABASE_BUSY_RETRY_AFTER_SECONDS),
      });
      return;
    }
    console.error('[WS] Upgrade authentication failed unexpectedly:', err);
    cb(false, 500, 'Internal Server Error');
    return;
  }

  if (!user) {
    console.log('[WARN] WebSocket authentication failed');
    cb(false, 401, 'Unauthorized');
    return;
  }

  req.user = user;
  console.log('[OK] WebSocket authenticated for user:', user.username);
  cb(true);
};
