// The task domain's public facade (architecture-v2). This is the ONE surface
// the epic layer may import (enforced by lint): the same functions the REST
// routes call when a human clicks. The bottega MCP is the adapter that
// exposes this API to an agent; REST is the adapter that exposes it to a
// person — one API, two adapters.

import { tasksDb, taskAgentRunsDb, type TaskWithProject } from '../../database/tasks.js';
import { pendingAskUserQuestions } from '../conversation/sessionState.js';
import { conversationQuestionsDb } from '../../database/conversationQuestions.js';
import { notifyTaskStatusChange } from '../notifications.js';
import {
  cleanupMergedWorktree,
  getBranchName,
  getPullRequestStatus,
  getPullRequestStatusByUrl,
  getWorktreePath,
  getWorktreeProjectPath,
  mergePullRequest,
  worktreeExists,
} from '../worktree.js';
import { assertWorktreeSafeToDestroy } from '../worktreeSafety.js';
import { resolveBaseBranch } from './baseBranch.js';
import { emitTaskEvent } from './events.js';
import type { AgentType, TaskAgentRunRow, TaskWorktreeState } from '@shared/types/db';
import type { BroadcastToTaskSubscribersFn } from '@shared/websocket/messages';

// Commands + queries that already live in their own modules.
export {
  createTaskWithWorktree,
  deleteTaskCompletely,
  getAllTasks,
  getTask as getTaskForUser,
  hasTaskAccess,
  type CreateTaskInput,
  type CreateTaskResult,
  type CreatedTaskWithWorktree,
} from '../taskService.js';
export { onTaskEvent } from './events.js';
export type {
  TaskEventMap,
  TaskEventName,
  TaskRunEndedEvent,
  TaskQuestionParkedEvent,
  TaskWorkflowBlockedEvent,
  TaskChainStartFailedEvent,
  TaskMergedEvent,
  TaskDeletedEvent,
} from './events.js';
export { resolveBaseBranch } from './baseBranch.js';
export {
  startAgentRun,
  BaseSyncConflictError,
  TaskAgentRunConflictError,
  getRunningAgentForTask,
} from '../agentRunner.js';
export { readTaskDoc, writeTaskDoc } from '../documentation.js';
export type { TaskWithProject } from '../../database/tasks.js';

/**
 * One task with its project, or null. No caller identity: this is the
 * server-side surface for automations acting on tasks they already own the
 * right to touch (the epic layer on its tickets); the REST routes keep using
 * `getTaskForUser` with its membership check.
 */
export function getTask(taskId: number): TaskWithProject | null {
  return tasksDb.getWithProject(taskId) ?? null;
}

export interface TaskFlags {
  status: string;
  planificationComplete: boolean;
  workflowComplete: boolean;
  workflowBlocked: boolean;
  /** Why, when the agent said so. Null unless `workflowBlocked`. */
  workflowBlockedReason: string | null;
  refinementComplete: boolean;
  prAgentComplete: boolean;
  runCount: number;
  /** Nothing can start on the task until its worktree setup is 'ready'. */
  worktreeState: TaskWorktreeState;
  /** Why the setup failed, with the hook's last output. Null unless 'failed'. */
  worktreeError: string | null;
}

/** The workflow flags an automation reasons about, read fresh. */
export function taskFlags(taskId: number): TaskFlags | null {
  const task = tasksDb.getById(taskId);
  if (!task) return null;
  return {
    status: task.status,
    planificationComplete: !!task.planification_complete,
    workflowComplete: !!task.workflow_complete,
    workflowBlocked: !!task.workflow_blocked,
    workflowBlockedReason: task.workflow_blocked_reason,
    refinementComplete: !!task.refinement_complete,
    prAgentComplete: !!task.pr_agent_complete,
    runCount: task.workflow_run_count,
    worktreeState: task.worktree_state,
    worktreeError: task.worktree_error,
  };
}

/**
 * Lift a blocked ticket and give it a clean slate — the exact pair of writes
 * `POST /api/tasks/:id/resume` performs when a human clicks Resume, so a
 * supervising automation and a person unblock a task the same way. Starting
 * the next agent is the caller's move.
 */
export function unblockTask(taskId: number): TaskFlags | null {
  if (!tasksDb.getById(taskId)) return null;
  tasksDb.unblockWorkflow(taskId);
  tasksDb.resetRunCount(taskId);
  return taskFlags(taskId);
}

