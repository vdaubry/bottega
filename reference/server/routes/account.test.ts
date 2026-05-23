import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../services/userApiKey.js', () => ({
  generateApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  getApiKeyStatus: vi.fn()
}));

// Bypass authentication in route tests by injecting req.user manually.
vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => {
    req.user = req.user || ({ id: 7, username: 'testuser' } as never);
    next();
  }
}));

import accountRoutes from './account.js';
import {
  generateApiKey,
  getApiKeyStatus,
  revokeApiKey
} from '../services/userApiKey.js';

describe('Account Routes', () => {
  let app: import("express").Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/account', accountRoutes);
  });

  describe('GET /api/account/api-key', () => {
    it('returns the status payload (no plaintext)', async () => {
      vi.mocked(getApiKeyStatus).mockReturnValue({ hasKey: true, lastUsedAt: '2026-05-08T03:00:00Z' });

      const res = await request(app).get('/api/account/api-key');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ hasKey: true, lastUsedAt: '2026-05-08T03:00:00Z' });
      expect(getApiKeyStatus).toHaveBeenCalledWith(7);
    });

    it('returns 404 when the user is missing', async () => {
      vi.mocked(getApiKeyStatus).mockReturnValue(null);

      const res = await request(app).get('/api/account/api-key');

      expect(res.status).toBe(404);
    });

    it('returns 500 on service error', async () => {
      vi.mocked(getApiKeyStatus).mockImplementation(() => { throw new Error('boom'); });
      const res = await request(app).get('/api/account/api-key');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/account/api-key', () => {
    it('returns the freshly generated plaintext exactly once', async () => {
      vi.mocked(generateApiKey).mockReturnValue('ccui_aaaa1111');

      const res = await request(app).post('/api/account/api-key');

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ key: 'ccui_aaaa1111' });
      expect(generateApiKey).toHaveBeenCalledWith(7);
    });

    it('returns 500 on service error', async () => {
      vi.mocked(generateApiKey).mockImplementation(() => { throw new Error('boom'); });
      const res = await request(app).post('/api/account/api-key');
      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /api/account/api-key', () => {
    it('revokes the key for the current user', async () => {
      const res = await request(app).delete('/api/account/api-key');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(revokeApiKey).toHaveBeenCalledWith(7);
    });

    it('returns 500 on service error', async () => {
      vi.mocked(revokeApiKey).mockImplementation(() => { throw new Error('boom'); });
      const res = await request(app).delete('/api/account/api-key');
      expect(res.status).toBe(500);
    });
  });
});
