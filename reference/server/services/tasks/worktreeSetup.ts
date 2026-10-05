// Worktree setup — the background half of task creation.
//
// Creating a task returns at once with `worktree_state = 'provisioning'`; this
// module then runs `git worktree add`, which runs the project's post-checkout
// hook (docs/agents/worktree-provisioning.md). That hook is the project's own
// and can take minutes — or hang — so no request waits on it. The outcome
// lands on the row ('ready' or 'failed' + the reason) and is published as a
// `worktree-state-changed` TaskEvent.
//
// The rules this module exists to keep:
// - A failed setup never deletes the task. It stays 'failed' with the hook's
//   last output, for a retry or a delete. (Deleting it silently is how tasks
//   used to vanish under the agents already working on them.)
// - Nothing starts a conversation until the state is 'ready'
//   (`tasksDb.assertWorktreeReady`, enforced in `conversationsDb.create`).
// - A setup is one process group: a timeout, a delete, or a shutdown stops the
//   hook's children too.
// - Setups in the same repository run one at a time, in creation order. A
//   hook typically installs dependencies into caches shared by every worktree
//   of the repo; an epic creating ten tickets must not start ten installs at
//   once. The timeout counts from a setup's start, not from its queueing.

import { tasksDb } from '../../database/tasks.js';
import {
  cleanupFailedWorktreeAdd,
  createWorktree,
  getBranchName,
  getWorktreePath,
  sanitizeTitle,
  worktreeExists,
} from '../worktree.js';
import { emitTaskEvent } from './events.js';

interface RunningSetup {
  controller: AbortController;
  done: Promise<void>;
  /** False while it waits behind earlier setups of the same repository. */
  started: boolean;
}

const runningSetups = new Map<number, RunningSetup>();

/** Per repository: the tail of its setup queue. */
const repoQueues = new Map<string, Promise<void>>();

/** Stored on tasks whose setup was running when the server went down. */
export const INTERRUPTED_SETUP_ERROR =
  'Bottega restarted while the worktree was being set up, so the setup never finished.';

/**
 * Start setting up the task's worktree in the background. The row must
 * already say 'provisioning'. Returns a promise that settles when the setup
 * ends (whatever the outcome) — callers normally don't await it.
 *
 * `clearLeftovers` first removes a worktree and branch an earlier attempt
 * left behind (a crash mid-setup), so `git worktree add -b` can start clean.
 */
export function startWorktreeSetup(
  taskId: number,
  options: { clearLeftovers?: boolean } = {},
): Promise<void> {
  const existing = runningSetups.get(taskId);
  if (existing) return existing.done;

  const task = tasksDb.getWithProject(taskId);
  if (!task) return Promise.resolve();
  const repoPath = task.repo_folder_path;

  const controller = new AbortController();
  const setup: RunningSetup = { controller, done: Promise.resolve(), started: false };
  const previous = repoQueues.get(repoPath) ?? Promise.resolve();
  const done = previous
    .then(() => {
      setup.started = true;
      return runSetup(taskId, controller.signal, options.clearLeftovers ?? false);
    })
    .catch((error: unknown) => {
      // runSetup records its own failures; this only guards the bookkeeping.
      console.error(`[WorktreeSetup] Task ${taskId}: unexpected error`, error);
    })
    .finally(() => {
      runningSetups.delete(taskId);
      if (repoQueues.get(repoPath) === done) repoQueues.delete(repoPath);
    });
  setup.done = done;
  repoQueues.set(repoPath, done);
  runningSetups.set(taskId, setup);
  return done;
}

