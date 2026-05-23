import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AgentModelsTab from './AgentModelsTab';
import { AGENT_TYPES_WITH_SETTINGS, type AgentModelSetting } from '../../shared/types/agentModelSettings';

vi.mock('lucide-react', () => ({
  Loader2: () => <span data-testid="icon-loader" />,
  AlertCircle: () => <span data-testid="icon-alert" />,
}));

vi.mock('../utils/api', () => ({
  api: {
    userAgentModelSettings: {
      get: vi.fn(),
      update: vi.fn(),
      connectedProviders: vi.fn(),
    },
    openCodeAuth: {
      models: vi.fn(),
    },
  },
}));

import { api } from '../utils/api';

function fakeRes<T>(status: number, body: T): Promise<Response & { json(): Promise<T> }> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response & { json(): Promise<T> });
}

function fullSettings(setting: AgentModelSetting): Record<string, AgentModelSetting> {
  const out: Record<string, AgentModelSetting> = {};
  for (const a of AGENT_TYPES_WITH_SETTINGS) out[a] = { ...setting };
  return out;
}

const anthropicSettings = fullSettings({ provider: 'anthropic', model: 'sonnet', effort: 'high' });

const zenCatalog = {
  models: [
    { id: 'opencode/kimi-k2.6', bareModelId: 'kimi-k2.6', name: 'Kimi K2.6', status: 'active' as const, contextWindow: 200000 },
    { id: 'opencode/qwen3.6-plus', bareModelId: 'qwen3.6-plus', name: 'Qwen3.6 Plus', status: 'active' as const, contextWindow: 128000 },
  ],
};

describe('AgentModelsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.userAgentModelSettings.get).mockReturnValue(
      fakeRes(200, { needsSeeding: false, settings: anthropicSettings }) as never,
    );
    vi.mocked(api.userAgentModelSettings.connectedProviders).mockReturnValue(
      fakeRes(200, { connected: ['anthropic', 'opencode'] }) as never,
    );
    vi.mocked(api.userAgentModelSettings.update).mockImplementation(
      ((settings: Record<string, AgentModelSetting>) => fakeRes(200, { settings })) as never,
    );
    vi.mocked(api.openCodeAuth.models).mockReturnValue(fakeRes(200, zenCatalog) as never);
  });

  it('renders a row per agent', async () => {
    render(<AgentModelsTab />);
    expect(await screen.findByTestId('agent-row-planification')).toBeInTheDocument();
    expect(screen.getByTestId('agent-row-yolo')).toBeInTheDocument();
  });

  it('filters the provider dropdown to connected providers only', async () => {
    vi.mocked(api.userAgentModelSettings.connectedProviders).mockReturnValue(
      fakeRes(200, { connected: ['anthropic'] }) as never,
    );
    render(<AgentModelsTab />);
    const provider = (await screen.findByTestId('agent-provider-select-planification')) as HTMLSelectElement;
    expect(provider.querySelector('option[value="anthropic"]')).not.toBeNull();
    expect(provider.querySelector('option[value="openai"]')).toBeNull();
    expect(provider.querySelector('option[value="opencode"]')).toBeNull();
  });

  it('prompts to connect a provider when the user is unseeded', async () => {
    vi.mocked(api.userAgentModelSettings.get).mockReturnValue(
      fakeRes(200, { needsSeeding: true }) as never,
    );
    render(<AgentModelsTab />);
    expect(await screen.findByText(/Connect a provider/i)).toBeInTheDocument();
  });

  it('switching a provider to OpenCode resets the model to the first Zen entry, hides Effort, and saves', async () => {
    render(<AgentModelsTab />);
    await waitFor(() => expect(api.openCodeAuth.models).toHaveBeenCalled());

    const provider = await screen.findByTestId('agent-provider-select-planification');
    fireEvent.change(provider, { target: { value: 'opencode' } });

    await waitFor(() => {
      const model = screen.getByTestId('agent-model-select-planification') as HTMLSelectElement;
      expect(model.value).toBe('opencode/kimi-k2.6');
    });
    expect(screen.queryByTestId('agent-effort-select-planification')).not.toBeInTheDocument();

    await waitFor(() => expect(api.userAgentModelSettings.update).toHaveBeenCalled());
    const calls = vi.mocked(api.userAgentModelSettings.update).mock.calls;
    const saved = calls[calls.length - 1]![0] as Record<string, AgentModelSetting>;
    expect(saved.planification).toEqual({ provider: 'opencode', model: 'opencode/kimi-k2.6', effort: null });
    // Other agents are unchanged in the full-object save.
    expect(saved.review?.provider).toBe('anthropic');
  });
});
