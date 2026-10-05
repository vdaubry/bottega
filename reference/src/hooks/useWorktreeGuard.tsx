/*
 * useWorktreeGuard — one code path for "this action deletes a worktree".
 *
 * Every destructive endpoint answers 409 `UnsavedWorktreeWorkResponse` when the
 * worktree still holds uncommitted or unpushed work. Rather than teach each of
 * the five call sites (Merge & Cleanup, status → Completed on the task page and
 * on the dashboard, Delete task on the board and on the edit page) how to read
 * that body and what to offer, they hand the action to `guard` and render
 * `guardModal`.
 *
 * The hook awaits the user's choice, so a call site reads linearly:
 *
 *   const outcome = await guard({ taskId, intent: 'merge', run: (force) =>
 *     api.tasks.mergeAndCleanup(taskId, force) });
 *   if (outcome.status === 'ok') { ...proceed with outcome.data }
 *
 * `status: 'saved'` means the user chose to keep the worktree and push instead —
 * the destructive action deliberately did **not** run.
 */

import React, { useCallback, useRef, useState } from 'react';
import { api } from '../utils/api';
import UnsavedWorktreeWorkModal, {
  type GuardChoice,
  type GuardIntent,
} from '../components/UnsavedWorktreeWorkModal';
import { UNSAVED_WORKTREE_WORK, type UnsavedWorktreeWorkResponse } from '../../shared/api/tasks';
import type { TypedResponse } from '../../shared/api/_common';

export type { GuardIntent } from '../components/UnsavedWorktreeWorkModal';

export type GuardOutcome<T> =
  /** The destructive action ran (possibly after the user chose to discard). */
  | { status: 'ok'; data: T }
  /** The user chose to commit & push; the destructive action did not run. */
  | { status: 'saved' }
  /** The user backed out. */
  | { status: 'cancelled' }
  | { status: 'error'; error: string };

/**
 * What a destructive call amounts to once the "unsaved work" 409 has been
 * separated from every other failure. `guard` derives it from a raw response;
 * `guardWith` takes it directly, for callers that go through `TaskContext`
 * rather than `api.tasks.*` (deleting a task has to update context state).
 */
export type GuardRunResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'conflict'; conflict: UnsavedWorktreeWorkResponse }
  | { kind: 'error'; error: string };

export interface GuardRequest<T> {
  taskId: number;
  intent: GuardIntent;
  /** Runs the destructive call. `force` = discard the unsaved work. */
  run: (force: boolean) => Promise<TypedResponse<T>>;
  /** Commit message for the "commit & push" branch. Defaults server-side. */
  commitMessage?: string;
}

export interface GuardWithRequest<T> extends Omit<GuardRequest<T>, 'run'> {
  run: (force: boolean) => Promise<GuardRunResult<T>>;
}

interface Pending {
  conflict: UnsavedWorktreeWorkResponse;
  intent: GuardIntent;
  taskId: number;
  commitMessage: string | undefined;
  run: (force: boolean) => Promise<GuardRunResult<unknown>>;
}

function isConflictBody(body: unknown): body is UnsavedWorktreeWorkResponse {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { error?: unknown }).error === UNSAVED_WORKTREE_WORK
  );
}

/**
 * Read a destructive endpoint's response into an outcome, separating the
 * "unsaved work" 409 from every other failure.
 */
export async function readGuardedResponse<T>(
  response: TypedResponse<T>,
): Promise<GuardRunResult<T>> {
  // A 404 on a worktree that is already gone is the goal state, not a failure —
  // the "status → completed" path hits it routinely.
  if (response.status === 404) return { kind: 'ok', data: undefined as T };

  const body: unknown = await response.json().catch(() => null);

  if (response.status === 409 && isConflictBody(body)) {
    return { kind: 'conflict', conflict: body };
  }

  if (!response.ok) {
    const error = (body as { error?: string } | null)?.error;
    return { kind: 'error', error: error || 'Action failed' };
  }

  return { kind: 'ok', data: body as T };
}

export function useWorktreeGuard() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<GuardChoice | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  // Held across the modal's lifetime so `guard` can stay a plain await.
  const resolveRef = useRef<((outcome: GuardOutcome<never>) => void) | null>(null);

  const settle = useCallback((outcome: GuardOutcome<unknown>) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setPending(null);
    setBusy(null);
    setModalError(null);
    resolve?.(outcome as GuardOutcome<never>);
  }, []);

  const guardWith = useCallback(
    async <T,>({ taskId, intent, run, commitMessage }: GuardWithRequest<T>): Promise<GuardOutcome<T>> => {
      let result: GuardRunResult<T>;
      try {
        result = await run(false);
      } catch (err) {
        return { status: 'error', error: err instanceof Error ? err.message : String(err) };
      }

      if (result.kind === 'ok') return { status: 'ok', data: result.data };
      if (result.kind === 'error') return { status: 'error', error: result.error };

      return new Promise<GuardOutcome<T>>((resolve) => {
        resolveRef.current = resolve;
        setPending({
          conflict: result.conflict,
          intent,
          taskId,
          commitMessage,
          run,
        });
      });
    },
    [],
  );

  const guard = useCallback(
    <T,>({ run, ...rest }: GuardRequest<T>): Promise<GuardOutcome<T>> =>
      guardWith<T>({ ...rest, run: async (force) => readGuardedResponse(await run(force)) }),
    [guardWith],
  );

  const handleChoice = useCallback(
    async (choice: GuardChoice) => {
      if (!pending) return;

      if (choice === 'cancel') {
        settle({ status: 'cancelled' });
        return;
      }

      setBusy(choice);
      setModalError(null);

      if (choice === 'save') {
        try {
          const response = await api.tasks.pushChanges(pending.taskId, pending.commitMessage);
          const body = await response.json().catch(() => null);
          if (!response.ok || body?.success === false) {
            const error = body && 'error' in body ? body.error : undefined;
            setModalError(error || 'Failed to commit and push');
            setBusy(null);
            return;
          }
        } catch (err) {
          setModalError(err instanceof Error ? err.message : 'Failed to commit and push');
          setBusy(null);
          return;
        }
        // Saved, and deliberately stopping here: the push moved the PR head and
        // CI is re-running. Merging now would land a head nobody has seen green.
        settle({ status: 'saved' });
        return;
      }

      try {
        const result = await pending.run(true);
        if (result.kind === 'error') {
          setModalError(result.error);
          setBusy(null);
          return;
        }
        // A second conflict cannot happen (force bypasses the check), but if the
        // server ever disagrees, surfacing it beats looping.
        if (result.kind === 'conflict') {
          setModalError('The worktree still reports unsaved work.');
          setBusy(null);
          return;
        }
        settle({ status: 'ok', data: result.data });
      } catch (err) {
        setModalError(err instanceof Error ? err.message : 'Action failed');
        setBusy(null);
      }
    },
    [pending, settle],
  );

  const guardModal = pending ? (
    <UnsavedWorktreeWorkModal
      conflict={pending.conflict}
      intent={pending.intent}
      busy={busy}
      error={modalError}
      onChoose={(choice) => void handleChoice(choice)}
    />
  ) : null;

  return { guard, guardWith, guardModal };
}
