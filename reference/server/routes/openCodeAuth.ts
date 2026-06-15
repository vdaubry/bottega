// /api/opencode-auth/* — OpenCode (Zen) authentication, per-user scoped.
//
// Four routes:
//   - GET    /status — does this user have a Zen API key configured?
//   - PUT    /key    — set or replace the user's Zen API key.
//   - DELETE /key    — clear the user's Zen API key.
//   - GET    /models — live Zen catalog for this user (proxies the
//                      OpenCode server's GET /config/providers, so the
//                      settings UI never hardcodes model IDs).
//
// Every mutation ends with `invalidateOpenCodeServer(userId)` so the
// per-user `opencode serve` (which cached the previous auth.json at
// startup) is torn down. The next agent run awaits the shutdown and
// spawns a fresh server reading the new key (R5).

import express, { type Request, type Response } from 'express';
import {
  clearOpenCodeKey,
  getOpenCodeAuthStatus,
  OpenCodeCredentialsError,
  setOpenCodeKey,
} from '../services/openCodeCredentials.js';
import { invalidateOpenCodeServer } from '../services/openCodeServerPool.js';
import { listOpenCodeModels } from '../services/providers/opencode/index.js';
import { seedAgentSettingsAfterConnect } from '../services/agentModelSettings.js';
import { validateBody } from '../middleware/validate.js';
import {
  SetOpenCodeKeyBodySchema,
  type SetOpenCodeKeyBody,
} from '../../shared/schemas/openCodeAuth.js';
import type {
  ClearOpenCodeKeyResponse,
  OpenCodeAuthStatusResponse,
  OpenCodeModelsResponse,
  SetOpenCodeKeyResponse,
} from '../../shared/api/openCodeAuth.js';
import type { ApiError } from '../../shared/api/_common.js';

const router = express.Router();

interface OpenCodeAuthErrorBody {
  error: string;
  code: 'OPENCODE_AUTH_STORAGE_ERROR' | 'OPENCODE_AUTH_INVALID_PAYLOAD';
}

function authErrorResponse(
  res: Response<OpenCodeAuthErrorBody | ApiError>,
  error: unknown,
  fallbackCode: OpenCodeAuthErrorBody['code'] = 'OPENCODE_AUTH_STORAGE_ERROR',
): Response {
  if (error instanceof OpenCodeCredentialsError) {
    return res.status(400).json({
      error: error.message,
      code: fallbackCode,
    });
  }
  console.error('[OpenCodeAuth] Error:', error);
  return res.status(500).json({
    error: error instanceof Error ? error.message : 'Internal error',
    code: fallbackCode,
  });
}

router.get(
  '/status',
  async (req: Request, res: Response<OpenCodeAuthStatusResponse | OpenCodeAuthErrorBody>) => {
    try {
      const status = await getOpenCodeAuthStatus(req.user!.id);
      res.json({
        authenticated: status.authenticated,
        status: status.status,
        authPath: status.authPath,
        tokenFingerprint: status.tokenFingerprint ?? null,
        reason: status.authenticated ? null : (status.reason ?? null),
      });
    } catch (error) {
      authErrorResponse(res as Response<OpenCodeAuthErrorBody | ApiError>, error);
    }
  },
);

router.put(
  '/key',
  validateBody(SetOpenCodeKeyBodySchema),
  async (
    req: Request,
    res: Response<SetOpenCodeKeyResponse | OpenCodeAuthErrorBody>,
  ) => {
    const { apiKey } = req.validated!.body as SetOpenCodeKeyBody;
    try {
      setOpenCodeKey(req.user!.id, apiKey);
      const status = await getOpenCodeAuthStatus(req.user!.id);
      if (!status.authenticated || !status.tokenFingerprint) {
        return authErrorResponse(
          res as Response<OpenCodeAuthErrorBody | ApiError>,
          new OpenCodeCredentialsError(
            status.reason ?? 'Persisted OpenCode API key did not validate',
          ),
          'OPENCODE_AUTH_INVALID_PAYLOAD',
        );
      }
      // R5: the running per-user opencode serve cached the previous
      // auth.json. Tear it down so the next agent run picks up the
      // newly-written key.
      void invalidateOpenCodeServer(req.user!.id).catch((err) => {
        console.error('[OpenCodeAuth] pool invalidate failed:', err);
      });

      // Seed this user's per-agent model settings if they have none yet. For
      // an unseeded user this fetches the live Zen catalog to pick a default
      // model (idempotent — already-seeded users skip the fetch entirely;
      // non-fatal on failure).
      await seedAgentSettingsAfterConnect(req.user!.id);

      res.status(201).json({
        authenticated: true,
        status: 'authenticated',
        tokenFingerprint: status.tokenFingerprint,
      });
    } catch (error) {
      authErrorResponse(res as Response<OpenCodeAuthErrorBody | ApiError>, error);
    }
  },
);

router.delete(
  '/key',
  (req: Request, res: Response<ClearOpenCodeKeyResponse | OpenCodeAuthErrorBody>) => {
    try {
      const cleared = clearOpenCodeKey(req.user!.id);
      void invalidateOpenCodeServer(req.user!.id).catch((err) => {
        console.error('[OpenCodeAuth] pool invalidate failed:', err);
      });
      res.json({ cleared });
    } catch (error) {
      authErrorResponse(res as Response<OpenCodeAuthErrorBody | ApiError>, error);
    }
  },
);

// Proxy the live Zen catalog from the user's OpenCode server. Returns
// an empty list (with 200 OK) when the user has no Zen key configured —
// the settings UI uses that to show a "connect first" hint, not an error.
router.get(
  '/models',
  async (req: Request, res: Response<OpenCodeModelsResponse | OpenCodeAuthErrorBody>) => {
    const userId = req.user!.id;
    try {
      const status = await getOpenCodeAuthStatus(userId);
      if (!status.authenticated) {
        res.json({ models: [] });
        return;
      }
      const models = await listOpenCodeModels(userId, 'opencode');
      res.json({ models });
    } catch (error) {
      // Most likely cause: the user's auth.json is stale and the spawn
      // failed validation. Return 500 with the OpenCode message so the
      // settings UI can surface it.
      authErrorResponse(res as Response<OpenCodeAuthErrorBody | ApiError>, error);
    }
  },
);

// Proxy the live Go catalog from the user's OpenCode server. Returns
// an empty list (with 200 OK) when the user has no key configured.
router.get(
  '/models-go',
  async (req: Request, res: Response<OpenCodeModelsResponse | OpenCodeAuthErrorBody>) => {
    const userId = req.user!.id;
    try {
      const status = await getOpenCodeAuthStatus(userId);
      if (!status.authenticated) {
        res.json({ models: [] });
        return;
      }
      const models = await listOpenCodeModels(userId, 'opencode-go');
      res.json({ models });
    } catch (error) {
      authErrorResponse(res as Response<OpenCodeAuthErrorBody | ApiError>, error);
    }
  },
);

export default router;
