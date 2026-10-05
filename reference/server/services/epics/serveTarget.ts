/**
 * The epic domain's answer to "switch server: serve epic N".
 *
 * "Switch server" points a project's NGINX-served symlink at one of its git
 * worktrees so a branch can be clicked through at the project's real URL
 * (`docs/web-server/switch-server.md`). Tickets have had this since the
 * beginning; an epic is the same act pointed at a different worktree — its
 * **delivery worktree**, which holds the epic feature branch, i.e. every merged
 * ticket together. That is exactly what you want to exercise before merging the
 * epic's final pull request, and it is the one thing you could not preview:
 * each ticket's own worktree is deleted when it merges.
 *
 * This lives in the epic layer, and `webServerManager` reaches it through the
 * `EpicServeResolver` interface registered at boot, because that module is
 * shared infrastructure and may not import this domain (architecture-v2 rule 1)
 * — the same shape as the conversation runtime's owner adapters.
 */

import { epicsDb } from '../../database/epics.js';
import { ensureEpicDeliveryWorktree } from './epicBranch.js';
import {
  registerEpicServeResolver,
  type EpicServeResolver,
} from '../webServerManager.js';

/**
 * Validate the epic against the project, make sure its delivery worktree
 * exists, and hand back the path to serve plus the name to show.
 *
 * Creating the worktree here is deliberate: an epic that has never had a
 * delivery conversation has no worktree yet, and "you must talk to the delivery
 * agent before you can preview the epic" would be a nonsense precondition.
 * `ensureEpicDeliveryWorktree` is idempotent and provisions the tree the same
 * way a ticket's is provisioned, so the result is servable.
 *
 * Throws with a user-facing message — `switchServedTarget` turns it into the
 * 400 body.
 */
async function resolveEpicServeTarget(
  epicId: number,
  projectId: number,
): Promise<{ worktreePath: string; name: string }> {
  const epic = epicsDb.getWithProject(epicId);
  if (!epic) {
    throw new Error('Epic not found');
  }
  if (epic.project_id !== projectId) {
    throw new Error('Epic does not belong to this project');
  }
  if (!epic.feature_branch) {
    throw new Error(
      'This epic has no feature branch yet — create its first ticket to open one.',
    );
  }

  const worktreePath = await ensureEpicDeliveryWorktree(epic);
  return { worktreePath, name: epic.name };
}

/** Read-only display name; never creates anything. */
function epicName(epicId: number): string | null {
  return epicsDb.getById(epicId)?.name ?? null;
}

export const epicServeResolver: EpicServeResolver = { resolveEpicServeTarget, epicName };

/** Wire the epic domain into the switch-server service. Idempotent. */
export function registerEpicServeTargetResolver(): void {
  registerEpicServeResolver(epicServeResolver);
}