export interface TaskRunSummary {
  runId: number;
  status: string;
  conversationId: number | null;
}

/** The latest run of each agent type (highest run id wins — the UI's rule). */
export function latestRunsByType(taskId: number): Partial<Record<AgentType, TaskRunSummary>> {
  const latest: Partial<Record<AgentType, TaskRunSummary>> = {};
  for (const run of taskAgentRunsDb
    .getByTask(taskId)
    .slice()
    .sort((a, b) => a.id - b.id)) {
    latest[run.agent_type] = {
      runId: run.id,
      status: run.status,
      conversationId: run.conversation_id,
    };
  }
  return latest;
}

/**
 * The newest run (optionally of one type) that has a conversation — the
 * taskId → conversationId mapping feedback/answer surfaces need.
 */
export function latestRunWithConversation(
  taskId: number,
  agentType?: AgentType,
): TaskAgentRunRow | null {
  return (
    taskAgentRunsDb
      .getByTask(taskId)
      .filter(
        (r) => r.conversation_id != null && (agentType === undefined || r.agent_type === agentType),
      )
      .sort((a, b) => b.id - a.id)[0] ?? null
  );
}

/**
 * Every agent run of a task, oldest first — the index a supervisor needs to
 * pick a conversation to inspect. `latestRunsByType` answers "where does this
 * ticket stand"; this answers "what has been tried", which is a different
 * question once a type has run more than once.
 */
export function taskAgentRuns(taskId: number): TaskAgentRunRow[] {
  return taskAgentRunsDb.getByTask(taskId).slice().sort((a, b) => a.id - b.id);
}

/** Whether any agent run was ever started on this task (the revision-window signal). */
export function taskHasAgentRuns(taskId: number): boolean {
  return taskAgentRunsDb.getByTask(taskId).length > 0;
}

/** Rename a task. */
export function updateTaskTitle(taskId: number, title: string | null): void {
  tasksDb.update(taskId, { title });
}

export interface PendingTaskQuestion {
  agentType: AgentType;
  conversationId: number;
  questions: unknown[];
}

/**
 * The questions a task agent is currently parked on, if any — wraps the
 * runtime's in-memory park map, newest run first.
 */
export function pendingQuestion(taskId: number): PendingTaskQuestion | null {
  for (const run of taskAgentRunsDb.getByTask(taskId).sort((a, b) => b.id - a.id)) {
    if (run.conversation_id == null) continue;
    const entry = pendingAskUserQuestions.get(run.conversation_id);
    if (entry) {
      return {
        agentType: run.agent_type,
        conversationId: run.conversation_id,
        questions: entry.questions,
      };
    }
    const durable = conversationQuestionsDb.pendingForConversation(run.conversation_id);
    if (durable) {
      return {
        agentType: run.agent_type,
        conversationId: run.conversation_id,
        questions: JSON.parse(durable.questions_json) as unknown[],
      };
    }
  }
  return null;
}

export interface TaskProgress extends TaskFlags {
  taskId: number;
  title: string | null;
  worktreePath: string | null;
  latestRuns: Partial<Record<AgentType, TaskRunSummary>>;
  pullRequest: {
    url: string | undefined;
    state: string | undefined;
    mergeable: string | undefined;
    ci: string;
  } | null;
}

/**
 * Where one task stands: its flags, its agent runs, its pull request and CI,
 * and the absolute path of its worktree.
 */
export async function taskProgress(taskId: number): Promise<TaskProgress | null> {
  const task = tasksDb.getWithProject(taskId);
  const flags = taskFlags(taskId);
  if (!task || !flags) return null;

  const pr = await getPullRequestStatus(task.repo_folder_path, taskId);
  const hasWorktree = await worktreeExists(task.repo_folder_path, taskId);

  return {
    taskId,
    title: task.title,
    ...flags,
    worktreePath: hasWorktree
      ? getWorktreeProjectPath(task.repo_folder_path, taskId, task.subproject_path)
      : null,
    latestRuns: latestRunsByType(taskId),
    pullRequest: pr.exists
      ? {
          url: pr.url,
          state: pr.state,
          mergeable: pr.mergeable,
          ci: pr.ciStatus?.status ?? 'none',
        }
      : null,
  };
}

export interface MergeTaskResult {
  success: boolean;
  error?: string;
  merged?: boolean;
  cleanupPending?: boolean;
  cleanupError?: string;
  cleanupRequiresManualReview?: boolean;
  warning?: string;
  [k: string]: unknown;
}

