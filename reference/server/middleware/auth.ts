import jwt from 'jsonwebtoken';
import type { RequestHandler } from 'express';
import { userDb } from '../database/db.js';
import type { UserRow } from '../database/db.js';
import { findUserByApiKey, isApiKeyFormat } from '../services/userApiKey.js';
import { withDatabaseBusyGuard } from './databaseBusy.js';

// Legacy placeholder that used to be the silent default. Tokens signed with
// this value are guessable by anyone reading the source; refuse to use it.
const FORBIDDEN_PLACEHOLDER_SECRET = 'bottega-dev-secret-change-in-production';

// 30 days. Every authenticated request returns a freshly-signed token in
// `X-Refreshed-Token`, so a user touching the app at least once per 30 days
// is never logged out.
const JWT_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;

// Public header name for the sliding refresh token.
export const REFRESHED_TOKEN_HEADER = 'X-Refreshed-Token';

const MISSING_SECRET_MESSAGE =
  'JWT_SECRET environment variable is required and must not be the placeholder. ' +
  'Generate one with: openssl rand -hex 64';

let cachedSecret: string | null = null;

const readSecretFromEnv = (): string => {
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.trim() === '' || raw === FORBIDDEN_PLACEHOLDER_SECRET) {
    throw new Error(MISSING_SECRET_MESSAGE);
  }
  return raw;
};

// Call once at startup to fail loud if JWT_SECRET is missing or unsafe.
export const ensureJwtSecret = (): void => {
  cachedSecret = readSecretFromEnv();
};

// Internal accessor — also exported so tests can sign/verify with the same
// secret the middleware uses, without re-reading env locally.
export const getJwtSecret = (): string => {
  if (cachedSecret !== null) return cachedSecret;
  cachedSecret = readSecretFromEnv();
  return cachedSecret;
};

interface JwtPayload {
  userId: number;
  username: string;
  tokenVersion: number;
}

interface ResolvedToken {
  user: UserRow;
  // True when the token was a JWT (eligible for rolling refresh). API keys
  // are long-lived already; never refresh them.
  isJwt: boolean;
}

// Resolve a Bearer/URL token to a user, supporting both API keys and JWTs.
//
// Throws whatever the synchronous lookups throw — a locked database included
// (`SqliteError`, code SQLITE_BUSY). The two boundaries that call it,
// `authenticateToken` and the WebSocket `verifyClient`, turn that into a 503.
const resolveToken = (token: string | null | undefined): ResolvedToken | null => {
  if (!token) return null;
  if (isApiKeyFormat(token)) {
    const apiUser = findUserByApiKey(token) as UserRow | null;
    if (!apiUser) return null;
    return { user: apiUser, isJwt: false };
  }
  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, getJwtSecret()) as JwtPayload;
  } catch {
    return null;
  }
  if (typeof decoded.tokenVersion !== 'number') return null;
  const currentVersion = userDb.getTokenVersion(decoded.userId);
  if (currentVersion === null || decoded.tokenVersion !== currentVersion) return null;
  const user = userDb.getUserById(decoded.userId) as UserRow | undefined;
  if (!user) return null;
  return { user, isJwt: true };
};

const signJwtForUser = (user: Pick<UserRow, 'id' | 'username'>, tokenVersion: number): string =>
  jwt.sign(
    {
      userId: user.id,
      username: user.username,
      tokenVersion,
    },
    getJwtSecret(),
    { expiresIn: JWT_EXPIRES_IN_SECONDS },
  );

// JWT / API-key authentication middleware.
//
// Every request must present a credential — there is deliberately NO IP-based
// "localhost bypass". The backend runs behind nginx → Vite → the API on
// loopback, so it sees req.ip = 127.0.0.1 for *every* request, remote ones
// included. An exception keyed on that address was therefore equivalent to no
// auth at all and let anonymous internet callers act as the first user. Do not
// re-introduce an IP-based bypass; auth decisions must not depend on req.ip.
//
// Synchronous on purpose, and behind `withDatabaseBusyGuard`: the lookups in
// here are better-sqlite3 calls, which throw SQLITE_BUSY when another process
// holds the database file. This used to be an `async` handler, so that throw
// became a rejected promise Express 4 never sees — the unhandled rejection
// that took a server down on 2026-09-04. Now a lock answers 503 + Retry-After
// and any other throw goes to Express's error handler; the process is never
// what fails.
const authenticateToken: RequestHandler = withDatabaseBusyGuard((req, res, next) => {
  // Bearer token (Authorization header) or query-string token (for media elements that can't set headers)
  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader && authHeader.split(' ')[1];
  const urlToken = req.query.token as string | undefined;
  const token = bearerToken || urlToken;

  if (!token) {
    res.status(401).json({ error: 'Access denied. No token provided.' });
    return;
  }

  const resolved = resolveToken(token);
  if (!resolved) {
    res.status(401).json({ error: 'Invalid or expired credentials.' });
    return;
  }
  req.user = resolved.user;

  if (resolved.isJwt) {
    // Rolling refresh: hand the client a freshly-signed 30d token on every
    // successful JWT request. Best-effort — a signing failure must not break
    // the request itself.
    try {
      const tv = userDb.getTokenVersion(resolved.user.id);
      if (tv !== null) {
        res.setHeader(REFRESHED_TOKEN_HEADER, signJwtForUser(resolved.user, tv));
      }
    } catch (error) {
      console.error('Token refresh signing failed:', error);
    }
  }

  next();
});

// Generate a fresh JWT for a user. Pulls the current `token_version` from
// the DB so the issued token survives until the next logout/password-change.
const generateToken = (user: Pick<UserRow, 'id' | 'username'>): string => {
  const tv = userDb.getTokenVersion(user.id);
  if (tv === null) {
    throw new Error(`Cannot generate token for unknown user id ${user.id}`);
  }
  return signJwtForUser(user, tv);
};

// Admin authorization middleware (requires authenticateToken first). Same
// database boundary as `authenticateToken`: `isAdmin` is a synchronous read.
const requireAdmin: RequestHandler = withDatabaseBusyGuard((req, res, next) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const isAdmin = userDb.isAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  next();
});

export interface WebSocketUser {
  id: number;
  userId: number;
  username: string;
}

// WebSocket authentication function. Like `resolveToken`, it lets a locked
// database throw: the upgrade hook (`websocket/verifyClient.ts`) is the
// boundary that answers the handshake with a 503.
const authenticateWebSocket = (token: string | null | undefined): WebSocketUser | null => {
  if (!token) return null;

  const resolved = resolveToken(token);
  if (!resolved) return null;
  return {
    id: resolved.user.id,
    userId: resolved.user.id,
    username: resolved.user.username,
  };
};

export {
  authenticateToken,
  requireAdmin,
  generateToken,
  authenticateWebSocket,
};
