import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  task: ((): Record<string, unknown> => ({}))(),
  landing: null as Record<string, unknown> | null,
  order: [] as string[],
  getPr: vi.fn(),
  getPrByUrl: vi.fn(),
  mergePr: vi.fn(),
  cleanup: vi.fn(),
  assertSafe: vi.fn(),
  emit: vi.fn(),
  notify: vi.fn(),
  clearSessions: vi.fn(),
}));

vi.mock('../../database/tasks.js', () => ({
  tasksDb: {
    getWithProject: vi.fn(() => harness.task),
    getById: vi.fn(() => harness.task),
    getLanding: vi.fn(() => harness.landing),
    requestLanding: vi.fn((_taskId: number, identity: Record<string, unknown>) => {
      harness.order.push('intent');
      harness.landing = {
        task_id: 42,
        pr_url: identity.prUrl,
        head_branch: identity.headBranch,
        base_branch: identity.baseBranch,
        state: 'merge_requested',
        cleanup_state: 'pending',
        cleanup_retryable: 1,
      };
      return harness.landing;
    }),
    finalizeLanding: vi.fn((_taskId: number, sha: string | null, mergedAt: string | null) => {
      harness.order.push('finalize');
      const previousStatus = String(harness.task.status);
      harness.task.status = 'completed';
      harness.task.pr_agent_complete = 1;
      Object.assign(harness.landing!, {
        state: 'merged',
        merge_commit_sha: sha,
        merged_at: mergedAt,
      });
      return {
        task: { ...harness.task },
        previousStatus,
        transitioned: previousStatus !== 'completed',
      };
    }),
    markLandingCleanup: vi.fn((_taskId: number, success: boolean, error?: string) => {
      Object.assign(harness.landing!, {
        cleanup_state: success ? 'completed' : 'failed',
        cleanup_error: error ?? null,
      });
      return harness.landing;
    }),
    preserveLandingWorktree: vi.fn((_taskId: number, reason: string) => {
      Object.assign(harness.landing!, {
        cleanup_state: 'failed',
        cleanup_retryable: 0,
        cleanup_error: reason,
      });
      return harness.landing;
    }),
    listLandingsToReconcile: vi.fn(() => (harness.landing ? [harness.landing] : [])),
  },
  taskAgentRunsDb: { getByTask: vi.fn(() => []) },
}));

vi.mock('../../database/conversationQuestions.js', () => ({
  conversationQuestionsDb: { pendingForConversation: vi.fn() },
}));
vi.mock('../conversation/sessionState.js', () => ({ pendingAskUserQuestions: new Map() }));
vi.mock('../taskService.js', () => ({
  createTaskWithWorktree: vi.fn(),
  deleteTaskCompletely: vi.fn(),
  getAllTasks: vi.fn(),
  getTask: vi.fn(),
  hasTaskAccess: vi.fn(),
}));
vi.mock('../notifications.js', () => ({ notifyTaskStatusChange: harness.notify }));
vi.mock('../worktree.js', () => ({
  getPullRequestStatus: harness.getPr,
  getPullRequestStatusByUrl: harness.getPrByUrl,
  mergePullRequest: async (...args: unknown[]) => {
    harness.order.push('merge');
    return harness.mergePr(...args);
  },
  cleanupMergedWorktree: harness.cleanup,
  getWorktreePath: (_repo: string, taskId: number) => `/repo-worktrees/task-${taskId}`,
  getWorktreeProjectPath: (_repo: string, taskId: number) => `/repo-worktrees/task-${taskId}`,
  getBranchName: vi.fn().mockResolvedValue('task/42-feature'),
  worktreeExists: vi.fn().mockResolvedValue(true),
}));
vi.mock('../worktreeSafety.js', () => ({
  assertWorktreeSafeToDestroy: async (...args: unknown[]) => {
    harness.order.push('safety');
    return harness.assertSafe(...args);
  },
}));
vi.mock('./baseBranch.js', () => ({
  resolveBaseBranch: vi.fn().mockResolvedValue('epic/7-feature'),
}));
vi.mock('./events.js', () => ({
  emitTaskEvent: harness.emit,
  onTaskEvent: vi.fn(),
}));
vi.mock('../conversation/sessionControl.js', () => ({
  clearStreamingSessionsForTask: harness.clearSessions,
}));

