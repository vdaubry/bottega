// Settings → Agent Models (per-user). Lists all six agents with a
// provider/model/effort picker each, filtered to the providers the current
// user has connected. Replaces the old admin-only global agent_model_settings
// editor (which lived in the Prompts tab).

import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { api } from '../utils/api';
import AgentModelSettingRow from './AgentModelSettingRow';
import {
  AGENT_TYPES_WITH_SETTINGS,
  MODELS_FOR_UI,
  EFFORTS_FOR_UI,
  type AgentModelSetting,
  type AgentModelSettings,
} from '../../shared/types/agentModelSettings';
import type { AgentType } from '../../shared/types/db';
import type { Provider } from '../../shared/providers/types';
import type { OpenCodeModelEntry } from '../../shared/api/openCodeAuth';

const AGENT_LABELS: Record<AgentType, string> = {
  planification: 'Planning',
  implementation: 'Implementation',
  refinement: 'Refinement',
  review: 'Review',
  pr: 'PR',
  yolo: 'YOLO',
};

function AgentModelsTab() {
  const [settings, setSettings] = useState<AgentModelSettings | null>(null);
  const [needsSeeding, setNeedsSeeding] = useState(false);
  const [connected, setConnected] = useState<Provider[]>([]);
  // Separate catalog slots so switching one provider variant doesn't overwrite
  // the other. Each row receives the catalog that matches its own provider.
  const [openCodeZenModels, setOpenCodeZenModels] = useState<OpenCodeModelEntry[] | null>(null);
  const [openCodeGoModels, setOpenCodeGoModels] = useState<OpenCodeModelEntry[] | null>(null);
  const [isLoadingZenModels, setLoadingZenModels] = useState(false);
  const [isLoadingGoModels, setLoadingGoModels] = useState(false);
  const [isLoading, setLoading] = useState(true);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const loadOpenCodeZenModels = useCallback(async (): Promise<OpenCodeModelEntry[]> => {
    setLoadingZenModels(true);
    try {
      const res = await api.openCodeAuth.models();
      if (!res.ok) {
        setOpenCodeZenModels([]);
        return [];
      }
      const body = await res.json();
      setOpenCodeZenModels(body.models);
      return body.models as OpenCodeModelEntry[];
    } catch {
      setOpenCodeZenModels([]);
      return [];
    } finally {
      setLoadingZenModels(false);
    }
  }, []);

  const loadOpenCodeGoModels = useCallback(async (): Promise<OpenCodeModelEntry[]> => {
    setLoadingGoModels(true);
    try {
      const res = await api.openCodeAuth.modelsGo();
      if (!res.ok) {
        setOpenCodeGoModels([]);
        return [];
      }
      const body = await res.json();
      setOpenCodeGoModels(body.models);
      return body.models as OpenCodeModelEntry[];
    } catch {
      setOpenCodeGoModels([]);
      return [];
    } finally {
      setLoadingGoModels(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const [settingsRes, providersRes] = await Promise.all([
          api.userAgentModelSettings.get(),
          api.userAgentModelSettings.connectedProviders(),
        ]);
        if (providersRes.ok) {
           const body = await providersRes.json();
           setConnected(body.connected);
           // Load each catalog independently so neither overwrites the other.
           if (body.connected.includes('opencode')) {
             void loadOpenCodeZenModels();
           }
           if (body.connected.includes('opencode-go')) {
             void loadOpenCodeGoModels();
           }
         }
        if (settingsRes.ok) {
          const body = await settingsRes.json();
          if (body.needsSeeding) {
            setNeedsSeeding(true);
          } else {
            setSettings(body.settings);
          }
        } else {
          setError('Failed to load agent model settings');
        }
      } catch {
        setError('Failed to load agent model settings');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadOpenCodeZenModels, loadOpenCodeGoModels]);

   const updateAgentSetting = useCallback(
    async (agent: AgentType, patch: Partial<AgentModelSetting>) => {
      if (!settings) return;
      const current = settings[agent];

      // Provider change resets model/effort to that provider's first option so
      // an Anthropic → OpenAI flip doesn't leave 'opus' under OpenAI's namespace.
      let merged: AgentModelSetting;
      if (patch.provider && patch.provider !== current.provider) {
        const p = patch.provider;

        // Ensure the target OpenCode variant's catalog is loaded before we try
        // to pick its first model. Each loader writes to its own slot, so
        // switching to Go never clobbers the Zen catalog (and vice versa).
        // Loaders return the fetched list so we can use it immediately without
        // relying on stale closure state.
        let nextModel: string | null;
        if (p === 'opencode') {
          const catalog = openCodeZenModels ?? (await loadOpenCodeZenModels());
          nextModel = catalog[0]?.id ?? null;
        } else if (p === 'opencode-go') {
          const catalog = openCodeGoModels ?? (await loadOpenCodeGoModels());
          nextModel = catalog[0]?.id ?? null;
        } else {
          nextModel = MODELS_FOR_UI[p][0]!;
        }

        if (nextModel === null) {
          setError(
            'OpenCode catalog is still loading or no key is configured. ' +
              'Connect OpenCode in Settings → Providers, then try again.',
          );
          return;
        }
        merged = { provider: p, model: nextModel, effort: EFFORTS_FOR_UI[p][0] ?? null };
      } else {
        merged = { ...current, ...patch };
      }

      const next: AgentModelSettings = { ...settings, [agent]: merged };
      const previous = settings;
      setSettings(next);
      setSaving(true);
      setError(null);
      setStatusMsg(null);
      try {
        const res = await api.userAgentModelSettings.update(next);
        if (!res.ok) {
          setSettings(previous);
          setError('Failed to save agent model settings');
          return;
        }
        const body = await res.json();
        setSettings(body.settings);
        setStatusMsg('Saved');
      } catch {
        setSettings(previous);
        setError('Failed to save agent model settings');
      } finally {
        setSaving(false);
      }
    },
    [settings, openCodeZenModels, openCodeGoModels, loadOpenCodeZenModels, loadOpenCodeGoModels],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading agent models...
      </div>
    );
  }

  if (needsSeeding || !settings) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        <AlertCircle className="w-5 h-5 mx-auto mb-2" />
        Connect a provider in <span className="font-medium">Settings → Providers</span> to
        configure your agent models.
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-[400px]">
      <div className="pb-3 border-b border-border">
        <h3 className="text-base font-semibold text-foreground">Agent Models</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose which provider and model each agent runs on. Only providers you've connected
          are selectable.
        </p>
      </div>

      {error && (
        <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {statusMsg && !error && (
        <div className="mt-3 p-2 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded text-sm text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
          {isSaving && <Loader2 className="w-3 h-3 animate-spin" />}
          {statusMsg}
        </div>
      )}

      <div className="mt-2">
        {AGENT_TYPES_WITH_SETTINGS.map((agent) => {
          const providerForRow = settings[agent].provider;
          const openCodeModelsForRow =
            providerForRow === 'opencode-go' ? openCodeGoModels : openCodeZenModels;
          const isLoadingOpenCodeModelsForRow =
            providerForRow === 'opencode-go' ? isLoadingGoModels : isLoadingZenModels;
          return (
            <AgentModelSettingRow
              key={agent}
              agentType={agent}
              label={AGENT_LABELS[agent]}
              setting={settings[agent]}
              connectedProviders={connected}
              openCodeModels={openCodeModelsForRow}
              isLoadingOpenCodeModels={isLoadingOpenCodeModelsForRow}
              disabled={isSaving}
              onChange={updateAgentSetting}
            />
          );
        })}
      </div>
    </div>
  );
}

export default AgentModelsTab;
