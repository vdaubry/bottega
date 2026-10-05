import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConversationGetById, mockEpicGetById, mockRunByConversation, mockBuildServer } = vi.hoisted(() => ({
  mockConversationGetById: vi.fn(),
  mockEpicGetById: vi.fn(),
  mockRunByConversation: vi.fn(),
  mockBuildServer: vi.fn(),
}));

vi.mock('../../database/conversations.js', () => ({
  conversationsDb: { getById: mockConversationGetById },
}));

vi.mock('../../database/epics.js', () => ({
  epicsDb: { getById: mockEpicGetById },
  epicAgentRunsDb: { getByConversationId: mockRunByConversation },
}));

vi.mock('./bottega/mcpServer.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./bottega/mcpServer.js')>();
  return { ...original, buildBottegaMcpServer: mockBuildServer };
});

import { withBottegaMcpServer } from './bottegaInjection.js';

const EXISTING = { github: { command: 'gh-mcp' } };

beforeEach(() => {
  vi.clearAllMocks();
  mockEpicGetById.mockReturnValue({ id: 7, project_id: 2 });
  mockBuildServer.mockReturnValue({ type: 'sdk', name: 'bottega' });
});

describe('withBottegaMcpServer', () => {
  it('is a no-op for a task conversation', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: 12, epic_id: null });

    expect(withBottegaMcpServer(EXISTING, { conversationId: 5 })).toBe(EXISTING);
    expect(mockBuildServer).not.toHaveBeenCalled();
  });

  it('is a no-op for a conversation that no longer exists', () => {
    mockConversationGetById.mockReturnValue(undefined);

    expect(withBottegaMcpServer(null, { conversationId: 5 })).toBeNull();
  });

  it('is a no-op for an epic conversation with no linked agent run', () => {
    // A manual epic chat: the user talking about the epic outside any stage.
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue(undefined);

    expect(withBottegaMcpServer(EXISTING, { conversationId: 5 })).toBe(EXISTING);
    expect(mockBuildServer).not.toHaveBeenCalled();
  });

  it('merges the server for an architecture conversation — it signs its own stage off', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-architecture' });

    const result = withBottegaMcpServer(EXISTING, { conversationId: 5, userId: 1 });

    expect(result).toEqual({ ...EXISTING, bottega: { type: 'sdk', name: 'bottega' } });
    expect(mockBuildServer).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: 7, agentType: 'epic-architecture', conversationId: 5 }),
    );
  });

  it('merges the server for a specification conversation, keeping the existing config', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-specification' });
    const broadcast = vi.fn();

    const result = withBottegaMcpServer(EXISTING, {
      conversationId: 5,
      userId: 1,
      broadcastToEpicSubscribersFn: broadcast,
    });

    expect(result).toEqual({ ...EXISTING, bottega: { type: 'sdk', name: 'bottega' } });
    expect(mockBuildServer).toHaveBeenCalledWith({
      projectId: 2,
      epicId: 7,
      agentType: 'epic-specification',
      conversationId: 5,
      ticketTaskId: null,
      userId: 1,
      broadcastFn: undefined,
      broadcastToTaskSubscribersFn: undefined,
      broadcastToEpicSubscribersFn: broadcast,
    });
  });

  it('carries the orchestrator run\'s ticket into the catalog', () => {
    // The ticket lives on the run row, not on the call: a resume weeks later
    // re-derives the same supervision context as the run's first turn.
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({
      id: 9,
      agent_type: 'epic-orchestrator',
      ticket_task_id: 42,
    });

    withBottegaMcpServer(EXISTING, { conversationId: 5, userId: 1 });

    expect(mockBuildServer).toHaveBeenCalledWith(
      expect.objectContaining({ agentType: 'epic-orchestrator', ticketTaskId: 42 }),
    );
  });

  it('merges the server for a stories conversation too', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-stories' });

    expect(withBottegaMcpServer(EXISTING, { conversationId: 5, userId: 1 })).toEqual({
      ...EXISTING,
      bottega: { type: 'sdk', name: 'bottega' },
    });
    expect(mockBuildServer).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: 7, agentType: 'epic-stories' }),
    );
  });

  it('attaches the server even when the project has no MCP config at all', () => {
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'epic-specification' });

    expect(withBottegaMcpServer(null, { conversationId: 5 })).toEqual({
      bottega: { type: 'sdk', name: 'bottega' },
    });
  });

  it('ignores a task agent type stored against an epic conversation', () => {
    // Defensive: the two run kinds share one table, so the guard is explicit.
    mockConversationGetById.mockReturnValue({ id: 5, task_id: null, epic_id: 7 });
    mockRunByConversation.mockReturnValue({ id: 9, agent_type: 'planification' });

    expect(withBottegaMcpServer(EXISTING, { conversationId: 5 })).toBe(EXISTING);
    expect(mockBuildServer).not.toHaveBeenCalled();
  });
});
