import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockEpicGetById,
  mockSetActive,
  mockTasksGetByEpic,
  mockTasksGetWithProject,
  mockStartEpicAgentRun,
  mockGetRunningAgentForEpic,
  mockGetActivePrReviewerForEpic,
  mockRunsGetByTask,
  mockWorktreeExists,
  mockPrStatus,
  mockCurrentRun,
  mockNotifyOrchestrator,
  mockBroadcastEpicUpdated,
  mockSendBanner,
  mockCreateEpicCompletionPR,
  mockBlockOrchestration,
} = vi.hoisted(() => ({
  mockEpicGetById: vi.fn(),
  mockSetActive: vi.fn(),
  mockTasksGetByEpic: vi.fn(),
  mockTasksGetWithProject: vi.fn(),
  mockStartEpicAgentRun: vi.fn(),
  mockGetRunningAgentForEpic: vi.fn(),
  mockGetActivePrReviewerForEpic: vi.fn(),
  mockRunsGetByTask: vi.fn(),
  mockWorktreeExists: vi.fn(),
  mockPrStatus: vi.fn(),
  mockCurrentRun: vi.fn(),
  mockNotifyOrchestrator: vi.fn(),
  mockBroadcastEpicUpdated: vi.fn(),
  mockSendBanner: vi.fn(),
  mockCreateEpicCompletionPR: vi.fn(),
  mockBlockOrchestration: vi.fn(),
}));

vi.mock('../../../database/epics.js', () => ({
  epicsDb: { getById: mockEpicGetById, setOrchestrationActive: mockSetActive },
  epicTicketsDb: {
    listTickets: mockTasksGetByEpic,
    epicOf: (taskId: number) => {
      const task = mockTasksGetWithProject(taskId) as { epic_id?: number | null } | undefined;
      return task?.epic_id ?? null;
    },
  },
}));

vi.mock('../../../database/tasks.js', () => ({
  tasksDb: {
    getWithProject: mockTasksGetWithProject,
  },
  taskAgentRunsDb: { getByTask: mockRunsGetByTask },
}));

vi.mock('../../worktree.js', () => ({
  getPullRequestStatus: mockPrStatus,
  worktreeExists: mockWorktreeExists,
}));

vi.mock('../epicEvents.js', () => ({ broadcastEpicUpdated: mockBroadcastEpicUpdated }));

vi.mock('./bridge.js', () => ({
  currentOrchestratorRun: mockCurrentRun,
  getBridgeBroadcasters: () => ({ broadcastFn: 'bf' }),
  notifyOrchestrator: mockNotifyOrchestrator,
}));

vi.mock('../epicAgentRunner.js', () => ({
  startEpicAgentRun: mockStartEpicAgentRun,
  getRunningAgentForEpic: mockGetRunningAgentForEpic,
  getActivePrReviewerForEpic: mockGetActivePrReviewerForEpic,
  EpicPrReviewerConflictError: class EpicPrReviewerConflictError extends Error {},
}));

vi.mock('../../notifications.js', () => ({ sendBannerNotification: mockSendBanner }));
vi.mock('./blocking.js', () => ({ blockOrchestration: mockBlockOrchestration }));

vi.mock('../epicBranch.js', () => ({ createEpicCompletionPR: mockCreateEpicCompletionPR }));

// The task facade over the same fixtures.
vi.mock('../../tasks/index.js', () => {
  return {
    getRunningAgentForTask: (taskId: number) =>
      (mockRunsGetByTask(taskId) as Array<{ status: string }>).find(
        (run) => run.status === 'running',
      ) ?? null,
    taskFlags: (taskId: number) => {
      const task = mockTasksGetWithProject(taskId) as Record<string, unknown> | undefined;
      if (!task) return null;
      return {
        status: task.status,
        planificationComplete: !!task.planification_complete,
        workflowComplete: !!task.workflow_complete,
        workflowBlocked: !!task.workflow_blocked,
        refinementComplete: !!task.refinement_complete,
        prAgentComplete: !!task.pr_agent_complete,
        runCount: task.workflow_run_count,
        worktreeState: task.worktree_state ?? 'ready',
        worktreeError: task.worktree_error ?? null,
      };
    },
    taskProgress: async (taskId: number) => {
      const task = mockTasksGetWithProject(taskId) as Record<string, unknown> | undefined;
      if (!task) return null;
      const hasWorktree = await mockWorktreeExists(task.repo_folder_path, taskId);
      const pr = (await mockPrStatus(task.repo_folder_path, taskId)) as Record<string, unknown>;
      return {
        taskId,
        title: task.title,
        status: task.status,
        worktreePath: hasWorktree ? `${task.repo_folder_path}-worktrees/task-${taskId}` : null,
        latestRuns: {},
        pullRequest: pr?.exists
          ? {
              url: pr.url,
              state: pr.state,
              mergeable: pr.mergeable,
              ci: (pr.ciStatus as { status?: string } | undefined)?.status ?? 'none',
            }
          : null,
      };
    },
  };
});

