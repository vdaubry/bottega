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

import { useState, useCallback, useMemo } from 'react';
import { api } from '../utils/api';
import { MODELS_FOR_UI } from '../../shared/types/agentModelSettings';
import type { Provider } from '../../shared/providers/types';
import type { OpenCodeModelEntry } from '../../shared/api/openCodeAuth';

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  opencode: 'OpenCode',
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

/** First selectable model for a provider, given the (maybe-unloaded) Zen catalog. */
export function firstModelFor(
  p: Provider,
  openCodeModels: OpenCodeModelEntry[] | null,
): string {
  if (p === 'opencode') {
    return openCodeModels && openCodeModels.length > 0 ? openCodeModels[0]!.id : '';
  }
  return MODELS_FOR_UI[p][0] ?? '';
}

export interface ProviderModelSelection {
  provider: Provider;
  model: string;
  setModel: (m: string) => void;
  handleProviderChange: (next: Provider) => void;
  modelOptions: Array<{ value: string; label: string }>;
  loadingOpenCodeModels: boolean;
  /** Reset the selection back to the Claude default (keeps the cached catalog). */
  reset: () => void;
}

export function useProviderModelSelection(): ProviderModelSelection {
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState<string>(firstModelFor('anthropic', null));
  // Live Zen catalog: null = not yet fetched, [] = fetched-but-none (no key).
  const [openCodeModels, setOpenCodeModels] = useState<OpenCodeModelEntry[] | null>(null);
  const [loadingOpenCodeModels, setLoadingOpenCodeModels] = useState(false);

  // Best-effort fetch of the per-user OpenCode catalog. Returns [] (not an
  // error) when the user has no Zen key, mirroring the settings UI.
  const loadOpenCodeModels = useCallback(async () => {
    setLoadingOpenCodeModels(true);
    try {
      const res = await api.openCodeAuth.models();
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

  const handleProviderChange = useCallback(
    (next: Provider) => {
      setProvider(next);
      if (next === 'opencode') {
        if (openCodeModels === null) {
          setModel('');
          void loadOpenCodeModels();
        } else {
          setModel(firstModelFor('opencode', openCodeModels));
        }
      } else {
        setModel(firstModelFor(next, openCodeModels));
      }
    },
    [openCodeModels, loadOpenCodeModels],
  );

  // Options for the model dropdown — static enum for anthropic/openai, the
  // live Zen catalog for opencode (empty until fetched or when no key).
  const modelOptions = useMemo<Array<{ value: string; label: string }>>(
    () =>
      provider === 'opencode'
        ? (openCodeModels ?? []).map((m) => ({
            value: m.id,
            label: m.status === 'deprecated' ? `${m.name} (deprecated)` : m.name,
          }))
        : MODELS_FOR_UI[provider].map((m) => ({ value: m, label: MODEL_LABELS[m] ?? m })),
    [provider, openCodeModels],
  );

  const reset = useCallback(() => {
    setProvider('anthropic');
    setModel(firstModelFor('anthropic', null));
    // Keep the fetched OpenCode catalog cached across opens (per-user, stable).
  }, []);

  return {
    provider,
    model,
    setModel,
    handleProviderChange,
    modelOptions,
    loadingOpenCodeModels,
    reset,
  };
}
