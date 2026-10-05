import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockEpicGetById,
  mockGetProject,
  mockTasksGetByEpic,
  mockTasksGetById,
  mockTasksGetWithProject,
  mockTasksUpdate,
  mockRunsGetByTask,
  mockReadTaskDoc,
  mockWriteTaskDoc,
  mockCreateTask,
  mockRenumber,
  mockDeleteTask,
  mockMoveTask,
} = vi.hoisted(() => ({
  mockEpicGetById: vi.fn(),
  mockGetProject: vi.fn(),
  mockTasksGetByEpic: vi.fn(),
  mockTasksGetById: vi.fn(),
  mockTasksGetWithProject: vi.fn(),
  mockTasksUpdate: vi.fn(),
  mockSetEpicOrder: vi.fn(),
  mockRunsGetByTask: vi.fn(),
  mockReadTaskDoc: vi.fn(),
  mockWriteTaskDoc: vi.fn(),
  mockCreateTask: vi.fn(),
  mockDeleteTask: vi.fn(),
  mockMoveTask: vi.fn(),
  mockRenumber: vi.fn().mockReturnValue([]),
}));

// Same capture harness as mcpServer.test.ts — tool() is a definition builder,
// so what we exercise here is our handlers.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: unknown) => Promise<unknown>,
  ) => ({ name, description, inputSchema, handler }),
}));

vi.mock('../../../../database/epics.js', () => ({
  epicsDb: { getById: mockEpicGetById },
  epicTicketsDb: {
    listTickets: mockTasksGetByEpic,
    epicOf: (taskId: number) => {
      const task = (mockTasksGetWithProject(taskId) ?? mockTasksGetById(taskId)) as
        | { epic_id?: number | null }
        | undefined;
      return task?.epic_id ?? null;
    },
    get: (taskId: number) => {
      const task = mockTasksGetById(taskId) as { epic_order?: number | null } | undefined;
      return task ? { epic_id: 7, task_id: taskId, position: task.epic_order ?? null } : undefined;
    },
  },
}));

// The task facade — the only surface the tools may act on tasks through.
vi.mock('../../../tasks/index.js', () => ({
  getTask: (taskId: number) => (mockTasksGetWithProject(taskId) ?? mockTasksGetById(taskId)) ?? null,
  taskHasAgentRuns: (taskId: number) => (mockRunsGetByTask(taskId) ?? []).length > 0,
  updateTaskTitle: (taskId: number, title: string | null) => mockTasksUpdate(taskId, { title }),
  readTaskDoc: mockReadTaskDoc,
  writeTaskDoc: mockWriteTaskDoc,
  deleteTaskCompletely: mockDeleteTask,
}));

// The epic layer's own ticket service (v2 step 3): creation and ordering.
vi.mock('../../ticketService.js', () => ({
  createEpicTicket: mockCreateTask,
  moveTicket: mockMoveTask,
  renumberTickets: mockRenumber,
}));

import { buildStoryTools } from './story.js';

interface CapturedTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

const EPIC = { id: 7, project_id: 3, user_id: 4 };
const PROJECT = { id: 3, repo_folder_path: '/repos/nimbus' };

/** A pending ticket with no runs — the revisable shape. */
function ticket(id: number, overrides: Record<string, unknown> = {}) {
  return { id, project_id: 3, epic_id: 7, epic_order: id, title: `T${id}`, status: 'pending', ...overrides };
}

function tools(ctxOverrides: Record<string, unknown> = {}): Record<string, CapturedTool> {
  const built = buildStoryTools({ epicId: 7, userId: 1, ...ctxOverrides }) as CapturedTool[];
  return Object.fromEntries(built.map((t) => [t.name, t]));
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEpicGetById.mockReturnValue({ ...EPIC });
  mockGetProject.mockReturnValue({ ...PROJECT });
  mockTasksGetByEpic.mockReturnValue([]);
  mockRunsGetByTask.mockReturnValue([]);
  mockCreateTask.mockResolvedValue({
    success: true,
    task: { id: 42, title: 'Add the pricing_tier table', position: 1 },
  });
  mockDeleteTask.mockResolvedValue(true);
});

