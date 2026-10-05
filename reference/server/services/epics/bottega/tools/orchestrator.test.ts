import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockEpicGetById,
  mockSetBlocked,
  mockTasksGetByEpic,
  mockTasksGetById,
  mockTasksGetWithProject,
  mockRunsGetByTask,
  mockRunsGetByEpic,
  mockStartPrReview,
  mockStartAgentRun,
  mockUnblockTask,
  mockGetRunningAgentForTask,
  mockSendMessage,
  mockResolveQuestion,
  mockPrStatus,
  mockWorktreeExists,
  mockReadTaskDoc,
  mockCompletionPR,
  mockBlockOrchestration,
  mockResumeOrchestration,
  mockSendBanner,
  pendingQuestions,
} = vi.hoisted(() => ({
  mockEpicGetById: vi.fn(),
  mockSetBlocked: vi.fn(),
  mockTasksGetByEpic: vi.fn(),
  mockTasksGetById: vi.fn(),
  mockTasksGetWithProject: vi.fn(),
  mockTasksUpdate: vi.fn(),
  mockRunsGetByTask: vi.fn(),
  mockRunsGetByEpic: vi.fn(),
  mockStartPrReview: vi.fn(),
  mockStartAgentRun: vi.fn(),
  mockUnblockTask: vi.fn(),
  mockGetRunningAgentForTask: vi.fn(),
  mockSendMessage: vi.fn(),
  mockResolveQuestion: vi.fn(),
  mockPrStatus: vi.fn(),
  mockWorktreeExists: vi.fn(),
  mockReadTaskDoc: vi.fn(),
  mockCompletionPR: vi.fn(),
  mockBlockOrchestration: vi.fn(),
  mockResumeOrchestration: vi.fn(),
  mockSendBanner: vi.fn(),
  pendingQuestions: new Map<number, unknown>(),
}));

// Same capture harness as the other tool suites: `tool()` is a definition
// builder, so what we exercise here is our handlers.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: unknown) => Promise<unknown>,
  ) => ({ name, description, inputSchema, handler }),
}));

vi.mock('../../../../database/epics.js', () => ({
  epicsDb: { getById: mockEpicGetById, setOrchestrationBlocked: mockSetBlocked },
  epicTicketsDb: {
    listTickets: mockTasksGetByEpic,
    epicOf: (taskId: number) => {
      const task = (mockTasksGetWithProject(taskId) ?? mockTasksGetById(taskId)) as
        | { epic_id?: number | null }
        | undefined;
      return task?.epic_id ?? null;
    },
    get: vi.fn(),
  },
  epicAgentRunsDb: { getByEpic: mockRunsGetByEpic },
}));