export interface MergeTaskOptions {
  force?: boolean | undefined;
  /** Whose badge to update on the status change; defaults to the task owner. */
  userId?: number | undefined;
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
}

/**
 * Finish the local task transition once GitHub is known to have merged.
 * SQLite records the landing and task completion in one transaction; every
 * notification/event after that point is replayable and never authoritative.
 */
async function finalizeMergedTask(
  task: TaskWithProject,
  remote: { mergeCommitSha?: string | null; mergedAt?: string | null },
  options: MergeTaskOptions,
): Promise<void> {
  const finalized = tasksDb.finalizeLanding(
    task.id,
    remote.mergeCommitSha ?? null,
    remote.mergedAt ?? null,
  );
  if (!finalized) throw new Error(`Task ${task.id} disappeared while finalizing its merge`);

  if (finalized.transitioned) {
    const notifyUserId = options.userId ?? task.user_id;
    if (notifyUserId) {
      notifyTaskStatusChange(notifyUserId, finalized.previousStatus, 'completed').catch(
        (err: unknown) => {
          console.error('[Tasks] Failed to send task status notification:', err);
        },
      );
    }

    const { clearStreamingSessionsForTask } = await import(
      '../conversation/sessionControl.js'
    );
    const cleared = clearStreamingSessionsForTask(task.id);
    for (const { conversationId } of cleared) {
      options.broadcastToTaskSubscribersFn?.(task.id, {
        type: 'streaming-ended',
        conversationId,
      });
    }
  }

  // Safe to replay: subscribers re-read state and sequencing is guarded.
  emitTaskEvent('task-merged', { taskId: task.id });
}

async function cleanupLanding(task: TaskWithProject): Promise<MergeTaskResult> {
  const landing = tasksDb.getLanding(task.id);
  if (!landing || landing.state !== 'merged') {
    return { success: false, error: `Task ${task.id} has no merged landing to clean up` };
  }
  if (landing.cleanup_state === 'completed') return { success: true, merged: true };
  if (!landing.cleanup_retryable) {
    return {
      success: true,
      merged: true,
      cleanupPending: true,
      cleanupError: landing.cleanup_error ?? 'Worktree cleanup requires manual review.',
      cleanupRequiresManualReview: true,
    };
  }

  const cleanup = await cleanupMergedWorktree(
    task.repo_folder_path,
    task.id,
    landing.head_branch,
    landing.base_branch,
  );
  tasksDb.markLandingCleanup(task.id, cleanup.success, cleanup.error);

  if (!cleanup.success) {
    console.error(
      `[Tasks] PR ${landing.pr_url} is merged and task ${task.id} is completed, ` +
        `but worktree cleanup is pending: ${cleanup.error ?? 'unknown error'}`,
    );
    return {
      success: true,
      merged: true,
      cleanupPending: true,
      cleanupError: cleanup.error ?? 'unknown cleanup error',
    };
  }
  return { success: true, merged: true, ...(cleanup.warning ? { warning: cleanup.warning } : {}) };
}

function startLandingCleanup(task: TaskWithProject): MergeTaskResult {
  const landing = tasksDb.getLanding(task.id);
  if (landing?.cleanup_state === 'completed') return { success: true, merged: true };
  if (landing && !landing.cleanup_retryable) {
    return {
      success: true,
      merged: true,
      cleanupPending: true,
      cleanupError: landing.cleanup_error ?? 'Worktree cleanup requires manual review.',
      cleanupRequiresManualReview: true,
    };
  }

  // Do not keep an HTTP response or reviewer turn open while a dependency-heavy
  // directory is removed. The durable cleanup_state makes this safe to detach:
  // completion is already committed, failures are persisted, and boot retries.
  void cleanupLanding(task).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    tasksDb.markLandingCleanup(task.id, false, message);
    console.error(`[Tasks] Background cleanup failed for task ${task.id}:`, error);
  });
  return { success: true, merged: true, cleanupPending: true };
}

/**
 * Land one task as a small saga:
 *
 * 1. verify the disposable worktree is safe;
 * 2. persist exact PR identity + merge intent;
 * 3. ask GitHub to merge and re-read ambiguous failures;
 * 4. atomically mark the landing/task merged;
 * 5. attempt cleanup as retryable housekeeping.
 *
 * One function for every caller — the Merge button's route and the epic PR
 * reviewer's `merge_task` — so adapters cannot drift.
 *
 * Throws `UnsavedWorktreeWorkError` when the
 * worktree holds unsaved work and `force` is not set.
 */
