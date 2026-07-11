/*
 * ProviderModelPicker.tsx — the provider + model dropdown pair.
 *
 * Presentational only; drive it with `useProviderModelSelection()`. Used by
 * every conversation-start surface so the user always picks an explicit model.
 */

import React from 'react';
import type { Provider } from '../../shared/providers/types';
import { PROVIDER_LABELS, type ProviderModelSelection } from '../hooks/useProviderModelSelection';

interface ProviderModelPickerProps
  extends Pick<
    ProviderModelSelection,
    | 'provider'
    | 'model'
    | 'setModel'
    | 'handleProviderChange'
    | 'modelOptions'
    | 'loadingOpenCodeModels'
    | 'availableProviders'
  > {
  disabled?: boolean;
  /** Prefix for the select `data-testid`s (e.g. 'new-conversation' → '…-provider-select'). */
  testIdPrefix?: string;
}

const SELECT_CLASS =
  'bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md px-2 py-1 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-50';

export function ProviderModelPicker({
  provider,
  model,
  setModel,
  handleProviderChange,
  modelOptions,
  loadingOpenCodeModels,
  availableProviders,
  disabled = false,
  testIdPrefix = 'conversation',
}: ProviderModelPickerProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label className="flex items-center gap-2">
        <span className="text-gray-500 dark:text-gray-400">Provider</span>
        <select
          value={provider}
          onChange={(e) => handleProviderChange(e.target.value as Provider)}
          disabled={disabled}
          data-testid={`${testIdPrefix}-provider-select`}
          className={SELECT_CLASS}
        >
          {availableProviders.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
       <label className="flex items-center gap-2">
         <span className="text-gray-500 dark:text-gray-400">Model</span>
         <select
           value={model}
           onChange={(e) => setModel(e.target.value)}
           disabled={disabled || ((provider === 'opencode' || provider === 'opencode-go') && loadingOpenCodeModels)}
           data-testid={`${testIdPrefix}-model-select`}
           className={SELECT_CLASS}
         >
           {(provider === 'opencode' || provider === 'opencode-go') && modelOptions.length === 0 ? (
             <option value="">
               {loadingOpenCodeModels ? 'Loading models…' : 'No models — connect an OpenCode key'}
             </option>
           ) : (
             modelOptions.map((m) => (
               <option key={m.value} value={m.value}>
                 {m.label}
               </option>
             ))
           )}
         </select>
       </label>
    </div>
  );
}

export default ProviderModelPicker;