// The task facade — every ticket act goes through it (the MCP rule). Its
// query surface is derived from the same task/run fixtures the direct reads
// used, so the tests keep their vocabulary.
vi.mock('../../../tasks/index.js', () => {
  const flagsOf = (taskId: number) => {
    const task = mockTasksGetWithProject(taskId) as Record<string, unknown> | undefined;
    if (!task) return null;
    return {
      status: task.status,
      planificationComplete: !!task.planification_complete,
      workflowComplete: !!task.workflow_complete,
      workflowBlocked: !!task.workflow_blocked,
      workflowBlockedReason: (task.workflow_blocked_reason as string | null) ?? null,
      refinementComplete: !!task.refinement_complete,
      prAgentComplete: !!task.pr_agent_complete,
      runCount: task.workflow_run_count,
      worktreeState: (task.worktree_state as string | undefined) ?? 'ready',
      worktreeError: (task.worktree_error as string | null | undefined) ?? null,
    };
  };
  const runsOf = (taskId: number) =>
    ((mockRunsGetByTask(taskId) ?? []) as Array<Record<string, unknown>>);
  return {
    startAgentRun: mockStartAgentRun,
    getRunningAgentForTask: mockGetRunningAgentForTask,
    unblockTask: mockUnblockTask,
    getTask: (taskId: number) => mockTasksGetWithProject(taskId) ?? null,
    readTaskDoc: mockReadTaskDoc,
    taskFlags: flagsOf,
    latestRunsByType: (taskId: number) => {
      const latest: Record<string, unknown> = {};
      for (const run of runsOf(taskId).slice().sort((a, b) => (a.id as number) - (b.id as number))) {
        latest[run.agent_type as string] = {
          runId: run.id,
          status: run.status,
          conversationId: run.conversation_id,
        };
      }
      return latest;
    },
    latestRunWithConversation: (taskId: number, agentType?: string) =>
      runsOf(taskId)
        .filter(
          (r) =>
            r.conversation_id != null && (agentType === undefined || r.agent_type === agentType),
        )
        .sort((a, b) => (b.id as number) - (a.id as number))[0] ?? null,
    pendingQuestion: (taskId: number) => {
      for (const run of runsOf(taskId).sort((a, b) => (b.id as number) - (a.id as number))) {
        if (run.conversation_id == null) continue;
        const entry = pendingQuestions.get(run.conversation_id as number) as
          | { questions: unknown[] }
          | undefined;
        if (entry) {
          return {
            agentType: run.agent_type,
            conversationId: run.conversation_id,
            questions: entry.questions,
          };
        }
      }
      return null;
    },
    taskProgress: async (taskId: number) => {
      const task = mockTasksGetWithProject(taskId) as Record<string, unknown> | undefined;
      const flags = flagsOf(taskId);
      if (!task || !flags) return null;
      const pr = (await mockPrStatus(task.repo_folder_path, taskId)) as Record<string, unknown>;
      const hasWorktree = await mockWorktreeExists(task.repo_folder_path, taskId);
      return {
        taskId,
        title: task.title,
        ...flags,
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

vi.mock('../../../conversation/sessionState.js', () => ({
  pendingAskUserQuestions: pendingQuestions,
}));

vi.mock('../../../worktree.js', () => ({
  getPullRequestStatus: mockPrStatus,
  getWorktreeProjectPath: (repo: string, id: number) => `${repo}-worktrees/task-${id}`,
  worktreeExists: mockWorktreeExists,
}));

vi.mock('../../epicBranch.js', () => ({
  createEpicCompletionPR: mockCompletionPR,
}));

vi.mock('../../orchestrator/blocking.js', () => ({
  blockOrchestration: mockBlockOrchestration,
  resumeOrchestration: mockResumeOrchestration,
}));

vi.mock('../../../conversation/startConversation.js', () => ({ sendMessage: mockSendMessage }));

vi.mock('../../../conversation/askUserQuestion.js', () => ({
  resolveAskUserQuestion: mockResolveQuestion,
}));

vi.mock('../../../notifications.js', () => ({ sendBannerNotification: mockSendBanner }));

vi.mock('../../orchestrator/sequencing.js', () => ({ startPrReview: mockStartPrReview }));

import { buildOrchestratorTools } from './orchestrator.js';

interface CapturedTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

const EPIC = { id: 7, project_id: 3, user_id: 4, name: 'Nimbus Pricing', status: 'active' };

/** A ticket of epic 7 with its project joined in, as `getWithProject` returns. */
function ticket(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    project_id: 3,
    epic_id: 7,
    epic_order: 1,
    title: `T${id}`,
    status: 'in_progress',
    repo_folder_path: '/repos/nimbus',
    subproject_path: null,
    planification_complete: 0,
    workflow_complete: 0,
    workflow_blocked: 0,
    workflow_blocked_reason: null,
    refinement_complete: 0,
    pr_agent_complete: 0,
    workflow_run_count: 3,
    ...overrides,
  };
}

function tools(ctxOverrides: Record<string, unknown> = {}): Record<string, CapturedTool> {
  const built = buildOrchestratorTools({
    epicId: 7,
    ticketTaskId: 42,
    userId: 1,
    ...ctxOverrides,
  }) as CapturedTool[];
  return Object.fromEntries(built.map((t) => [t.name, t]));
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

beforeEach(() => {
  vi.clearAllMocks();
  pendingQuestions.clear();
  mockEpicGetById.mockReturnValue({ ...EPIC });
  mockTasksGetByEpic.mockReturnValue([]);
  mockRunsGetByTask.mockReturnValue([]);
  mockRunsGetByEpic.mockReturnValue([]);
  mockGetRunningAgentForTask.mockReturnValue(null);
  mockTasksGetWithProject.mockImplementation((id: number) => ticket(id));
  mockWorktreeExists.mockResolvedValue(true);
  mockPrStatus.mockResolvedValue({ exists: false });
  mockStartAgentRun.mockResolvedValue({ agentRun: { id: 101 } });
  mockUnblockTask.mockImplementation((id: number) => ({ taskId: id }));
  mockResumeOrchestration.mockReturnValue(null);
});

describe('epic ownership', () => {
  it('refuses a ticket that belongs to another epic', async () => {
    mockTasksGetWithProject.mockReturnValue(ticket(99, { epic_id: 8 }));

    const result = await tools().start_planification!.handler({ taskId: 99 });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/does not belong to this epic/);
    expect(mockStartAgentRun).not.toHaveBeenCalled();
  });

  it('refuses a ticket that does not exist', async () => {
    mockTasksGetWithProject.mockReturnValue(undefined);

    const result = await tools().get_task_progress!.handler({ taskId: 404 });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/does not exist/);
  });
});

describe('start_planification', () => {
  it('starts the run with the technical prompt variant forced', async () => {
    // The orchestrator reviews the plan itself, so the non-technical
    // auto-chain variant would be reviewing nothing.
    await tools().start_planification!.handler({ taskId: 42 });

    expect(mockStartAgentRun).toHaveBeenCalledWith(
      42,
      'planification',
      expect.objectContaining({ driver: 'automation' }),
    );
  });

  it('refuses while another agent is running on the ticket', async () => {
    mockGetRunningAgentForTask.mockReturnValue({
      id: 5,
      agent_type: 'implementation',
      status: 'running',
    });

    const result = await tools().start_planification!.handler({ taskId: 42 });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/busy: a implementation agent/);
    expect(mockStartAgentRun).not.toHaveBeenCalled();
  });

  it('refuses while the ticket\'s worktree is still being set up, and says a wake will come', async () => {
    mockTasksGetWithProject.mockReturnValue(ticket(42, { worktree_state: 'provisioning' }));

    const result = await tools().start_planification!.handler({ taskId: 42 });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/busy: its worktree is still being set up\. End your turn/);
    expect(mockStartAgentRun).not.toHaveBeenCalled();
  });

  it('points at the finished plan instead of re-planning', async () => {
    mockTasksGetWithProject.mockReturnValue(ticket(42, { planification_complete: 1 }));

    const result = await tools().start_planification!.handler({ taskId: 42 });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/read_task_plan/);
  });
});

