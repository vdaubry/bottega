/**
 * useConversationSubscription Hook
 *
 * Subscribes the current WebSocket to a specific conversation id so the
 * server delivers conversation-scoped messages (`claude-response`,
 * `claude-status`, `claude-complete`, `claude-error`, `session-created`,
 * `context-usage`, `awaiting-user-answer`, `conversation-name-updated`,
 * `streaming-started`, `streaming-ended`) to this client and only this
 * client.
 *
 * Mirrors `useTaskSubscription`. Pass `null`/`undefined`/`0` to unsubscribe.
 */

import { useEffect, useRef } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import type { ConversationId } from '@shared/websocket/messages';

export function useConversationSubscription(
  conversationId: ConversationId | null | undefined,
): void {
  const { isConnected, sendMessage } = useWebSocket();
  const subscribedRef = useRef<ConversationId | null>(null);

  useEffect(() => {
    if (!isConnected || !conversationId) return;

    sendMessage('subscribe-conversation', { conversationId });
    subscribedRef.current = conversationId;
    console.log(
      '[useConversationSubscription] Subscribed to conversation:',
      conversationId,
    );

    return () => {
      sendMessage('unsubscribe-conversation', { conversationId });
      subscribedRef.current = null;
      console.log(
        '[useConversationSubscription] Unsubscribed from conversation:',
        conversationId,
      );
    };
  }, [conversationId, isConnected, sendMessage]);

  // Re-subscribe after reconnection.
  useEffect(() => {
    if (isConnected && subscribedRef.current) {
      sendMessage('subscribe-conversation', {
        conversationId: subscribedRef.current,
      });
      console.log(
        '[useConversationSubscription] Re-subscribed after reconnection:',
        subscribedRef.current,
      );
    }
  }, [isConnected, sendMessage]);
}

export default useConversationSubscription;
