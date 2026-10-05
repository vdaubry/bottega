import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEpicRunsByEpic, mockTaskRuns, mockRead, mockRender } = vi.hoisted(() => ({
  mockEpicRunsByEpic: vi.fn(),
  mockTaskRuns: vi.fn(),
  mockRead: vi.fn(),
  mockRender: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: unknown) => Promise<unknown>,
  ) => ({ name, description, inputSchema, handler }),
}));

vi.mock('../../../../database/epics.js', () => ({
  epicAgentRunsDb: { getByEpic: mockEpicRunsByEpic },
}));

vi.mock('../../../tasks/index.js', () => ({ taskAgentRuns: mockTaskRuns }));

// Stubbed whole, deliberately: the real reader imports the conversations
// table, and importing the DB layer from a unit test opens the live database.
vi.mock('../../../conversation/transcriptReader.js', () => ({
  readConversationTranscript: mockRead,
  renderTranscript: mockRender,
  TranscriptUnavailableError: class TranscriptUnavailableError extends Error {},
  DEFAULT_WINDOW: 40,
  DEFAULT_BLOCK_CHARS: 800,
}));

const { buildTranscriptTool } = await import('./transcript.js');
const { TranscriptUnavailableError } = await import('../../../conversation/transcriptReader.js');

const EPIC_ID = 4;
const TASK_ID = 1664;

/** A ticket that was reviewed twice — the case where a stage alone is ambiguous. */
const TASK_RUNS = [
  {
    id: 6141,
    agent_type: 'planification',
    status: 'completed',
    conversation_id: 7120,
    created_at: '2026-08-25 15:16:52',
    completed_at: '2026-08-25 15:51:44',
  },
  {
    id: 6142,
    agent_type: 'implementation',
    status: 'completed',
    conversation_id: 7121,
    created_at: '2026-08-25 16:01:50',
    completed_at: '2026-08-25 17:33:15',
  },
  {
    id: 6144,
    agent_type: 'review',
    status: 'completed',
    conversation_id: 7124,
    created_at: '2026-08-25 17:33:16',
    completed_at: '2026-08-25 18:05:48',
  },
  {
    id: 6150,
    agent_type: 'review',
    status: 'running',
    conversation_id: 7131,
    created_at: '2026-08-25 20:14:58',
    completed_at: null,
  },
];

const allowAll = () => Promise.resolve(null);

function makeTool(guard: (taskId: number) => Promise<string | null> = allowAll) {
  return buildTranscriptTool({ epicId: EPIC_ID }, guard) as unknown as {
    name: string;
    handler: (args: Record<string, unknown>) => Promise<{
      content: Array<{ text: string }>;
      isError?: boolean;
    }>;
  };
}

const textOf = (result: { content: Array<{ text: string }> }) => result.content[0]?.text ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  mockTaskRuns.mockReturnValue(TASK_RUNS);
  mockEpicRunsByEpic.mockReturnValue([]);
  mockRender.mockReturnValue('<rendered>');
  mockRead.mockResolvedValue({ meta: {}, entries: [], from: null, to: null, matches: null });
});

describe('read_agent_transcript', () => {
  it('refuses a task that is not a ticket of this epic', async () => {
    const tool = makeTool(() => Promise.resolve('Task 999 does not belong to this epic.'));
    const result = await tool.handler({ taskId: 999, agentType: 'review' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('does not belong to this epic');
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('lists the ticket\'s runs when no run is named, rather than guessing one', async () => {
    const result = await makeTool().handler({ taskId: TASK_ID });
    const payload = JSON.parse(textOf(result)) as {
      runs: Array<{ runId: number; agentType: string }>;
    };
    expect(payload.runs.map((r) => r.runId)).toEqual([6141, 6142, 6144, 6150]);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('includes the epic-level PR reviewer of this ticket in the listing', async () => {
    mockEpicRunsByEpic.mockReturnValue([
      {
        id: 88,
        agent_type: 'epic-pr-review',
        ticket_task_id: TASK_ID,
        status: 'completed',
        conversation_id: 7118,
        created_at: '2026-08-25 21:00:00',
        completed_at: null,
      },
      // Another ticket's reviewer, and an unrelated epic stage: neither is ours.
      {
        id: 89,
        agent_type: 'epic-pr-review',
        ticket_task_id: 1663,
        status: 'completed',
        conversation_id: 7101,
        created_at: '2026-08-25 08:40:18',
        completed_at: null,
      },
      { id: 90, agent_type: 'epic-orchestrator', ticket_task_id: TASK_ID, conversation_id: 7119 },
    ]);
    const payload = JSON.parse(textOf(await makeTool().handler({ taskId: TASK_ID }))) as {
      runs: Array<{ runId: number; agentType: string }>;
    };
    expect(payload.runs.map((r) => r.runId)).toEqual([6141, 6142, 6144, 6150, 88]);
    expect(payload.runs.at(-1)?.agentType).toBe('pr-review');
  });

  it('reads the newest run of a stage', async () => {
    await makeTool().handler({ taskId: TASK_ID, agentType: 'review' });
    expect(mockRead).toHaveBeenCalledWith(7131, {});
  });

  it('pins an earlier run of the same stage by runId', async () => {
    const result = await makeTool().handler({ taskId: TASK_ID, runId: 6144 });
    expect(mockRead).toHaveBeenCalledWith(7124, {});
    expect(textOf(result)).toContain('run 6144 · review · completed');
  });

  it('passes the window, search and subagent through, and expand to the renderer', async () => {
    await makeTool().handler({
      taskId: TASK_ID,
      agentType: 'implementation',
      limit: 10,
      before: 400,
      search: 'playwright',
      subagent: 'subagents/agent-a1',
      expand: 'toolu_9',
    });
    expect(mockRead).toHaveBeenCalledWith(7121, {
      limit: 10,
      before: 400,
      search: 'playwright',
      subagent: 'subagents/agent-a1',
    });
    expect(mockRender).toHaveBeenCalledWith(expect.anything(), {
      expand: 'toolu_9',
      maxBlockChars: expect.any(Number),
    });
  });

  it('says what the ticket does have when the named stage never ran', async () => {
    const result = await makeTool().handler({ taskId: TASK_ID, agentType: 'yolo' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('has no yolo run');
  });

  it('explains a run that died before it opened a conversation', async () => {
    mockTaskRuns.mockReturnValue([
      {
        id: 7000,
        agent_type: 'pr',
        status: 'failed',
        conversation_id: null,
        created_at: '2026-08-25 22:00:00',
        completed_at: '2026-08-25 22:00:01',
      },
    ]);
    const result = await makeTool().handler({ taskId: TASK_ID, agentType: 'pr' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('has no conversation');
  });

  it('refuses a ticket that has never run an agent', async () => {
    mockTaskRuns.mockReturnValue([]);
    const result = await makeTool().handler({ taskId: TASK_ID, agentType: 'review' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('never run an agent');
  });

  it('turns an unreadable transcript into a refusal the model can act on', async () => {
    mockRead.mockRejectedValue(new TranscriptUnavailableError('Conversation 7131 has no stored messages.'));
    const result = await makeTool().handler({ taskId: TASK_ID, agentType: 'review' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no stored messages');
  });
});
