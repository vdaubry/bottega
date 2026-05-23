import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../services/codexCredentials.js', () => ({
  CodexCredentialsError: class CodexCredentialsError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CodexCredentialsError';
    }
  },
  getCodexAuthStatus: vi.fn(),
  writeCodexAuth: vi.fn(),
  clearCodexAuth: vi.fn(),
}));

vi.mock('../services/codexAuthFlow.js', () => ({
  CodexAuthLoginError: class CodexAuthLoginError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 500) {
      super(message);
      this.name = 'CodexAuthLoginError';
      this.statusCode = statusCode;
    }
  },
  cancelCodexAuthLogin: vi.fn(),
  getActiveCodexAuthLogin: vi.fn(),
  startCodexAuthLogin: vi.fn(),
}));

vi.mock('../services/agentModelSettings.js', () => ({
  seedAgentSettingsAfterConnect: vi.fn().mockResolvedValue(undefined),
}));

import codexAuthRoutes from './codexAuth.js';
import {
  CodexCredentialsError,
  getCodexAuthStatus,
  writeCodexAuth,
  clearCodexAuth,
} from '../services/codexCredentials.js';
import {
  CodexAuthLoginError,
  cancelCodexAuthLogin,
  getActiveCodexAuthLogin,
  startCodexAuthLogin,
} from '../services/codexAuthFlow.js';
import { seedAgentSettingsAfterConnect } from '../services/agentModelSettings.js';

describe('Codex auth routes', () => {
  let app: import('express').Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 42, username: 'testuser' } as never;
      next();
    });
    app.use('/api/codex-auth', codexAuthRoutes);
  });

  describe('GET /status', () => {
    it('reports authenticated when the credential store has a valid auth.json', async () => {
      vi.mocked(getCodexAuthStatus).mockResolvedValueOnce({
        authenticated: true,
        status: 'authenticated',
        authPath: '/x/auth.json',
        method: 'oauth',
        tokenFingerprint: 'abcdef',
        email: 'user@example.com',
      });
      vi.mocked(getActiveCodexAuthLogin).mockReturnValue(null);
      const res = await request(app).get('/api/codex-auth/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        authenticated: true,
        status: 'authenticated',
        method: 'oauth',
        email: 'user@example.com',
        tokenFingerprint: 'abcdef',
        reason: null,
        login: null,
      });
    });

    it("reports missing with a reason when no auth.json is present", async () => {
      vi.mocked(getCodexAuthStatus).mockResolvedValueOnce({
        authenticated: false,
        status: 'missing',
        authPath: '/x/auth.json',
        reason: 'ENOENT',
      });
      vi.mocked(getActiveCodexAuthLogin).mockReturnValue(null);
      const res = await request(app).get('/api/codex-auth/status');
      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(false);
      expect(res.body.reason).toBe('ENOENT');
      expect(res.body.login).toBeNull();
    });

    it("surfaces an in-flight device-auth login (authUrl + deviceCode)", async () => {
      vi.mocked(getCodexAuthStatus).mockResolvedValueOnce({
        authenticated: false,
        status: 'missing',
        authPath: '/x/auth.json',
        reason: 'pending',
      });
      vi.mocked(getActiveCodexAuthLogin).mockReturnValue({
        loginSessionId: 'login-1',
        authUrl: 'https://auth.openai.com/codex/device',
        deviceCode: 'WX12-AB34',
        startedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-01T00:15:00Z',
      });
      const res = await request(app).get('/api/codex-auth/status');
      expect(res.body.login).toEqual({
        active: true,
        loginSessionId: 'login-1',
        authUrl: 'https://auth.openai.com/codex/device',
        deviceCode: 'WX12-AB34',
        startedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-01T00:15:00Z',
      });
    });
  });

  describe('POST /start', () => {
    it('returns the URL + deviceCode produced by codexAuthFlow.start', async () => {
      vi.mocked(startCodexAuthLogin).mockResolvedValueOnce({
        loginSessionId: 'login-7',
        authUrl: 'https://auth.openai.com/codex/device',
        deviceCode: 'ABCD-1234',
        startedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-01T00:15:00Z',
      });
      const res = await request(app).post('/api/codex-auth/start');
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        loginSessionId: 'login-7',
        authUrl: 'https://auth.openai.com/codex/device',
        deviceCode: 'ABCD-1234',
        startedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-01T00:15:00Z',
      });
    });

    it('returns the flow error status when codexAuthFlow.start throws', async () => {
      vi.mocked(startCodexAuthLogin).mockRejectedValueOnce(
        new CodexAuthLoginError('codex login exited before producing a URL', 500),
      );
      const res = await request(app).post('/api/codex-auth/start');
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('CODEX_AUTH_FLOW_ERROR');
    });
  });

  describe('POST /cancel', () => {
    it('returns cancelled=true when a session was active', async () => {
      vi.mocked(cancelCodexAuthLogin).mockReturnValue(true);
      const res = await request(app).post('/api/codex-auth/cancel');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cancelled: true });
    });

    it('returns cancelled=false when no session was active', async () => {
      vi.mocked(cancelCodexAuthLogin).mockReturnValue(false);
      const res = await request(app).post('/api/codex-auth/cancel');
      expect(res.body).toEqual({ cancelled: false });
    });
  });

  describe('POST /paste', () => {
    it('400s when authJson is not valid JSON', async () => {
      const res = await request(app)
        .post('/api/codex-auth/paste')
        .send({ authJson: 'not json' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CODEX_AUTH_INVALID_PAYLOAD');
    });

    it('400s when authJson is JSON but carries no usable credential', async () => {
      const res = await request(app)
        .post('/api/codex-auth/paste')
        .send({ authJson: JSON.stringify({ unrelated: true }) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CODEX_AUTH_INVALID_PAYLOAD');
    });

    it('persists a valid OAuth auth.json and reports authenticated', async () => {
      vi.mocked(writeCodexAuth).mockReturnValueOnce({ authPath: '/x/auth.json' });
      vi.mocked(getCodexAuthStatus).mockResolvedValueOnce({
        authenticated: true,
        status: 'authenticated',
        authPath: '/x/auth.json',
        method: 'oauth',
        tokenFingerprint: 'abcdef',
      });
      const res = await request(app)
        .post('/api/codex-auth/paste')
        .send({
          authJson: JSON.stringify({
            tokens: { access_token: 'codex-tok-12345' },
          }),
        });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        authenticated: true,
        status: 'authenticated',
        method: 'oauth',
        tokenFingerprint: 'abcdef',
      });
      expect(writeCodexAuth).toHaveBeenCalled();
      expect(seedAgentSettingsAfterConnect).toHaveBeenCalledWith(42);
    });

    it('returns 400 when writeCodexAuth throws (e.g. dir permission failure)', async () => {
      vi.mocked(writeCodexAuth).mockImplementationOnce(() => {
        throw new CodexCredentialsError('dir not writable');
      });
      const res = await request(app)
        .post('/api/codex-auth/paste')
        .send({
          authJson: JSON.stringify({ tokens: { access_token: 'abc' } }),
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/dir not writable/);
    });
  });

  describe('DELETE /', () => {
    it('returns cleared=true when the credential was removed', async () => {
      vi.mocked(clearCodexAuth).mockReturnValueOnce(true);
      const res = await request(app).delete('/api/codex-auth');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cleared: true });
    });

    it('returns cleared=false when there was nothing to remove', async () => {
      vi.mocked(clearCodexAuth).mockReturnValueOnce(false);
      const res = await request(app).delete('/api/codex-auth');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cleared: false });
    });
  });
});
