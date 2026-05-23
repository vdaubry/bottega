// Provider picker modal — replaces the Anthropic-only ClaudeAuthModal.
// Renders Claude + Codex + OpenCode panels in one stack so first-time
// users (and anyone hitting PROVIDER_CREDENTIALS_MISSING) can pick which
// provider to connect. The same panels also render in Settings →
// Providers — there's one source of truth per provider.

import { X } from 'lucide-react';
import { Button } from './ui/button';
import ClaudeAuthPanel from './ClaudeAuthPanel';
import CodexAuthPanel from './CodexAuthPanel';
import OpenCodeAuthPanel from './OpenCodeAuthPanel';

export interface ProvidersModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * When false, the modal can't be dismissed (no close button, backdrop clicks
   * ignored). Used for the blocking first-login gate where the user must
   * connect at least one provider before using the app. Defaults to true.
   */
  dismissable?: boolean;
}

function ProvidersModal({ isOpen, onClose, dismissable = true }: ProvidersModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      data-testid="providers-modal"
    >
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={dismissable ? onClose : undefined}
      />

      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border border-border bg-background shadow-xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-background p-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Connect a provider</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect at least one provider before starting chats or agents.
              You can connect more later in Settings.
            </p>
          </div>
          {dismissable && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              title="Close"
              data-testid="providers-modal-close"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        <div className="space-y-8 p-5">
          <ClaudeAuthPanel />
          <div className="border-t border-border" />
          <CodexAuthPanel />
          <div className="border-t border-border" />
          <OpenCodeAuthPanel />
        </div>
      </div>
    </div>
  );
}

export default ProvidersModal;
