/**
 * PR Service - Consolidates PR logic for manual button and PR agent
 *
 * This service provides a unified interface for PR operations used by:
 * - Manual "Create PR" button in the UI
 * - Automated PR agent
 */

import {
  hasUncommittedChanges,
  commitAllChanges,
  createPullRequest as worktreeCreatePR,
  getPullRequestStatus,
  getWorktreeStatus,
  getWorktreePath,
} from './worktree.js';
import { getWorktreeSafety, describeUnsavedWork, MAX_LISTED_FILES } from './worktreeSafety.js';
import { resolveBaseBranch } from './tasks/baseBranch.js';
import { tasksDb } from '../database/db.js';
import type { TaskRow } from '../database/db.js';

export interface PRResult {
  success: boolean;
  url?: string | undefined;
  error?: string | undefined;
}

export interface CIStatusResult {
  success: boolean;
  url?: string | undefined;
  ciStatus?: unknown;
  mergeable?: string | undefined;
  error?: string | undefined;
}

/**
 * Create or update a PR for a task
 * Used by both manual button and PR agent
 *
 * The base branch is resolved here rather than passed in, so every caller
 * (manual button, PR agent, later the orchestrator) targets the same branch:
 * the epic's feature branch for an epic ticket, the repo's default branch
 * otherwise. Both the ahead-check and `gh pr create --base` use it.
 */
export async function createOrUpdatePR(
  repoPath: string,
  taskId: number,
  title: string,
  body: string,
): Promise<PRResult> {
  // 1. Check for uncommitted changes -> commit
  const changesResult = await hasUncommittedChanges(repoPath, taskId);
  if (changesResult.success && changesResult.hasChanges) {
    const commitResult = await commitAllChanges(repoPath, taskId, title);
    if (!commitResult.success) {
      return { success: false, error: `Failed to commit: ${commitResult.error}` };
    }
  }

  const task = tasksDb.getById(taskId);
  const baseBranch = await resolveBaseBranch(task, repoPath);

  // 2. Check commits ahead of the base branch
  const statusResult = await getWorktreeStatus(repoPath, taskId, baseBranch);
  if (statusResult.success && statusResult.ahead === 0) {
    return { success: false, error: 'No changes to create a PR' };
  }

  // 3. Create PR
  return worktreeCreatePR(repoPath, taskId, title, body, baseBranch);
}

/**
 * Get CI status and failure details for a task's PR
 */
export async function getCIStatusWithDetails(
  repoPath: string,
  taskId: number,
): Promise<CIStatusResult> {
  const prStatus = await getPullRequestStatus(repoPath, taskId);
  if (!prStatus.success || !prStatus.exists) {
    return { success: false, error: 'No PR found' };
  }
  return {
    success: true,
    url: prStatus.url,
    ciStatus: prStatus.ciStatus,
    mergeable: prStatus.mergeable,
  };
}

/**
 * Check if PR agent should run for a task
 */
export function shouldRunPrAgent(task: Pick<TaskRow, 'workflow_complete' | 'pr_agent_complete'>): boolean {
  return task.workflow_complete === 1 && task.pr_agent_complete === 0;
}

export interface TaskPublishState {
  /** Everything in the worktree has reached the PR — it is safe to delete. */
  published: boolean;
  /** Absent when the task or its worktree is gone; then `published` is true. */
  worktreePath: string | null;
  /** Dirty paths, truncated to `MAX_LISTED_FILES`. */
  files: string[];
  dirtyFiles: number;
  unpushedCommits: number;
  /** "4 uncommitted files and 2 unpushed commits", or "no unsaved work". */
  summary: string;
}

const PUBLISHED: TaskPublishState = Object.freeze({
  published: true,
  worktreePath: null,
  files: [],
  dirtyFiles: 0,
  unpushedCommits: 0,
  summary: describeUnsavedWork({ dirtyFiles: 0, unpushedCommits: 0 }),
});

/**
 * Has every change in this task's worktree reached the PR?
 *
 * Same question as `getWorktreeSafety` — "would deleting this worktree lose
 * work?" — asked at the other end of the lifecycle. The worktree *will* be
 * deleted once the PR merges, so the PR stage may only be marked complete on a
 * tree that is already safe to throw away: no dirty paths (a QA screenshot and a
 * forgotten source edit look identical from here, which is the point — the agent
 * has to have triaged them), and no commits that never left the box, because a
 * merge takes the PR's remote head.
 *
 * Deliberately checks the worktree **root** rather than the monorepo subproject
 * path: a byproduct dropped one directory up is exactly as lost.
 *
 * Reports published when the worktree is missing — there is nothing left to
 * publish, and refusing to close out a task whose worktree was already cleaned
 * up would strand it.
 */
export async function getTaskPublishState(taskId: number): Promise<TaskPublishState> {
  const task = tasksDb.getWithProject(taskId);
  if (!task) return PUBLISHED;

  const worktreePath = getWorktreePath(task.repo_folder_path, taskId);
  const safety = await getWorktreeSafety(worktreePath);

  return {
    published: safety.clean,
    worktreePath,
    files: safety.files,
    dirtyFiles: safety.dirtyFiles,
    unpushedCommits: safety.unpushedCommits,
    summary: describeUnsavedWork(safety),
  };
}

export { MAX_LISTED_FILES };
