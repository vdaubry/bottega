// One agent's (provider, model, effort) picker row. Extracted from
// AgentPromptsTab so the per-user Agent Models tab can render all six agents.
// Pure presentational — the parent owns state and persistence.

import { Loader2 } from 'lucide-react';
import {
  MODELS_FOR_UI,
  EFFORTS_FOR_UI,
  type AgentModelSetting,
} from '../../shared/types/agentModelSettings';
import type { AgentType } from '../../shared/types/db';
import type { Provider } from '../../shared/providers/types';
import type { OpenCodeModelEntry } from '../../shared/api/openCodeAuth';

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Claude Code',
  openai: 'Codex',
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go',
};

// Labels for the two static providers. OpenCode model labels are NOT
// hardcoded — they're fetched live from `/api/opencode-auth/models` (the Zen
// catalog is owned by OpenCode and ≈40 entries large; a frozen list is exactly
// what broke Phase 12.3). See `feedback_no_guessing_external_lists`.
export const MODEL_LABELS: Record<string, string> = {
  sonnet: 'Sonnet',
  opus: 'Opus',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 mini',
};

export const EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

/**
 * Build the model `<option>` list for a setting. For OpenCode (Zen or Go) the list is the
 * live catalog (falling back to "current model only" so the dropdown is
 * never blank); the persisted model is appended if it's no longer in the
 * catalog. For the static providers it's the canonical enum.
 */
export function buildModelOptions(
  provider: Provider,
  currentModel: string,
  openCodeModels: OpenCodeModelEntry[] | null,
): Array<{ value: string; label: string }> {
  if (provider !== 'opencode' && provider !== 'opencode-go') {
    return MODELS_FOR_UI[provider].map((m) => ({ value: m, label: MODEL_LABELS[m] ?? m }));
  }
  const live = openCodeModels ?? [];
  const catalogName = provider === 'opencode-go' ? 'Go' : 'Zen';
  const options: Array<{ value: string; label: string }> =
    live.length > 0
      ? live.map((m) => ({
          value: m.id,
          label: m.status === 'deprecated' ? `${m.name} (deprecated)` : m.name,
        }))
      : [{ value: currentModel, label: currentModel }];
  if (options.length > 0 && !options.some((o) => o.value === currentModel)) {
    options.push({ value: currentModel, label: `${currentModel} (not in current ${catalogName} catalog)` });
  }
  return options;
}

interface AgentModelSettingRowProps {
  agentType: AgentType;
  label: string;
  setting: AgentModelSetting;
  /** Providers the user has credentials for — the provider dropdown is filtered to these. */
  connectedProviders: Provider[];
  openCodeModels: OpenCodeModelEntry[] | null;
  isLoadingOpenCodeModels: boolean;
  disabled: boolean;
  onChange: (agent: AgentType, patch: Partial<AgentModelSetting>) => void;
}

function AgentModelSettingRow({
  agentType,
  label,
  setting,
  connectedProviders,
  openCodeModels,
  isLoadingOpenCodeModels,
  disabled,
  onChange,
}: AgentModelSettingRowProps) {
  const providerKey = setting.provider;
  // Always include the currently-selected provider so a setting saved under a
  // since-disconnected provider still renders, plus every connected provider.
  const providerOptions: Provider[] = Array.from(
    new Set<Provider>([providerKey, ...connectedProviders]),
  );
  const modelOptions = buildModelOptions(providerKey, setting.model, openCodeModels);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3 text-sm py-3 border-b border-border last:border-b-0">
      <span className="w-full sm:w-32 font-medium text-foreground" data-testid={`agent-row-${agentType}`}>
        {label}
      </span>
      <label className="flex items-center gap-2 w-full sm:w-auto">
        <span className="text-muted-foreground w-20 sm:w-auto shrink-0">Harness</span>
        <select
          value={providerKey}
          onChange={(e) => onChange(agentType, { provider: e.target.value as Provider })}
          disabled={disabled}
          data-testid={`agent-provider-select-${agentType}`}
          className="flex-1 min-w-0 sm:flex-none bg-background border border-border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          {providerOptions.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
       <label className="flex items-center gap-2 w-full sm:w-auto">
         <span className="text-muted-foreground w-20 sm:w-auto shrink-0">Model</span>
         <select
           value={setting.model}
           onChange={(e) => onChange(agentType, { model: e.target.value })}
           disabled={disabled || ((providerKey === 'opencode' || providerKey === 'opencode-go') && isLoadingOpenCodeModels)}
           data-testid={`agent-model-select-${agentType}`}
           className="flex-1 min-w-0 sm:flex-none bg-background border border-border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
         >
           {modelOptions.map((m) => (
             <option key={m.value} value={m.value}>
               {m.label}
             </option>
           ))}
         </select>
         {(providerKey === 'opencode' || providerKey === 'opencode-go') && isLoadingOpenCodeModels && (
           <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
         )}
       </label>
      {EFFORTS_FOR_UI[providerKey].length > 0 && (
        <label className="flex items-center gap-2 w-full sm:w-auto">
          <span className="text-muted-foreground w-20 sm:w-auto shrink-0">Effort</span>
          <select
            value={setting.effort ?? ''}
            onChange={(e) => onChange(agentType, { effort: e.target.value })}
            disabled={disabled}
            data-testid={`agent-effort-select-${agentType}`}
            className="flex-1 min-w-0 sm:flex-none bg-background border border-border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            {EFFORTS_FOR_UI[providerKey].map((e) => (
              <option key={e} value={e}>
                {EFFORT_LABELS[e] ?? e}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

export default AgentModelSettingRow;
