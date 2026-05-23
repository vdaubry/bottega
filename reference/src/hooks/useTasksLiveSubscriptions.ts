/**
 * useTasksLiveSubscriptions Hook
 *
 * Subscribes the WebSocket to a *set* of task ids so the client receives
 * task-channel events (`streaming-started`, `streaming-ended`,
 * `agent-run-updated`, `task-blocked`, `conversation-added`,
 * `conversation-name-updated`) for any of them.
 *
 * This is what powers the Dashboard / Board "Live" badge between REST
 * snapshots: the dashboard and board call this with the task ids they're
 * currently rendering, and TaskContext's global `streaming-started` /
 * `streaming-ended` listeners pick up the events on subscribed tasks.
 *
 * The hook is idempotent — adding/removing ids only sends the deltas — and
 * resubscribes everything after a WS reconnection.
 */

import { useEffect, useRef } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import type { TaskId } from '@shared/websocket/messages';

export function useTasksLiveSubscriptions(
  taskIds: ReadonlyArray<TaskId> | null | undefined,
): void {
  const { isConnected, sendMessage } = useWebSocket();
  const subscribedRef = useRef<Set<TaskId>>(new Set());

  useEffect(() => {
    if (!isConnected) {
      // Note: don't clear subscribedRef on disconnect — we want to
      // re-subscribe the same set after reconnect.
      return;
    }

    const wanted = new Set<TaskId>();
    if (taskIds) {
      for (const id of taskIds) {
        if (typeof id === 'number' && Number.isFinite(id)) wanted.add(id);
      }
    }

    // Add new subscriptions
    for (const id of wanted) {
      if (!subscribedRef.current.has(id)) {
        sendMessage('subscribe-task', { taskId: id });
        subscribedRef.current.add(id);
      }
    }
    // Drop subscriptions no longer in the visible set
    for (const id of Array.from(subscribedRef.current)) {
      if (!wanted.has(id)) {
        sendMessage('unsubscribe-task', { taskId: id });
        subscribedRef.current.delete(id);
      }
    }
  }, [taskIds, isConnected, sendMessage]);

  // Re-subscribe after reconnection. The dispatch loop drops subscriptions
  // when the socket closes (`cleanupClientSubscriptions`), so a new socket
  // needs the full set re-sent.
  const wasConnectedRef = useRef(isConnected);
  useEffect(() => {
    const wasConnected = wasConnectedRef.current;
    wasConnectedRef.current = isConnected;
    if (isConnected && !wasConnected) {
      for (const id of subscribedRef.current) {
        sendMessage('subscribe-task', { taskId: id });
      }
    }
  }, [isConnected, sendMessage]);
}

export default useTasksLiveSubscriptions;
