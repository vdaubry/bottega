import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../database/tasks.js', () => ({
  tasksDb: {
    getById: vi.fn(),
    getWithProject: vi.fn(),
    markRefinementComplete: vi.fn(),
    blockWorkflow: vi.fn(),
  },
  taskAgentRunsDb: {
    getByConversationId: vi.fn(),
    getByTask: vi.fn().mockReturnValue([]),
    getByStatus: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('../../database/db.js', () => ({
  userDb: { getUserById: vi.fn() },
}));

vi.mock('../worktree.js', () => ({
  worktreeExists: vi.fn().mockResolvedValue(false),
  getWorktreeProjectPath: vi.fn(),
}));

vi.mock('../notifications.js', () => ({
  notifyClaudeComplete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../agentRunner.js', () => ({
  startAgentRun: vi.fn().mockResolvedValue(undefined),
  getRunningAgentForTask: vi.fn().mockReturnValue(null),
}));

// The task path publishes TaskEvents; the epic layer's subscriber has its own
// tests. Mocked so ordering can be asserted against the chain dispatch.
vi.mock('./events.js', () => ({
  emitTaskEvent: vi.fn(),
}));

vi.mock('../conversation/atlasInjection.js', () => ({
  withAtlasMcpServer: vi.fn((s) => s),
}));

import { taskOwnerAdapter, MAX_WORKFLOW_RUNS } from './adapter.js';
import { tasksDb, taskAgentRunsDb } from '../../database/tasks.js';
import { userDb } from '../../database/db.js';
import { worktreeExists } from '../worktree.js';
import { notifyClaudeComplete } from '../notifications.js';
import { startAgentRun, getRunningAgentForTask } from '../agentRunner.js';
import { emitTaskEvent } from './events.js';

function setLinkedRuns(runs: unknown): void {
  vi.mocked(taskAgentRunsDb.getByTask).mockReturnValue(runs as never);
  vi.mocked(taskAgentRunsDb.getByConversationId).mockImplementation(((
    conversationId: number,
  ) =>
    (runs as Array<{ conversation_id: number | null }>).find(
      (r) => r.conversation_id === conversationId,
    )) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  setLinkedRuns([]);
  vi.mocked(worktreeExists).mockResolvedValue(false);
  vi.mocked(getRunningAgentForTask).mockReturnValue(null);
  vi.mocked(startAgentRun).mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.useRealTimers();
});

function ctx(overrides = {}) {
  return {
    conversationId: 100,
    taskId: 7,
    epicId: null,
    claudeSessionId: 'sess',
    userId: 1,
    broadcastFn: vi.fn(),
    broadcastToTaskSubscribersFn: vi.fn(),
    isNewSession: false,
    ...overrides,
  } as never;
}

const onTurnEnded = (c: unknown) => taskOwnerAdapter.onTurnEnded(c as never);

describe('task adapter onTurnEnded', () => {
  it('is a no-op when ctx has no taskId', async () => {
    await onTurnEnded(ctx({ taskId: undefined }));

    expect(taskAgentRunsDb.getByConversationId).not.toHaveBeenCalled();
    expect(notifyClaudeComplete).not.toHaveBeenCalled();
  });

  it('marks the linked agent run completed and broadcasts agent-run-updated', async () => {
    const c = ctx();
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'pr', status: 'running' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, title: 'T', project_id: 1, workflow_complete: false } as never);

    await onTurnEnded(c);

    expect(taskAgentRunsDb.updateStatus).toHaveBeenCalledWith(9, 'completed');
    expect((c as { broadcastToTaskSubscribersFn: ReturnType<typeof vi.fn> }).broadcastToTaskSubscribersFn).toHaveBeenCalledWith(7, {
      type: 'agent-run-updated',
      agentRun: { id: 9, status: 'completed', agent_type: 'pr', conversation_id: 100 },
    });
  });

  it("leaves a 'failed' row untouched and skips chaining (user-Stop path)", async () => {
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'implementation', status: 'failed' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 0 } as never);

    await onTurnEnded(ctx());

    expect(taskAgentRunsDb.updateStatus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('does not chain after a PR agent (terminal)', async () => {
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'pr', status: 'running' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_complete: true, refinement_complete: true, pr_agent_complete: false } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    vi.mocked(worktreeExists).mockResolvedValue(true);

    await onTurnEnded(ctx());
    vi.advanceTimersByTime(2000);

    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('skips planification → implementation chain for technical actor', async () => {
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'planification', status: 'running', driver: 'human' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 0 } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, is_technical: 1 } as never);

    await onTurnEnded(ctx());
    vi.advanceTimersByTime(2000);

    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('chains planification → implementation for non-technical actor after 1s', async () => {
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'planification', status: 'running', driver: 'human' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 0 } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, is_technical: 0 } as never);

    await onTurnEnded(ctx());
    expect(startAgentRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(startAgentRun).toHaveBeenCalledWith(7, 'implementation', expect.objectContaining({ userId: 1 }));
  });

  it('an automation-driven planification never auto-chains — its driver reviews the plan (policy 2)', async () => {
    vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, is_technical: 0 } as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 0 } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    setLinkedRuns([{ id: 1, agent_type: 'planification', status: 'running', conversation_id: 100, driver: 'automation' }]);

    await onTurnEnded(ctx());
    await vi.runAllTimersAsync();

    expect(emitTaskEvent).toHaveBeenCalledWith(
      'run-ended',
      expect.objectContaining({ driver: 'automation', agentType: 'planification' }),
    );
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('the chain inherits the ending run driver', async () => {
    setLinkedRuns([{ id: 3, agent_type: 'implementation', status: 'running', conversation_id: 100, driver: 'automation' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 1 } as never);

    await onTurnEnded(ctx());
    await vi.advanceTimersByTimeAsync(1000);

    expect(startAgentRun).toHaveBeenCalledWith(7, 'review', expect.objectContaining({ driver: 'automation' }));
  });

  it("publishes 'run-ended' before any chaining decision (notify-before-chain)", async () => {
    vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, is_technical: 0 } as never);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 0 } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    setLinkedRuns([{ id: 1, agent_type: 'planification', status: 'running', conversation_id: 100, driver: 'human' }]);

    await onTurnEnded(ctx());
    await vi.runAllTimersAsync();

    expect(emitTaskEvent).toHaveBeenCalledWith('run-ended', {
      taskId: 7,
      runId: 1,
      agentType: 'planification',
      driver: 'human',
      status: 'completed',
      conversationId: 100,
    });
    expect(startAgentRun).toHaveBeenCalledWith(7, 'implementation', expect.anything());
    const emitOrder = vi.mocked(emitTaskEvent).mock.invocationCallOrder[0]!;
    const chainOrder = vi.mocked(startAgentRun).mock.invocationCallOrder[0]!;
    expect(emitOrder).toBeLessThan(chainOrder);
  });

  it("publishes 'run-ended' with status 'failed' for a failed run (no chain)", async () => {
    setLinkedRuns([{ id: 4, agent_type: 'implementation', status: 'failed', conversation_id: 100, driver: 'human' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7 } as never);

    await onTurnEnded(ctx());
    await vi.runAllTimersAsync();

    expect(emitTaskEvent).toHaveBeenCalledWith(
      'run-ended',
      expect.objectContaining({ runId: 4, status: 'failed' }),
    );
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('chains implementation ↔ review when not workflow_complete', async () => {
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'implementation', status: 'running' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 1 } as never);

    await onTurnEnded(ctx());
    await vi.advanceTimersByTimeAsync(1000);
    expect(startAgentRun).toHaveBeenCalledWith(7, 'review', expect.any(Object));

    vi.clearAllMocks();
    vi.mocked(getRunningAgentForTask).mockReturnValue(null);
    setLinkedRuns([{ id: 10, conversation_id: 100, agent_type: 'review', status: 'running' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 2 } as never);

    await onTurnEnded(ctx());
    await vi.advanceTimersByTimeAsync(1000);
    expect(startAgentRun).toHaveBeenCalledWith(7, 'implementation', expect.any(Object));
  });

  it('starts refinement when workflow_complete, then PR when a worktree exists', async () => {
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'review', status: 'running' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_complete: true, refinement_complete: false } as never);

    await onTurnEnded(ctx());
    await vi.advanceTimersByTimeAsync(1000);
    expect(startAgentRun).toHaveBeenCalledWith(7, 'refinement', expect.any(Object));

    vi.clearAllMocks();
    vi.mocked(getRunningAgentForTask).mockReturnValue(null);
    setLinkedRuns([{ id: 10, conversation_id: 100, agent_type: 'refinement', status: 'running' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_complete: true, refinement_complete: false, pr_agent_complete: false } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    vi.mocked(worktreeExists).mockResolvedValue(true);

    await onTurnEnded(ctx());
    expect(tasksDb.markRefinementComplete).toHaveBeenCalledWith(7);
    await vi.advanceTimersByTimeAsync(1000);
    expect(startAgentRun).toHaveBeenCalledWith(7, 'pr', expect.any(Object));
  });

  it("blocks the workflow at MAX_WORKFLOW_RUNS and publishes 'workflow-blocked'", async () => {
    const c = ctx();
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'implementation', status: 'running' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: MAX_WORKFLOW_RUNS } as never);

    await onTurnEnded(c);

    expect(tasksDb.blockWorkflow).toHaveBeenCalledWith(7);
    expect((c as { broadcastToTaskSubscribersFn: ReturnType<typeof vi.fn> }).broadcastToTaskSubscribersFn).toHaveBeenCalledWith(7, {
      type: 'task-blocked',
      reason: 'max_iterations',
    });
    expect(emitTaskEvent).toHaveBeenCalledWith(
      'workflow-blocked',
      expect.objectContaining({ taskId: 7, reason: 'max-iterations' }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it("publishes 'workflow-blocked' when the agent blocked itself, carrying its reason", async () => {
    // `scripts/block-workflow.ts` runs out of process, so the flag is simply
    // there when the chain re-reads the row. Before this, the loop stopped
    // silently and a supervising orchestrator never learned of it.
    const c = ctx();
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'review', status: 'running' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({
      id: 7,
      workflow_run_count: 3,
      workflow_blocked: 1,
      workflow_blocked_reason: 'No Playwright/browser connector, manual QA cannot run.',
    } as never);

    await onTurnEnded(c);

    expect(
      (c as { broadcastToTaskSubscribersFn: ReturnType<typeof vi.fn> })
        .broadcastToTaskSubscribersFn,
    ).toHaveBeenCalledWith(7, { type: 'task-blocked', reason: 'agent_requested' });
    expect(emitTaskEvent).toHaveBeenCalledWith('workflow-blocked', {
      taskId: 7,
      reason: 'agent-requested',
      detail: 'No Playwright/browser connector, manual QA cannot run.',
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('still announces a block whose agent gave no reason, pointing at the ticket doc', async () => {
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'review', status: 'running' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({
      id: 7,
      workflow_run_count: 3,
      workflow_blocked: 1,
      workflow_blocked_reason: null,
    } as never);

    await onTurnEnded(ctx());

    expect(emitTaskEvent).toHaveBeenCalledWith(
      'workflow-blocked',
      expect.objectContaining({
        taskId: 7,
        reason: 'agent-requested',
        detail: expect.stringContaining('Review Findings'),
      }),
    );
  });

  it('announces a block that only appears on the delayed chain re-check', async () => {
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'implementation', status: 'running' }]);
    // Not blocked when the chain decides; blocked by the time it fires.
    vi.mocked(tasksDb.getById)
      .mockReturnValueOnce({ id: 7, workflow_run_count: 1 } as never)
      .mockReturnValue({
        id: 7,
        workflow_run_count: 1,
        workflow_blocked: 1,
        workflow_blocked_reason: 'blocked late',
      } as never);

    await onTurnEnded(ctx());
    await vi.advanceTimersByTimeAsync(2000);

    expect(startAgentRun).not.toHaveBeenCalled();
    expect(emitTaskEvent).toHaveBeenCalledWith(
      'workflow-blocked',
      expect.objectContaining({ reason: 'agent-requested', detail: 'blocked late' }),
    );
  });

  it('skips chaining when another task agent is running', async () => {
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'implementation', status: 'running' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 1 } as never);
    vi.mocked(getRunningAgentForTask).mockReturnValue({
      id: 4,
      task_id: 7,
      agent_type: 'review',
      status: 'running',
    } as never);

    await onTurnEnded(ctx());
    await vi.advanceTimersByTimeAsync(1000);

    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it("publishes 'chain-start-failed' when the chain dispatch throws, and never inserts a sibling row", async () => {
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'implementation', status: 'running' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, workflow_run_count: 1 } as never);
    vi.mocked(startAgentRun).mockRejectedValue(new Error('dispatch failed'));

    await onTurnEnded(ctx());
    await vi.advanceTimersByTimeAsync(1000);

    expect(emitTaskEvent).toHaveBeenCalledWith('chain-start-failed', {
      taskId: 7,
      nextAgentType: 'review',
      error: 'dispatch failed',
    });
    expect(taskAgentRunsDb.create).not.toHaveBeenCalled();
    expect(taskAgentRunsDb.updateStatus).toHaveBeenCalledTimes(1);
    expect(taskAgentRunsDb.updateStatus).toHaveBeenCalledWith(9, 'completed');
  });

  it('mutes the push for automation-driven runs and keeps it for manual chats (policy 3)', async () => {
    setLinkedRuns([{ id: 2, agent_type: 'pr', status: 'running', conversation_id: 100, driver: 'automation' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, title: 'T', project_id: 1 } as never);

    await onTurnEnded(ctx());
    expect(notifyClaudeComplete).toHaveBeenCalledWith(
      1, 'T', 7, 100, 1,
      expect.objectContaining({ driver: 'automation' }),
    );

    // A conversation with no run behind it — a manual chat, even on an
    // orchestrated ticket — notifies its human: the person asked directly.
    vi.clearAllMocks();
    setLinkedRuns([]);
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, title: 'T', project_id: 1 } as never);
    await onTurnEnded(ctx());
    expect(notifyClaudeComplete).toHaveBeenCalledWith(
      1, 'T', 7, 100, 1,
      expect.objectContaining({ driver: 'human', agentType: null }),
    );
  });
});

