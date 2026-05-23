/**
 * useTaskSubscription Hook
 *
 * Subscribes to real-time task updates via WebSocket.
 * When subscribed, the hook receives and processes:
 * - conversation-added: New conversations created for the task
 * - agent-run-updated: Agent run status changes
 *
 * Updates the TaskContext state directly to provide live updates
 * on the Task Detail page without requiring manual refresh.
 */

import { useEffect, useRef } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import { useTaskContext, type Conversation, type AgentRun } from '../contexts/TaskContext';
import type {
  ServerMessageOf,
  TaskId,
} from '@shared/websocket/messages';

/**
 * Subscribe to real-time updates for a specific task.
 *
 * Pass `null`/`undefined`/`0` to unsubscribe (all treated as falsy).
 */
export function useTaskSubscription(
  taskId: TaskId | null | undefined,
): void {
  const { isConnected, subscribe, unsubscribe, sendMessage } = useWebSocket();
  const { setConversations, setAgentRuns } = useTaskContext();
  const subscribedTaskRef = useRef<TaskId | null>(null);

  useEffect(() => {
    if (!isConnected || !taskId) return;

    sendMessage('subscribe-task', { taskId });
    subscribedTaskRef.current = taskId;
    console.log('[useTaskSubscription] Subscribed to task:', taskId);

    const handleConversationAdded = (
      msg: ServerMessageOf<'conversation-added'>,
    ) => {
      if (msg.taskId === taskId && msg.conversation) {
        console.log(
          '[useTaskSubscription] Conversation added:',
          msg.conversation.id,
        );
        // ConversationSummary from the WS message is structurally narrower
        // than ConversationRow (the state type); the runtime payload only
        // carries the subset consumers use, so cast at the boundary.
        const incoming = msg.conversation as unknown as Conversation;
        setConversations((prev) => {
          if (prev.some((c) => c.id === incoming.id)) return prev;
          return [incoming, ...prev];
        });
      }
    };

    const handleAgentRunUpdated = (
      msg: ServerMessageOf<'agent-run-updated'>,
    ) => {
      if (msg.taskId === taskId && msg.agentRun) {
        console.log(
          '[useTaskSubscription] Agent run updated:',
          msg.agentRun.id,
          msg.agentRun.status,
        );
        const incoming = msg.agentRun as unknown as AgentRun;
        setAgentRuns((prev) => {
          const existing = prev.find((run) => run.id === incoming.id);
          if (existing) {
            return prev.map((run) =>
              run.id === incoming.id ? { ...run, ...incoming } : run,
            );
          }
          return [...prev, incoming];
        });
      }
    };

    const handleConversationNameUpdated = (
      msg: ServerMessageOf<'conversation-name-updated'>,
    ) => {
      // The message is dual-emitted on both the task channel and the
      // conversation channel — gate on `msg.taskId` so a hook subscribed to a
      // different task doesn't apply a rename it shouldn't see, and so the
      // conversation-channel copy (which has no taskId match) is ignored.
      if (msg.taskId !== taskId || !msg.conversationId || !msg.name) return;
      console.log(
        '[useTaskSubscription] Conversation name updated:',
        msg.conversationId,
        msg.name,
      );
      setConversations((prev) =>
        prev.map((c) =>
          c.id === msg.conversationId ? { ...c, name: msg.name } : c,
        ),
      );
    };

    subscribe('conversation-added', handleConversationAdded);
    subscribe('agent-run-updated', handleAgentRunUpdated);
    subscribe('conversation-name-updated', handleConversationNameUpdated);

    return () => {
      sendMessage('unsubscribe-task', { taskId });
      subscribedTaskRef.current = null;
      unsubscribe('conversation-added', handleConversationAdded);
      unsubscribe('agent-run-updated', handleAgentRunUpdated);
      unsubscribe(
        'conversation-name-updated',
        handleConversationNameUpdated,
      );
      console.log('[useTaskSubscription] Unsubscribed from task:', taskId);
    };
  }, [
    taskId,
    isConnected,
    sendMessage,
    subscribe,
    unsubscribe,
    setConversations,
    setAgentRuns,
  ]);

  // Re-subscribe after reconnection
  useEffect(() => {
    if (isConnected && subscribedTaskRef.current) {
      sendMessage('subscribe-task', { taskId: subscribedTaskRef.current });
      console.log(
        '[useTaskSubscription] Re-subscribed after reconnection:',
        subscribedTaskRef.current,
      );
    }
  }, [isConnected, sendMessage]);
}

export default useTaskSubscription;
