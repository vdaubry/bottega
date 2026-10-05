import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetById, mockLoadEntries, mockListSubagents } = vi.hoisted(() => ({
  mockGetById: vi.fn(),
  mockLoadEntries: vi.fn(),
  mockListSubagents: vi.fn(),
}));

vi.mock('../../database/conversations.js', () => ({
  conversationsDb: { getById: mockGetById },
}));

vi.mock('../conversationContentStore.js', () => ({
  conversationContentStore: {
    loadEntries: mockLoadEntries,
    listSubagentTranscripts: mockListSubagents,
  },
}));

const {
  readConversationTranscript,
  renderTranscript,
  normalizeEntries,
  summarizeToolUsage,
  TranscriptUnavailableError,
} = await import('./transcriptReader.js');

const CONVERSATION = {
  id: 42,
  name: 'Review and Fix',
  provider: 'openai',
  model: 'gpt-6.1-sol',
  claude_conversation_id: 'sess-1',
  session_path: '/repo/worktrees/task-7',
};

/** A turn shaped like the store holds it, whichever provider wrote it. */
function transcript() {
  return [
    { type: 'user', timestamp: '2026-08-25T10:00:00Z', message: { content: 'Review the ticket.' } },
    { type: 'ai-title', aiTitle: 'Review and Fix' },
    {
      type: 'assistant',
      timestamp: '2026-08-25T10:00:01Z',
      message: { content: [{ type: 'thinking', thinking: 'Checking the suite first.' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-08-25T10:00:02Z',
      message: {
        content: [
          { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'bin/test' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2026-08-25T10:00:30Z',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: 'x'.repeat(2000) },
        ],
      },
    },
    { type: 'queue-operation', operation: 'drain' },
    {
      type: 'assistant',
      timestamp: '2026-08-25T10:00:40Z',
      message: { content: [{ type: 'text', text: 'Status: BLOCKED. No Playwright connector.' }] },
    },
    { type: 'result', timestamp: '2026-08-25T10:00:41Z', is_error: false },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetById.mockReturnValue(CONVERSATION);
  mockLoadEntries.mockResolvedValue(transcript());
  mockListSubagents.mockResolvedValue([]);
});

describe('normalizeEntries', () => {
  it('drops UI bookkeeping and keeps everything the agent actually did', () => {
    const { normalized, hidden } = normalizeEntries(transcript());
    expect(hidden).toBe(2); // ai-title + queue-operation
    expect(normalized.map((e) => e.blocks[0]?.kind)).toEqual([
      'text',
      'thinking',
      'tool_use',
      'tool_result',
      'text',
      'meta',
    ]);
    expect(normalized.map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('names a result after the call it answers — a bare tool_result says nothing', () => {
    const { normalized } = normalizeEntries(transcript());
    const result = normalized[3]?.blocks[0];
    expect(result?.kind).toBe('tool_result');
    expect(result?.tool).toBe('Bash');
    expect(result?.isError).toBe(true);
  });

  it('flags every block of an entry the provider marked as an API error', () => {
    const { normalized } = normalizeEntries([
      {
        type: 'assistant',
        isApiErrorMessage: true,
        message: { content: [{ type: 'text', text: '429 rate limit' }] },
      },
    ]);
    expect(normalized[0]?.blocks[0]?.isError).toBe(true);
  });

  it('keeps a tool_result whose content is a block array, not a string', () => {
    const { normalized } = normalizeEntries([
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'c',
              content: [{ type: 'text', text: 'line' }, { type: 'image' }],
            },
          ],
        },
      },
    ]);
    expect(normalized[0]?.blocks[0]?.body).toBe('line\n[image]');
  });
});

describe('summarizeToolUsage', () => {
  it('tallies calls and errors, worst first', () => {
    const { normalized } = normalizeEntries(transcript());
    expect(summarizeToolUsage(normalized)).toEqual([{ tool: 'Bash', calls: 1, errors: 1 }]);
  });
});

describe('readConversationTranscript', () => {
  it('refuses a conversation that never started a session', async () => {
    mockGetById.mockReturnValue({ ...CONVERSATION, claude_conversation_id: null });
    await expect(readConversationTranscript(42)).rejects.toBeInstanceOf(
      TranscriptUnavailableError,
    );
  });

  it('refuses a conversation with no stored messages', async () => {
    mockLoadEntries.mockResolvedValue([]);
    await expect(readConversationTranscript(42)).rejects.toBeInstanceOf(
      TranscriptUnavailableError,
    );
  });

  it('returns the tail by default and reports the whole run in its meta', async () => {
    const window = await readConversationTranscript(42, { limit: 2 });
    expect(window.meta.totalEntries).toBe(6);
    expect(window.meta.hiddenEntries).toBe(2);
    expect(window.meta.errorIndices).toEqual([3]);
    expect(window.from).toBe(4);
    expect(window.to).toBe(5);
  });

  it('pages back with `before`, which is exclusive', async () => {
    const window = await readConversationTranscript(42, { limit: 2, before: 4 });
    expect([window.from, window.to]).toEqual([2, 3]);
  });

  it('filters with `search` and reports the matching indices', async () => {
    const window = await readConversationTranscript(42, { search: 'playwright' });
    expect(window.matches).toEqual([4]);
    expect(window.entries).toHaveLength(1);
  });

  it('reads a subagent transcript when asked, and lists them otherwise', async () => {
    mockListSubagents.mockResolvedValue(['subagents/agent-a1']);
    await readConversationTranscript(42, { subagent: 'subagents/agent-a1' });
    expect(mockLoadEntries).toHaveBeenCalledWith('sess-1', '/repo/worktrees/task-7', 'subagents/agent-a1');

    await readConversationTranscript(42);
    expect(mockLoadEntries).toHaveBeenLastCalledWith('sess-1', '/repo/worktrees/task-7', null);
  });
});

describe('renderTranscript', () => {
  it('heads the slice with the tool tally — where a missing connector shows up', async () => {
    const text = renderTranscript(await readConversationTranscript(42, { limit: 1 }));
    expect(text).toContain('Bash×1 (1 errored)');
    expect(text).toContain('errors at entries: 3');
    expect(text).toContain('6 entries (2 UI bookkeeping entries hidden)');
  });

  it('says so when no tool was ever called', () => {
    const text = renderTranscript({
      meta: {
        conversationId: 1,
        name: null,
        provider: 'anthropic',
        model: null,
        sessionId: 's',
        cwd: '/repo',
        subagent: null,
        totalEntries: 0,
        hiddenEntries: 0,
        toolUsage: [],
        subagents: [],
        errorIndices: [],
      },
      entries: [],
      from: null,
      to: null,
      matches: null,
    });
    expect(text).toContain('(no tool was ever called)');
    expect(text).toContain('nothing in this window');
  });

  it('truncates a long block and says how to open it', async () => {
    const text = renderTranscript(await readConversationTranscript(42, { limit: 2, before: 4 }));
    expect(text).toContain('more chars — expand with expand="call-1"');
    expect(text).toContain('tool_result Bash (call-1) [ERROR]');
  });

  it('opens exactly the block named by `expand`, by tool id or by entry index', async () => {
    const window = await readConversationTranscript(42, { limit: 2, before: 4 });
    const byTool = renderTranscript(window, { expand: 'call-1' });
    expect(byTool).not.toContain('more chars — expand');
    expect(byTool).toContain('x'.repeat(2000));

    const byIndex = renderTranscript(window, { expand: '#3' });
    expect(byIndex).toContain('x'.repeat(2000));
  });

  it('offers the back-page cursor until the start of the run is reached', async () => {
    expect(renderTranscript(await readConversationTranscript(42, { limit: 2 }))).toContain(
      'page back with before=4',
    );
    expect(
      renderTranscript(await readConversationTranscript(42, { limit: 2, before: 2 })),
    ).toContain('this is the start of the run');
  });
});