describe('task adapter resolveScope', () => {
  it('resolves a task to its worktree when one exists, else the repo checkout', async () => {
    const { getWorktreeProjectPath } = await import('../worktree.js');
    vi.mocked(tasksDb.getWithProject).mockReturnValue({
      id: 3,
      project_id: 7,
      repo_folder_path: '/repo',
      subproject_path: 'apps/web',
    } as never);
    vi.mocked(worktreeExists).mockResolvedValue(true);
    vi.mocked(getWorktreeProjectPath).mockReturnValue('/repo-worktrees/task-3/apps/web');

    const withWorktree = await taskOwnerAdapter.resolveScope({ kind: 'task', taskId: 3 });
    expect(withWorktree).toMatchObject({
      kind: 'task',
      taskId: 3,
      epicId: null,
      projectId: 7,
      cwd: '/repo-worktrees/task-3/apps/web',
    });

    vi.mocked(worktreeExists).mockResolvedValue(false);
    const withoutWorktree = await taskOwnerAdapter.resolveScope({ kind: 'task', taskId: 3 });
    expect(withoutWorktree.cwd).toBe('/repo');
  });

  it('throws for a missing task', async () => {
    vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);
    await expect(taskOwnerAdapter.resolveScope({ kind: 'task', taskId: 99 })).rejects.toThrow(
      /Task 99 not found/,
    );
  });
});

