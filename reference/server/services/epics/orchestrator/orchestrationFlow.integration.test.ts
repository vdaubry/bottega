import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  epicRuns: [] as Array<Record<string, unknown>>,
  taskRuns: [] as Array<Record<string, unknown>>,
  activeSessions: new Map<string, unknown>(),
  pendingQuestions: new Map<number, unknown>(),
  getEpic: vi.fn(),
  setEpicActive: vi.fn(),
  getEpicTasks: vi.fn(),
  getTask: vi.fn(),
  updateTask: vi.fn(),
  getEpicRuns: vi.fn(),
  getTaskRuns: vi.fn(),
  getRun: vi.fn(),
  ticketEpicOf: vi.fn(),
  markPrAgentComplete: vi.fn(),
  startEpicAgent: vi.fn(),
  startTaskAgent: vi.fn(),
  getRunningEpicAgent: vi.fn(),
  sendMessage: vi.fn(),
  getPrStatus: vi.fn(),
  mergeAndCleanup: vi.fn(),
  createCompletionPr: vi.fn(),
  sendBanner: vi.fn(),
  writeOutcome: vi.fn(),
  landing: null as Record<string, unknown> | null,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: unknown) => Promise<unknown>,
  ) => ({ name, description, inputSchema, handler }),
}));

vi.mock('../../../database/epics.js', () => ({
  epicsDb: {
    getById: harness.getEpic,
    setOrchestrationActive: harness.setEpicActive,
  },
  epicTicketsDb: {
    listTickets: harness.getEpicTasks,
    epicOf: harness.ticketEpicOf,
    get: vi.fn(),
  },
  epicAgentRunsDb: {
    getByEpic: harness.getEpicRuns,
    getById: harness.getRun,
  },
}));

