import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGetByConversationId,
  mockSetTicketTask,
  mockEpicOf,
  mockCreateEpicTicket,
  mockGetTask,
  mockTaskFlags,
  mockMergeTicket,
} = vi.hoisted(() => ({
  mockGetByConversationId: vi.fn(),
  mockSetTicketTask: vi.fn(),
  mockEpicOf: vi.fn(),
  mockCreateEpicTicket: vi.fn(),
  mockGetTask: vi.fn(),
  mockTaskFlags: vi.fn(),
  mockMergeTicket: vi.fn(),
}));

vi.mock('../../../../database/epics.js', () => ({
  epicAgentRunsDb: {
    getByConversationId: mockGetByConversationId,
    setTicketTask: mockSetTicketTask,
  },
  epicTicketsDb: { epicOf: mockEpicOf },
}));

vi.mock('../../ticketService.js', () => ({ createEpicTicket: mockCreateEpicTicket }));

vi.mock('../../../tasks/index.js', () => ({
  getTask: mockGetTask,
  taskFlags: mockTaskFlags,
}));

vi.mock('./prReview.js', () => ({
  mergeTicket: mockMergeTicket,
  OUTCOME_SUMMARY_MAX: 4000,
}));

import { buildQaFixTools } from './qaFix.js';

const CTX = {
  projectId: 3,
  epicId: 7,
  agentType: 'epic-qa-fix' as const,
  conversationId: 5,
  userId: 1,
};

const FIX_RUN = {
  id: 70,
  epic_id: 7,
  agent_type: 'epic-qa-fix',
  status: 'running',
  conversation_id: 5,
  ticket_task_id: null,
};

function tools() {
  const built = buildQaFixTools(CTX);
  return Object.fromEntries(built.map((t) => [t.name, t]));
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0]!.text;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetByConversationId.mockReturnValue({ ...FIX_RUN });
  mockEpicOf.mockReturnValue(7);
});

describe('create_fix_ticket', () => {
  it('creates the ticket through the ticket service and stamps the run row', async () => {
    mockCreateEpicTicket.mockResolvedValue({
      success: true,
      task: { id: 42, position: 13 },
      baseBranch: 'epic/7-nimbus',
    });

    const result = (await tools().create_fix_ticket!.handler({
      title: 'QA fixes',
      description: 'S-039 …',
    })) as never;

    expect(mockCreateEpicTicket).toHaveBeenCalledWith(
      7,
      { title: 'QA fixes', description: 'S-039 …' },
      1,
    );
    expect(mockSetTicketTask).toHaveBeenCalledWith(70, 42);
    expect(text(result)).toContain('"taskId": 42');
    expect(text(result)).toContain('start_planification');
  });

  it('refuses a second ticket on the same mission', async () => {
    mockGetByConversationId.mockReturnValue({ ...FIX_RUN, ticket_task_id: 42 });

    const result = (await tools().create_fix_ticket!.handler({
      title: 'Again',
      description: 'x',
    })) as never;

    expect(mockCreateEpicTicket).not.toHaveBeenCalled();
    expect(text(result)).toContain('already supervises ticket #42');
  });

  it('hands a service failure back without stamping anything', async () => {
    mockCreateEpicTicket.mockResolvedValue({ success: false, error: 'branch push failed' });

    const result = (await tools().create_fix_ticket!.handler({
      title: 'QA fixes',
      description: 'x',
    })) as never;

    expect(mockSetTicketTask).not.toHaveBeenCalled();
    expect(text(result)).toContain('branch push failed');
  });
});

describe('adopt_fix_ticket', () => {
  it('stamps an existing unmerged ticket of this epic', async () => {
    mockTaskFlags.mockReturnValue({ status: 'in_progress' });

    const result = (await tools().adopt_fix_ticket!.handler({ taskId: 42 })) as never;

    expect(mockSetTicketTask).toHaveBeenCalledWith(70, 42);
    expect(text(result)).toContain('adopted');
  });

  it('refuses a foreign or merged ticket', async () => {
    mockTaskFlags.mockReturnValue({ status: 'in_progress' });
    mockEpicOf.mockReturnValue(9);
    let result = (await tools().adopt_fix_ticket!.handler({ taskId: 42 })) as never;
    expect(text(result)).toContain('does not belong');

    mockEpicOf.mockReturnValue(7);
    mockTaskFlags.mockReturnValue({ status: 'completed' });
    result = (await tools().adopt_fix_ticket!.handler({ taskId: 42 })) as never;
    expect(text(result)).toContain('already merged');
    expect(mockSetTicketTask).not.toHaveBeenCalled();
  });
});

describe('merge_task', () => {
  beforeEach(() => {
    mockGetByConversationId.mockReturnValue({ ...FIX_RUN, ticket_task_id: 42 });
    mockGetTask.mockReturnValue({ id: 42, status: 'in_review', project_id: 3 });
  });

  it('merges through the shared guard-set with the re-test closing — never the sequencing one', async () => {
    mockMergeTicket.mockImplementation(
      async (_epicId: number, _task: unknown, _summary: string, closing: (last: boolean) => string) => ({
        ok: true,
        text: `merged. ${closing(true)}`,
      }),
    );

    const result = (await tools().merge_task!.handler({
      taskId: 42,
      outcomeSummary: 'Fixed S-039.',
    })) as never;

    expect(text(result)).toContain('re-test');
    expect(text(result)).toContain('record_qa_results');
    expect(text(result)).not.toContain('the next ticket starts on its own');
    expect(text(result)).not.toContain('epic pull request');
  });

  it('is bound to the mission ticket', async () => {
    mockGetTask.mockReturnValue({ id: 43, status: 'in_review', project_id: 3 });

    const result = (await tools().merge_task!.handler({
      taskId: 43,
      outcomeSummary: 'x',
    })) as never;

    expect(mockMergeTicket).not.toHaveBeenCalled();
    expect(text(result)).toContain('supervises ticket #42 only');
  });
});