describe('the catalog', () => {
  it('is exactly the four ticket verbs', () => {
    expect(Object.keys(tools())).toEqual([
      'create_task',
      'list_epic_tasks',
      'update_task',
      'delete_task',
    ]);
  });
});

describe('create_task', () => {
  const ARGS = { title: 'Add the pricing_tier table', description: '## Goal\nA table.' };

  it('creates the ticket through the same service the REST route uses', async () => {
    const result = await tools().create_task!.handler(ARGS);

    expect(result.isError).toBeUndefined();
    expect(mockCreateTask).toHaveBeenCalledWith(
      7,
      { title: ARGS.title, description: ARGS.description },
      1,
    );
    expect(JSON.parse(text(result))).toMatchObject({ taskId: 42, position: 1 });
  });

  it('surfaces a non-fatal branch warning so the agent can relay it', async () => {
    mockCreateTask.mockResolvedValue({
      success: true,
      task: { id: 42, title: 'x', epic_order: 1 },
      baseBranch: 'epic/7-nimbus-pricing',
      warning: 'the feature branch is local-only',
    });

    const parsed = JSON.parse(text(await tools().create_task!.handler(ARGS)));

    expect(parsed).toMatchObject({
      baseBranch: 'epic/7-nimbus-pricing',
      warning: 'the feature branch is local-only',
    });
  });

  it('falls back to the epic creator when the conversation has no acting user', async () => {
    await tools({ userId: undefined }).create_task!.handler(ARGS);

    expect(mockCreateTask).toHaveBeenCalledWith(7, expect.anything(), 4);
  });

  it('refuses while the orchestrator is executing the sequence', async () => {
    // The durable flag catches the window the derived signal misses: the user
    // started orchestration, but ticket 1 has not moved yet.
    mockEpicGetById.mockReturnValue({ ...EPIC, orchestration_active: 1 });

    const result = await tools().create_task!.handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/being implemented by its orchestrator/);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('refuses once a ticket of the epic has left pending', async () => {
    mockTasksGetByEpic.mockReturnValue([ticket(40, { status: 'in_progress' })]);

    const result = await tools().create_task!.handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Task 40 of this epic has already started');
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('refuses once a ticket has agent runs, even while still pending', async () => {
    mockTasksGetByEpic.mockReturnValue([ticket(40)]);
    mockRunsGetByTask.mockReturnValue([{ id: 1 }]);

    const result = await tools().create_task!.handler(ARGS);

    expect(result.isError).toBe(true);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('reports a worktree failure as a readable refusal', async () => {
    mockCreateTask.mockResolvedValue({ success: false, error: 'Failed to create worktree: no origin' });

    const result = await tools().create_task!.handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no origin');
  });

  it('reports a deleted epic instead of throwing', async () => {
    mockEpicGetById.mockReturnValue(undefined);

    const result = await tools().create_task!.handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no longer exists');
  });

  it('reports an inaccessible project instead of throwing', async () => {
    // The access check lives in createEpicTicket now; its refusal surfaces
    // through the tool's error result.
    mockCreateTask.mockRejectedValue(new Error('Epic 7 not found in this project'));

    const result = await tools().create_task!.handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not found in this project');
  });

  it('turns an unexpected failure into an error result the model can read', async () => {
    mockCreateTask.mockRejectedValue(new Error('disk full'));

    const result = await tools().create_task!.handler(ARGS);

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('disk full');
  });
});

describe('list_epic_tasks', () => {
  it('returns execution order with the revision window per ticket', async () => {
    mockTasksGetByEpic.mockReturnValue([ticket(41), ticket(42, { status: 'in_progress' })]);

    const parsed = JSON.parse(text(await tools().list_epic_tasks!.handler({})));

    expect(parsed.tasks).toEqual([
      { taskId: 41, position: 1, title: 'T41', status: 'pending', revisable: true },
      { taskId: 42, position: 2, title: 'T42', status: 'in_progress', revisable: false },
    ]);
    expect(mockReadTaskDoc).not.toHaveBeenCalled();
  });

  it('reads the ticket documents only when asked', async () => {
    mockTasksGetByEpic.mockReturnValue([ticket(41)]);
    mockReadTaskDoc.mockReturnValue('## Goal\nA table.');

    const parsed = JSON.parse(
      text(await tools().list_epic_tasks!.handler({ includeDescriptions: true })),
    );

    expect(mockReadTaskDoc).toHaveBeenCalledWith(3, 41);
    expect(parsed.tasks[0].description).toBe('## Goal\nA table.');
  });
});

describe('update_task', () => {
  beforeEach(() => {
    mockTasksGetById.mockReturnValue(ticket(41));
  });

  it('applies title, description and position in one call', async () => {
    mockTasksGetById.mockReturnValueOnce(ticket(41)).mockReturnValue(ticket(41, { epic_order: 2 }));

    const result = await tools().update_task!.handler({
      taskId: 41,
      title: 'Renamed',
      description: 'new body',
      position: 2,
    });

    expect(result.isError).toBeUndefined();
    expect(mockTasksUpdate).toHaveBeenCalledWith(41, { title: 'Renamed' });
    expect(mockWriteTaskDoc).toHaveBeenCalledWith(3, 41, 'new body');
    expect(mockMoveTask).toHaveBeenCalledWith(7, 41, 2);
    expect(JSON.parse(text(result)).updated).toEqual(['title', 'description', 'position']);
  });

  it('refuses an empty update rather than pretending it did something', async () => {
    const result = await tools().update_task!.handler({ taskId: 41 });

    expect(result.isError).toBe(true);
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it("refuses a ticket from another epic", async () => {
    mockTasksGetById.mockReturnValue(ticket(41, { epic_id: 99 }));

    const result = await tools().update_task!.handler({ taskId: 41, title: 'x' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('does not belong to this epic');
    expect(mockTasksUpdate).not.toHaveBeenCalled();
  });

  it('refuses a ticket that is no longer pending, and says what to do instead', async () => {
    mockTasksGetById.mockReturnValue(ticket(41, { status: 'in_progress' }));

    const result = await tools().update_task!.handler({ taskId: 41, description: 'x' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Task 41 is 'in_progress'");
    expect(text(result)).toContain('Create a follow-up ticket');
    expect(mockWriteTaskDoc).not.toHaveBeenCalled();
  });

  it('refuses a pending ticket that already has agent runs', async () => {
    mockRunsGetByTask.mockReturnValue([{ id: 1 }]);

    const result = await tools().update_task!.handler({ taskId: 41, description: 'x' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('already has agent runs');
  });

  it('reports an unknown ticket', async () => {
    mockTasksGetById.mockReturnValue(undefined);

    const result = await tools().update_task!.handler({ taskId: 41, title: 'x' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('does not exist');
  });
});

describe('delete_task', () => {
  beforeEach(() => {
    mockTasksGetById.mockReturnValue(ticket(41));
    mockTasksGetWithProject.mockReturnValue({ ...ticket(41), repo_folder_path: '/repos/nimbus' });
  });

  it('deletes through the shared service and closes the gap in the order', async () => {
    mockTasksGetByEpic.mockReturnValue([ticket(42, { epic_order: 2 }), ticket(43, { epic_order: 3 })]);

    const result = await tools().delete_task!.handler({ taskId: 41 });

    expect(result.isError).toBeUndefined();
    expect(mockDeleteTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 41, repo_folder_path: '/repos/nimbus' }),
    );
    expect(mockRenumber).toHaveBeenCalledWith(7);
  });

  it('refuses a started ticket', async () => {
    mockTasksGetWithProject.mockReturnValue(
      ticket(41, { status: 'completed', repo_folder_path: '/repos/nimbus' }),
    );

    const result = await tools().delete_task!.handler({ taskId: 41 });

    expect(result.isError).toBe(true);
    expect(mockDeleteTask).not.toHaveBeenCalled();
  });

  it('refuses a ticket from another epic', async () => {
    mockTasksGetWithProject.mockReturnValue(
      ticket(41, { epic_id: 99, repo_folder_path: '/repos/nimbus' }),
    );

    const result = await tools().delete_task!.handler({ taskId: 41 });

    expect(result.isError).toBe(true);
    expect(mockDeleteTask).not.toHaveBeenCalled();
  });

  it('reports a delete that changed nothing', async () => {
    mockDeleteTask.mockResolvedValue(false);

    const result = await tools().delete_task!.handler({ taskId: 41 });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('could not be deleted');
  });
});
