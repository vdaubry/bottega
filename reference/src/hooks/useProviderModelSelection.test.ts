import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Provider } from '../../shared/providers/types';
import { useProviderModelSelection, preferredProvider } from './useProviderModelSelection';

// The connected set the mocked ConnectedProviders context reports. Mutate it
// before rendering the hook to simulate different account states.
let mockConnected: Provider[] = [];
vi.mock('../contexts/ConnectedProvidersContext', () => ({
  useConnectedProviders: () => ({
    connected: mockConnected,
    hasAny: mockConnected.length > 0,
    loading: false,
    refresh: vi.fn(),
  }),
}));

// Stub the OpenCode catalog fetch so a default-to-OpenCode account can resolve
// a model without hitting the network.
const mockModels = vi.fn();
vi.mock('../utils/api', () => ({
  api: { openCodeAuth: { models: () => mockModels() } },
}));

function catalog(...ids: string[]) {
  return {
    ok: true,
    json: async () => ({ models: ids.map((id) => ({ id, name: id, status: 'active' })) }),
  };
}

describe('preferredProvider', () => {
  it('prefers anthropic > openai > opencode', () => {
    expect(preferredProvider(['opencode', 'openai', 'anthropic'])).toBe('anthropic');
    expect(preferredProvider(['opencode', 'openai'])).toBe('openai');
    expect(preferredProvider(['opencode'])).toBe('opencode');
  });

  it('falls back to anthropic when nothing is connected', () => {
    expect(preferredProvider([])).toBe('anthropic');
  });
});

describe('useProviderModelSelection', () => {
  beforeEach(() => {
    mockConnected = [];
    mockModels.mockReset();
  });

  it('defaults to the only connected provider (opencode) and loads its catalog', async () => {
    mockConnected = ['opencode'];
    mockModels.mockResolvedValue(catalog('opencode/big-pickle', 'opencode/other'));

    const { result } = renderHook(() => useProviderModelSelection());

    // Never defaults to Anthropic for an OpenCode-only account — that's what
    // used to trip the Claude-auth modal on a new conversation.
    expect(result.current.provider).toBe('opencode');
    // The picker only offers what's connected.
    expect(result.current.availableProviders).toEqual(['opencode']);
    // The catalog is fetched and the first model auto-selected.
    await waitFor(() => expect(result.current.model).toBe('opencode/big-pickle'));
  });

  it('defaults to anthropic + sonnet when Anthropic is connected', () => {
    mockConnected = ['anthropic', 'opencode'];

    const { result } = renderHook(() => useProviderModelSelection());

    expect(result.current.provider).toBe('anthropic');
    expect(result.current.model).toBe('sonnet');
    expect(result.current.availableProviders).toEqual(['anthropic', 'opencode']);
  });

  it('offers all providers but defaults to anthropic before the connected set loads', () => {
    mockConnected = [];

    const { result } = renderHook(() => useProviderModelSelection());

    expect(result.current.provider).toBe('anthropic');
    expect(result.current.availableProviders).toEqual(['anthropic', 'openai', 'opencode', 'opencode-go']);
  });

  it('keeps a manual provider pick instead of snapping back to the connected default', async () => {
    mockConnected = ['anthropic', 'openai'];

    const { result } = renderHook(() => useProviderModelSelection());
    expect(result.current.provider).toBe('anthropic');

    act(() => result.current.handleProviderChange('openai'));
    expect(result.current.provider).toBe('openai');

    // The connected-set effect must not override the user's explicit choice.
    await waitFor(() => expect(result.current.provider).toBe('openai'));
  });

  it('keeps a stable reset identity across an OpenCode catalog load', async () => {
    // Regression: callers wire `reset` into open/close effects
    // (`[isOpen, resetProviderModel]`). If `reset` changed identity when the
    // catalog resolved, those effects would re-fire mid-open and wipe input.
    mockConnected = ['opencode'];
    let resolveModels: () => void = () => {};
    mockModels.mockImplementation(
      () => new Promise((res) => { resolveModels = () => res(catalog('opencode/big-pickle')); }),
    );

    const { result } = renderHook(() => useProviderModelSelection());
    const resetBefore = result.current.reset;
    expect(result.current.model).toBe(''); // catalog still pending

    await act(async () => {
      resolveModels();
    });
    await waitFor(() => expect(result.current.model).toBe('opencode/big-pickle'));

    expect(result.current.reset).toBe(resetBefore);
  });
});
