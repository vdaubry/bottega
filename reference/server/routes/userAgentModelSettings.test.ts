import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../services/agentModelSettings.js', () => ({
  loadAgentModelSettings: vi.fn(),
  saveAgentModelSettings: vi.fn(),
  MissingUserAgentSettingsError: class MissingUserAgentSettingsError extends Error {},
}));

vi.mock('../services/credentials/registry.js', () => ({
  getCredentialStore: vi.fn(),
}));

import userAgentModelSettingsRoutes from './userAgentModelSettings.js';
import {
  loadAgentModelSettings,
  saveAgentModelSettings,
  MissingUserAgentSettingsError,
} from '../services/agentModelSettings.js';
import { getCredentialStore } from '../services/credentials/registry.js';
import {
  AGENT_TYPES_WITH_SETTINGS,
  type AgentModelSetting,
  type AgentModelSettings,
} from '../../shared/types/agentModelSettings.js';
import type { Provider } from '../../shared/providers/types.js';

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: number } }).user = { id: 5 };
    next();
  });
  app.use('/api/uams', userAgentModelSettingsRoutes);
  return app;
}

function fullSettings(setting: AgentModelSetting): AgentModelSettings {
  const out: Record<string, AgentModelSetting> = {};
  for (const a of AGENT_TYPES_WITH_SETTINGS) out[a] = setting;
  return out as AgentModelSettings;
}

function connectProviders(...connected: Provider[]): void {
  vi.mocked(getCredentialStore).mockImplementation(
    (p: Provider) =>
      ({
        getStatus: async () => ({
          authenticated: connected.includes(p),
          status: connected.includes(p) ? 'authenticated' : 'missing',
          tokenPath: null,
        }),
      }) as unknown as ReturnType<typeof getCredentialStore>,
  );
}

describe('/api/user-agent-model-settings', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('GET returns needsSeeding when the user is unseeded', async () => {
    vi.mocked(loadAgentModelSettings).mockImplementation(() => {
      throw new MissingUserAgentSettingsError(5, 'unseeded');
    });
    const res = await request(app).get('/api/uams');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsSeeding: true });
  });

  it('GET returns the settings for a seeded user', async () => {
    const settings = fullSettings({ provider: 'anthropic', model: 'sonnet', effort: 'high' });
    vi.mocked(loadAgentModelSettings).mockReturnValue(settings);
    const res = await request(app).get('/api/uams');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsSeeding: false, settings });
  });

  it('PUT persists a valid full settings object', async () => {
    const settings = fullSettings({ provider: 'openai', model: 'gpt-5.5', effort: 'high' });
    const res = await request(app).put('/api/uams').send(settings);
    expect(res.status).toBe(200);
    expect(saveAgentModelSettings).toHaveBeenCalledWith(5, settings);
    expect(res.body.settings).toEqual(settings);
  });

  it('PUT rejects a payload missing an agent entry (400)', async () => {
    const res = await request(app)
      .put('/api/uams')
      .send({ planification: { provider: 'anthropic', model: 'sonnet', effort: 'high' } });
    expect(res.status).toBe(400);
    expect(saveAgentModelSettings).not.toHaveBeenCalled();
  });

  it('PUT rejects a cross-provider model (anthropic + gpt-5.5) (400)', async () => {
    const settings = fullSettings({ provider: 'anthropic', model: 'gpt-5.5', effort: 'high' });
    const res = await request(app).put('/api/uams').send(settings);
    expect(res.status).toBe(400);
    expect(saveAgentModelSettings).not.toHaveBeenCalled();
  });

  it('GET /connected-providers filters by credential status', async () => {
    connectProviders('anthropic', 'opencode');
    const res = await request(app).get('/api/uams/connected-providers');
    expect(res.status).toBe(200);
    expect(res.body.connected.sort()).toEqual(['anthropic', 'opencode']);
  });
});
