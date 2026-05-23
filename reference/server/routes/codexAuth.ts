// /api/codex-auth/* — Codex CLI authentication, per-user scoped.
//
// Phase 10 part 1 ships:
//   - GET    /status       — does this user have a usable auth.json?
//   - POST   /paste        — Path B: paste the JSON contents of a working
//                            ~/.codex/auth.json and persist to the per-user
//                            CODEX_HOME with mode 0600.
//   - DELETE /             — clear the per-user auth.json.
//
// Phase 10 part 2 will add /start /complete /cancel + the PTY-driven
// `codex login --device-auth` flow.

import express, { type Request, type Response } from 'express';
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
import { validateBody } from '../middleware/validate.js';
import {
  PasteCodexAuthBodySchema,
  type PasteCodexAuthBody,
} from '../../shared/schemas/codexAuth.js';
import type {
  CodexAuthStatusResponse,
  PasteCodexAuthResponse,
  ClearCodexAuthResponse,
  StartCodexAuthResponse,
  CancelCodexAuthResponse,
} from '../../shared/api/codexAuth.js';
import type { ApiError } from '../../shared/api/_common.js';

const router = express.Router();

interface CodexAuthErrorBody {
  error: string;
  code: 'CODEX_AUTH_STORAGE_ERROR' | 'CODEX_AUTH_INVALID_PAYLOAD' | 'CODEX_AUTH_FLOW_ERROR';
}

function authErrorResponse(
  res: Response<CodexAuthErrorBody | ApiError>,
  error: unknown,
  fallbackCode: CodexAuthErrorBody['code'] = 'CODEX_AUTH_STORAGE_ERROR',
): Response {
  if (error instanceof CodexAuthLoginError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: 'CODEX_AUTH_FLOW_ERROR',
    });
  }
  if (error instanceof CodexCredentialsError) {
    return res.status(400).json({
      error: error.message,
      code: fallbackCode,
    });
  }
  console.error('[CodexAuth] Error:', error);
  return res.status(500).json({
    error: error instanceof Error ? error.message : 'Internal error',
    code: fallbackCode,
  });
}

router.get(
  '/status',
  async (req: Request, res: Response<CodexAuthStatusResponse | CodexAuthErrorBody>) => {
    try {
      const status = await getCodexAuthStatus(req.user!.id);
      const activeLogin = getActiveCodexAuthLogin(req.user!.id);
      res.json({
        authenticated: status.authenticated,
        status: status.status,
        method: status.method ?? null,
        email: status.email ?? null,
        tokenFingerprint: status.tokenFingerprint ?? null,
        reason: status.authenticated ? null : (status.reason ?? null),
        login: activeLogin
          ? {
              active: true,
              loginSessionId: activeLogin.loginSessionId,
              authUrl: activeLogin.authUrl,
              deviceCode: activeLogin.deviceCode,
              startedAt: activeLogin.startedAt,
              expiresAt: activeLogin.expiresAt,
            }
          : null,
      });
    } catch (error) {
      authErrorResponse(res as Response<CodexAuthErrorBody | ApiError>, error);
    }
  },
);

router.post(
  '/start',
  async (req: Request, res: Response<StartCodexAuthResponse | CodexAuthErrorBody>) => {
    try {
      const login = await startCodexAuthLogin(req.user!.id);
      res.status(201).json({
        loginSessionId: login.loginSessionId,
        authUrl: login.authUrl,
        deviceCode: login.deviceCode,
        startedAt: login.startedAt,
        expiresAt: login.expiresAt,
      });
    } catch (error) {
      authErrorResponse(res as Response<CodexAuthErrorBody | ApiError>, error);
    }
  },
);

router.post(
  '/cancel',
  (req: Request, res: Response<CancelCodexAuthResponse | CodexAuthErrorBody>) => {
    try {
      const cancelled = cancelCodexAuthLogin(req.user!.id, 'user-cancelled');
      res.json({ cancelled });
    } catch (error) {
      authErrorResponse(res as Response<CodexAuthErrorBody | ApiError>, error);
    }
  },
);

router.post(
  '/paste',
  validateBody(PasteCodexAuthBodySchema),
  async (
    req: Request,
    res: Response<PasteCodexAuthResponse | CodexAuthErrorBody>,
  ) => {
    const { authJson } = req.validated!.body as PasteCodexAuthBody;
    let parsed: unknown;
    try {
      parsed = JSON.parse(authJson);
    } catch {
      return authErrorResponse(
        res as Response<CodexAuthErrorBody | ApiError>,
        new CodexCredentialsError('auth.json paste is not valid JSON'),
        'CODEX_AUTH_INVALID_PAYLOAD',
      );
    }

    // Shape check before persistence so we never write an unusable file.
    const payload = parsed as {
      tokens?: { access_token?: unknown; id_token?: unknown };
      OPENAI_API_KEY?: unknown;
    };
    const hasOauth =
      typeof payload.tokens?.access_token === 'string' ||
      typeof payload.tokens?.id_token === 'string';
    const hasApiKey = typeof payload.OPENAI_API_KEY === 'string';
    if (!hasOauth && !hasApiKey) {
      return authErrorResponse(
        res as Response<CodexAuthErrorBody | ApiError>,
        new CodexCredentialsError(
          'auth.json paste must contain tokens.access_token, tokens.id_token, or OPENAI_API_KEY',
        ),
        'CODEX_AUTH_INVALID_PAYLOAD',
      );
    }

    try {
      writeCodexAuth(req.user!.id, parsed);
      const status = await getCodexAuthStatus(req.user!.id);
      if (!status.authenticated) {
        return authErrorResponse(
          res as Response<CodexAuthErrorBody | ApiError>,
          new CodexCredentialsError(
            status.reason ?? 'Persisted auth.json did not validate',
          ),
          'CODEX_AUTH_INVALID_PAYLOAD',
        );
      }
      // Seed this user's per-agent model settings from their first connected
      // provider if they have none yet (idempotent; non-fatal on failure).
      await seedAgentSettingsAfterConnect(req.user!.id);

      res.status(201).json({
        authenticated: true,
        status: 'authenticated',
        method: status.method!,
        tokenFingerprint: status.tokenFingerprint!,
      });
    } catch (error) {
      authErrorResponse(res as Response<CodexAuthErrorBody | ApiError>, error);
    }
  },
);

router.delete(
  '/',
  (req: Request, res: Response<ClearCodexAuthResponse | CodexAuthErrorBody>) => {
    try {
      const cleared = clearCodexAuth(req.user!.id);
      res.json({ cleared });
    } catch (error) {
      authErrorResponse(res as Response<CodexAuthErrorBody | ApiError>, error);
    }
  },
);

export default router;
