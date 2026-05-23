import { api } from './api';

export interface WorktreeCleanupResult {
  ok: boolean;
  /** True when the user declined the uncommitted-changes prompt. */
  aborted?: boolean;
  error?: string;
}

/**
 * Remove the worktree for a task. If it has uncommitted changes, prompt the
 * user before forcing the deletion.
 */
export async function cleanupWorktreeOnComplete(taskId: number): Promise<WorktreeCleanupResult> {
  try {
    const response = await api.tasks.discardWorktree(taskId);

    if (response.ok) {
      return { ok: true };
    }

    if (response.status === 404) {
      return { ok: true };
    }

    if (response.status === 409) {
      const data = (await response.json().catch(() => ({}))) as { hasChanges?: boolean; error?: string };
      if (data.hasChanges) {
        if (!window.confirm('This worktree has uncommitted changes that will be lost. Continue anyway?')) {
          return { ok: false, aborted: true };
        }
        const forceResponse = await api.tasks.discardWorktree(taskId, true);
        if (forceResponse.ok) {
          return { ok: true };
        }
        const errData = (await forceResponse.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: errData.error || 'Failed to delete worktree' };
      }
    }

    const errData = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: errData.error || 'Failed to delete worktree' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
