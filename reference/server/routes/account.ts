import express, { type Request, type Response } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import {
  generateApiKey,
  getApiKeyStatus,
  revokeApiKey,
} from '../services/userApiKey.js';
import type { ApiError } from '../../shared/api/_common.js';
import type {
  ApiKeyStatusResponse,
  GenerateApiKeyResponse,
  RevokeApiKeyResponse,
} from '../../shared/api/auth.js';

const router = express.Router();

router.use(authenticateToken);

// GET /api/account/api-key — status (no plaintext, never)
router.get(
  '/api-key',
  (req: Request, res: Response<ApiKeyStatusResponse | ApiError>) => {
    try {
      const status = getApiKeyStatus(req.user!.id);
      if (!status) return res.status(404).json({ error: 'User not found' });
      res.json(status);
    } catch (error) {
      console.error('[account] Error getting API key status:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// POST /api/account/api-key — generate (or regenerate, replacing the previous key)
// Returns the plaintext exactly once. The server only persists the SHA-256 hash.
router.post(
  '/api-key',
  (req: Request, res: Response<GenerateApiKeyResponse | ApiError>) => {
    try {
      const key = generateApiKey(req.user!.id);
      res.status(201).json({ key });
    } catch (error) {
      console.error('[account] Error generating API key:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// DELETE /api/account/api-key — revoke
router.delete(
  '/api-key',
  (req: Request, res: Response<RevokeApiKeyResponse | ApiError>) => {
    try {
      revokeApiKey(req.user!.id);
      res.json({ success: true });
    } catch (error) {
      console.error('[account] Error revoking API key:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
