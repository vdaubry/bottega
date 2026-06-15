import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/db.js', () => ({
  userAgentModelSettingsDb: {
    getRaw: vi.fn(),
    set: vi.fn(),
  },
  userDb: {
    completeOnboarding: vi.fn(),
  },
  agentRunsDb: {
    getByConversationId: vi.fn(),
  },
}));

vi.mock('./credentials/registry.js', () => ({
  getCredentialStore: vi.fn(),
}));

vi.mock('./providers/opencode/index.js', () => ({
  listOpenCodeModels: vi.fn(),
}));

import {
  loadAgentModelSettings,
  ensureUserAgentModelSettings,
  resolveResumeModelEffort,
  MissingUserAgentSettingsError,
} from './agentModelSettings.js';
import { userAgentModelSettingsDb, userDb, agentRunsDb } from '../database/db.js';
import { getCredentialStore } from './credentials/registry.js';
import { listOpenCodeModels } from './providers/opencode/index.js';
import {
  AGENT_TYPES_WITH_SETTINGS,
  type AgentModelSetting,
} from '../../shared/types/agentModelSettings.js';
import type { Provider } from '../../shared/providers/types.js';

const USER = 7;

function fullBlob(setting: AgentModelSetting): string {
  const out: Record<string, AgentModelSetting> = {};
  for (const a of AGENT_TYPES_WITH_SETTINGS) out[a] = setting;
  return JSON.stringify(out);
}

// Wire getCredentialStore so the given providers report authenticated.
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadAgentModelSettings (per-user)', () => {
  it('throws when the user has no settings row', () => {
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(null);
    expect(() => loadAgentModelSettings(USER)).toThrow(MissingUserAgentSettingsError);
  });

  it('throws on malformed JSON', () => {
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue('{not json');
    expect(() => loadAgentModelSettings(USER)).toThrow(MissingUserAgentSettingsError);
  });

  it('throws when an agent entry is missing (partial blob)', () => {
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(
      JSON.stringify({ planification: { provider: 'anthropic', model: 'sonnet', effort: 'high' } }),
    );
    expect(() => loadAgentModelSettings(USER)).toThrow(MissingUserAgentSettingsError);
  });

  it('throws when an entry has an invalid model for its provider', () => {
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(
      fullBlob({ provider: 'anthropic', model: 'haiku', effort: 'high' }),
    );
    expect(() => loadAgentModelSettings(USER)).toThrow(MissingUserAgentSettingsError);
  });

  it('throws on a cross-provider entry (openai + opus)', () => {
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(
      fullBlob({ provider: 'openai', model: 'opus', effort: 'high' }),
    );
    expect(() => loadAgentModelSettings(USER)).toThrow(MissingUserAgentSettingsError);
  });

  it('returns a fully-populated map for a valid blob', () => {
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(
      fullBlob({ provider: 'openai', model: 'gpt-5.5', effort: 'high' }),
    );
    const result = loadAgentModelSettings(USER);
    expect(result.planification).toEqual({ provider: 'openai', model: 'gpt-5.5', effort: 'high' });
    expect(result.yolo).toEqual({ provider: 'openai', model: 'gpt-5.5', effort: 'high' });
  });

  it('coerces a legacy entry without a provider to anthropic (D6)', () => {
    // Backfilled pre-multi-provider rows: { model, effort } with no provider.
    const out: Record<string, { model: string; effort: string }> = {};
    for (const a of AGENT_TYPES_WITH_SETTINGS) out[a] = { model: 'opus', effort: 'high' };
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(JSON.stringify(out));
    const result = loadAgentModelSettings(USER);
    expect(result.implementation).toEqual({ provider: 'anthropic', model: 'opus', effort: 'high' });
  });

  it('migrates corrupt opencode-go entries that have an opencode/ prefixed model', () => {
    // The original opencode-go UI had a stale-closure bug: when switching a
    // phase to opencode-go, it picked the first Zen model (opencode/...) from
    // the stale closure and saved it under the opencode-go provider. The new
    // strict validator rejects opencode/ models for opencode-go, so we re-
    // prefix them on load to opencode-go/<bareModelId>.
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(
      fullBlob({ provider: 'opencode-go', model: 'opencode/kimi-k2.6', effort: null }),
    );
    const result = loadAgentModelSettings(USER);
    expect(result.planification).toEqual({
      provider: 'opencode-go',
      model: 'opencode-go/kimi-k2.6',
      effort: null,
    });
    // All six agents should be migrated.
    expect(result.yolo).toEqual({
      provider: 'opencode-go',
      model: 'opencode-go/kimi-k2.6',
      effort: null,
    });
  });
});

