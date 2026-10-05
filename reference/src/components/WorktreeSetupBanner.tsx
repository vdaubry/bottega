/**
 * WorktreeSetupBanner — where the task's background worktree setup stands.
 *
 * A task is usable the moment it is created, but its worktree (`git worktree
 * add` plus the project's own setup hook) is built in the background and can
 * take minutes. Until it is ready, nothing can start a conversation on the
 * task; this banner says why, and when the setup failed it shows the hook's
 * last output with the only two ways forward: retry it, or delete the task.
 */

import { useState } from 'react';
import { AlertCircle, Loader2, RotateCw, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import type { TaskWorktreeState } from '../../shared/types/db';

interface WorktreeSetupBannerProps {
  state: TaskWorktreeState;
  error: string | null;
  onRetry: () => Promise<unknown>;
  onDelete?: (() => void) | undefined;
}

export default function WorktreeSetupBanner({
  state,
  error,
  onRetry,
  onDelete,
}: WorktreeSetupBannerProps) {
  const [isRetrying, setIsRetrying] = useState(false);

  if (state === 'ready') return null;

  if (state === 'provisioning') {
    return (
      <div
        className="px-4 py-2 border-b border-border bg-blue-500/10 flex items-start gap-2 text-sm text-blue-700 dark:text-blue-300"
        data-testid="worktree-setup-provisioning"
      >
        <Loader2 className="w-4 h-4 mt-0.5 flex-shrink-0 animate-spin" />
        <span className="min-w-0">
          Setting up the worktree… The project&apos;s setup (dependencies, build) runs first
          and can take a few minutes. Chats and agents can start once it is ready.
        </span>
      </div>
    );
  }

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      await onRetry();
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <div
      className="px-4 py-3 border-b border-border bg-red-500/10 text-sm text-red-700 dark:text-red-400"
      data-testid="worktree-setup-failed"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <span className="min-w-0 font-medium">
          Worktree setup failed. No chat or agent can run on this task until it is set up.
        </span>
      </div>
      {error ? (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 text-xs text-foreground">
          {error}
        </pre>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void handleRetry()} disabled={isRetrying}>
          {isRetrying ? (
            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
          ) : (
            <RotateCw className="w-4 h-4 mr-1" />
          )}
          Retry setup
        </Button>
        {onDelete ? (
          <Button size="sm" variant="outline" onClick={onDelete} className="text-red-600 dark:text-red-400">
            <Trash2 className="w-4 h-4 mr-1" />
            Delete task
          </Button>
        ) : null}
      </div>
    </div>
  );
}
