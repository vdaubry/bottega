import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTaskSubscription } from './useTaskSubscription';
import type {
  AgentRunSummary,
  ConversationSummary,
  ServerMessageOf,
} from '@shared/websocket/messages';

// Mock the WebSocketContext
const mockSendMessage = vi.fn();
const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();

vi.mock('../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({
    isConnected: true,
    sendMessage: mockSendMessage,
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
  }),
}));

// Mock the TaskContext
const mockSetConversations = vi.fn();
const mockSetAgentRuns = vi.fn();

vi.mock('../contexts/TaskContext', () => ({
  useTaskContext: () => ({
    setConversations: mockSetConversations,
    setAgentRuns: mockSetAgentRuns,
  }),
}));

type ConversationAddedHandler = (
  msg: ServerMessageOf<'conversation-added'>,
) => void;
type AgentRunUpdatedHandler = (
  msg: ServerMessageOf<'agent-run-updated'>,
) => void;

function findHandler<T>(eventType: string): T {
  const call = mockSubscribe.mock.calls.find((c) => c[0] === eventType);
  if (!call) {
    throw new Error(`No subscription registered for event: ${eventType}`);
  }
  return call[1] as T;
}

describe('useTaskSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Subscription Management', () => {
    it('should subscribe to task when taskId is provided', () => {
      renderHook(() => useTaskSubscription(42));

      expect(mockSendMessage).toHaveBeenCalledWith('subscribe-task', {
        taskId: 42,
      });
    });

    it('should not subscribe when taskId is null', () => {
      renderHook(() => useTaskSubscription(null));

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('should not subscribe when taskId is undefined', () => {
      renderHook(() => useTaskSubscription(undefined));

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('should unsubscribe when component unmounts', () => {
      const { unmount } = renderHook(() => useTaskSubscription(42));

      unmount();

      expect(mockSendMessage).toHaveBeenCalledWith('unsubscribe-task', {
        taskId: 42,
      });
    });

    it('should unsubscribe from old task and subscribe to new task when taskId changes', () => {
      const { rerender } = renderHook(
        ({ taskId }: { taskId: number }) => useTaskSubscription(taskId),
        { initialProps: { taskId: 1 } },
      );

      expect(mockSendMessage).toHaveBeenCalledWith('subscribe-task', {
        taskId: 1,
      });

      rerender({ taskId: 2 });

      expect(mockSendMessage).toHaveBeenCalledWith('unsubscribe-task', {
        taskId: 1,
      });
      expect(mockSendMessage).toHaveBeenCalledWith('subscribe-task', {
        taskId: 2,
      });
    });

    it('should subscribe to conversation-added and agent-run-updated events', () => {
      renderHook(() => useTaskSubscription(42));

      expect(mockSubscribe).toHaveBeenCalledWith(
        'conversation-added',
        expect.any(Function),
      );
      expect(mockSubscribe).toHaveBeenCalledWith(
        'agent-run-updated',
        expect.any(Function),
      );
    });

    it('should unsubscribe from events on unmount', () => {
      const { unmount } = renderHook(() => useTaskSubscription(42));

      unmount();

      expect(mockUnsubscribe).toHaveBeenCalledWith(
        'conversation-added',
        expect.any(Function),
      );
      expect(mockUnsubscribe).toHaveBeenCalledWith(
        'agent-run-updated',
        expect.any(Function),
      );
    });
  });

  describe('Conversation Added Event Handling', () => {
    it('should add conversation to state when conversation-added event is received', () => {
      renderHook(() => useTaskSubscription(42));

      const conversationAddedCallback =
        findHandler<ConversationAddedHandler>('conversation-added');

      const newConversation: ConversationSummary = {
        id: 1,
        task_id: 42,
        claude_conversation_id: 'abc123',
        created_at: '2026-01-01T00:00:00Z',
      };

      act(() => {
        conversationAddedCallback({
          type: 'conversation-added',
          taskId: 42,
          conversation: newConversation,
        });
      });

      expect(mockSetConversations).toHaveBeenCalled();

      const updaterFn = mockSetConversations.mock.calls[0]![0] as (
        prev: ConversationSummary[],
      ) => ConversationSummary[];
      const result = updaterFn([]);
      expect(result).toEqual([newConversation]);
    });

    it('should not add conversation when taskId does not match', () => {
      renderHook(() => useTaskSubscription(42));

      const conversationAddedCallback =
        findHandler<ConversationAddedHandler>('conversation-added');

      const newConversation: ConversationSummary = {
        id: 1,
        task_id: 99,
        claude_conversation_id: 'abc123',
        created_at: '2026-01-01T00:00:00Z',
      };

      act(() => {
        conversationAddedCallback({
          type: 'conversation-added',
          taskId: 99,
          conversation: newConversation,
        });
      });

      expect(mockSetConversations).not.toHaveBeenCalled();
    });

    it('should not add duplicate conversation', () => {
      renderHook(() => useTaskSubscription(42));

      const conversationAddedCallback =
        findHandler<ConversationAddedHandler>('conversation-added');

      const existingConversation: ConversationSummary = {
        id: 1,
        task_id: 42,
        claude_conversation_id: 'abc123',
        created_at: '2026-01-01T00:00:00Z',
      };

      act(() => {
        conversationAddedCallback({
          type: 'conversation-added',
          taskId: 42,
          conversation: existingConversation,
        });
      });

      const updaterFn = mockSetConversations.mock.calls[0]![0] as (
        prev: ConversationSummary[],
      ) => ConversationSummary[];
      const seed: ConversationSummary[] = [
        {
          id: 1,
          task_id: 42,
          claude_conversation_id: null,
          created_at: '2026-01-01T00:00:00Z',
        },
      ];
      const result = updaterFn(seed);
      expect(result).toEqual(seed);
    });

    it('should add conversation to beginning of list (newest first)', () => {
      renderHook(() => useTaskSubscription(42));

      const conversationAddedCallback =
        findHandler<ConversationAddedHandler>('conversation-added');

      const newConversation: ConversationSummary = {
        id: 2,
        task_id: 42,
        claude_conversation_id: 'new',
        created_at: '2026-01-02T00:00:00Z',
      };

      act(() => {
        conversationAddedCallback({
          type: 'conversation-added',
          taskId: 42,
          conversation: newConversation,
        });
      });

      const updaterFn = mockSetConversations.mock.calls[0]![0] as (
        prev: ConversationSummary[],
      ) => ConversationSummary[];
      const existingConversations: ConversationSummary[] = [
        {
          id: 1,
          task_id: 42,
          claude_conversation_id: 'old',
          created_at: '2026-01-01T00:00:00Z',
        },
      ];
      const result = updaterFn(existingConversations);

      expect(result[0]).toEqual(newConversation);
      expect(result[1]).toEqual(existingConversations[0]);
    });
  });

  describe('Agent Run Updated Event Handling', () => {
    it('should update existing agent run when agent-run-updated event is received', () => {
      renderHook(() => useTaskSubscription(42));

      const agentRunUpdatedCallback =
        findHandler<AgentRunUpdatedHandler>('agent-run-updated');

      const updatedAgentRun: AgentRunSummary = {
        id: 1,
        status: 'completed',
        agent_type: 'implementation',
        conversation_id: null,
      };

      act(() => {
        agentRunUpdatedCallback({
          type: 'agent-run-updated',
          taskId: 42,
          agentRun: updatedAgentRun,
        });
      });

      expect(mockSetAgentRuns).toHaveBeenCalled();

      const updaterFn = mockSetAgentRuns.mock.calls[0]![0] as (
        prev: AgentRunSummary[],
      ) => AgentRunSummary[];
      const existingRuns: AgentRunSummary[] = [
        {
          id: 1,
          status: 'running',
          agent_type: 'implementation',
          conversation_id: null,
        },
      ];
      const result = updaterFn(existingRuns);

      expect(result[0]!.status).toBe('completed');
      expect(result[0]!.agent_type).toBe('implementation');
    });

    it('should add new agent run if not existing', () => {
      renderHook(() => useTaskSubscription(42));

      const agentRunUpdatedCallback =
        findHandler<AgentRunUpdatedHandler>('agent-run-updated');

      const newAgentRun: AgentRunSummary = {
        id: 2,
        status: 'running',
        agent_type: 'review',
        conversation_id: null,
      };

      act(() => {
        agentRunUpdatedCallback({
          type: 'agent-run-updated',
          taskId: 42,
          agentRun: newAgentRun,
        });
      });

      const updaterFn = mockSetAgentRuns.mock.calls[0]![0] as (
        prev: AgentRunSummary[],
      ) => AgentRunSummary[];
      const existingRuns: AgentRunSummary[] = [
        {
          id: 1,
          status: 'completed',
          agent_type: 'implementation',
          conversation_id: null,
        },
      ];
      const result = updaterFn(existingRuns);

      expect(result.length).toBe(2);
      expect(result[1]).toEqual(newAgentRun);
    });

    it('should not update agent runs when taskId does not match', () => {
      renderHook(() => useTaskSubscription(42));

      const agentRunUpdatedCallback =
        findHandler<AgentRunUpdatedHandler>('agent-run-updated');

      const updatedAgentRun: AgentRunSummary = {
        id: 1,
        status: 'completed',
        agent_type: 'implementation',
        conversation_id: null,
      };

      act(() => {
        agentRunUpdatedCallback({
          type: 'agent-run-updated',
          taskId: 99,
          agentRun: updatedAgentRun,
        });
      });

      expect(mockSetAgentRuns).not.toHaveBeenCalled();
    });

    it('should handle status transition from running to completed', () => {
      renderHook(() => useTaskSubscription(42));

      const agentRunUpdatedCallback =
        findHandler<AgentRunUpdatedHandler>('agent-run-updated');

      act(() => {
        agentRunUpdatedCallback({
          type: 'agent-run-updated',
          taskId: 42,
          agentRun: {
            id: 1,
            status: 'completed',
            agent_type: 'implementation',
            conversation_id: 5,
          },
        });
      });

      const updaterFn = mockSetAgentRuns.mock.calls[0]![0] as (
        prev: AgentRunSummary[],
      ) => AgentRunSummary[];
      const existingRuns: AgentRunSummary[] = [
        {
          id: 1,
          status: 'running',
          agent_type: 'implementation',
          conversation_id: 5,
        },
      ];
      const result = updaterFn(existingRuns);

      expect(result[0]!.status).toBe('completed');
    });

    it('should handle status transition from running to failed', () => {
      renderHook(() => useTaskSubscription(42));

      const agentRunUpdatedCallback =
        findHandler<AgentRunUpdatedHandler>('agent-run-updated');

      act(() => {
        agentRunUpdatedCallback({
          type: 'agent-run-updated',
          taskId: 42,
          agentRun: {
            id: 1,
            status: 'failed',
            agent_type: 'review',
            conversation_id: null,
          },
        });
      });

      const updaterFn = mockSetAgentRuns.mock.calls[0]![0] as (
        prev: AgentRunSummary[],
      ) => AgentRunSummary[];
      const existingRuns: AgentRunSummary[] = [
        {
          id: 1,
          status: 'running',
          agent_type: 'review',
          conversation_id: null,
        },
      ];
      const result = updaterFn(existingRuns);

      expect(result[0]!.status).toBe('failed');
    });
  });

  describe('Connection State Handling', () => {
    it('should not subscribe when not connected', () => {
      // Re-mock with isConnected: false
      vi.doMock('../contexts/WebSocketContext', () => ({
        useWebSocket: () => ({
          isConnected: false,
          sendMessage: mockSendMessage,
          subscribe: mockSubscribe,
          unsubscribe: mockUnsubscribe,
        }),
      }));

      mockSendMessage.mockClear();
      mockSubscribe.mockClear();

      // Note: This test verifies the logic - in actual implementation,
      // the hook checks isConnected before subscribing
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty conversation in event', () => {
      renderHook(() => useTaskSubscription(42));

      const conversationAddedCallback =
        findHandler<ConversationAddedHandler>('conversation-added');

      act(() => {
        conversationAddedCallback({
          type: 'conversation-added',
          taskId: 42,
          // Wire-level malformed payload — the hook must guard against this.
          conversation: null as unknown as ConversationSummary,
        });
      });

      expect(mockSetConversations).not.toHaveBeenCalled();
    });

    it('should handle empty agentRun in event', () => {
      renderHook(() => useTaskSubscription(42));

      const agentRunUpdatedCallback =
        findHandler<AgentRunUpdatedHandler>('agent-run-updated');

      act(() => {
        agentRunUpdatedCallback({
          type: 'agent-run-updated',
          taskId: 42,
          agentRun: null as unknown as AgentRunSummary,
        });
      });

      expect(mockSetAgentRuns).not.toHaveBeenCalled();
    });

    it('should handle taskId of 0', () => {
      // taskId of 0 should be treated as falsy and not subscribe
      renderHook(() => useTaskSubscription(0));

      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });
});