describe('questions', () => {
  it('reads the parked questions off the newest conversation holding them', async () => {
    mockRunsGetByTask.mockReturnValue([
      { id: 1, agent_type: 'planification', conversation_id: 90 },
      { id: 2, agent_type: 'planification', conversation_id: 91 },
    ]);
    pendingQuestions.set(91, { questions: [{ question: 'Currency?' }] });

    const result = await tools().get_pending_question!.handler({ taskId: 42 });

    expect(JSON.parse(text(result))).toMatchObject({
      taskId: 42,
      conversationId: 91,
      questions: [{ question: 'Currency?' }],
    });
  });

  it('says nothing is waiting rather than erroring', async () => {
    mockRunsGetByTask.mockReturnValue([
      { id: 1, agent_type: 'planification', conversation_id: 90 },
    ]);

    const result = await tools().get_pending_question!.handler({ taskId: 42 });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toMatch(/No agent on task 42 is waiting/);
  });

  it('answers through the same call the human widget makes', async () => {
    mockRunsGetByTask.mockReturnValue([
      { id: 2, agent_type: 'planification', conversation_id: 91 },
    ]);
    pendingQuestions.set(91, { questions: [] });
    mockResolveQuestion.mockResolvedValue({ kind: 'resolved' });

    await tools().answer_question!.handler({ taskId: 42, answers: { Currency: 'EUR' } });

    expect(mockResolveQuestion).toHaveBeenCalledWith(
      91,
      { Currency: 'EUR' },
      expect.objectContaining({ permissionMode: 'bypassPermissions' }),
    );
  });

  it('falls back to the newest conversation when nothing is parked in memory', async () => {
    // The restart path: the SDK process is gone, so `resolveAskUserQuestion`
    // recovers by injecting a synthetic tool_result.
    mockRunsGetByTask.mockReturnValue([
      { id: 3, agent_type: 'planification', conversation_id: 93 },
      { id: 2, agent_type: 'planification', conversation_id: 92 },
    ]);
    mockResolveQuestion.mockResolvedValue({ kind: 'recovered' });

    const result = await tools().answer_question!.handler({ taskId: 42, answers: {} });

    expect(mockResolveQuestion).toHaveBeenCalledWith(93, {}, expect.anything());
    expect(text(result)).toMatch(/recovered/);
  });
});