async function runSetup(
  taskId: number,
  signal: AbortSignal,
  clearLeftovers: boolean,
): Promise<void> {
  // Cancelled (deleted) while it waited for its turn: nothing was created.
  if (signal.aborted) return;
  const task = tasksDb.getWithProject(taskId);
  if (!task) return;
  const repoPath = task.repo_folder_path;
  const startedAt = Date.now();

  if (clearLeftovers) {
    await clearSetupLeftovers(repoPath, taskId, task.title);
  }

  console.log(`[WorktreeSetup] Task ${taskId}: setting up worktree in ${repoPath}`);
  const result = await createWorktree(repoPath, taskId, task.title, task.base_branch, {
    signal,
  });
  const seconds = Math.round((Date.now() - startedAt) / 1000);

  if (result.aborted) {
    // Cancelled by a delete: the task is going away, there is nothing to record.
    console.log(`[WorktreeSetup] Task ${taskId}: setup cancelled after ${seconds}s`);
    return;
  }
  if (!tasksDb.getById(taskId)) return;

  if (result.success) {
    tasksDb.setWorktreeState(taskId, 'ready');
    console.log(`[WorktreeSetup] Task ${taskId}: worktree ready in ${seconds}s`);
    emitTaskEvent('worktree-state-changed', { taskId, state: 'ready', error: null });
    return;
  }

  const reason = result.error ?? 'Worktree setup failed';
  const error = result.output ? `${reason}\n\n${result.output}` : reason;
  tasksDb.setWorktreeState(taskId, 'failed', error);
  console.error(
    `[WorktreeSetup] Task ${taskId}: worktree setup failed after ${seconds}s: ${reason}` +
      (result.output ? `\n--- last output ---\n${result.output}` : ''),
  );
  emitTaskEvent('worktree-state-changed', { taskId, state: 'failed', error });
}

/**
 * Remove what an interrupted attempt left: the worktree directory and its
 * branch. Safe without the unsaved-work check — no conversation can have run
 * in a worktree that never reached 'ready'.
 */
async function clearSetupLeftovers(
  repoPath: string,
  taskId: number,
  title: string | null,
): Promise<void> {
  const worktreePath = getWorktreePath(repoPath, taskId);
  const branch =
    ((await worktreeExists(repoPath, taskId)) ? await getBranchName(worktreePath) : null) ??
    `task/${taskId}-${sanitizeTitle(title)}`;
  await cleanupFailedWorktreeAdd(repoPath, worktreePath, branch);
}

/**
 * Retry a failed setup. Returns false (and changes nothing) unless the task
 * exists and its setup failed.
 */
export function retryWorktreeSetup(taskId: number): boolean {
  const task = tasksDb.getById(taskId);
  if (!task || task.worktree_state !== 'failed' || runningSetups.has(taskId)) return false;

  // Flip the row before anything async, so a second retry is refused.
  tasksDb.setWorktreeState(taskId, 'provisioning');
  emitTaskEvent('worktree-state-changed', { taskId, state: 'provisioning', error: null });
  void startWorktreeSetup(taskId, { clearLeftovers: true });
  return true;
}

/**
 * Stop the task's setup, if any. A started setup is waited for until it has
 * cleaned up (the half-made worktree and branch are removed). Used before a
 * delete.
 */
export async function cancelWorktreeSetup(taskId: number): Promise<void> {
  const running = runningSetups.get(taskId);
  if (!running) return;
  running.controller.abort();
  // Still queued: it will skip itself when its turn comes, having created
  // nothing — no need to wait behind the setups ahead of it.
  if (!running.started) return;
  await running.done;
}

/**
 * Signal every running setup to stop — on shutdown, so no hook outlives the
 * server. Does not wait: the rows stay 'provisioning', and the next boot's
 * {@link failInterruptedWorktreeSetups} marks them failed.
 */
export function abortAllWorktreeSetups(): void {
  for (const running of runningSetups.values()) {
    running.controller.abort();
  }
}

/** Whether this process is setting up the task's worktree right now. */
export function isWorktreeSetupRunning(taskId: number): boolean {
  return runningSetups.has(taskId);
}

/**
 * Crash recovery, for the server that owns the database: a row still
 * 'provisioning' at boot belonged to a setup that died with the previous
 * process. Mark each failed, so the task offers Retry instead of staying
 * stuck. Returns the ids it failed.
 */
export function failInterruptedWorktreeSetups(): number[] {
  const taskIds = tasksDb.failInterruptedWorktreeSetups(INTERRUPTED_SETUP_ERROR);
  for (const taskId of taskIds) {
    console.warn(`[WorktreeSetup] Task ${taskId}: setup was interrupted by a restart; marked failed`);
    emitTaskEvent('worktree-state-changed', {
      taskId,
      state: 'failed',
      error: INTERRUPTED_SETUP_ERROR,
    });
  }
  return taskIds;
}