describe('ensureUserAgentModelSettings', () => {
  it('returns false (no write) when the user already has settings', async () => {
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(fullBlob({
      provider: 'anthropic',
      model: 'sonnet',
      effort: 'high',
    }));
    const result = await ensureUserAgentModelSettings(USER);
    expect(result).toBe(false);
    expect(userAgentModelSettingsDb.set).not.toHaveBeenCalled();
  });

  it('returns false when no provider is connected', async () => {
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(null);
    connectProviders();
    const result = await ensureUserAgentModelSettings(USER);
    expect(result).toBe(false);
    expect(userAgentModelSettingsDb.set).not.toHaveBeenCalled();
  });

  it('seeds anthropic→sonnet and completes onboarding', async () => {
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(null);
    connectProviders('anthropic');
    const result = await ensureUserAgentModelSettings(USER);
    expect(result).toBe(true);
    const saved = JSON.parse(vi.mocked(userAgentModelSettingsDb.set).mock.calls[0]![1]);
    expect(saved.planification).toEqual({ provider: 'anthropic', model: 'sonnet', effort: 'high' });
    expect(userDb.completeOnboarding).toHaveBeenCalledWith(USER);
  });

  it('seeds openai→gpt-5.5 when only OpenAI is connected', async () => {
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(null);
    connectProviders('openai');
    await ensureUserAgentModelSettings(USER);
    const saved = JSON.parse(vi.mocked(userAgentModelSettingsDb.set).mock.calls[0]![1]);
    expect(saved.review).toEqual({ provider: 'openai', model: 'gpt-5.5', effort: 'high' });
  });

  it('prefers anthropic over opencode when both are connected', async () => {
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(null);
    connectProviders('anthropic', 'opencode');
    await ensureUserAgentModelSettings(USER);
    const saved = JSON.parse(vi.mocked(userAgentModelSettingsDb.set).mock.calls[0]![1]);
    expect(saved.pr.provider).toBe('anthropic');
  });

  it('seeds opencode from the first live catalog entry', async () => {
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(null);
    connectProviders('opencode');
    vi.mocked(listOpenCodeModels).mockResolvedValue([
      { id: 'opencode/kimi-k2', bareModelId: 'kimi-k2', name: 'Kimi', status: 'active', contextWindow: null },
    ]);
    const result = await ensureUserAgentModelSettings(USER);
    expect(result).toBe(true);
    const saved = JSON.parse(vi.mocked(userAgentModelSettingsDb.set).mock.calls[0]![1]);
    expect(saved.planification).toEqual({ provider: 'opencode', model: 'opencode/kimi-k2', effort: null });
  });

  it('declines to seed opencode when its catalog is empty (no guessed id)', async () => {
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(null);
    connectProviders('opencode');
    vi.mocked(listOpenCodeModels).mockResolvedValue([]);
    const result = await ensureUserAgentModelSettings(USER);
    expect(result).toBe(false);
    expect(userAgentModelSettingsDb.set).not.toHaveBeenCalled();
  });
});

describe('resolveResumeModelEffort', () => {
  const convo = {
    id: 1,
    provider: 'anthropic' as Provider,
    model: 'opus',
    effort: 'high' as string | null,
  };

  it('keeps the stored model when no userId (programmatic resume)', () => {
    expect(resolveResumeModelEffort(convo, undefined)).toEqual({ model: 'opus', effort: 'high' });
    expect(agentRunsDb.getByConversationId).not.toHaveBeenCalled();
  });

  it('keeps the stored model for a manual conversation (no agent run)', () => {
    vi.mocked(agentRunsDb.getByConversationId).mockReturnValue(undefined);
    expect(resolveResumeModelEffort(convo, USER)).toEqual({ model: 'opus', effort: 'high' });
  });

  it("overrides model+effort from the resuming user's setting (same provider)", () => {
    vi.mocked(agentRunsDb.getByConversationId).mockReturnValue({ agent_type: 'planification' } as never);
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(
      fullBlob({ provider: 'anthropic', model: 'sonnet', effort: 'max' }),
    );
    expect(resolveResumeModelEffort(convo, USER)).toEqual({ model: 'sonnet', effort: 'max' });
  });

  it('keeps the stored model when the user setting targets a different provider', () => {
    vi.mocked(agentRunsDb.getByConversationId).mockReturnValue({ agent_type: 'planification' } as never);
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(
      fullBlob({ provider: 'openai', model: 'gpt-5.5', effort: 'high' }),
    );
    expect(resolveResumeModelEffort(convo, USER)).toEqual({ model: 'opus', effort: 'high' });
  });

  it('keeps the stored model when the resuming user is unseeded', () => {
    vi.mocked(agentRunsDb.getByConversationId).mockReturnValue({ agent_type: 'planification' } as never);
    vi.mocked(userAgentModelSettingsDb.getRaw).mockReturnValue(null);
    expect(resolveResumeModelEffort(convo, USER)).toEqual({ model: 'opus', effort: 'high' });
  });
});
