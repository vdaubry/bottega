import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import Database from 'better-sqlite3';
import {
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  requireAdmin,
  ensureJwtSecret,
  getJwtSecret,
  REFRESHED_TOKEN_HEADER,
} from './auth.js';

// Mock the database module
vi.mock('../database/db.js', () => ({
  userDb: {
    getFirstUser: vi.fn(),
    getUserById: vi.fn(),
    isAdmin: vi.fn(),
    getTokenVersion: vi.fn(),
    bumpTokenVersion: vi.fn(),
  },
}));

vi.mock('../services/userApiKey.js', () => ({
  isApiKeyFormat: vi.fn(
    (token: unknown) => typeof token === 'string' && token.startsWith('ccui_'),
  ),
  findUserByApiKey: vi.fn(),
}));

import { userDb } from '../database/db.js';
import { findUserByApiKey } from '../services/userApiKey.js';

// Tests build minimal request/response stubs; the production handlers only
// touch a few fields. Rather than satisfy the full Express types, we cast
// at the call site.
type ReqStub = Record<string, unknown>;
type ResStub = Record<string, unknown>;

const callAuth = (req: ReqStub, res: ResStub, next: NextFunction) =>
  authenticateToken(req as unknown as Request, res as unknown as Response, next);
const callRequireAdmin = (req: ReqStub, res: ResStub, next: NextFunction) =>
  requireAdmin(req as unknown as Request, res as unknown as Response, next);

// `userDb.getUserById` / `userDb.getFirstUser` / `findUserByApiKey` are typed
// against `SafeUserRow` (or the API-key shape), but the production middleware
// code only reads `id` / `username` from the mock value. Cast at the boundary.
const asSafeUser = <T extends { id: number; username: string }>(u: T) => u as never;

const makeRes = (): ResStub & { setHeader: ReturnType<typeof vi.fn> } => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn(),
  setHeader: vi.fn(),
});

