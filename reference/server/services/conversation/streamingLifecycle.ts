// Universal streaming lifecycle: WebSocket broadcasts and activeStreamingSessions
// bookkeeping. No agent-run knowledge, no notifications — those are composed in
// at the call site from `agentRunLifecycle.ts`.
//
// See ./types.ts for StreamingContext.

import { activeStreamingSessions } from './sessionState.js';
import type { StreamingContext } from './types.js';

/**
 * Handle streaming started event. Broadcasts to WebSocket clients and
 * registers the session in the active-streaming map.
 *
 * Dual-emits the `streaming-started` event:
 * - on the **conversation** channel (via `broadcastFn`), so the chat page's
 *   "Claude is responding…" indicator lights up.
 * - on the **task** channel (via `broadcastToTaskSubscribersFn`), so the
 *   Dashboard / Board / Task Detail "Live" badge lights up.
 * A WebSocket subscribed to both channels receives the message twice; UI
 * handlers are idempotent so this is acceptable.
 */
export function handleStreamingStarted(context: StreamingContext): void {
  const {
    conversationId,
    taskId,
    claudeSessionId,
    broadcastFn,
    broadcastToTaskSubscribersFn,
  } = context;

  if (claudeSessionId) {
    activeStreamingSessions.set(claudeSessionId, { taskId, conversationId });
  }

  if (broadcastFn) {
    broadcastFn(conversationId, {
      type: 'streaming-started',
      conversationId,
      ...(claudeSessionId ? { claudeSessionId } : {}),
      ...(taskId ? { taskId } : {}),
    });
  }

  if (broadcastToTaskSubscribersFn && taskId) {
    // `taskId` is spliced in by the helper itself.
    broadcastToTaskSubscribersFn(taskId, {
      type: 'streaming-started',
      conversationId,
      ...(claudeSessionId ? { claudeSessionId } : {}),
    });
  }

  console.log(`[ConversationAdapter] Streaming started for conversation ${conversationId}`);
}

/**
 * Handle streaming complete event. Removes the session from the
 * active-streaming map and broadcasts streaming-ended on both the
 * conversation channel and the task channel (see `handleStreamingStarted`
 * for the rationale).
 *
 * No success/failure parameter: from the streaming-loop's point of view a
 * turn either ended or it didn't, and the WebSocket consumers don't care
 * which. Failure is tracked separately on the agent_run row by
 * `abortSession` (user-Stop) and the orphan-recovery sweep on server restart.
 */
export async function handleStreamingComplete(
  context: StreamingContext,
): Promise<void> {
  const {
    conversationId,
    taskId,
    claudeSessionId,
    broadcastFn,
    broadcastToTaskSubscribersFn,
  } = context;

  if (claudeSessionId) {
    activeStreamingSessions.delete(claudeSessionId);
  }

  if (broadcastFn) {
    broadcastFn(conversationId, {
      type: 'streaming-ended',
      conversationId,
      ...(taskId ? { taskId } : {}),
    });
  }

  if (broadcastToTaskSubscribersFn && taskId) {
    broadcastToTaskSubscribersFn(taskId, {
      type: 'streaming-ended',
      conversationId,
    });
  }

  console.log(`[ConversationAdapter] Streaming ended for conversation ${conversationId}`);
}

type AsyncHandler<T> = ((arg: T) => unknown | Promise<unknown>) | null | undefined;

/**
 * Compose async lifecycle handlers. Each handler is awaited in order; a
 * thrown error in one handler is logged and does not stop subsequent handlers
 * from running. Returns a single `(arg) => Promise<void>` suitable for use
 * as an `onComplete` hook.
 */
export function composeAsync<T>(
  ...handlers: Array<AsyncHandler<T>>
): (arg: T) => Promise<void> {
  return async (arg: T) => {
    for (const fn of handlers) {
      if (!fn) continue;
      try {
        await fn(arg);
      } catch (err) {
        console.error('[ConversationAdapter] composed handler failed:', err);
      }
    }
  };
}
