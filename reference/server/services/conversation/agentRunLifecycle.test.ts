import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../database/conversations.js', () => ({
  conversationsDb: { getById: vi.fn() },
}));

import { conversationsDb } from '../../database/conversations.js';
import {
  assertAgentRunTurnCanStart,
  buildAgentRunCompletionHandler,
  failLinkedAgentRunIfRunning,
  handleAgentRunTurnStarted,
} from './agentRunLifecycle.js';
import { registerOwnerAdapter } from './ownerAdapters.js';
import type { ConversationOwnerAdapter } from './ownerAdapters.js';

// The runtime module under test is a pure dispatcher: it must route by the
// conversation's owner and never look inside either domain itself.
function fakeAdapter(kind: 'task' | 'epic'): ConversationOwnerAdapter {
  return {
    kind,
    resolveScope: vi.fn(),
    resolveOwner: vi.fn(),
    linkedRun: vi.fn().mockReturnValue(null),
    assertTurnCanStart: vi.fn(),
    interruptLinkedRun: vi.fn().mockReturnValue(null),
    failLinkedRunIfRunning: vi.fn().mockReturnValue(null),
    onTurnStarted: vi.fn().mockResolvedValue(undefined),
    onTurnEnded: vi.fn().mockResolvedValue(undefined),
    onQuestionParked: vi.fn(),
    sweepOrphans: vi.fn(),
    augmentMcpServers: vi.fn((s) => s),
    extraDisallowedTools: vi.fn().mockReturnValue([]),
    extraPreToolUseHooks: vi.fn().mockReturnValue([]),
    assertProviderAllowed: vi.fn(),
  };
}

let taskAdapter: ConversationOwnerAdapter;
let epicAdapter: ConversationOwnerAdapter;

beforeEach(() => {
  vi.clearAllMocks();
  taskAdapter = fakeAdapter('task');
  epicAdapter = fakeAdapter('epic');
  registerOwnerAdapter(taskAdapter);
  registerOwnerAdapter(epicAdapter);
});

describe('assertAgentRunTurnCanStart', () => {
  it('dispatches the pre-provider concurrency check by conversation owner', () => {
    vi.mocked(conversationsDb.getById).mockReturnValue({
      id: 100,
      owner_kind: 'epic',
    } as never);

    assertAgentRunTurnCanStart(100);

    expect(epicAdapter.assertTurnCanStart).toHaveBeenCalledWith(100);
    expect(taskAdapter.assertTurnCanStart).not.toHaveBeenCalled();
  });
});

describe('buildAgentRunCompletionHandler', () => {
  it('routes a task conversation turn end to the task adapter', async () => {
    const ctx = { conversationId: 100, taskId: 7, epicId: null } as never;
    await buildAgentRunCompletionHandler(ctx)();

    expect(taskAdapter.onTurnEnded).toHaveBeenCalledWith(ctx);
    expect(epicAdapter.onTurnEnded).not.toHaveBeenCalled();
  });

  it('routes an epic conversation turn end to the epic adapter', async () => {
    const ctx = { conversationId: 5, taskId: null, epicId: 42 } as never;
    await buildAgentRunCompletionHandler(ctx)();

    expect(epicAdapter.onTurnEnded).toHaveBeenCalledWith(ctx);
    expect(taskAdapter.onTurnEnded).not.toHaveBeenCalled();
  });

  it('is a no-op when the context names neither owner', async () => {
    await buildAgentRunCompletionHandler({ conversationId: 1 } as never)();

    expect(taskAdapter.onTurnEnded).not.toHaveBeenCalled();
    expect(epicAdapter.onTurnEnded).not.toHaveBeenCalled();
  });
});

describe('handleAgentRunTurnStarted', () => {
  it('dispatches the start to the epic owner before streaming is announced', async () => {
    const ctx = { conversationId: 100, epicId: 7, taskId: null } as never;

    await handleAgentRunTurnStarted(ctx);

    expect(epicAdapter.onTurnStarted).toHaveBeenCalledWith(ctx);
    expect(taskAdapter.onTurnStarted).not.toHaveBeenCalled();
  });
});

describe('failLinkedAgentRunIfRunning', () => {
  it('dispatches by the conversation owner_kind', () => {
    vi.mocked(conversationsDb.getById).mockReturnValue({
      id: 100,
      owner_kind: 'epic',
    } as never);
    vi.mocked(epicAdapter.failLinkedRunIfRunning).mockReturnValue({
      id: 9,
      agent_type: 'epic-pr-review',
      status: 'running',
      conversation_id: 100,
    });

    failLinkedAgentRunIfRunning(100);

    expect(epicAdapter.failLinkedRunIfRunning).toHaveBeenCalledWith(100);
    expect(taskAdapter.failLinkedRunIfRunning).not.toHaveBeenCalled();
  });

  it('never throws, even when the conversation is missing or the adapter fails', () => {
    vi.mocked(conversationsDb.getById).mockReturnValue(undefined);
    expect(() => failLinkedAgentRunIfRunning(1)).not.toThrow();

    vi.mocked(conversationsDb.getById).mockReturnValue({ id: 1, owner_kind: 'task' } as never);
    vi.mocked(taskAdapter.failLinkedRunIfRunning).mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => failLinkedAgentRunIfRunning(1)).not.toThrow();
  });
});