import { mergeTask, reconcileTaskLandings } from './index.js';

const OPEN_PR = {
  success: true,
  exists: true,
  url: 'https://github.com/o/r/pull/42',
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  headBranch: 'task/42-feature',
  baseBranch: 'epic/7-feature',
  ciStatus: { status: 'passed', checks: [] },
};

const MERGED_PR = {
  ...OPEN_PR,
  state: 'MERGED',
  merged: true,
  mergeCommitSha: 'abc123',
  mergedAt: '2026-08-24T12:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  harness.order.length = 0;
  harness.landing = null;
  harness.task = {
    id: 42,
    project_id: 3,
    user_id: 4,
    title: 'Feature',
    status: 'in_progress',
    pr_agent_complete: 1,
    repo_folder_path: '/repo',
    subproject_path: null,
  };
  harness.getPr.mockResolvedValue(OPEN_PR);
  harness.getPrByUrl.mockResolvedValue(MERGED_PR);
  harness.mergePr.mockResolvedValue(MERGED_PR);
  harness.cleanup.mockResolvedValue({ success: true });
  harness.assertSafe.mockResolvedValue(undefined);
  harness.notify.mockResolvedValue(undefined);
  harness.clearSessions.mockReturnValue([]);
});

describe('task landing saga', () => {
  it('records intent before GitHub and completes the task even when cleanup fails', async () => {
    harness.cleanup.mockResolvedValue({ success: false, error: 'cleanup timed out' });

    const result = await mergeTask(42);

    expect(harness.order).toEqual(['safety', 'intent', 'merge', 'finalize']);
    expect(harness.task.status).toBe('completed');
    await vi.waitFor(() =>
      expect(harness.landing).toMatchObject({ state: 'merged', cleanup_state: 'failed' }),
    );
    expect(result).toMatchObject({
      success: true,
      merged: true,
      cleanupPending: true,
    });
    expect(harness.emit).toHaveBeenCalledWith('task-merged', { taskId: 42 });
  });

  it('repairs a crash after GitHub merged but before task completion', async () => {
    harness.landing = {
      task_id: 42,
      pr_url: OPEN_PR.url,
      head_branch: OPEN_PR.headBranch,
      base_branch: OPEN_PR.baseBranch,
      state: 'merge_requested',
      cleanup_state: 'pending',
      cleanup_retryable: 1,
    };

    await reconcileTaskLandings({ awaitCleanup: true });

    expect(harness.getPrByUrl).toHaveBeenCalledWith('/repo', OPEN_PR.url);
    expect(harness.task.status).toBe('completed');
    expect(harness.landing).toMatchObject({ state: 'merged', cleanup_state: 'completed' });
    expect(harness.mergePr).not.toHaveBeenCalled();
    expect(harness.emit).toHaveBeenCalledWith('task-merged', { taskId: 42 });
  });

  it('reconciles an already-merged PR but preserves an uncheckpointed worktree', async () => {
    harness.getPr.mockResolvedValue(MERGED_PR);

    const result = await mergeTask(42);

    expect(harness.task.status).toBe('completed');
    expect(harness.assertSafe).not.toHaveBeenCalled();
    expect(harness.cleanup).not.toHaveBeenCalled();
    expect(harness.landing).toMatchObject({ cleanup_retryable: 0 });
    expect(result).toMatchObject({
      success: true,
      merged: true,
      cleanupPending: true,
      cleanupRequiresManualReview: true,
    });

    await reconcileTaskLandings({ awaitCleanup: true });
    expect(harness.cleanup).not.toHaveBeenCalled();
  });
});
