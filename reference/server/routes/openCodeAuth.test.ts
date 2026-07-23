import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../services/openCodeCredentials.js', () => ({
  OpenCodeCredentialsError: class OpenCodeCredentialsError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'OpenCodeCredentialsError';
    }
  },
  getOpenCodeAuthStatus: vi.fn(),
  setOpenCodeKey: vi.fn(),
  clearOpenCodeKey: vi.fn(),
}));

vi.mock('../services/openCodeServerPool.js', () => ({
  invalidateOpenCodeServer: vi.fn(async () => {}),
}));

vi.mock('../services/providers/opencode/index.js', () => ({
  listOpenCodeModels: vi.fn(),
}));

vi.mock('../services/agentModelSettings.js', () => ({
  seedAgentSettingsAfterConnect: vi.fn().mockResolvedValue(undefined),
}));

import openCodeAuthRoutes from './openCodeAuth.js';
import {
  clearOpenCodeKey,
  getOpenCodeAuthStatus,
  OpenCodeCredentialsError,
  setOpenCodeKey,
} from '../services/openCodeCredentials.js';
import { invalidateOpenCodeServer } from '../services/openCodeServerPool.js';
import { listOpenCodeModels } from '../services/providers/opencode/index.js';
import { seedAgentSettingsAfterConnect } from '../services/agentModelSettings.js';

const VALID_KEY = 'sk-zen-' + 'x'.repeat(40); // 47 chars; well within 20–512 range

function appForUser(userId: number, username = 'testuser'): import('express').Application {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: userId, username } as never;
    next();
  });
  app.use('/api/opencode-auth', openCodeAuthRoutes);
  return app;
}

