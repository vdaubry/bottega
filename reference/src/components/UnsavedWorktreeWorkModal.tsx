/*
 * UnsavedWorktreeWorkModal.tsx — the one prompt shown before any action that
 * destroys a task's worktree (Merge & Cleanup, status → Completed, Delete task,
 * Discard worktree).
 *
 * Three ways out, matching the server's 409 contract:
 *   1. Cancel — nothing happens.
 *   2. Commit & push — save the work, and deliberately **stop there**. Pushing
 *      moves the PR head and re-triggers CI; merging in the same breath would
 *      land a head nobody has seen green. The user comes back and merges once
 *      it is.
 *   3. Discard — force the original action through.
 *
 * Which of 2 and 3 is the primary button depends on intent: on an explicit
 * "delete this task" the user already said they want it gone, so discarding is
 * the expected answer; everywhere else saving is.
 */

import React, { useState } from 'react';
import { AlertTriangle, X, Upload, Trash2, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import type { UnsavedWorktreeWorkResponse } from '../../shared/api/tasks';

export type GuardIntent = 'merge' | 'complete' | 'delete' | 'discard';

export type GuardChoice = 'cancel' | 'save' | 'discard';

const INTENT_COPY: Record<GuardIntent, { title: string; lede: string; discardLabel: string }> = {
  merge: {
    title: 'Merging would lose work',
    lede: 'Merging the pull request deletes this worktree, and the pull request does not contain everything in it.',
    discardLabel: 'Discard and merge',
  },
  complete: {
    title: 'Completing would lose work',
    lede: 'Marking this task completed deletes its worktree, and it still holds work that is not on the remote.',
    discardLabel: 'Discard and complete',
  },
  delete: {
    title: 'Deleting would lose work',
    lede: 'Deleting this task deletes its worktree, and it still holds work that is not on the remote.',
    discardLabel: 'Discard and delete',
  },
  discard: {
    title: 'This worktree still has work',
    lede: 'Discarding the worktree throws away everything that is not on the remote.',
    discardLabel: 'Discard anyway',
  },
};

export interface UnsavedWorktreeWorkModalProps {
  conflict: UnsavedWorktreeWorkResponse;
  intent: GuardIntent;
  /** Set while the chosen action is in flight, so the buttons can lock. */
  busy?: GuardChoice | null;
  error?: string | null;
  onChoose: (choice: GuardChoice) => void;
}

export default function UnsavedWorktreeWorkModal({
  conflict,
  intent,
  busy = null,
  error = null,
  onChoose,
}: UnsavedWorktreeWorkModalProps) {
  const [showFiles, setShowFiles] = useState(false);
  const copy = INTENT_COPY[intent];
  const discardIsPrimary = intent === 'delete';
  const locked = busy !== null;

  const saveLabel =
    conflict.prNumber !== null
      ? `Commit & push to PR #${conflict.prNumber}`
      : 'Commit & push branch';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={locked ? undefined : () => onChoose('cancel')}
      />

      <div className="relative bg-card rounded-lg shadow-xl border border-border w-full max-w-lg mx-4">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0" />
            <h2 className="text-lg font-semibold text-foreground truncate">{copy.title}</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onChoose('cancel')} disabled={locked}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-sm text-muted-foreground">{copy.lede}</p>

          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              {conflict.summary} would be permanently lost.
            </p>
            {conflict.branch && (
              <p className="mt-0.5 text-xs text-muted-foreground font-mono truncate">
                {conflict.branch}
              </p>
            )}
          </div>

          {conflict.dirtyPaths.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowFiles((v) => !v)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronRight
                  className={`w-3.5 h-3.5 transition-transform ${showFiles ? 'rotate-90' : ''}`}
                />
                {showFiles ? 'Hide' : 'Show'} uncommitted files
              </button>
              {showFiles && (
                <ul className="mt-2 max-h-40 overflow-y-auto rounded-md bg-muted/50 p-2 space-y-0.5">
                  {conflict.dirtyPaths.map((file) => (
                    <li key={file} className="text-xs font-mono text-muted-foreground truncate">
                      {file}
                    </li>
                  ))}
                  {conflict.dirtyFiles > conflict.dirtyPaths.length && (
                    <li className="text-xs text-muted-foreground italic">
                      …and {conflict.dirtyFiles - conflict.dirtyPaths.length} more
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 p-4 border-t border-border sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => onChoose('cancel')} disabled={locked}>
            Cancel
          </Button>

          <Button
            variant={discardIsPrimary ? 'destructive' : 'outline'}
            onClick={() => onChoose('discard')}
            disabled={locked}
            title={`${conflict.summary} will be permanently lost`}
          >
            {busy === 'discard' ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4 mr-1.5" />
            )}
            {copy.discardLabel}
          </Button>

          <Button
            variant={discardIsPrimary ? 'outline' : 'default'}
            onClick={() => onChoose('save')}
            disabled={locked}
            title="Commit everything and push — the worktree is kept so you can keep testing"
          >
            {busy === 'save' ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <Upload className="w-4 h-4 mr-1.5" />
            )}
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
