// /api/user-agent-model-settings/* — per-user agent (provider, model, effort).
//
// Three routes (all per-user; mounted behind authenticateToken):
//   - GET  /                    — this user's settings, or { needsSeeding }
//   - PUT  /                    — replace this user's settings (all six agents)
//   - GET  /connected-providers — which providers this user has credentials for
//
// Replaces the old admin-only global `agent_model_settings` app-setting. The
// settings tab filters its provider dropdown to `connected-providers`; the
// blocking first-login modal gates on it being non-empty.

import express, { type Request, type Response } from 'express';
import {
  loadAgentModelSettings,
  saveAgentModelSettings,
  MissingUserAgentSettingsError,
} from '../services/agentModelSettings.js';
import { getCredentialStore } from '../services/credentials/registry.js';
import { validateBody } from '../middleware/validate.js';
import {
  PutUserAgentModelSettingsBodySchema,
  type PutUserAgentModelSettingsBody,
} from '../../shared/schemas/userAgentModelSettings.js';
import type {
  ConnectedProvidersResponse,
  GetUserAgentModelSettingsResponse,
  UpdateUserAgentModelSettingsResponse,
} from '../../shared/api/userAgentModelSettings.js';
import type { ApiError } from '../../shared/api/_common.js';
import type { AgentModelSettings } from '../../shared/types/agentModelSettings.js';
import { PROVIDERS } from '../../shared/providers/models.js';
import type { Provider } from '../../shared/providers/types.js';

const router = express.Router();

router.get('/', (req: Request, res: Response<GetUserAgentModelSettingsResponse | ApiError>) => {
  try {
    const settings = loadAgentModelSettings(req.user!.id);
    res.json({ needsSeeding: false, settings });
  } catch (error) {
    if (error instanceof MissingUserAgentSettingsError) {
      return res.json({ needsSeeding: true });
    }
    console.error('Error loading user agent model settings:', error);
    res.status(500).json({ error: 'Failed to load agent model settings' });
  }
});

router.put(
  '/',
  validateBody(PutUserAgentModelSettingsBodySchema),
  (req: Request, res: Response<UpdateUserAgentModelSettingsResponse | ApiError>) => {
    const body = req.validated!.body as PutUserAgentModelSettingsBody;
    try {
      saveAgentModelSettings(req.user!.id, body as AgentModelSettings);
      res.json({ settings: body as AgentModelSettings });
    } catch (error) {
      console.error('Error saving user agent model settings:', error);
      res.status(500).json({ error: 'Failed to save agent model settings' });
    }
  },
);

router.get(
  '/connected-providers',
  async (req: Request, res: Response<ConnectedProvidersResponse | ApiError>) => {
    try {
      const userId = req.user!.id;
      const connected: Provider[] = [];
      for (const provider of PROVIDERS) {
        try {
          const status = await getCredentialStore(provider).getStatus(userId);
          if (status.authenticated) connected.push(provider);
        } catch {
          // A provider whose status check throws is treated as not-connected.
        }
      }
      res.json({ connected });
    } catch (error) {
      console.error('Error checking connected providers:', error);
      res.status(500).json({ error: 'Failed to check connected providers' });
    }
  },
);

export default router;
