import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import appSettingsRoutes from './appSettings.js';

vi.mock('../database/db.js', () => ({
  appSettingsDb: {
    getAll: vi.fn(),
    setValue: vi.fn(),
  },
}));

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
  requireAdmin: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

import { appSettingsDb } from '../database/db.js';

describe('PUT /api/app-settings', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(appSettingsDb.getAll).mockReturnValue({
      internal_tool_name: 'Bottega',
      github_pr_trigger: 'bottega',
    });
    vi.mocked(appSettingsDb.setValue).mockImplementation((_k, v) => v);

    app = express();
    app.use(express.json());
    app.use('/api/app-settings', appSettingsRoutes);
  });

  it('accepts a free-text key update', async () => {
    const res = await request(app)
      .put('/api/app-settings')
      .send({ internal_tool_name: 'Atelier' });

    expect(res.status).toBe(200);
    expect(appSettingsDb.setValue).toHaveBeenCalledWith('internal_tool_name', 'Atelier');
  });

  it('normalizes the github_pr_trigger', async () => {
    const res = await request(app)
      .put('/api/app-settings')
      .send({ github_pr_trigger: '@MyBot' });

    expect(res.status).toBe(200);
    expect(appSettingsDb.setValue).toHaveBeenCalledWith('github_pr_trigger', 'mybot');
  });

  it('rejects agent_model_settings — it is now a per-user setting, not a global key', async () => {
    const res = await request(app)
      .put('/api/app-settings')
      .send({ agent_model_settings: JSON.stringify({ planification: {} }) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown setting key: agent_model_settings/);
    expect(appSettingsDb.setValue).not.toHaveBeenCalled();
  });
});