describe('task adapter surface', () => {
  it('question-parked is published for task conversations', () => {
    taskOwnerAdapter.onQuestionParked(
      { id: 100, task_id: 7, epic_id: null, owner_kind: 'task' } as never,
      [{ question: 'Which db?' }],
    );
    expect(emitTaskEvent).toHaveBeenCalledWith('question-parked', {
      taskId: 7,
      conversationId: 100,
      questions: [{ question: 'Which db?' }],
    });
  });

  it('sweepOrphans fails running task runs', () => {
    vi.mocked(taskAgentRunsDb.getByStatus).mockReturnValue([
      { id: 9, agent_type: 'implementation', task_id: 7, status: 'running' },
    ] as never);

    taskOwnerAdapter.sweepOrphans();

    expect(taskAgentRunsDb.updateStatus).toHaveBeenCalledWith(9, 'failed');
  });
});

// The non-technical sensitive-areas guardrail: a planning agent that escalated
// to a technical user blocked the workflow itself (block-workflow.ts) and wrote
// no plan. The turn end must announce that like any agent block and must never
// auto-chain into implementation — for either kind of actor.
describe('planification that blocked its own workflow (sensitive-areas escalation)', () => {
  const reason = 'Needs a technical user: the orders tables change';

  it.each([
    ['non-technical', 0],
    ['technical', 1],
  ])('announces the block and never auto-chains for a %s actor', async (_label, isTechnical) => {
    const c = ctx();
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'planification', status: 'running', driver: 'human' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({
      id: 7,
      workflow_run_count: 1,
      workflow_blocked: 1,
      workflow_blocked_reason: reason,
    } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({ repo_folder_path: '/r', user_id: 1 } as never);
    vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, is_technical: isTechnical } as never);

    await onTurnEnded(c);
    await vi.runAllTimersAsync();

    expect(taskAgentRunsDb.updateStatus).toHaveBeenCalledWith(9, 'completed');
    expect(
      (c as { broadcastToTaskSubscribersFn: ReturnType<typeof vi.fn> }).broadcastToTaskSubscribersFn,
    ).toHaveBeenCalledWith(7, { type: 'task-blocked', reason: 'agent_requested' });
    expect(emitTaskEvent).toHaveBeenCalledWith('workflow-blocked', {
      taskId: 7,
      reason: 'agent-requested',
      detail: reason,
    });
    expect(startAgentRun).not.toHaveBeenCalled();
  });

  it('an automation-driven planification returns to its driver first, without announcing', async () => {
    const c = ctx();
    setLinkedRuns([{ id: 9, conversation_id: 100, agent_type: 'planification', status: 'running', driver: 'automation' }]);
    vi.mocked(tasksDb.getById).mockReturnValue({
      id: 7,
      workflow_run_count: 1,
      workflow_blocked: 1,
      workflow_blocked_reason: reason,
    } as never);
    vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, is_technical: 0 } as never);

    await onTurnEnded(c);
    await vi.runAllTimersAsync();

    expect(
      (c as { broadcastToTaskSubscribersFn: ReturnType<typeof vi.fn> }).broadcastToTaskSubscribersFn,
    ).not.toHaveBeenCalledWith(7, expect.objectContaining({ type: 'task-blocked' }));
    expect(emitTaskEvent).not.toHaveBeenCalledWith('workflow-blocked', expect.anything());
    expect(startAgentRun).not.toHaveBeenCalled();
  });
});
