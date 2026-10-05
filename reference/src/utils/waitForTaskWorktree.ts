import { api } from './api';
import type { TaskWorktreeState } from '../../shared/types/db';

const POLL_INTERVAL_MS = 2_000;
// The server gives `git worktree add` (and the project's hook) 10 minutes,
// after which the setup is failed; a little longer here so we see that verdict.
const GIVE_UP_AFTER_MS = 11 * 60_000;

/**
 * Wait until a new task's background worktree setup has finished, by polling
 * the task. Resolves to the final state — 'ready' or 'failed' — or to
 * 'provisioning' if it is still running when we give up. Polling rather than
 * the WebSocket keeps this independent of which task channels are subscribed.
 */
export async function waitForTaskWorktree(taskId: number): Promise<TaskWorktreeState> {
  const deadline = Date.now() + GIVE_UP_AFTER_MS;
  for (;;) {
    try {
      const response = await api.tasks.get(taskId);
      if (response.ok) {
        const task = await response.json();
        if (task.worktree_state !== 'provisioning') return task.worktree_state;
      }
    } catch {
      // A dropped request (mobile network) is just one missed poll.
    }
    if (Date.now() >= deadline) return 'provisioning';
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