describe('Auth Middleware', () => {
  const mockUser = { id: 1, username: 'testuser' };
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
    // Most tests assume the current token_version matches what the token
    // carries. Individual tests can override.
    vi.mocked(userDb.getTokenVersion).mockReturnValue(1);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('ensureJwtSecret', () => {
    it('throws when JWT_SECRET is missing', () => {
      const saved = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;
      try {
        expect(() => ensureJwtSecret()).toThrow(/JWT_SECRET/);
      } finally {
        process.env.JWT_SECRET = saved;
      }
    });

    it('throws on the legacy placeholder value', () => {
      const saved = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'bottega-dev-secret-change-in-production';
      try {
        expect(() => ensureJwtSecret()).toThrow(/JWT_SECRET/);
      } finally {
        process.env.JWT_SECRET = saved;
      }
    });

    it('throws on an empty/whitespace JWT_SECRET', () => {
      const saved = process.env.JWT_SECRET;
      process.env.JWT_SECRET = '   ';
      try {
        expect(() => ensureJwtSecret()).toThrow(/JWT_SECRET/);
      } finally {
        process.env.JWT_SECRET = saved;
      }
    });

    it('returns without throwing when env is set', () => {
      expect(() => ensureJwtSecret()).not.toThrow();
      expect(getJwtSecret()).toBe(process.env.JWT_SECRET);
    });
  });

  describe('authenticateToken', () => {
    it('should authenticate with valid JWT token', async () => {
      vi.mocked(userDb.getUserById).mockReturnValue(asSafeUser(mockUser));
      const token = jwt.sign(
        { userId: 1, username: 'testuser', tokenVersion: 1 },
        getJwtSecret(),
        { expiresIn: 60 },
      );
      const req = {
        headers: { authorization: `Bearer ${token}` },
        query: {},
      };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect((req as { user?: unknown }).user).toEqual(mockUser);
    });

    it('sets X-Refreshed-Token header on successful JWT auth', async () => {
      vi.mocked(userDb.getUserById).mockReturnValue(asSafeUser(mockUser));
      const token = jwt.sign(
        { userId: 1, username: 'testuser', tokenVersion: 1 },
        getJwtSecret(),
        { expiresIn: 60 },
      );
      const req = {
        headers: { authorization: `Bearer ${token}` },
        query: {},
      };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith(
        REFRESHED_TOKEN_HEADER,
        expect.any(String),
      );
      const [, refreshedToken] = res.setHeader.mock.calls[0] as [string, string];
      const decoded = jwt.verify(refreshedToken, getJwtSecret()) as JwtPayload;
      expect(decoded.userId).toBe(1);
      expect(decoded.tokenVersion).toBe(1);
      expect(decoded.exp).toBeDefined();
    });

    it('does NOT set X-Refreshed-Token for API-key auth', async () => {
      vi.mocked(findUserByApiKey).mockReturnValue(asSafeUser(mockUser));
      const req = {
        headers: { authorization: 'Bearer ccui_abc123' },
        query: {},
      };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('rejects JWT whose tokenVersion is behind the DB', async () => {
      vi.mocked(userDb.getTokenVersion).mockReturnValue(2);
      const token = jwt.sign(
        { userId: 1, username: 'testuser', tokenVersion: 1 },
        getJwtSecret(),
        { expiresIn: 60 },
      );
      const req = {
        headers: { authorization: `Bearer ${token}` },
        query: {},
      };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired credentials.' });
    });

    it('rejects an expired JWT', async () => {
      const expiredToken = jwt.sign(
        { userId: 1, username: 'testuser', tokenVersion: 1 },
        getJwtSecret(),
        { expiresIn: -10 },
      );
      const req = {
        headers: { authorization: `Bearer ${expiredToken}` },
        query: {},
      };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired credentials.' });
    });

    it('rejects JWT missing tokenVersion claim', async () => {
      const legacyToken = jwt.sign(
        { userId: 1, username: 'testuser' },
        getJwtSecret(),
        { expiresIn: 60 },
      );
      const req = {
        headers: { authorization: `Bearer ${legacyToken}` },
        query: {},
      };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should authenticate with valid API key (ccui_) as Bearer', async () => {
      vi.mocked(findUserByApiKey).mockReturnValue(asSafeUser(mockUser));
      const req = {
        headers: { authorization: 'Bearer ccui_abc123' },
        query: {},
      };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(findUserByApiKey).toHaveBeenCalledWith('ccui_abc123');
      expect(next).toHaveBeenCalled();
      expect((req as { user?: unknown }).user).toEqual(mockUser);
    });

    it('should return 401 for an unknown API key', async () => {
      vi.mocked(findUserByApiKey).mockReturnValue(null);
      const req = {
        headers: { authorization: 'Bearer ccui_unknown' },
        query: {},
      };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired credentials.' });
    });

    it('should authenticate with JWT in query parameter (for media elements)', async () => {
      const jwtToken = jwt.sign(
        { userId: mockUser.id, username: mockUser.username, tokenVersion: 1 },
        getJwtSecret(),
        { expiresIn: 60 },
      );
      vi.mocked(userDb.getUserById).mockReturnValue(asSafeUser(mockUser));
      const req = { headers: {}, query: { token: jwtToken } };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect((req as { user?: unknown }).user).toEqual(mockUser);
    });

    it('should return 401 when no token is provided', async () => {
      const req = { headers: {}, query: {} };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Access denied. No token provided.' });
    });

    it('should return 401 for an invalid JWT', async () => {
      const req = {
        headers: { authorization: 'Bearer invalid-token' },
        query: {},
      };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired credentials.' });
    });

    it('should return 401 when JWT user no longer exists', async () => {
      vi.mocked(userDb.getUserById).mockReturnValue(undefined);
      const token = jwt.sign(
        { userId: 999, username: 'unknown', tokenVersion: 1 },
        getJwtSecret(),
        { expiresIn: 60 },
      );
      const req = {
        headers: { authorization: `Bearer ${token}` },
        query: {},
      };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired credentials.' });
    });

    // Regression guard for the removed IP-based localhost auth-bypass. The
    // backend sits behind nginx → Vite → loopback, so req.ip is a loopback
    // address for every request, remote ones included. An unauthenticated
    // request to web-server/config from ANY loopback address must be rejected,
    // never silently authenticated as the first user.
    it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
      'rejects unauthenticated web-server/config from loopback %s (no bypass)',
      async (ip) => {
        const req = {
          headers: {},
          query: {},
          ip,
          baseUrl: '/api',
          path: '/projects/123/web-server/config',
        };
        const res = makeRes();
        const next = vi.fn();

        await callAuth(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({
          error: 'Access denied. No token provided.',
        });
        // The removed bypass used to resolve the caller via getFirstUser().
        expect(userDb.getFirstUser).not.toHaveBeenCalled();
      },
    );

    it('authenticates web-server/config normally when a valid token IS supplied', async () => {
      vi.mocked(userDb.getUserById).mockReturnValue(asSafeUser(mockUser));
      const token = jwt.sign(
        { userId: 1, username: 'testuser', tokenVersion: 1 },
        getJwtSecret(),
        { expiresIn: 60 },
      );
      const req = {
        headers: { authorization: `Bearer ${token}` },
        query: {},
        ip: '127.0.0.1',
        baseUrl: '/api',
        path: '/projects/123/web-server/config',
      };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect((req as { user?: unknown }).user).toEqual(mockUser);
    });

    it('should NOT allow localhost bypass for non-setup endpoints', async () => {
      const req = {
        headers: {},
        query: {},
        ip: '127.0.0.1',
        baseUrl: '/api',
        path: '/projects/123/tasks',
      };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should NOT allow non-localhost requests to bypass auth on setup endpoints', async () => {
      const req = {
        headers: {},
        query: {},
        ip: '192.168.1.100',
        baseUrl: '/api',
        path: '/projects/123/web-server/config',
      };
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('generateToken', () => {
    it('should generate a valid JWT token', () => {
      vi.mocked(userDb.getTokenVersion).mockReturnValue(7);
      const user = { id: 1, username: 'testuser' };

      const token = generateToken(user);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');

      const decoded = jwt.verify(token, getJwtSecret()) as JwtPayload;
      expect(decoded.userId).toBe(1);
      expect(decoded.username).toBe('testuser');
      expect(decoded.tokenVersion).toBe(7);
    });

    it('signs with a 30d expiry', () => {
      vi.mocked(userDb.getTokenVersion).mockReturnValue(1);
      const user = { id: 1, username: 'testuser' };

      const token = generateToken(user);
      const decoded = jwt.verify(token, getJwtSecret()) as JwtPayload;

      expect(decoded.exp).toBeDefined();
      const issuedAt = decoded.iat ?? 0;
      const exp = decoded.exp ?? 0;
      const lifetimeSeconds = exp - issuedAt;
      // 30 days = 2,592,000 s. Allow ±5 s for clock granularity.
      expect(lifetimeSeconds).toBeGreaterThanOrEqual(2_591_995);
      expect(lifetimeSeconds).toBeLessThanOrEqual(2_592_005);
    });

    it('throws when the user no longer exists', () => {
      vi.mocked(userDb.getTokenVersion).mockReturnValue(null);
      expect(() => generateToken({ id: 999, username: 'gone' })).toThrow(/999/);
    });
  });

  describe('a locked database at the boundary', () => {
    // What better-sqlite3 throws when another process holds the file past
    // the busy timeout. The boundary must fail the request with a 503 — not
    // a 401 (the credential is fine) and not the process (it used to).
    const busy = () => new Database.SqliteError('database is locked', 'SQLITE_BUSY');
    const busyReq = (headers: Record<string, string>) => ({
      method: 'GET',
      baseUrl: '/api',
      path: '/projects',
      headers,
      query: {},
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('answers 503 + Retry-After when the API-key lookup throws SQLITE_BUSY', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(findUserByApiKey).mockImplementationOnce(() => {
        throw busy();
      });
      const req = busyReq({ authorization: 'Bearer ccui_abc123' });
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '1');
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({ error: expect.any(String) });
      expect((req as { user?: unknown }).user).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('answers 503 when the JWT token_version check throws SQLITE_BUSY', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(userDb.getTokenVersion).mockImplementationOnce(() => {
        throw busy();
      });
      const token = jwt.sign(
        { userId: 1, username: 'testuser', tokenVersion: 1 },
        getJwtSecret(),
        { expiresIn: 60 },
      );
      const req = busyReq({ authorization: `Bearer ${token}` });
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.status).not.toHaveBeenCalledWith(401);
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    });

    it('requireAdmin answers 503 when the admin check throws SQLITE_BUSY', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(userDb.isAdmin).mockImplementationOnce(() => {
        throw busy();
      });
      const req = { ...busyReq({}), user: { id: 1 } };
      const res = makeRes();
      const next = vi.fn();

      callRequireAdmin(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    });

    it('forwards a non-busy failure to next(err) rather than throwing or masking it', async () => {
      const boom = new TypeError('unexpected');
      vi.mocked(findUserByApiKey).mockImplementationOnce(() => {
        throw boom;
      });
      const req = busyReq({ authorization: 'Bearer ccui_abc123' });
      const res = makeRes();
      const next = vi.fn();

      await callAuth(req, res, next);

      expect(next).toHaveBeenCalledWith(boom);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('authenticateWebSocket lets the error through — the upgrade hook maps it', () => {
      vi.mocked(findUserByApiKey).mockImplementationOnce(() => {
        throw busy();
      });
      expect(() => authenticateWebSocket('ccui_abc123')).toThrow(Database.SqliteError);
    });
  });

  describe('authenticateWebSocket', () => {
    it('should authenticate with valid JWT token', () => {
      vi.mocked(userDb.getUserById).mockReturnValue(asSafeUser({ id: 1, username: 'testuser' }));
      const token = jwt.sign(
        { userId: 1, username: 'testuser', tokenVersion: 1 },
        getJwtSecret(),
        { expiresIn: 60 },
      );

      const result = authenticateWebSocket(token);

      expect(result).toBeDefined();
      expect(result!.userId).toBe(1);
      expect(result!.username).toBe('testuser');
    });

    it('should authenticate with API key', () => {
      vi.mocked(findUserByApiKey).mockReturnValue(asSafeUser(mockUser));
      const result = authenticateWebSocket('ccui_abc123');
      expect(result).toEqual({ id: 1, userId: 1, username: 'testuser' });
    });

    it('should return null for invalid token', () => {
      const result = authenticateWebSocket('invalid-token');
      expect(result).toBeNull();
    });

    it('should return null for empty token', () => {
      expect(authenticateWebSocket('')).toBeNull();
      expect(authenticateWebSocket(null)).toBeNull();
    });
  });

  describe('requireAdmin', () => {
    it('should call next() when user is admin', () => {
      vi.mocked(userDb.isAdmin).mockReturnValue(true);
      const req = { user: { id: 1 } };
      const res = makeRes();
      const next = vi.fn();

      callRequireAdmin(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should return 403 when user is not admin', () => {
      vi.mocked(userDb.isAdmin).mockReturnValue(false);
      const req = { user: { id: 1 } };
      const res = makeRes();
      const next = vi.fn();

      callRequireAdmin(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Admin access required' });
    });

    it('should return 401 when no user is present', () => {
      const req = {};
      const res = makeRes();
      const next = vi.fn();

      callRequireAdmin(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    });

    it('should return 401 when user has no id', () => {
      const req = { user: {} };
      const res = makeRes();
      const next = vi.fn();

      callRequireAdmin(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});
