import express, { type Request, type Response } from 'express';
import {
  cancelClaudeAuthLogin,
  ClaudeAuthLoginError,
  completeClaudeAuthLogin,
  getActiveClaudeAuthLogin,
  startClaudeAuthLogin,
} from '../services/claudeAuthFlow.js';
import {
  ClaudeCredentialsError,
  clearClaudeOAuthToken,
  getClaudeAuthStatus,
} from '../services/claudeCredentials.js';
import { seedAgentSettingsAfterConnect } from '../services/agentModelSettings.js';
import type {
  CancelClaudeAuthResponse,
  ClaudeAuthStatusResponse,
  ClearClaudeAuthResponse,
  CompleteClaudeAuthResponse,
  StartClaudeAuthResponse,
} from '../../shared/api/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  CompleteClaudeAuthBodySchema,
  type CompleteClaudeAuthBody,
} from '../../shared/schemas/auth.js';

const router = express.Router();

interface ClaudeAuthErrorBody {
  error: string;
  code: 'CLAUDE_AUTH_FLOW_ERROR' | 'CLAUDE_AUTH_STORAGE_ERROR';
}

function routeLog(
  req: Pick<Request, 'baseUrl' | 'path' | 'user'>,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  console.log(
    '[ClaudeAuthRoute]',
    JSON.stringify({
      message,
      userId: req.user?.id ?? null,
      path: `${req.baseUrl || ''}${req.path || ''}`,
      ...extra,
    }),
  );
}

function authErrorResponse(res: Response<ClaudeAuthErrorBody>, error: unknown): Response {
  if (error instanceof ClaudeAuthLoginError) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: 'CLAUDE_AUTH_FLOW_ERROR',
    });
  }

  if (error instanceof ClaudeCredentialsError) {
    return res.status(500).json({
      error: error.message,
      code: 'CLAUDE_AUTH_STORAGE_ERROR',
    });
  }

  console.error('[ClaudeAuth] Error:', error);
  return res.status(500).json({
    error: 'Claude authentication failed',
    code: 'CLAUDE_AUTH_FLOW_ERROR',
  });
}

// `getClaudeAuthStatus` and `completeClaudeAuthLogin` return ad-hoc shapes
// today (`{ authenticated, status, tokenPath, ... }`). Older route code
// reached for `authMethod` / `apiProvider` even though the underlying
// helpers don't currently set them — the values just landed as `undefined`
// and were coalesced to `null`. Until the credential helpers grow proper
// types, treat their return values as a wider record so the route surface
// keeps that behaviour without `tsc` complaining.
type ClaudeStatusLoose = {
  authenticated: boolean;
  status: string;
  reason?: string | null;
  authMethod?: string | null;
  apiProvider?: string | null;
};

router.get(
  '/status',
  async (req: Request, res: Response<ClaudeAuthStatusResponse | ClaudeAuthErrorBody>) => {
    try {
      routeLog(req, 'status-request');
      const status = (await getClaudeAuthStatus(req.user!.id)) as ClaudeStatusLoose;
      const activeLogin = getActiveClaudeAuthLogin(req.user!.id);
      routeLog(req, 'status-response', {
        authenticated: status.authenticated,
        status: status.status,
        hasActiveLogin: Boolean(activeLogin),
      });

      res.json({
        authenticated: status.authenticated,
        status: status.status,
        authMethod: status.authMethod || null,
        apiProvider: status.apiProvider || null,
        reason: status.authenticated ? null : status.reason || null,
        login: activeLogin
          ? {
              active: true,
              loginSessionId: activeLogin.loginSessionId,
              authUrl: activeLogin.authUrl,
              startedAt: activeLogin.startedAt,
              expiresAt: activeLogin.expiresAt,
            }
          : null,
      });
    } catch (error) {
      authErrorResponse(res as Response<ClaudeAuthErrorBody>, error);
    }
  },
);

router.post(
  '/start',
  async (req: Request, res: Response<StartClaudeAuthResponse | ClaudeAuthErrorBody>) => {
    try {
      routeLog(req, 'start-request');
      const login = await startClaudeAuthLogin(req.user!.id);
      routeLog(req, 'start-response', {
        loginSessionId: login.loginSessionId,
        hasAuthUrl: Boolean(login.authUrl),
        expiresAt: login.expiresAt,
      });

      res.status(201).json({
        loginSessionId: login.loginSessionId,
        authUrl: login.authUrl,
        startedAt: login.startedAt,
        expiresAt: login.expiresAt,
      });
    } catch (error) {
      authErrorResponse(res as Response<ClaudeAuthErrorBody>, error);
    }
  },
);

router.post(
  '/complete',
  validateBody(CompleteClaudeAuthBodySchema),
  async (
    req: Request,
    res: Response<CompleteClaudeAuthResponse | ClaudeAuthErrorBody>,
  ) => {
    try {
      const { loginSessionId, code } = req.validated!.body as CompleteClaudeAuthBody;
      routeLog(req, 'complete-request', {
        loginSessionId: loginSessionId || null,
        codeLength: typeof code === 'string' ? code.trim().length : 0,
      });
      const status = (await completeClaudeAuthLogin(
        req.user!.id,
        loginSessionId,
        code,
      )) as ClaudeStatusLoose;
      routeLog(req, 'complete-response', {
        authenticated: true,
        authMethod: status.authMethod || null,
        apiProvider: status.apiProvider || null,
      });

      // Seed this user's per-agent model settings from their first connected
      // provider if they have none yet (idempotent; non-fatal on failure).
      await seedAgentSettingsAfterConnect(req.user!.id);

      res.json({
        authenticated: true,
        status: status.status,
        authMethod: status.authMethod || null,
        apiProvider: status.apiProvider || null,
      });
    } catch (error) {
      authErrorResponse(res as Response<ClaudeAuthErrorBody>, error);
    }
  },
);

router.post(
  '/cancel',
  (req: Request, res: Response<CancelClaudeAuthResponse | ClaudeAuthErrorBody>) => {
    try {
      routeLog(req, 'cancel-request');
      const cancelled = cancelClaudeAuthLogin(req.user!.id, 'user-cancelled');
      routeLog(req, 'cancel-response', { cancelled });
      res.json({ cancelled });
    } catch (error) {
      authErrorResponse(res as Response<ClaudeAuthErrorBody>, error);
    }
  },
);

// Disconnect: delete the per-user OAuth token. `cleared` is false when there
// was nothing to remove. The next Claude query will fail to read a token and
// fall back to the connect flow, so there's no subprocess pool to invalidate.
router.delete(
  '/',
  (req: Request, res: Response<ClearClaudeAuthResponse | ClaudeAuthErrorBody>) => {
    try {
      routeLog(req, 'clear-request');
      const cleared = clearClaudeOAuthToken(req.user!.id);
      routeLog(req, 'clear-response', { cleared });
      res.json({ cleared });
    } catch (error) {
      authErrorResponse(res as Response<ClaudeAuthErrorBody>, error);
    }
  },
);

export default router;
