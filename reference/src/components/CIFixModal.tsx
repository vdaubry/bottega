/*
 * CIFixModal.tsx — pick a provider + model before starting a "Fix CI"
 * conversation. The Fix-CI action used to hard-code a Claude model; it now
 * runs on whatever the user explicitly selects here.
 */

import React from 'react';
import { X, AlertCircle } from 'lucide-react';
import { Button } from './ui/button';
import { ProviderModelPicker } from './ProviderModelPicker';
import { useProviderModelSelection } from '../hooks/useProviderModelSelection';
import type { Provider } from '../../shared/providers/types';

export interface CIFixModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (provider: Provider, model: string) => void | Promise<void>;
  prUrl?: string | undefined;
  isSubmitting?: boolean;
}

export default function CIFixModal({
  isOpen,
  onClose,
  onSubmit,
  prUrl,
  isSubmitting = false,
}: CIFixModalProps) {
  const {
    provider,
    model,
    setModel,
    handleProviderChange,
    modelOptions,
    loadingOpenCodeModels,
  } = useProviderModelSelection();

  if (!isOpen) return null;

  const canSubmit = !isSubmitting && !(provider === 'opencode' && !model);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={!isSubmitting ? onClose : undefined}
      />

      <div className="relative bg-card rounded-lg shadow-xl border border-border w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-red-500" />
            <h2 className="text-lg font-semibold text-foreground">Fix CI failures</h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={isSubmitting}
            className="h-8 w-8 p-0"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Starts a conversation in the task worktree to retrieve the CI failures, fix
            them, and push — iterating until checks pass.
            {prUrl && (
              <>
                {' '}
                PR: <span className="font-medium text-foreground break-all">{prUrl}</span>
              </>
            )}
          </p>

          <ProviderModelPicker
            provider={provider}
            model={model}
            setModel={setModel}
            handleProviderChange={handleProviderChange}
            modelOptions={modelOptions}
            loadingOpenCodeModels={loadingOpenCodeModels}
            disabled={isSubmitting}
            testIdPrefix="ci-fix"
          />

          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              className="flex-1"
              disabled={!canSubmit}
              onClick={() => void onSubmit(provider, model)}
            >
              {isSubmitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                  Starting…
                </>
              ) : (
                'Start fix'
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
