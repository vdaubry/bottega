import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../services/claudeCredentials.js', () => ({
  ClaudeCredentialsError: class ClaudeCredentialsError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ClaudeCredentialsError';
    }
  },
  getClaudeAuthStatus: vi.fn(),
  clearClaudeOAuthToken: vi.fn()
}));

vi.mock('../services/claudeAuthFlow.js', () => ({
  ClaudeAuthLoginError: class ClaudeAuthLoginError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 500) {
      super(message);
      this.name = 'ClaudeAuthLoginError';
      this.statusCode = statusCode;
    }
  },
  getActiveClaudeAuthLogin: vi.fn(),
  startClaudeAuthLogin: vi.fn(),
  completeClaudeAuthLogin: vi.fn(),
  cancelClaudeAuthLogin: vi.fn()
}));

vi.mock('../services/agentModelSettings.js', () => ({
  seedAgentSettingsAfterConnect: vi.fn().mockResolvedValue(undefined),
}));

import claudeAuthRoutes from './claudeAuth.js';
import {
  ClaudeCredentialsError,
  clearClaudeOAuthToken,
  getClaudeAuthStatus
} from '../services/claudeCredentials.js';
import { seedAgentSettingsAfterConnect } from '../services/agentModelSettings.js';
import {
  cancelClaudeAuthLogin,
  ClaudeAuthLoginError,
  completeClaudeAuthLogin,
  getActiveClaudeAuthLogin,
  startClaudeAuthLogin
} from '../services/claudeAuthFlow.js';

describe('Claude auth routes', () => {
  let app: import("express").Application;

  beforeEach(() => {
    vi.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 42, username: 'testuser' } as never;
      next();
    });
    app.use('/api/claude-auth', claudeAuthRoutes);
  });

  it('returns authenticated status for the current user', async () => {
    vi.mocked(getClaudeAuthStatus).mockResolvedValue({
      authenticated: true,
      status: 'authenticated',
      authMethod: 'claudeAiOauth',
      apiProvider: 'firstParty'
    } as never);
    vi.mocked(getActiveClaudeAuthLogin).mockReturnValue(null);

    const response = await request(app).get('/api/claude-auth/status');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      authenticated: true,
      status: 'authenticated',
      authMethod: 'claudeAiOauth',
      apiProvider: 'firstParty',
      reason: null,
      login: null
    });
    expect(getClaudeAuthStatus).toHaveBeenCalledWith(42);
  });

  it('includes an active login session in status responses', async () => {
    vi.mocked(getClaudeAuthStatus).mockResolvedValue({
      authenticated: false,
      status: 'missing',
      reason: 'missing credentials'
    } as never);
    vi.mocked(getActiveClaudeAuthLogin).mockReturnValue({
      loginSessionId: 'login-123',
      authUrl: 'https://claude.com/cai/oauth/authorize?state=abc',
      startedAt: '2026-05-06T00:00:00.000Z',
      expiresAt: '2026-05-06T00:10:00.000Z'
    });

    const response = await request(app).get('/api/claude-auth/status');

    expect(response.status).toBe(200);
    expect(response.body.authenticated).toBe(false);
    expect(response.body.login).toEqual({
      active: true,
      loginSessionId: 'login-123',
      authUrl: 'https://claude.com/cai/oauth/authorize?state=abc',
      startedAt: '2026-05-06T00:00:00.000Z',
      expiresAt: '2026-05-06T00:10:00.000Z'
    });
  });

  it('starts a new Claude auth login for the current user', async () => {
    vi.mocked(startClaudeAuthLogin).mockResolvedValue({
      loginSessionId: 'login-123',
      authUrl: 'https://claude.com/cai/oauth/authorize?state=abc',
      startedAt: '2026-05-06T00:00:00.000Z',
      expiresAt: '2026-05-06T00:10:00.000Z'
    });

    const response = await request(app).post('/api/claude-auth/start').send({});

    expect(response.status).toBe(201);
    expect(response.body.loginSessionId).toBe('login-123');
    expect(response.body.authUrl).toContain('https://claude.com/');
    expect(startClaudeAuthLogin).toHaveBeenCalledWith(42);
  });

  it('completes a Claude auth login with the submitted code', async () => {
    vi.mocked(completeClaudeAuthLogin).mockResolvedValue({
      authenticated: true,
      status: 'authenticated',
      authMethod: 'claudeAiOauth',
      apiProvider: 'firstParty'
    } as never);

    const response = await request(app)
      .post('/api/claude-auth/complete')
      .send({ loginSessionId: 'login-123', code: 'oauth-code' });

    expect(response.status).toBe(200);
    expect(response.body.authenticated).toBe(true);
    expect(completeClaudeAuthLogin).toHaveBeenCalledWith(42, 'login-123', 'oauth-code');
    // Seeds per-agent model settings on first connect.
    expect(seedAgentSettingsAfterConnect).toHaveBeenCalledWith(42);
  });

  it('maps auth flow errors to their explicit status code', async () => {
    vi.mocked(startClaudeAuthLogin).mockRejectedValue(new ClaudeAuthLoginError('expired', 410));

    const response = await request(app).post('/api/claude-auth/start').send({});

    expect(response.status).toBe(410);
    expect(response.body).toEqual({
      error: 'expired',
      code: 'CLAUDE_AUTH_FLOW_ERROR'
    });
  });

  it('returns a storage error when the credential root is not writable', async () => {
    vi.mocked(startClaudeAuthLogin).mockRejectedValue(new ClaudeCredentialsError('root is not writable'));

    const response = await request(app).post('/api/claude-auth/start').send({});

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'root is not writable',
      code: 'CLAUDE_AUTH_STORAGE_ERROR'
    });
  });

  it('cancels an active Claude auth login for the current user', async () => {
    vi.mocked(cancelClaudeAuthLogin).mockReturnValue(true);

    const response = await request(app).post('/api/claude-auth/cancel').send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ cancelled: true });
    expect(cancelClaudeAuthLogin).toHaveBeenCalledWith(42, 'user-cancelled');
  });

  describe('DELETE /', () => {
    it('returns cleared=true when the token was removed', async () => {
      vi.mocked(clearClaudeOAuthToken).mockReturnValueOnce(true);

      const response = await request(app).delete('/api/claude-auth');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ cleared: true });
      expect(clearClaudeOAuthToken).toHaveBeenCalledWith(42);
    });

    it('returns cleared=false when there was nothing to remove', async () => {
      vi.mocked(clearClaudeOAuthToken).mockReturnValueOnce(false);

      const response = await request(app).delete('/api/claude-auth');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ cleared: false });
    });

    it('maps storage errors to a 500 storage error code', async () => {
      vi.mocked(clearClaudeOAuthToken).mockImplementationOnce(() => {
        throw new ClaudeCredentialsError('disk on fire');
      });

      const response = await request(app).delete('/api/claude-auth');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'disk on fire',
        code: 'CLAUDE_AUTH_STORAGE_ERROR'
      });
    });
  });
});