describe('plan review', () => {
  it('refuses to read a plan that does not exist yet', async () => {
    const result = await tools().read_task_plan!.handler({ taskId: 42 });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no finished plan/);
  });

  it('returns the ticket document once planification is complete', async () => {
    mockTasksGetWithProject.mockReturnValue(ticket(42, { planification_complete: 1 }));
    mockReadTaskDoc.mockReturnValue('## Goal\nShip the pricing module');

    expect(text(await tools().read_task_plan!.handler({ taskId: 42 }))).toContain('Ship the');
  });

  it('sends feedback as a plain message into the planification conversation', async () => {
    mockRunsGetByTask.mockReturnValue([
      { id: 2, agent_type: 'planification', conversation_id: 91 },
    ]);
    mockSendMessage.mockResolvedValue(undefined);

    await tools().send_feedback_to_planification!.handler({
      taskId: 42,
      message: 'Split step 3 in two.',
    });

    expect(mockSendMessage).toHaveBeenCalledWith(
      91,
      'Split step 3 in two.',
      expect.objectContaining({ permissionMode: 'bypassPermissions' }),
    );
  });

  it('refuses to approve a plan that was never written', async () => {
    const result = await tools().approve_plan_and_start_implementation!.handler({ taskId: 42 });

    expect(result.isError).toBe(true);
    expect(mockStartAgentRun).not.toHaveBeenCalled();
  });

  it('starts implementation once the plan is approved', async () => {
    mockTasksGetWithProject.mockReturnValue(ticket(42, { planification_complete: 1 }));

    await tools().approve_plan_and_start_implementation!.handler({ taskId: 42 });

    expect(mockStartAgentRun).toHaveBeenCalledWith(42, 'implementation', expect.anything());
  });
});

