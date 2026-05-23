// Global application settings (single-instance key/value).
//
// GET is public so the dashboard can render the configured tool name on the
// login screen, before the user is authenticated. PUT is admin-only.

import express, { type Request, type Response } from 'express';
import { appSettingsDb } from '../database/db.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import type { ApiError } from '../../shared/api/_common.js';
import type {
  GetAppSettingsResponse,
  UpdateAppSettingsRequest,
  UpdateAppSettingsResponse,
} from '../../shared/api/settings.js';

const router = express.Router();

// Per-agent provider/model/effort is now per-user (see
// `/api/user-agent-model-settings`), not a global key. Only free-text global
// keys remain here.
const ALLOWED_KEYS = new Set<keyof UpdateAppSettingsRequest>([
  'internal_tool_name',
  'github_pr_trigger',
]);

const MAX_VALUE_LENGTH = 100;

function normalizeTrigger(value: string): string {
  return value.trim().replace(/^@+/, '').toLowerCase();
}

router.get('/', (_req: Request, res: Response<GetAppSettingsResponse | ApiError>) => {
  try {
    const settings = appSettingsDb.getAll() as unknown as GetAppSettingsResponse;
    res.json(settings);
  } catch (error) {
    console.error('Error reading app_settings:', error);
    res.status(500).json({ error: 'Failed to read app settings' });
  }
});

router.put(
  '/',
  authenticateToken,
  requireAdmin,
  (
    req: Request<unknown, UpdateAppSettingsResponse | ApiError, UpdateAppSettingsRequest>,
    res: Response<UpdateAppSettingsResponse | ApiError>,
  ) => {
    const updates: UpdateAppSettingsRequest = req.body || {};
    const cleaned: Record<string, string> = {};

    for (const [key, rawValue] of Object.entries(updates)) {
      if (!ALLOWED_KEYS.has(key as keyof UpdateAppSettingsRequest)) {
        return res.status(400).json({ error: `Unknown setting key: ${key}` });
      }
      if (typeof rawValue !== 'string') {
        return res.status(400).json({ error: `Value for ${key} must be a string` });
      }

      let value = rawValue.trim();
      if (key === 'github_pr_trigger') {
        value = normalizeTrigger(value);
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
          return res.status(400).json({
            error: 'github_pr_trigger must contain only letters, digits, hyphens, or underscores',
          });
        }
      }

      if (!value) {
        return res.status(400).json({ error: `Value for ${key} cannot be empty` });
      }
      if (value.length > MAX_VALUE_LENGTH) {
        return res
          .status(400)
          .json({ error: `Value for ${key} is too long (max ${MAX_VALUE_LENGTH})` });
      }

      cleaned[key] = value;
    }

    try {
      for (const [key, value] of Object.entries(cleaned)) {
        appSettingsDb.setValue(key, value);
      }
      res.json(appSettingsDb.getAll() as unknown as UpdateAppSettingsResponse);
    } catch (error) {
      console.error('Error writing app_settings:', error);
      res.status(500).json({ error: 'Failed to save app settings' });
    }
  },
);

export default router;