import {
  advance,
  nextTicket,
  scheduleNextTicket,
  schedulePrReview,
  startPrReview,
  wakeOrchestrator,
} from './sequencing.js';

const ORCHESTRATING = {
  id: 7,
  name: 'Nimbus Pricing',
  project_id: 3,
  user_id: 4,
  orchestration_active: 1,
  orchestration_blocked: 0,
};

function ticket(id: number, status = 'pending', order = id) {
  return { id, epic_id: 7, epic_order: order, status, title: `T${id}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEpicGetById.mockReturnValue({ ...ORCHESTRATING });
  mockTasksGetByEpic.mockReturnValue([]);
  mockGetRunningAgentForEpic.mockReturnValue(null);
  mockGetActivePrReviewerForEpic.mockReturnValue(null);
  mockRunsGetByTask.mockReturnValue([]);
  mockTasksGetWithProject.mockImplementation((id: number) => ({
    ...ticket(id, 'in_review'),
    project_id: 3,
    repo_folder_path: '/repos/nimbus',
  }));
  mockWorktreeExists.mockResolvedValue(true);
  mockPrStatus.mockResolvedValue({ exists: true, url: 'https://pr/42', state: 'OPEN' });
  mockStartEpicAgentRun.mockResolvedValue({
    agentRun: { id: 900 },
    conversation: { id: 120 },
  });
  mockCurrentRun.mockReturnValue(null);
  mockSetActive.mockReturnValue({ ...ORCHESTRATING, orchestration_active: 0 });
  mockSendBanner.mockResolvedValue(undefined);
  mockCreateEpicCompletionPR.mockResolvedValue({ success: true, url: 'https://pr/epic-7' });
});

describe('nextTicket', () => {
  it('is the first ticket that has not merged', () => {
    mockTasksGetByEpic.mockReturnValue([
      ticket(41, 'completed'),
      ticket(42, 'in_review'),
      ticket(43),
    ]);

    expect(nextTicket(7)?.id).toBe(42);
  });

  it('is null once every ticket has merged', () => {
    mockTasksGetByEpic.mockReturnValue([ticket(41, 'completed')]);

    expect(nextTicket(7)).toBeNull();
  });
});

describe('advance', () => {
  it('starts an orchestrator run on the first unmerged ticket', async () => {
    mockTasksGetByEpic.mockReturnValue([ticket(41, 'completed'), ticket(42)]);

    await advance(7);

    expect(mockStartEpicAgentRun).toHaveBeenCalledWith(
      7,
      'epic-orchestrator',
      expect.objectContaining({ ticketTaskId: 42, userId: 4 }),
    );
  });

  // A new ticket's worktree is set up in the background. The subscriber
  // re-advances when that setup ends.
  it('waits for a ticket whose worktree is still being set up', async () => {
    mockTasksGetByEpic.mockReturnValue([ticket(42)]);
    mockTasksGetWithProject.mockReturnValue({ id: 42, status: 'pending', worktree_state: 'provisioning' });

    await advance(7);

    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
    expect(mockBlockOrchestration).not.toHaveBeenCalled();
  });

  it('pauses the epic on a ticket whose worktree setup failed — only a human can retry it', async () => {
    mockTasksGetByEpic.mockReturnValue([ticket(42)]);
    mockTasksGetWithProject.mockReturnValue({
      id: 42,
      status: 'pending',
      worktree_state: 'failed',
      worktree_error: 'hook exited with code 1',
    });

    await advance(7);

    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
    expect(mockBlockOrchestration).toHaveBeenCalledWith(
      7,
      expect.stringContaining('worktree setup of ticket 42 failed'),
      expect.objectContaining({ userId: 4 }),
    );
  });

  it('does nothing while the current conversation is already on that ticket', async () => {
    // The resting state between events: idle is not the same as finished.
    mockTasksGetByEpic.mockReturnValue([ticket(42)]);
    mockCurrentRun.mockReturnValue({ id: 55, conversation_id: 91, ticket_task_id: 42 });

    await advance(7);

    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
  });

  it('hops to the next ticket once the current one merged', async () => {
    mockTasksGetByEpic.mockReturnValue([ticket(41, 'completed'), ticket(42)]);
    mockCurrentRun.mockReturnValue({ id: 55, conversation_id: 91, ticket_task_id: 41 });

    await advance(7);

    expect(mockStartEpicAgentRun).toHaveBeenCalledWith(
      7,
      'epic-orchestrator',
      expect.objectContaining({ ticketTaskId: 42 }),
    );
  });

  it('yields while an epic run is already streaming — one at a time', async () => {
    mockTasksGetByEpic.mockReturnValue([ticket(42)]);
    mockGetRunningAgentForEpic.mockReturnValue({ id: 55, status: 'running' });

    await advance(7);

    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
  });

  it('does nothing for an epic that is not orchestrated', async () => {
    mockEpicGetById.mockReturnValue({ ...ORCHESTRATING, orchestration_active: 0 });
    mockTasksGetByEpic.mockReturnValue([ticket(42)]);

    await advance(7);

    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
  });

  it('does nothing while the epic is blocked', async () => {
    mockEpicGetById.mockReturnValue({ ...ORCHESTRATING, orchestration_blocked: 1 });
    mockTasksGetByEpic.mockReturnValue([ticket(42)]);

    await advance(7);

    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
  });
});

describe('finishing', () => {
  beforeEach(() => {
    mockTasksGetByEpic.mockReturnValue([ticket(41, 'completed'), ticket(42, 'completed')]);
  });

  it('leaves orchestration and announces the row change', async () => {
    await advance(7);

    expect(mockSetActive).toHaveBeenCalledWith(7, false);
    expect(mockBroadcastEpicUpdated).toHaveBeenCalled();
    expect(mockCreateEpicCompletionPR).toHaveBeenCalledWith(7);
    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
  });

  it('tells the user the final pull request is theirs to merge', async () => {
    await advance(7);

    expect(mockSendBanner).toHaveBeenCalledWith(
      4,
      expect.stringMatching(/implementation complete/i),
      expect.stringContaining('https://pr/epic-7'),
      expect.anything(),
    );
  });

  it('tells the user how to retry when automatic PR creation fails', async () => {
    mockCreateEpicCompletionPR.mockResolvedValue({ success: false, error: 'GitHub auth expired' });

    await advance(7);

    expect(mockSendBanner).toHaveBeenCalledWith(
      4,
      expect.stringMatching(/implementation complete/i),
      expect.stringMatching(/Open final PR.*retry/i),
      expect.anything(),
    );
  });

  it('does NOT flip the epic status — merging the final PR is a human act', async () => {
    await advance(7);

    expect(mockSetActive).toHaveBeenCalledTimes(1);
  });
});

describe('wakeOrchestrator', () => {
  it('hands the orchestrator a snapshot rather than a replay', () => {
    mockCurrentRun.mockReturnValue({ id: 55, conversation_id: 91, ticket_task_id: 42 });

    wakeOrchestrator(7, 'server-restarted');

    expect(mockNotifyOrchestrator).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'server-restarted',
        taskId: 42,
        payload: expect.stringMatching(/re-read the current state/i),
      }),
    );
  });

  it('says so differently when the user resumed by hand', () => {
    mockCurrentRun.mockReturnValue({ id: 55, conversation_id: 91, ticket_task_id: 42 });

    wakeOrchestrator(7, 'resumed');

    expect(mockNotifyOrchestrator).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ payload: expect.stringMatching(/has resumed it/) }),
    );
  });

  it('starts a run instead when there is no conversation to wake', async () => {
    vi.useFakeTimers();
    mockCurrentRun.mockReturnValue(null);
    mockTasksGetByEpic.mockReturnValue([ticket(42)]);

    wakeOrchestrator(7, 'resumed');
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    expect(mockNotifyOrchestrator).not.toHaveBeenCalled();
    expect(mockStartEpicAgentRun).toHaveBeenCalledWith(
      7,
      'epic-orchestrator',
      expect.objectContaining({ ticketTaskId: 42 }),
    );
  });
});

describe('scheduleNextTicket', () => {
  it('re-reads the world after a settle delay, like the task chaining does', async () => {
    vi.useFakeTimers();
    mockTasksGetByEpic.mockReturnValue([ticket(42)]);

    scheduleNextTicket(7);
    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    vi.useRealTimers();

    expect(mockStartEpicAgentRun).toHaveBeenCalled();
  });
});

describe('startPrReview', () => {
  it('starts a reviewer run on the ticket, in its worktree, with the bridge broadcasters', async () => {
    const result = await startPrReview(7, 42);

    expect(result).toEqual({ started: true, runId: 900, conversationId: 120 });
    expect(mockStartEpicAgentRun).toHaveBeenCalledWith(
      7,
      'epic-pr-review',
      expect.objectContaining({ ticketTaskId: 42, userId: 4, broadcastFn: 'bf' }),
    );
  });

  it('refuses when the epic is not orchestrated or is paused', async () => {
    mockEpicGetById.mockReturnValue({ ...ORCHESTRATING, orchestration_active: 0 });
    expect(await startPrReview(7, 42)).toMatchObject({ started: false, reason: /not being orchestrated/ });

    mockEpicGetById.mockReturnValue({ ...ORCHESTRATING, orchestration_blocked: 1 });
    expect(await startPrReview(7, 42)).toMatchObject({ started: false, reason: /paused/ });

    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
  });

  it("refuses another epic's ticket and a ticket already merged", async () => {
    mockTasksGetWithProject.mockReturnValue({ ...ticket(42), epic_id: 8 });
    expect(await startPrReview(7, 42)).toMatchObject({ started: false, reason: /not a ticket of epic 7/ });

    mockTasksGetWithProject.mockReturnValue({ ...ticket(42, 'completed'), repo_folder_path: '/r' });
    expect(await startPrReview(7, 42)).toMatchObject({ started: false, reason: /already merged/ });

    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
  });

  it('refuses an active reviewer, but not the orchestrator own turn', async () => {
    mockGetActivePrReviewerForEpic.mockReturnValue({
      id: 91,
      agent_type: 'epic-pr-review',
      status: 'blocked',
    });
    expect(await startPrReview(7, 42)).toMatchObject({
      started: false,
      reason: /reviewer run 91 is blocked/i,
    });

    mockGetActivePrReviewerForEpic.mockReturnValue(null);
    mockGetRunningAgentForEpic.mockReturnValue({ id: 78, agent_type: 'epic-orchestrator' });
    expect(await startPrReview(7, 42)).toMatchObject({ started: true });
  });

  it('refuses while a task agent is still running on the ticket', async () => {
    mockRunsGetByTask.mockReturnValue([{ id: 610, agent_type: 'pr', status: 'running' }]);

    expect(await startPrReview(7, 42)).toMatchObject({
      started: false,
      reason: /pr agent \(run 610\) is running/,
    });
    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
  });

  it('says there is nothing to review when the worktree or an open pull request is missing', async () => {
    mockWorktreeExists.mockResolvedValue(false);
    expect(await startPrReview(7, 42)).toMatchObject({ started: false, noPullRequest: true, reason: /no worktree/ });

    mockWorktreeExists.mockResolvedValue(true);
    mockPrStatus.mockResolvedValue({ exists: false });
    expect(await startPrReview(7, 42)).toMatchObject({ started: false, noPullRequest: true, reason: /no pull request/ });

    mockPrStatus.mockResolvedValue({ exists: true, state: 'MERGED' });
    expect(await startPrReview(7, 42)).toMatchObject({ started: false, noPullRequest: true, reason: /MERGED, not open/ });

    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
  });
});

describe('schedulePrReview', () => {
  const prRun = { id: 601, agent_type: 'pr', status: 'completed' };

  it('hands the pull request to the reviewer after the settle delay, silently', async () => {
    schedulePrReview(7, 42, prRun, 0);
    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(mockStartEpicAgentRun).toHaveBeenCalledTimes(1));
    expect(mockNotifyOrchestrator).not.toHaveBeenCalled();
  });

  it('wakes the orchestrator with the reason when there is nothing to review', async () => {
    mockPrStatus.mockResolvedValue({ exists: false });

    schedulePrReview(7, 42, prRun, 0);

    await vi.waitFor(() => expect(mockNotifyOrchestrator).toHaveBeenCalledTimes(1));
    expect(mockNotifyOrchestrator).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'pr-turn-ended',
        taskId: 42,
        runId: 601,
        status: 'completed',
        payload: expect.stringMatching(/no pull request.*resume_ticket.*block_epic/s),
      }),
    );
    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
  });

  it('wakes the orchestrator when starting the reviewer throws, so it can retry', async () => {
    mockStartEpicAgentRun.mockRejectedValue(new Error('no credentials'));

    schedulePrReview(7, 42, prRun, 0);

    await vi.waitFor(() => expect(mockNotifyOrchestrator).toHaveBeenCalledTimes(1));
    expect(mockNotifyOrchestrator).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'pr-turn-ended',
        payload: expect.stringMatching(/no credentials.*start_pr_review/s),
      }),
    );
  });

  it('stays silent on an ordinary refusal — a review already in flight is not news', async () => {
    mockGetActivePrReviewerForEpic.mockReturnValue({
      id: 91,
      agent_type: 'epic-pr-review',
      status: 'running',
    });

    schedulePrReview(7, 42, prRun, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
    expect(mockNotifyOrchestrator).not.toHaveBeenCalled();
  });
});