describe('resume_ticket', () => {
  const blocked = (overrides: Record<string, unknown> = {}) =>
    ticket(42, {
      workflow_blocked: 1,
      workflow_blocked_reason: 'No Playwright/browser connector, manual QA cannot run.',
      planification_complete: 1,
      ...overrides,
    });

  it('unblocks the ticket and restarts the chosen agent as automation', async () => {
    mockTasksGetWithProject.mockImplementation(() => blocked());

    const result = await tools().resume_ticket!.handler({ taskId: 42, agentType: 'review' });

    expect(mockUnblockTask).toHaveBeenCalledWith(42);
    expect(mockStartAgentRun).toHaveBeenCalledWith(
      42,
      'review',
      expect.objectContaining({ driver: 'automation' }),
    );
    // The orchestrator should hear what the block had been, so its turn can
    // say what it overruled.
    expect(text(result)).toMatch(/No Playwright\/browser connector/);
  });

  it("passes the orchestrator's note to the restarted agent as extra context", async () => {
    mockTasksGetWithProject.mockImplementation(() => blocked());

    await tools().resume_ticket!.handler({
      taskId: 42,
      agentType: 'review',
      note: 'Playwright is reinstalled and answering — re-run QA scenarios 1-9.',
    });

    expect(mockStartAgentRun).toHaveBeenCalledWith(
      42,
      'review',
      expect.objectContaining({
        extraContext: 'Playwright is reinstalled and answering — re-run QA scenarios 1-9.',
      }),
    );
  });

  it('resumes a ticket that is merely stalled, not flagged blocked', async () => {
    mockTasksGetWithProject.mockImplementation(() =>
      ticket(42, { planification_complete: 1 }),
    );

    await tools().resume_ticket!.handler({ taskId: 42, agentType: 'implementation' });

    expect(mockUnblockTask).not.toHaveBeenCalled();
    expect(mockStartAgentRun).toHaveBeenCalledWith(42, 'implementation', expect.anything());
  });

  it('refuses while an agent is still running on the ticket', async () => {
    mockTasksGetWithProject.mockImplementation(() => blocked());
    mockGetRunningAgentForTask.mockReturnValue({ id: 5, agent_type: 'review' });

    const result = await tools().resume_ticket!.handler({ taskId: 42, agentType: 'review' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/busy/);
    expect(mockUnblockTask).not.toHaveBeenCalled();
    expect(mockStartAgentRun).not.toHaveBeenCalled();
  });

  it('refuses a ticket that is finished — workflow complete AND pull request opened', async () => {
    mockTasksGetWithProject.mockImplementation(() =>
      ticket(42, {
        workflow_complete: 1,
        pr_agent_complete: 1,
        planification_complete: 1,
      }),
    );

    const result = await tools().resume_ticket!.handler({ taskId: 42, agentType: 'review' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/nothing to resume/);
    expect(mockStartAgentRun).not.toHaveBeenCalled();
  });

  // The exact shape of epic 4's ticket #1664: review and refinement passed
  // (workflow_complete), then the PR agent died on a provider error, leaving
  // the work uncommitted and no pull request. `workflow_complete` alone must
  // not read as "finished", or the only recovery is to block the epic.
  it('restarts the pull-request agent on a ticket whose PR step failed', async () => {
    mockTasksGetWithProject.mockImplementation(() =>
      ticket(42, {
        workflow_complete: 1,
        refinement_complete: 1,
        pr_agent_complete: 0,
        planification_complete: 1,
      }),
    );

    const result = await tools().resume_ticket!.handler({
      taskId: 42,
      agentType: 'pr',
      note: 'The previous run died on a provider error; the worktree is intact.',
    });

    expect(result.isError).toBeFalsy();
    expect(mockStartAgentRun).toHaveBeenCalledWith(
      42,
      'pr',
      expect.objectContaining({
        driver: 'automation',
        extraContext: 'The previous run died on a provider error; the worktree is intact.',
      }),
    );
  });

  it("refuses another epic's ticket, like every other ticket verb", async () => {
    mockTasksGetWithProject.mockReturnValue(ticket(99, { epic_id: 8, workflow_blocked: 1 }));

    const result = await tools().resume_ticket!.handler({ taskId: 99, agentType: 'review' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/does not belong to this epic/);
    expect(mockUnblockTask).not.toHaveBeenCalled();
  });

  // Epic 4 again, one step later: the epic was blocked (`block_epic` the
  // night before), the user asked the orchestrator to restart the PR stage,
  // and resume_ticket started run 6155 with the epic STILL blocked — so when
  // that run failed, the bridge dropped the wake and nobody ever heard.
  // Acting on a ticket must resume orchestration first.
  it('resumes a blocked orchestration before restarting the agent', async () => {
    mockTasksGetWithProject.mockImplementation(() =>
      ticket(42, { workflow_complete: 1, planification_complete: 1 }),
    );
    mockResumeOrchestration.mockReturnValue({ ...EPIC, orchestration_blocked: 0 });

    const result = await tools().resume_ticket!.handler({ taskId: 42, agentType: 'pr' });

    expect(mockResumeOrchestration).toHaveBeenCalledWith(7, expect.anything());
    // Unblock strictly before the run starts: the run's first events must
    // find an epic whose bridge will deliver them.
    expect(mockResumeOrchestration.mock.invocationCallOrder[0]!).toBeLessThan(
      mockStartAgentRun.mock.invocationCallOrder[0]!,
    );
    expect(text(result)).toMatch(/Orchestration was paused; your action has resumed it/);
  });

  it('says nothing about resuming when the epic was not blocked', async () => {
    mockTasksGetWithProject.mockImplementation(() =>
      ticket(42, { workflow_complete: 1, planification_complete: 1 }),
    );

    const result = await tools().resume_ticket!.handler({ taskId: 42, agentType: 'pr' });

    expect(mockResumeOrchestration).toHaveBeenCalledWith(7, expect.anything());
    expect(text(result)).not.toMatch(/resumed it/);
  });

  it('does not resume orchestration when a guard refuses the restart', async () => {
    mockTasksGetWithProject.mockImplementation(() => blocked());
    mockGetRunningAgentForTask.mockReturnValue({ id: 5, agent_type: 'review' });

    await tools().resume_ticket!.handler({ taskId: 42, agentType: 'review' });

    expect(mockResumeOrchestration).not.toHaveBeenCalled();
  });
});

describe('the pull request', () => {
  it('carries no review or merge verbs — the PR reviewer owns that stage', () => {
    const names = Object.keys(tools());

    expect(names).toContain('start_pr_review');
    expect(names).not.toContain('get_pr_diff');
    expect(names).not.toContain('request_pr_changes');
    expect(names).not.toContain('merge_task');
  });

  it('reports the newest PR-review run of the ticket, read off the epic runs', async () => {
    mockRunsGetByEpic.mockReturnValue([
      { id: 300, agent_type: 'epic-orchestrator', ticket_task_id: 42, status: 'completed' },
      { id: 301, agent_type: 'epic-pr-review', ticket_task_id: 42, status: 'failed', conversation_id: 9 },
      { id: 305, agent_type: 'epic-pr-review', ticket_task_id: 42, status: 'running', conversation_id: 12 },
      { id: 306, agent_type: 'epic-pr-review', ticket_task_id: 43, status: 'running', conversation_id: 13 },
    ]);

    const result = await tools().get_task_progress!.handler({ taskId: 42 });

    expect(JSON.parse(text(result)).prReview).toEqual({
      runId: 305,
      status: 'running',
      conversationId: 12,
    });
  });

  it('reports no review when none has run', async () => {
    const result = await tools().get_task_progress!.handler({ taskId: 42 });

    expect(JSON.parse(text(result)).prReview).toBeNull();
  });

  it('starts the reviewer through the sequencer and tells the orchestrator to sleep', async () => {
    mockStartPrReview.mockResolvedValue({ started: true, runId: 305, conversationId: 12 });

    const result = await tools().start_pr_review!.handler({ taskId: 42 });

    expect(mockStartPrReview).toHaveBeenCalledWith(7, 42);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toMatch(/run 305/);
    expect(text(result)).toMatch(/end your turn/i);
  });

  it('relays a refusal, and points at resume_ticket when there is nothing to review', async () => {
    mockStartPrReview.mockResolvedValue({
      started: false,
      reason: 'task 42 has no pull request',
      noPullRequest: true,
    });

    const result = await tools().start_pr_review!.handler({ taskId: 42 });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no pull request/);
    expect(text(result)).toMatch(/resume_ticket/);
  });

  it('relays a refusal to wait on when a review is already in flight', async () => {
    mockStartPrReview.mockResolvedValue({
      started: false,
      reason: 'a epic-pr-review run (305) is already in flight on this epic',
    });

    const result = await tools().start_pr_review!.handler({ taskId: 42 });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/already in flight/);
    expect(text(result)).not.toMatch(/block_epic/);
  });

  it('refuses to start a review on another epic\'s ticket', async () => {
    mockTasksGetWithProject.mockReturnValue(ticket(99, { epic_id: 8 }));

    const result = await tools().start_pr_review!.handler({ taskId: 99 });

    expect(result.isError).toBe(true);
    expect(mockStartPrReview).not.toHaveBeenCalled();
  });

  // The sequencer refuses paused epics ('orchestration is paused'), so the
  // resume must land strictly before it is asked.
  it('resumes a blocked orchestration before asking the sequencer', async () => {
    mockResumeOrchestration.mockReturnValue({ ...EPIC, orchestration_blocked: 0 });
    mockStartPrReview.mockResolvedValue({ started: true, runId: 305, conversationId: 12 });

    const result = await tools().start_pr_review!.handler({ taskId: 42 });

    expect(mockResumeOrchestration).toHaveBeenCalledWith(7, expect.anything());
    expect(mockResumeOrchestration.mock.invocationCallOrder[0]!).toBeLessThan(
      mockStartPrReview.mock.invocationCallOrder[0]!,
    );
    expect(text(result)).toMatch(/Orchestration was paused; your action has resumed it/);
  });
});

describe('epic-level verbs', () => {
  it('refuses the final pull request while tickets are unmerged', async () => {
    mockTasksGetByEpic.mockReturnValue([
      { id: 41, status: 'completed' },
      { id: 42, status: 'in_review' },
    ]);

    const result = await tools().open_epic_pr!.handler({});

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/#42/);
    expect(mockCompletionPR).not.toHaveBeenCalled();
  });

  it('opens the final pull request once every ticket has merged', async () => {
    mockTasksGetByEpic.mockReturnValue([{ id: 41, status: 'completed' }]);
    mockCompletionPR.mockResolvedValue({ success: true, url: 'https://pr/epic' });

    const result = await tools().open_epic_pr!.handler({ title: 'Epic: Nimbus Pricing' });

    expect(text(result)).toContain('https://pr/epic');
    expect(text(result)).toMatch(/waiting for their review and merge/);
  });

  it('blocks through the shared path, so an escalation looks like a runaway', async () => {
    mockBlockOrchestration.mockReturnValue({ ...EPIC, orchestration_blocked: 1 });

    const result = await tools().block_epic!.handler({ reason: 'Needs the product owner.' });

    expect(mockBlockOrchestration).toHaveBeenCalledWith(
      7,
      'Needs the product owner.',
      expect.anything(),
    );
    expect(result.isError).toBeUndefined();
  });
});
