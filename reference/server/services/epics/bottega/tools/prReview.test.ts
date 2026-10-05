import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockTasksGetByEpic,
  mockTasksGetWithProject,
  mockTasksUpdate,
  mockMarkPrAgentComplete,
  mockPrStatus,
  mockMergeAndCleanup,
  mockWriteOutcome,
  mockResolveBase,
  mockBlockOrchestration,
} = vi.hoisted(() => ({
  mockTasksGetByEpic: vi.fn(),
  mockTasksGetWithProject: vi.fn(),
  mockTasksUpdate: vi.fn(),
  mockMarkPrAgentComplete: vi.fn(),
  mockPrStatus: vi.fn(),
  mockMergeAndCleanup: vi.fn(),
  mockWriteOutcome: vi.fn(),
  mockResolveBase: vi.fn(),
  mockBlockOrchestration: vi.fn(),
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
  epicTicketsDb: {
    listTickets: mockTasksGetByEpic,
    epicOf: (taskId: number) => {
      const task = mockTasksGetWithProject(taskId) as { epic_id?: number | null } | undefined;
      return task?.epic_id ?? null;
    },
  },
}));

// Landing the ticket goes through the task facade's mergeTask — the Merge
// button's service. The live PR re-check reads taskProgress.
vi.mock('../../../tasks/index.js', () => ({
  getTask: (taskId: number) => mockTasksGetWithProject(taskId) ?? null,
  mergeTask: mockMergeAndCleanup,
  taskProgress: async (taskId: number) => {
    const task = mockTasksGetWithProject(taskId) as Record<string, unknown> | undefined;
    if (!task) return null;
    const pr = (await mockPrStatus(task.repo_folder_path, taskId)) as Record<string, unknown>;
    return {
      taskId,
      title: task.title,
      status: task.status,
      worktreePath: `${task.repo_folder_path}-worktrees/task-${taskId}`,
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
}));

vi.mock('../../epicArchive.js', () => ({ writeEpicTaskOutcome: mockWriteOutcome }));
vi.mock('../../orchestrator/blocking.js', () => ({
  blockOrchestration: mockBlockOrchestration,
}));

import { buildPrReviewTools } from './prReview.js';
import { UnsavedWorktreeWorkError } from '../../../worktreeSafety.js';

interface CapturedTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

/** A ticket of epic 7 with its project joined in, as `getWithProject` returns. */
function ticket(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    project_id: 3,
    epic_id: 7,
    title: `T${id}`,
    status: 'in_progress',
    repo_folder_path: '/repos/nimbus',
    subproject_path: null,
    pr_agent_complete: 1,
    ...overrides,
  };
}

function tools(ctxOverrides: Record<string, unknown> = {}): Record<string, CapturedTool> {
  const built = buildPrReviewTools({
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
  mockTasksGetByEpic.mockReturnValue([]);
  mockTasksGetWithProject.mockImplementation((id: number) => ticket(id));
  mockPrStatus.mockResolvedValue({
    exists: true,
    url: 'https://pr/1',
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    ciStatus: { status: 'passed', checks: [] },
  });
  mockMergeAndCleanup.mockResolvedValue({ success: true });
  mockWriteOutcome.mockReturnValue('/archive/outcomes/task-42.md');
  mockResolveBase.mockResolvedValue('epic/7-nimbus-pricing');
});

describe('the catalog', () => {
  it('is merge and block — nothing else', () => {
    expect(Object.keys(tools()).sort()).toEqual(['block_epic', 'merge_task']);
  });
});

describe('merge_task', () => {
  it('merges into the epic feature branch, completes the ticket and records the outcome', async () => {
    const result = await tools().merge_task!.handler({
      taskId: 42,
      outcomeSummary: 'Pricing module landed; monthlyCost is the entry point.',
    });

    // One call into the task facade's mergeTask — merge, cleanup, status
    // flip and notifications all live there (the Merge button's service).
    expect(mockMergeAndCleanup).toHaveBeenCalledWith(42);
    expect(mockWriteOutcome).toHaveBeenCalledWith(3, 7, 42, expect.stringContaining('Pricing'));
    expect(result.isError).toBeUndefined();
    // The final ticket: the server opens the epic PR, the reviewer just stops.
    expect(text(result)).toMatch(/final ticket/i);
    expect(text(result)).toMatch(/end your turn/i);
    expect(text(result)).not.toContain('open_epic_pr');
  });

  it('ends normally when another ticket remains', async () => {
    mockTasksGetByEpic.mockReturnValue([
      { id: 42, status: 'in_progress' },
      { id: 43, status: 'pending' },
    ]);

    const result = await tools().merge_task!.handler({ taskId: 42, outcomeSummary: 'landed' });

    expect(text(result)).toMatch(/next ticket starts on its own/i);
    expect(text(result)).not.toMatch(/final ticket/i);
  });

  it('is bound to the ticket it reviews', async () => {
    const result = await tools().merge_task!.handler({ taskId: 43, outcomeSummary: 'x' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/reviews ticket #42 only/);
    expect(mockMergeAndCleanup).not.toHaveBeenCalled();
  });

  it('refuses a ticket of another epic', async () => {
    mockTasksGetWithProject.mockReturnValue(ticket(42, { epic_id: 8 }));

    const result = await tools().merge_task!.handler({ taskId: 42, outcomeSummary: 'x' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/does not belong to this epic/);
  });

  it('refuses a ticket that is already merged', async () => {
    mockTasksGetWithProject.mockReturnValue(ticket(42, { status: 'completed' }));

    const result = await tools().merge_task!.handler({ taskId: 42, outcomeSummary: 'x' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/already merged/);
    expect(mockMergeAndCleanup).not.toHaveBeenCalled();
  });

  it('lands a ticket whose PR agent never signed off — mergeTask signs the stage off itself', async () => {
    // A PR agent that gave up on CI leaves the flag unset; the reviewer got
    // CI green, so the stage completes inside the facade's mergeTask once the
    // PR has landed (covered in the task facade's own tests).
    mockTasksGetWithProject.mockReturnValue(ticket(42, { pr_agent_complete: 0 }));

    const result = await tools().merge_task!.handler({ taskId: 42, outcomeSummary: 'x' });

    expect(result.isError).toBeUndefined();
    expect(mockMergeAndCleanup).toHaveBeenCalledWith(42);
  });

  it('does not touch the flag when the PR agent already set it', async () => {
    await tools().merge_task!.handler({ taskId: 42, outcomeSummary: 'x' });

    expect(mockMarkPrAgentComplete).not.toHaveBeenCalled();
  });

  it('refuses when there is no pull request', async () => {
    mockPrStatus.mockResolvedValue({ exists: false });

    const result = await tools().merge_task!.handler({ taskId: 42, outcomeSummary: 'x' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no pull request/);
  });

  it('refuses a pull request that is no longer open', async () => {
    mockPrStatus.mockResolvedValue({ exists: true, state: 'MERGED', mergeable: 'UNKNOWN' });

    const result = await tools().merge_task!.handler({ taskId: 42, outcomeSummary: 'x' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/MERGED, not open/);
    expect(mockMergeAndCleanup).not.toHaveBeenCalled();
  });

  it('tells the reviewer to rebase a conflicting pull request itself', async () => {
    mockPrStatus.mockResolvedValue({ exists: true, state: 'OPEN', mergeable: 'CONFLICTING' });

    const result = await tools().merge_task!.handler({ taskId: 42, outcomeSummary: 'x' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/rebase/i);
    expect(text(result)).toMatch(/force-with-lease/);
    expect(mockMergeAndCleanup).not.toHaveBeenCalled();
  });

  it('waits rather than merging on pending CI', async () => {
    mockPrStatus.mockResolvedValue({
      exists: true,
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      ciStatus: { status: 'pending', checks: [] },
    });

    const result = await tools().merge_task!.handler({ taskId: 42, outcomeSummary: 'x' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/pending/);
    expect(text(result)).toMatch(/gh pr checks/);
    expect(mockMergeAndCleanup).not.toHaveBeenCalled();
  });

  it('refuses red CI', async () => {
    mockPrStatus.mockResolvedValue({
      exists: true,
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      ciStatus: { status: 'failed', checks: [] },
    });

    const result = await tools().merge_task!.handler({ taskId: 42, outcomeSummary: 'x' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/failed/);
    expect(mockMergeAndCleanup).not.toHaveBeenCalled();
  });

  it('refuses to land a worktree holding work the pull request does not contain', async () => {
    mockMergeAndCleanup.mockRejectedValue(
      new UnsavedWorktreeWorkError(42, {
        clean: false,
        files: ['src/lib/pricing.ts'],
        dirtyFiles: 1,
        unpushedCommits: 0,
        branch: 'task-42',
      }),
    );

    const result = await tools().merge_task!.handler({ taskId: 42, outcomeSummary: 'x' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/commit and push/i);
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('does not complete the ticket when the merge fails, but keeps the write-ahead outcome', async () => {
    mockMergeAndCleanup.mockResolvedValue({ success: false, error: 'gh exploded' });

    const result = await tools().merge_task!.handler({ taskId: 42, outcomeSummary: 'x' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/gh exploded/);
    expect(text(result)).toMatch(/block_epic/);
    expect(mockTasksUpdate).not.toHaveBeenCalled();
    // The note is written before the GitHub side effect. It is not consumed
    // while the task remains open, and a retry replaces it; if GitHub merged
    // despite an ambiguous client error, restart reconciliation still has the
    // handoff for the next ticket.
    expect(mockWriteOutcome).toHaveBeenCalledWith(3, 7, 42, 'x');
  });
});

describe('block_epic', () => {
  it('blocks through the shared path, so an escalation looks like a runaway', async () => {
    mockBlockOrchestration.mockReturnValue({ id: 7 });

    const result = await tools().block_epic!.handler({ reason: 'CI red after 10 rounds: flaky e2e' });

    expect(mockBlockOrchestration).toHaveBeenCalledWith(
      7,
      'CI red after 10 rounds: flaky e2e',
      expect.objectContaining({ userId: 1 }),
    );
    expect(result.isError).toBeUndefined();
    expect(text(result)).toMatch(/end your turn/i);
  });
});
