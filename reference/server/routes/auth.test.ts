import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';
import authRoutes from './auth.js';
import { db, userDb } from '../database/db.js';
import type { ApiError } from '../../shared/api/_common.js';
import type {
  AuthenticatedUser,
  AuthStatusResponse,
  AuthSuccessResponse,
} from '../../shared/api/auth.js';

vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn(),
    compare: vi.fn(),
  },
}));

vi.mock('../database/db.js', () => ({
  userDb: {
    hasUsers: vi.fn(),
    createUser: vi.fn(),
    setAdmin: vi.fn(),
    getUserById: vi.fn(),
    getUserByUsername: vi.fn(),
    updateLastLogin: vi.fn(),
    updateIsTechnical: vi.fn(),
    getFirstUser: vi.fn(),
    isAdmin: vi.fn(),
    getTokenVersion: vi.fn(),
    bumpTokenVersion: vi.fn(),
  },
  db: {
    prepare: vi.fn(),
  },
}));

const makeSafeUser = (
  overrides: Partial<AuthenticatedUser> = {},
): AuthenticatedUser => ({
  id: 1,
  username: 'owner',
  created_at: '2026-05-12 00:00:00',
  last_login: '2026-05-12 00:00:01',
  is_admin: 1,
  is_technical: 0,
  ...overrides,
});

const mockedBcrypt = vi.mocked(bcrypt);
const mockedDb = vi.mocked(db);
const mockedUserDb = vi.mocked(userDb);

describe('Auth Routes', () => {
  let app: import('express').Application;
  let preparedSql: string[];
  let transactionRuns: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();

    preparedSql = [];
    transactionRuns = {};
    mockedDb.prepare.mockImplementation((sql: string) => {
      preparedSql.push(sql);
      const run = vi.fn();
      transactionRuns[sql] = run;
      return { run } as never;
    });

    mockedBcrypt.hash.mockResolvedValue('hashed_password' as never);
    mockedBcrypt.compare.mockResolvedValue(true as never);
    // generateToken pulls the user's current token_version from the DB.
    mockedUserDb.getTokenVersion.mockReturnValue(1);

    app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
  });

  describe('GET /api/auth/status', () => {
    it('reports setup is needed when there are no users', async () => {
      mockedUserDb.hasUsers.mockReturnValue(false);

      const res = await request(app).get('/api/auth/status');
      const body = res.body as AuthStatusResponse;

      expect(res.status).toBe(200);
      expect(body).toEqual({ needsSetup: true, isAuthenticated: false });
    });

    it('reports setup is closed when a user already exists', async () => {
      mockedUserDb.hasUsers.mockReturnValue(true);

      const res = await request(app).get('/api/auth/status');
      const body = res.body as AuthStatusResponse;

      expect(res.status).toBe(200);
      expect(body).toEqual({ needsSetup: false, isAuthenticated: false });
    });
  });

  describe('POST /api/auth/register', () => {
    it('creates the first user as an admin bootstrap account', async () => {
      const authUser = makeSafeUser();
      mockedUserDb.hasUsers
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false);
      mockedUserDb.createUser.mockReturnValue({ id: 1, username: 'owner' });
      mockedUserDb.setAdmin.mockReturnValue(authUser);
      mockedUserDb.getUserById.mockReturnValue(authUser);

      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: ' owner ', password: 'password123' });
      const body = res.body as AuthSuccessResponse;

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.user).toEqual(authUser);
      expect(body.token).toEqual(expect.any(String));
      expect(mockedBcrypt.hash).toHaveBeenCalledWith('password123', 12);
      expect(mockedUserDb.createUser).toHaveBeenCalledWith('owner', 'hashed_password');
      expect(mockedUserDb.setAdmin).toHaveBeenCalledWith(1, true);
      expect(mockedUserDb.updateLastLogin).toHaveBeenCalledWith(1);
      expect(preparedSql).toContain('BEGIN');
      expect(preparedSql).toContain('COMMIT');
    });

    it('rejects public registration once any user exists', async () => {
      mockedUserDb.hasUsers.mockReturnValue(true);

      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'second', password: 'password123' });
      const body = res.body as ApiError;

      expect(res.status).toBe(403);
      expect(body.error).toBe('Registration is closed. Ask an admin to create your account.');
      expect(mockedBcrypt.hash).not.toHaveBeenCalled();
      expect(mockedUserDb.createUser).not.toHaveBeenCalled();
      expect(preparedSql).toEqual([]);
    });

    it('rolls back if another setup request creates a user before the transaction check', async () => {
      mockedUserDb.hasUsers
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);

      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'racer', password: 'password123' });

      expect(res.status).toBe(403);
      expect(mockedUserDb.createUser).not.toHaveBeenCalled();
      expect(preparedSql).toContain('BEGIN');
      expect(preparedSql).toContain('ROLLBACK');
      expect(preparedSql).not.toContain('COMMIT');
      expect(transactionRuns.ROLLBACK).toHaveBeenCalled();
    });

    it('validates the setup payload before checking user state', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'ab', password: 'short' });
      const body = res.body as ApiError;

      expect(res.status).toBe(400);
      expect(body.error).toBe('Validation failed');
      expect(mockedUserDb.hasUsers).not.toHaveBeenCalled();
      expect(mockedUserDb.createUser).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/auth/login', () => {
    it('returns the full safe user shape after login', async () => {
      const authUser = makeSafeUser({ id: 2, username: 'admin' });
      mockedUserDb.getUserByUsername.mockReturnValue({
        id: 2,
        username: 'admin',
        password_hash: 'stored_hash',
      } as never);
      mockedUserDb.getUserById.mockReturnValue(authUser);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'password123' });
      const body = res.body as AuthSuccessResponse;

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.user).toEqual(authUser);
      expect(body.token).toEqual(expect.any(String));
      expect(mockedBcrypt.compare).toHaveBeenCalledWith('password123', 'stored_hash');
      expect(mockedUserDb.updateLastLogin).toHaveBeenCalledWith(2);
    });

    it('validates the login payload', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: '', password: '' });
      const body = res.body as ApiError;

      expect(res.status).toBe(400);
      expect(body.error).toBe('Validation failed');
      expect(mockedUserDb.getUserByUsername).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/auth/logout', () => {
    it('bumps the user token_version so prior JWTs become invalid', async () => {
      const authUser = makeSafeUser({ id: 5, username: 'logoutuser' });
      mockedUserDb.getUserById.mockReturnValue(authUser);
      mockedUserDb.bumpTokenVersion.mockReturnValue(2);
      // The middleware verifies tokenVersion against this:
      mockedUserDb.getTokenVersion.mockReturnValue(1);

      // Sign a real token so authenticateToken accepts it.
      const jwtMod = await import('jsonwebtoken');
      const { getJwtSecret } = await import('../middleware/auth.js');
      const token = jwtMod.default.sign(
        { userId: 5, username: 'logoutuser', tokenVersion: 1 },
        getJwtSecret(),
        { expiresIn: 60 },
      );

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, message: 'Logged out successfully' });
      expect(mockedUserDb.bumpTokenVersion).toHaveBeenCalledWith(5);
    });

    it('rejects logout without a token', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(401);
      expect(mockedUserDb.bumpTokenVersion).not.toHaveBeenCalled();
    });
  });
});