export async function mergeTask(
  taskId: number,
  options: MergeTaskOptions = {},
): Promise<MergeTaskResult> {
  const task = tasksDb.getWithProject(taskId);
  if (!task) return { success: false, error: `Task ${taskId} not found` };

  const baseBranch = await resolveBaseBranch(task, task.repo_folder_path);
  const pr = await getPullRequestStatus(task.repo_folder_path, taskId);
  if (!pr.success || !pr.exists || !pr.url) {
    return { success: false, error: pr.error ?? `Task ${taskId} has no pull request` };
  }

  const headBranch =
    pr.headBranch ?? (await getBranchName(getWorktreePath(task.repo_folder_path, taskId)));
  if (!headBranch) {
    return { success: false, error: `Could not determine the pull request branch for task ${taskId}` };
  }
  const exactBaseBranch = pr.baseBranch ?? baseBranch;
  const previousLanding = tasksDb.getLanding(taskId);

  // Idempotent recovery for a PR merged outside (or just before) this process.
  // Complete the task from the remote fact, but do not force-delete a tree
  // unless this service had already recorded the pre-merge safety checkpoint.
  if (pr.state === 'MERGED') {
    tasksDb.requestLanding(taskId, {
      prUrl: pr.url,
      headBranch,
      baseBranch: exactBaseBranch,
    });
    await finalizeMergedTask(task, pr, options);
    if (!previousLanding) {
      const warning =
        'The pull request was already merged before Bottega recorded its safety checkpoint. ' +
        'The task is completed, but its worktree was left in place for manual cleanup.';
      tasksDb.preserveLandingWorktree(taskId, warning);
      return {
        success: true,
        merged: true,
        cleanupPending: true,
        cleanupError: warning,
        cleanupRequiresManualReview: true,
      };
    }
    return startLandingCleanup(task);
  }

  await assertWorktreeSafeToDestroy(
    getWorktreePath(task.repo_folder_path, taskId),
    taskId,
    { force: options.force },
  );

  // Write-ahead checkpoint: from here on, a restart can resolve the remote
  // outcome by URL without the worktree or an agent transcript.
  tasksDb.requestLanding(taskId, {
    prUrl: pr.url,
    headBranch,
    baseBranch: exactBaseBranch,
  });

  const merge = await mergePullRequest(task.repo_folder_path, pr.url);
  if (!merge.merged) {
    return { success: false, error: merge.error ?? `Pull request ${pr.url} did not merge` };
  }

  await finalizeMergedTask(task, merge, options);
  return startLandingCleanup(task);
}

/**
 * Boot repair for a crash between the write-ahead merge request and SQLite's
 * completion transaction. Open PRs are never auto-merged here; only a remote
 * MERGED fact can advance local state. Cleanup retries can run in the
 * background so a large dependency tree does not delay server readiness.
 */
export async function reconcileTaskLandings(
  options: { awaitCleanup?: boolean } = {},
): Promise<void> {
  const cleanupJobs: Array<Promise<MergeTaskResult>> = [];

  for (const snapshot of tasksDb.listLandingsToReconcile()) {
    try {
      const task = tasksDb.getWithProject(snapshot.task_id);
      if (!task) continue;
      let landing = snapshot;

      if (landing.state === 'merge_requested') {
        const remote = await getPullRequestStatusByUrl(task.repo_folder_path, landing.pr_url);
        if (!remote.success || remote.state !== 'MERGED') continue;
        await finalizeMergedTask(task, remote, {});
        landing = tasksDb.getLanding(task.id)!;
        console.log(
          `[RECOVERY] Reconciled merged PR ${landing.pr_url} to completed task ${task.id}`,
        );
      }

      if (
        landing.state === 'merged' &&
        landing.cleanup_retryable &&
        landing.cleanup_state !== 'completed'
      ) {
        cleanupJobs.push(cleanupLanding(task));
      }
    } catch (error) {
      console.error(
        `[RECOVERY] Could not reconcile task landing ${snapshot.task_id}:`,
        error,
      );
    }
  }

  if (options.awaitCleanup) {
    await Promise.allSettled(cleanupJobs);
  } else if (cleanupJobs.length > 0) {
    void Promise.allSettled(cleanupJobs);
  }
}