vi.mock('../../../database/tasks.js', () => ({
  tasksDb: {
    getById: harness.getTask,
    getWithProject: harness.getTask,
    update: harness.updateTask,
    markPrAgentComplete: harness.markPrAgentComplete,
    requestLanding: vi.fn((_taskId: number, identity: Record<string, unknown>) => {
      harness.landing = {
        task_id: 42,
        pr_url: identity.prUrl,
        head_branch: identity.headBranch,
        base_branch: identity.baseBranch,
        state: 'merge_requested',
        cleanup_state: 'pending',
      };
      return harness.landing;
    }),
    getLanding: vi.fn(() => harness.landing),
    finalizeLanding: vi.fn((_taskId: number, sha: string | null, mergedAt: string | null) => {
      const previousStatus = String(task.status);
      task.status = 'completed';
      task.pr_agent_complete = 1;
      Object.assign(harness.landing!, {
        state: 'merged',
        merge_commit_sha: sha,
        merged_at: mergedAt,
      });
      return { task: { ...task }, previousStatus, transitioned: previousStatus !== 'completed' };
    }),
    markLandingCleanup: vi.fn((_taskId: number, success: boolean, error?: string) => {
      Object.assign(harness.landing!, {
        cleanup_state: success ? 'completed' : 'failed',
        cleanup_error: error ?? null,
      });
      return harness.landing;
    }),
    listLandingsToReconcile: vi.fn(() => []),
  },
  taskAgentRunsDb: {
    getByTask: harness.getTaskRuns,
    getByStatus: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../../../database/db.js', () => ({
  db: {},
  userDb: { getUserById: vi.fn() },
}));

vi.mock('../../conversation/sessionState.js', () => ({
  activeSessions: harness.activeSessions,
  pendingAskUserQuestions: harness.pendingQuestions,
}));

vi.mock('../epicAgentRunner.js', () => ({
  startEpicAgentRun: harness.startEpicAgent,
  getRunningAgentForEpic: harness.getRunningEpicAgent,
  getActivePrReviewerForEpic: () =>
    harness.epicRuns.find(
      (run) =>
        run.agent_type === 'epic-pr-review' &&
        (run.status === 'running' || run.status === 'blocked'),
    ) ?? null,
  EpicPrReviewerConflictError: class EpicPrReviewerConflictError extends Error {},
}));

vi.mock('../../agentRunner.js', () => ({
  startAgentRun: harness.startTaskAgent,
  getRunningAgentForTask: () =>
    harness.taskRuns.find((run) => run.status === 'running') ?? null,
  BaseSyncConflictError: class BaseSyncConflictError extends Error {},
}));

// The facade re-exports taskService whose own import graph reaches the
// transcript store; irrelevant to this seam.
vi.mock('../../taskService.js', () => ({
  createTaskWithWorktree: vi.fn(),
  deleteTaskCompletely: vi.fn(),
  getAllTasks: vi.fn(),
  getTask: vi.fn(),
  hasTaskAccess: vi.fn(),
}));

vi.mock('../../conversation/startConversation.js', () => ({ sendMessage: harness.sendMessage }));
vi.mock('../../worktree.js', () => ({
  getPullRequestStatus: harness.getPrStatus,
  getPullRequestStatusByUrl: harness.getPrStatus,
  getWorktreeProjectPath: (repo: string, id: number) => `${repo}-worktrees/task-${id}`,
  getWorktreePath: (repo: string, id: number) => `${repo}-worktrees/task-${id}`,
  getBranchName: vi.fn().mockResolvedValue('task/42-pricing'),
  mergePullRequest: vi.fn().mockResolvedValue({
    success: true,
    exists: true,
    state: 'MERGED',
    merged: true,
    mergeCommitSha: 'abc123',
    mergedAt: '2026-08-24T12:00:00Z',
  }),
  cleanupMergedWorktree: vi.fn().mockResolvedValue({ success: true }),
  mergeAndCleanup: harness.mergeAndCleanup,
  worktreeExists: vi.fn().mockResolvedValue(true),
}));
vi.mock('../epicBranch.js', () => ({
  createEpicCompletionPR: harness.createCompletionPr,
}));
vi.mock('../../tasks/baseBranch.js', () => ({
  resolveBaseBranch: vi.fn().mockResolvedValue('epic/7-nimbus-pricing'),
}));
vi.mock('../../documentation.js', () => ({
  readTaskDoc: vi.fn().mockReturnValue('# Plan'),
  writeTaskDoc: vi.fn(),
}));

vi.mock('../epicArchive.js', () => ({
  writeEpicTaskOutcome: harness.writeOutcome,
}));
vi.mock('../../epicEvents.js', () => ({ broadcastEpicUpdated: vi.fn() }));
vi.mock('../../notifications.js', () => ({
  sendBannerNotification: harness.sendBanner,
  notifyTaskStatusChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./blocking.js', () => ({
  blockOrchestration: vi.fn(),
  resumeOrchestration: vi.fn().mockReturnValue(null),
}));
vi.mock('../../conversation/askUserQuestion.js', () => ({ resolveAskUserQuestion: vi.fn() }));
vi.mock('../../shell.js', () => ({ runCommand: vi.fn() }));
vi.mock('../../conversation/sessionControl.js', () => ({
  clearStreamingSessionsForTask: vi.fn().mockReturnValue([]),
}));

import { buildOrchestratorTools } from '../bottega/tools/orchestrator.js';
import { buildPrReviewTools } from '../bottega/tools/prReview.js';
import { _resetBridgeState, onPrReviewTurnEnded } from './bridge.js';
import { advance, schedulePrReview } from './sequencing.js';
import { emitTaskEvent, _resetTaskEventListeners } from '../../tasks/events.js';
import { registerEpicTaskEventSubscriber } from '../taskEventSubscriber.js';

interface CapturedTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

let epic: Record<string, unknown>;
let task: Record<string, unknown>;

function tools(): Record<string, CapturedTool> {
  const built = buildOrchestratorTools({
    epicId: 7,
    ticketTaskId: 42,
    userId: 4,
  }) as CapturedTool[];
  return Object.fromEntries(built.map((entry) => [entry.name, entry]));
}

function reviewerTools(): Record<string, CapturedTool> {
  const built = buildPrReviewTools({
    epicId: 7,
    ticketTaskId: 42,
    userId: 4,
  }) as CapturedTool[];
  return Object.fromEntries(built.map((entry) => [entry.name, entry]));
}

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetBridgeState();
  // The seam under test is the real event wiring: the task layer emits, the
  // epic subscriber (registered exactly as initEpics does it) reacts.
  _resetTaskEventListeners();
  registerEpicTaskEventSubscriber();
  harness.epicRuns.length = 0;
  harness.taskRuns.length = 0;
  harness.activeSessions.clear();
  harness.pendingQuestions.clear();
  harness.landing = null;

  epic = {
    id: 7,
    project_id: 3,
    user_id: 4,
    name: 'Nimbus Pricing',
    status: 'active',
    feature_branch: 'epic/7-nimbus-pricing',
    orchestration_active: 1,
    orchestration_blocked: 0,
  };
  task = {
    id: 42,
    project_id: 3,
    epic_id: 7,
    epic_order: 1,
    title: 'Implement pricing',
    status: 'pending',
    repo_folder_path: '/repos/nimbus',
    subproject_path: null,
    planification_complete: 0,
    workflow_complete: 0,
    workflow_blocked: 0,
    refinement_complete: 0,
    pr_agent_complete: 0,
    workflow_run_count: 0,
  };

  harness.getEpic.mockImplementation(() => epic);
  harness.setEpicActive.mockImplementation((_id: number, active: boolean) => {
    epic.orchestration_active = active ? 1 : 0;
    epic.orchestration_blocked = 0;
    return { ...epic };
  });
  harness.getEpicTasks.mockImplementation(() => [task]);
  harness.getTask.mockImplementation(() => task);
  harness.updateTask.mockImplementation((_id: number, changes: Record<string, unknown>) => {
    Object.assign(task, changes);
    return { ...task };
  });
  harness.getEpicRuns.mockImplementation(() => harness.epicRuns);
  harness.getTaskRuns.mockImplementation(() => harness.taskRuns);
  harness.getRun.mockImplementation((id: number) =>
    [...harness.epicRuns, ...harness.taskRuns].find((r) => r.id === id),
  );
  harness.getRunningEpicAgent.mockReturnValue(null);
  harness.ticketEpicOf.mockReturnValue(7);
  harness.startEpicAgent.mockImplementation(async (_id: number, agentType: string) => {
    // The orchestrator is dormant between events (its row reads completed);
    // a reviewer is one long turn (its row reads running until it ends).
    const run = {
      id: 501 + harness.epicRuns.length,
      agent_type: agentType,
      status: agentType === 'epic-pr-review' ? 'running' : 'completed',
      conversation_id: 91 + harness.epicRuns.length,
      ticket_task_id: 42,
    };
    harness.epicRuns.push(run);
    return {
      agentRun: run,
      conversation: { id: run.conversation_id },
      claudeSessionId: 'epic-session',
    };
  });
  harness.startTaskAgent.mockImplementation(async (_id: number, agentType: string) => {
    const run = {
      id: 600 + harness.taskRuns.length,
      agent_type: agentType,
      status: 'completed',
      conversation_id: 101 + harness.taskRuns.length,
    };
    harness.taskRuns.push(run);
    return { agentRun: run, conversation: { id: run.conversation_id }, claudeSessionId: 'task' };
  });
  harness.sendMessage.mockResolvedValue(undefined);
  harness.getPrStatus.mockResolvedValue({
    success: true,
    exists: true,
    url: 'https://github.com/o/r/pull/42',
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    headBranch: 'task/42-pricing',
    baseBranch: 'epic/7-nimbus-pricing',
    ciStatus: { status: 'passed', checks: [] },
  });
  harness.mergeAndCleanup.mockResolvedValue({ success: true });
  harness.writeOutcome.mockReturnValue('/archive/outcomes/task-42.md');
  harness.createCompletionPr.mockResolvedValue({
    success: true,
    url: 'https://github.com/o/r/pull/99',
  });
  harness.sendBanner.mockResolvedValue(undefined);
});