describe('OpenCode auth routes', () => {
  let app: import('express').Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = appForUser(42);
  });

  describe('GET /status', () => {
    it('reports authenticated when a Zen key is set', async () => {
      vi.mocked(getOpenCodeAuthStatus).mockResolvedValueOnce({
        authenticated: true,
        status: 'authenticated',
        authPath: '/x/auth.json',
        tokenFingerprint: 'abc123',
      });
      const res = await request(app).get('/api/opencode-auth/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        authenticated: true,
        status: 'authenticated',
        authPath: '/x/auth.json',
        tokenFingerprint: 'abc123',
        reason: null,
      });
    });

    it('reports missing with a reason when no auth.json exists', async () => {
      vi.mocked(getOpenCodeAuthStatus).mockResolvedValueOnce({
        authenticated: false,
        status: 'missing',
        authPath: '/x/auth.json',
        reason: 'not provisioned',
      });
      const res = await request(app).get('/api/opencode-auth/status');
      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(false);
      expect(res.body.reason).toBe('not provisioned');
      expect(res.body.tokenFingerprint).toBeNull();
    });

    it('reads status for the request user, not a hard-coded id', async () => {
      app = appForUser(7);
      vi.mocked(getOpenCodeAuthStatus).mockResolvedValueOnce({
        authenticated: false,
        status: 'missing',
        authPath: '/users/7/auth.json',
      });
      await request(app).get('/api/opencode-auth/status');
      expect(getOpenCodeAuthStatus).toHaveBeenCalledWith(7);
    });
  });

  describe('PUT /key', () => {
    it('rejects too-short keys with 400 (zod)', async () => {
      const res = await request(app)
        .put('/api/opencode-auth/key')
        .send({ apiKey: 'short' });
      expect(res.status).toBe(400);
      expect(setOpenCodeKey).not.toHaveBeenCalled();
    });

    it('rejects too-long keys with 400 (zod)', async () => {
      const tooLong = 'x'.repeat(513);
      const res = await request(app)
        .put('/api/opencode-auth/key')
        .send({ apiKey: tooLong });
      expect(res.status).toBe(400);
    });

    it('persists the key, returns the fingerprint, and invalidates the pool', async () => {
      vi.mocked(getOpenCodeAuthStatus).mockResolvedValueOnce({
        authenticated: true,
        status: 'authenticated',
        authPath: '/x/auth.json',
        tokenFingerprint: 'tail66',
      });
      const res = await request(app)
        .put('/api/opencode-auth/key')
        .send({ apiKey: VALID_KEY });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        authenticated: true,
        status: 'authenticated',
        tokenFingerprint: 'tail66',
      });
      expect(setOpenCodeKey).toHaveBeenCalledWith(42, VALID_KEY);
      expect(invalidateOpenCodeServer).toHaveBeenCalledWith(42);
      expect(seedAgentSettingsAfterConnect).toHaveBeenCalledWith(42);
    });

    it('surfaces an OpenCodeCredentialsError as 400 with INVALID_PAYLOAD code', async () => {
      vi.mocked(setOpenCodeKey).mockImplementationOnce(() => {
        throw new OpenCodeCredentialsError('Refusing to persist an empty OpenCode API key');
      });
      const res = await request(app)
        .put('/api/opencode-auth/key')
        .send({ apiKey: VALID_KEY });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('OPENCODE_AUTH_STORAGE_ERROR');
    });

    it('falls through to INVALID_PAYLOAD when the persisted key fails status validation', async () => {
      vi.mocked(getOpenCodeAuthStatus).mockResolvedValueOnce({
        authenticated: false,
        status: 'missing',
        authPath: '/x/auth.json',
        reason: 'auth.json corrupted',
      });
      const res = await request(app)
        .put('/api/opencode-auth/key')
        .send({ apiKey: VALID_KEY });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('OPENCODE_AUTH_INVALID_PAYLOAD');
    });
  });

  describe('DELETE /key', () => {
    it('returns cleared:true when a key existed and invalidates the pool', async () => {
      vi.mocked(clearOpenCodeKey).mockReturnValueOnce(true);
      const res = await request(app).delete('/api/opencode-auth/key');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cleared: true });
      expect(clearOpenCodeKey).toHaveBeenCalledWith(42);
      expect(invalidateOpenCodeServer).toHaveBeenCalledWith(42);
    });

    it('returns cleared:false when no key existed (idempotent delete)', async () => {
      vi.mocked(clearOpenCodeKey).mockReturnValueOnce(false);
      const res = await request(app).delete('/api/opencode-auth/key');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cleared: false });
    });
  });

  describe('GET /models', () => {
    it('returns an empty list (200) when the user has no Zen key — no error', async () => {
      vi.mocked(getOpenCodeAuthStatus).mockResolvedValueOnce({
        authenticated: false,
        status: 'missing',
        authPath: '/users/42/auth.json',
      });
      const res = await request(app).get('/api/opencode-auth/models');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ models: [] });
      // Crucially, we did NOT spawn an OpenCode server for an unauth user.
      expect(listOpenCodeModels).not.toHaveBeenCalled();
    });

    it('proxies the live Zen catalog when the user is authenticated', async () => {
      vi.mocked(getOpenCodeAuthStatus).mockResolvedValueOnce({
        authenticated: true,
        status: 'authenticated',
        authPath: '/users/42/auth.json',
        tokenFingerprint: 'abc123',
      });
      vi.mocked(listOpenCodeModels).mockResolvedValueOnce([
        {
          id: 'opencode/kimi-k2.6',
          bareModelId: 'kimi-k2.6',
          name: 'Kimi K2.6',
          status: 'active',
          contextWindow: 200000,
        },
        {
          id: 'opencode/qwen3.6-plus',
          bareModelId: 'qwen3.6-plus',
          name: 'Qwen3.6 Plus',
          status: 'active',
          contextWindow: 128000,
        },
      ]);
      const res = await request(app).get('/api/opencode-auth/models');
      expect(res.status).toBe(200);
      expect(res.body.models).toHaveLength(2);
      expect(res.body.models[0].id).toBe('opencode/kimi-k2.6');
      expect(res.body.models[1].id).toBe('opencode/qwen3.6-plus');
      expect(listOpenCodeModels).toHaveBeenCalledWith(42, 'opencode');
    });

    it('returns 500 with the upstream message when listOpenCodeModels throws', async () => {
      vi.mocked(getOpenCodeAuthStatus).mockResolvedValueOnce({
        authenticated: true,
        status: 'authenticated',
        authPath: '/users/42/auth.json',
        tokenFingerprint: 'abc123',
      });
      vi.mocked(listOpenCodeModels).mockRejectedValueOnce(
        new Error('OpenCode server failed to spawn (no Zen credit)'),
      );
      const res = await request(app).get('/api/opencode-auth/models');
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/spawn/i);
    });
  });

  describe('GET /models-go', () => {
    it('returns an empty list (200) when the user has no key — no error', async () => {
      vi.mocked(getOpenCodeAuthStatus).mockResolvedValueOnce({
        authenticated: false,
        status: 'missing',
        authPath: '/users/42/auth.json',
      });
      const res = await request(app).get('/api/opencode-auth/models-go');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ models: [] });
      expect(listOpenCodeModels).not.toHaveBeenCalled();
    });

    it('proxies the live Go catalog when the user is authenticated', async () => {
      vi.mocked(getOpenCodeAuthStatus).mockResolvedValueOnce({
        authenticated: true,
        status: 'authenticated',
        authPath: '/users/42/auth.json',
        tokenFingerprint: 'abc123',
      });
      vi.mocked(listOpenCodeModels).mockResolvedValueOnce([
        {
          id: 'opencode-go/deepseek-r1',
          bareModelId: 'deepseek-r1',
          name: 'DeepSeek R1',
          status: 'active',
          contextWindow: 64000,
        },
        {
          id: 'opencode-go/qwen3-coder',
          bareModelId: 'qwen3-coder',
          name: 'Qwen3 Coder',
          status: 'active',
          contextWindow: 128000,
        },
      ]);
      const res = await request(app).get('/api/opencode-auth/models-go');
      expect(res.status).toBe(200);
      expect(res.body.models).toHaveLength(2);
      expect(res.body.models[0].id).toBe('opencode-go/deepseek-r1');
      expect(res.body.models[1].id).toBe('opencode-go/qwen3-coder');
      expect(listOpenCodeModels).toHaveBeenCalledWith(42, 'opencode-go');
    });

    it('returns 500 with the upstream message when listOpenCodeModels throws', async () => {
      vi.mocked(getOpenCodeAuthStatus).mockResolvedValueOnce({
        authenticated: true,
        status: 'authenticated',
        authPath: '/users/42/auth.json',
        tokenFingerprint: 'abc123',
      });
      vi.mocked(listOpenCodeModels).mockRejectedValueOnce(
        new Error('OpenCode server failed to spawn'),
      );
      const res = await request(app).get('/api/opencode-auth/models-go');
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/spawn/i);
    });
  });

  describe('cross-user isolation', () => {
    it('reads each user the status the credential store reports for them', async () => {
      const appA = appForUser(1);
      const appB = appForUser(2);
      vi.mocked(getOpenCodeAuthStatus).mockImplementation(async (id) => {
        if (id === 1) {
          return {
            authenticated: true,
            status: 'authenticated',
            authPath: '/users/1/auth.json',
            tokenFingerprint: 'aaa111',
          };
        }
        return {
          authenticated: false,
          status: 'missing',
          authPath: '/users/2/auth.json',
        };
      });
      const a = await request(appA).get('/api/opencode-auth/status');
      const b = await request(appB).get('/api/opencode-auth/status');
      expect(a.body.authenticated).toBe(true);
      expect(a.body.tokenFingerprint).toBe('aaa111');
      expect(b.body.authenticated).toBe(false);
    });
  });
});
