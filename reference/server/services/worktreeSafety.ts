/**
 * Worktree safety — the single "would deleting this worktree lose work?" check.
 *
 * Every path that destroys a worktree (Merge & Cleanup, Discard, status →
 * Completed, Delete task, the old-completed sweep, the orchestrator's
 * `merge_task`, the stories agent's `delete_task`) funnels through
 * `removeWorktree` / `mergeAndCleanup`, and both call `assertWorktreeSafeToDestroy`
 * unless the caller explicitly passes `force`. Keeping the check inside those two
 * primitives — rather than in each route — is the point: a new caller inherits
 * the guard instead of having to remember it.
 *
 * **Two kinds of unsaved work, not one.** The check this replaces only looked at
 * `git status --porcelain`. That misses the more expensive failure: an agent that
 * *committed* but never pushed. `gh pr merge` merges the branch's **remote** head,
 * so those commits are not in the merge and die with the worktree — on a tree that
 * reports perfectly clean. Both counts are load-bearing.
 *
 * Everything here is path-based rather than `(repoPath, taskId)`-based so this
 * module imports nothing from `worktree.ts`: `worktree.ts` depends on it, and a
 * cycle between the two would be a load-order trap for every consumer and every
 * `vi.mock('./worktree.js')` in the suite.
 */

import fs from 'fs';
import { runCommand } from './shell.js';

/** Cap on the file list carried in the 409 payload / MCP error text. */
export const MAX_LISTED_FILES = 50;

export interface WorktreeSafety {
  /** Nothing would be lost by deleting the worktree. */
  clean: boolean;
  /** Paths with uncommitted modifications, truncated to `MAX_LISTED_FILES`. */
  files: string[];
  /** Full count of dirty paths (may exceed `files.length`). */
  dirtyFiles: number;
  /** Commits present locally that `origin/<branch>` does not have. */
  unpushedCommits: number;
  branch: string | null;
}

export const CLEAN_WORKTREE: WorktreeSafety = Object.freeze({
  clean: true,
  files: [],
  dirtyFiles: 0,
  unpushedCommits: 0,
  branch: null,
});

/**
 * Thrown by `removeWorktree` / `mergeAndCleanup` when unsaved work would be
 * destroyed and the caller did not pass `force`. Routes translate it into the
 * uniform 409 body; agent tools translate it into a tool-call failure.
 */
export class UnsavedWorktreeWorkError extends Error {
  readonly code = 'worktree-has-unsaved-work' as const;

  constructor(
    readonly taskId: number,
    readonly safety: WorktreeSafety,
  ) {
    super(`Worktree for task ${taskId} has ${describeUnsavedWork(safety)}`);
    this.name = 'UnsavedWorktreeWorkError';
  }
}

export function isUnsavedWorktreeWorkError(err: unknown): err is UnsavedWorktreeWorkError {
  return err instanceof UnsavedWorktreeWorkError;
}

/** "4 uncommitted files and 2 unpushed commits" — shared by the error and the UI copy. */
export function describeUnsavedWork(
  safety: Pick<WorktreeSafety, 'dirtyFiles' | 'unpushedCommits'>,
): string {
  const parts: string[] = [];
  if (safety.dirtyFiles > 0) {
    parts.push(`${safety.dirtyFiles} uncommitted file${safety.dirtyFiles === 1 ? '' : 's'}`);
  }
  if (safety.unpushedCommits > 0) {
    parts.push(
      `${safety.unpushedCommits} unpushed commit${safety.unpushedCommits === 1 ? '' : 's'}`,
    );
  }
  return parts.join(' and ') || 'no unsaved work';
}

async function currentBranch(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await runCommand('git', ['branch', '--show-current'], {
      cwd: worktreePath,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function countRevisions(cwd: string, revArgs: string[]): Promise<number> {
  try {
    const { stdout } = await runCommand('git', ['rev-list', '--count', ...revArgs], { cwd });
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Count commits that exist only on this box: reachable from `HEAD`, reachable
 * from no `origin/*` ref.
 *
 * `HEAD --not --remotes=origin` rather than `origin/<branch>..HEAD` on purpose.
 * The range form needs an `origin/<branch>` to subtract, and a branch that was
 * never pushed has none — it would then have to fall back to a base branch the
 * caller may not have supplied, and silently report 0. Asking "what has no
 * remote at all" needs no parameters and is right in every case: 0 for a fully
 * pushed branch, N for a branch pushed N commits ago, and the branch's whole
 * delta for one that was never pushed.
 *
 * Deliberately does **not** `git fetch` — the destructive paths are interactive
 * and a fetch would add seconds to every click. The local remote-tracking refs
 * are accurate here because this app is the only thing that pushes these
 * branches (`pushChanges` updates them as a side effect), and a stale ref can
 * only over-report, which fails safe.
 *
 * A repo with no `origin` refs at all reports **0**: there is nowhere to push,
 * so "unpushed" is not a meaningful thing to block a cleanup on.
 */
async function countUnpushedCommits(worktreePath: string): Promise<number> {
  try {
    const { stdout } = await runCommand(
      'git',
      ['for-each-ref', '--count=1', 'refs/remotes/origin'],
      { cwd: worktreePath },
    );
    if (stdout.trim().length === 0) return 0;
  } catch {
    return 0;
  }

  return countRevisions(worktreePath, ['HEAD', '--not', '--remotes=origin']);
}

/**
 * Inspect a worktree for work that deleting it would destroy.
 *
 * **A missing or unreadable worktree reports clean.** If `git status` itself
 * fails the worktree is already gone or corrupt — there is nothing to preserve,
 * and blocking would leave the user unable to clean up. The failure is logged.
 */
export async function getWorktreeSafety(worktreePath: string): Promise<WorktreeSafety> {
  try {
    await fs.promises.access(worktreePath);
  } catch {
    return CLEAN_WORKTREE;
  }

  let porcelain: string;
  try {
    // `--untracked-files=all` so a brand-new directory is listed as its files
    // rather than collapsed to `sub/` — the modal shows this list and states a
    // count, and "2 uncommitted files" must not mean "1 file and 1 directory".
    const { stdout } = await runCommand(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd: worktreePath },
    );
    porcelain = stdout;
  } catch (error) {
    console.warn(
      `[WorktreeSafety] Could not read status of ${worktreePath}; treating as clean:`,
      error,
    );
    return CLEAN_WORKTREE;
  }

  // Porcelain v1: two status chars, a space, then the path. A rename reads
  // `R  old -> new` — the destination is the file that exists on disk.
  const dirty = porcelain
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const withoutStatus = line.slice(2).trim();
      const arrow = withoutStatus.indexOf(' -> ');
      return arrow === -1 ? withoutStatus : withoutStatus.slice(arrow + 4);
    });

  const branch = await currentBranch(worktreePath);
  const unpushedCommits = await countUnpushedCommits(worktreePath);

  return {
    clean: dirty.length === 0 && unpushedCommits === 0,
    files: dirty.slice(0, MAX_LISTED_FILES),
    dirtyFiles: dirty.length,
    unpushedCommits,
    branch,
  };
}

/**
 * Throw `UnsavedWorktreeWorkError` unless the worktree is safe to destroy.
 * No-op when `force` is set — the caller has explicitly chosen to discard.
 */
export async function assertWorktreeSafeToDestroy(
  worktreePath: string,
  taskId: number,
  options: { force?: boolean | undefined } = {},
): Promise<void> {
  if (options.force) return;

  const safety = await getWorktreeSafety(worktreePath);
  if (safety.clean) return;

  throw new UnsavedWorktreeWorkError(taskId, safety);
}