describe('one-ticket orchestration seam', () => {
  it('drives planification, autonomous work, merge, event wakes, and final PR completion', async () => {
    await advance(7);
    expect(harness.startEpicAgent).toHaveBeenCalledWith(
      7,
      'epic-orchestrator',
      expect.objectContaining({ ticketTaskId: 42 }),
    );

    const orchestrator = tools();
    const planStart = await orchestrator.start_planification!.handler({ taskId: 42 });
    expect(planStart.isError).toBeUndefined();
    expect(harness.startTaskAgent).toHaveBeenLastCalledWith(
      42,
      'planification',
      expect.objectContaining({ driver: 'automation' }),
    );

    task.planification_complete = 1;
    // What the completion handler publishes when the planification turn ends
    // — the subscriber turns it into a bridge wake.
    emitTaskEvent('run-ended', {
      taskId: 42,
      runId: 600,
      agentType: 'planification',
      driver: 'automation',
      status: 'completed',
      conversationId: 101,
    });
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1));
    expect(harness.sendMessage.mock.calls[0]![1]).toContain(
      '[bottega-event] type=planification-turn-ended',
    );

    const approval = await orchestrator.approve_plan_and_start_implementation!.handler({
      taskId: 42,
    });
    expect(approval.isError).toBeUndefined();
    expect(harness.startTaskAgent).toHaveBeenLastCalledWith(
      42,
      'implementation',
      expect.anything(),
    );

    task.status = 'in_review';
    task.workflow_complete = 1;
    task.refinement_complete = 1;
    task.pr_agent_complete = 1;

    // The PR agent ended: through the event stream the server hands the pull
    // request to the reviewer — a fresh epic run in the ticket's worktree —
    // and the orchestrator is NOT woken for it.
    emitTaskEvent('run-ended', {
      taskId: 42,
      runId: 601,
      agentType: 'pr',
      driver: 'automation',
      status: 'completed',
      conversationId: 102,
    });
    await vi.waitFor(
      () =>
        expect(harness.startEpicAgent).toHaveBeenLastCalledWith(
          7,
          'epic-pr-review',
          expect.objectContaining({ ticketTaskId: 42, userId: 4 }),
        ),
      { timeout: 3000 },
    );
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    const reviewRun = harness.epicRuns.find((r) => r.agent_type === 'epic-pr-review')!;
    expect(reviewRun.status).toBe('running');

    // A second hand-off while the review is in flight is refused silently by
    // the epic-domain reviewer singleton.
    schedulePrReview(7, 42, { id: 602, agent_type: 'pr', status: 'completed' }, 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.startEpicAgent).toHaveBeenCalledTimes(2);
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);

    // The orchestrator can see the review from its own tools, and cannot merge.
    const progress = await orchestrator.get_task_progress!.handler({ taskId: 42 });
    expect(JSON.parse(resultText(progress)).prReview).toEqual(
      expect.objectContaining({ runId: reviewRun.id, status: 'running' }),
    );
    expect(orchestrator.merge_task).toBeUndefined();

    // The reviewer merges through its own catalog.
    const merge = await reviewerTools().merge_task!.handler({
      taskId: 42,
      outcomeSummary: 'Pricing landed and exports monthlyCost.',
    });
    expect(merge.isError).toBeUndefined();
    expect(resultText(merge)).toMatch(/final ticket/i);
    expect(task.status).toBe('completed');
    expect(harness.writeOutcome).toHaveBeenCalledWith(3, 7, 42, expect.stringContaining('monthlyCost'));

    // Its turn ends on a merged ticket: the sequencer finishes the epic —
    // final PR opened and the user told, with no orchestrator turn involved.
    reviewRun.status = 'completed';
    await advance(7);
    expect(epic.orchestration_active).toBe(0);
    expect(harness.createCompletionPr).toHaveBeenCalledTimes(1);
    expect(harness.sendBanner).toHaveBeenCalledWith(
      4,
      expect.stringMatching(/implementation complete/i),
      expect.stringContaining('https://github.com/o/r/pull/99'),
      expect.anything(),
    );
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('wakes the orchestrator when a review ends without merging, and lets it retry once', async () => {
    await advance(7);
    task.status = 'in_review';
    task.pr_agent_complete = 1;

    schedulePrReview(7, 42, { id: 601, agent_type: 'pr', status: 'completed' }, 0);
    await vi.waitFor(() => expect(harness.startEpicAgent).toHaveBeenCalledTimes(2));
    const firstReview = harness.epicRuns.find((r) => r.agent_type === 'epic-pr-review')!;

    // The reviewer's turn ends with the ticket still open (it died, or gave up
    // without blocking): the orchestrator hears about it.
    firstReview.status = 'failed';
    await onPrReviewTurnEnded(7, firstReview as never);
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1));
    const wake = harness.sendMessage.mock.calls[0]![1] as string;
    expect(wake).toContain('[bottega-event] type=pr-review-ended');
    expect(wake).toContain('status=failed');
    expect(wake).toContain('start_pr_review');

    // Its retry starts a second reviewer on the same ticket.
    const retry = await tools().start_pr_review!.handler({ taskId: 42 });
    expect(retry.isError).toBeUndefined();
    expect(harness.startEpicAgent).toHaveBeenCalledTimes(3);
    expect(harness.startEpicAgent).toHaveBeenLastCalledWith(
      7,
      'epic-pr-review',
      expect.objectContaining({ ticketTaskId: 42 }),
    );
  });

  it('wakes the orchestrator with a pr-turn-ended when there is nothing to review', async () => {
    await advance(7);
    task.status = 'in_review';
    harness.getPrStatus.mockResolvedValue({ exists: false });

    schedulePrReview(7, 42, { id: 601, agent_type: 'pr', status: 'completed' }, 0);
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1));
    const wake = harness.sendMessage.mock.calls[0]![1] as string;
    expect(wake).toContain('[bottega-event] type=pr-turn-ended');
    expect(wake).toContain('has no pull request');
    expect(wake).toContain('block_epic');
    expect(harness.startEpicAgent).toHaveBeenCalledTimes(1);
  });
});
