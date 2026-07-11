/*
 * useProviderModelSelection.ts — shared provider + model selection state.
 *
 * Every place that starts a conversation lets the user pick an explicit
 * (provider, model) pair (the system never defaults a model server-side).
 * This hook centralises that selection — the OpenCode catalog fetch, the
 * provider→model reset, and the derived dropdown options — so the picker is
 * identical across the New Conversation modal, the Ask-a-Question modal, and
 * the Fix-CI modal. Render it with `<ProviderModelPicker />`.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { api } from '../utils/api';
import { MODELS_FOR_UI } from '../../shared/types/agentModelSettings';
import { PROVIDERS } from '../../shared/providers/models';
import { useConnectedProviders } from '../contexts/ConnectedProvidersContext';
import type { Provider } from '../../shared/providers/types';
import type { OpenCodeModelEntry } from '../../shared/api/openCodeAuth';

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go',
};

// Static labels for the two enum-backed providers. OpenCode labels come from
// the live Zen catalog (fetched per-user), never hardcoded.
const MODEL_LABELS: Record<string, string> = {
  sonnet: 'Sonnet',
  opus: 'Opus',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 mini',
};

/** First selectable model for a provider, given the (maybe-unloaded) OpenCode catalog (Zen or Go). */
export function firstModelFor(
  p: Provider,
  openCodeModels: OpenCodeModelEntry[] | null,
): string {
  if (p === 'opencode' || p === 'opencode-go') {
    return openCodeModels && openCodeModels.length > 0 ? openCodeModels[0]!.id : '';
  }
  return MODELS_FOR_UI[p][0] ?? '';
}

/**
 * The provider a fresh conversation should default to: the highest-priority
 * provider the user has actually connected. Priority follows `PROVIDERS`
 * (anthropic > openai > opencode), matching how the server seeds per-agent
 * settings from a user's first connected provider — so the conversation
 * default lines up with the agent default. Falls back to `'anthropic'` only
 * when nothing is connected yet (the app-wide ConnectedProviders gate makes
 * that transient).
 */
export function preferredProvider(connected: Provider[]): Provider {
  return PROVIDERS.find((p) => connected.includes(p)) ?? 'anthropic';
}

export interface ProviderModelSelection {
  provider: Provider;
  model: string;
  setModel: (m: string) => void;
  handleProviderChange: (next: Provider) => void;
  modelOptions: Array<{ value: string; label: string }>;
  loadingOpenCodeModels: boolean;
  /**
   * Providers the user can pick — the ones they've connected. The picker
   * renders only these, so a user with (say) only OpenCode connected never
   * lands on the Anthropic option and never trips the Claude-auth gate.
   */
  availableProviders: Provider[];
  /** Reset the selection back to the preferred connected provider. */
  reset: () => void;
}

export function useProviderModelSelection(): ProviderModelSelection {
  const { connected } = useConnectedProviders();
  // Restrict the picker to connected providers, in canonical priority order.
  // Until the connected set has loaded, fall back to all providers so the
  // dropdown is never empty.
  const availableProviders = useMemo<Provider[]>(
    () => (connected.length > 0 ? PROVIDERS.filter((p) => connected.includes(p)) : [...PROVIDERS]),
    [connected],
  );

  const [provider, setProvider] = useState<Provider>(() => preferredProvider(connected));
  const [model, setModel] = useState<string>(() =>
    firstModelFor(preferredProvider(connected), null),
  );
  // Set once the user picks a provider by hand, so the connected-set effect
  // below stops overriding their choice.
  const userPickedRef = useRef(false);
  // Live OpenCode catalog: null = not yet fetched, [] = fetched-but-none (no key).
  const [openCodeModels, setOpenCodeModels] = useState<OpenCodeModelEntry[] | null>(null);
  const [loadingOpenCodeModels, setLoadingOpenCodeModels] = useState(false);

  // Best-effort fetch of the per-user OpenCode catalog. Returns [] (not an
  // error) when the user has no Zen or Go key, mirroring the settings UI.
  const loadOpenCodeModels = useCallback(async (providerID: 'opencode' | 'opencode-go' = 'opencode') => {
    setLoadingOpenCodeModels(true);
    try {
      const res = providerID === 'opencode-go' 
        ? await api.openCodeAuth.modelsGo()
        : await api.openCodeAuth.models();
      if (!res.ok) {
        setOpenCodeModels([]);
        return;
      }
      const body = await res.json();
      setOpenCodeModels(body.models);
      // Only auto-select if the user hasn't already picked something.
      setModel((prev) => (prev === '' && body.models.length > 0 ? body.models[0]!.id : prev));
    } catch {
      setOpenCodeModels([]);
    } finally {
      setLoadingOpenCodeModels(false);
    }
  }, []);

  // Switch provider + reset the model to that provider's first option. For
  // OpenCode (Zen or Go) this kicks off the (lazy, per-user) catalog fetch on first use.
  const applyProvider = useCallback(
    (next: Provider) => {
      setProvider(next);
      if (next === 'opencode' || next === 'opencode-go') {
        setModel('');
        void loadOpenCodeModels(next);
      } else {
        setModel(firstModelFor(next, openCodeModels));
      }
    },
    [openCodeModels, loadOpenCodeModels],
  );

  const handleProviderChange = useCallback(
    (next: Provider) => {
      userPickedRef.current = true;
      applyProvider(next);
    },
    [applyProvider],
  );

  // Snap to the preferred connected provider once we know what's connected
  // (the set loads asynchronously), unless the user has already picked one by
  // hand. Also lazily fetches the OpenCode catalog when OpenCode (Zen or Go) is the
  // default — so a connect-OpenCode-only user opens the modal with their
  // models already populated.
  useEffect(() => {
    if (userPickedRef.current || connected.length === 0) return;
    const preferred = preferredProvider(connected);
    if (preferred !== provider) {
      applyProvider(preferred);
    } else if ((preferred === 'opencode' || preferred === 'opencode-go') && openCodeModels === null && !loadingOpenCodeModels) {
      setModel('');
      void loadOpenCodeModels(preferred);
    }
  }, [connected, provider, openCodeModels, loadingOpenCodeModels, applyProvider, loadOpenCodeModels]);

  // Options for the model dropdown — static enum for anthropic/openai, the
  // live OpenCode catalog (Zen or Go) for opencode/opencode-go (empty until fetched or when no key).
  const modelOptions = useMemo<Array<{ value: string; label: string }>>(
    () =>
      provider === 'opencode' || provider === 'opencode-go'
        ? (openCodeModels ?? []).map((m) => ({
            value: m.id,
            label: m.status === 'deprecated' ? `${m.name} (deprecated)` : m.name,
          }))
        : MODELS_FOR_UI[provider].map((m) => ({ value: m, label: MODEL_LABELS[m] ?? m })),
    [provider, openCodeModels],
  );

  // `reset` must keep a STABLE identity: callers wire it into open/close
  // effects (e.g. `[isOpen, resetProviderModel]`). If its identity changed when
  // the OpenCode catalog resolved, those effects would re-run mid-open and wipe
  // user input. So read `connected`/`applyProvider` through refs instead of
  // depending on them.
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const applyProviderRef = useRef(applyProvider);
  applyProviderRef.current = applyProvider;

  const reset = useCallback(() => {
    userPickedRef.current = false;
    applyProviderRef.current(preferredProvider(connectedRef.current));
    // Keep the fetched OpenCode catalog cached across opens (per-user, stable).
  }, []);

  return {
    provider,
    model,
    setModel,
    handleProviderChange,
    modelOptions,
    loadingOpenCodeModels,
    availableProviders,
    reset,
  };
}
