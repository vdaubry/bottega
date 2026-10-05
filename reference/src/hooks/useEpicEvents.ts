/**
 * useEpicEvents — the epic pages' WebSocket lifecycle. Subscribes to the
 * epic channel, which carries for an epic exactly what the task channel
 * carries for a task: agent-run status, conversation lifecycle, streaming
 * start/end. Transcripts still arrive on the conversation channel, because an
 * epic conversation is a normal conversation.
 *
 * Re-subscribes on reconnect (the effect is keyed on `isConnected`), following
 * the app-wide convention.
 */

import { useEffect, useRef } from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import type { EpicId, ServerMessageOf } from '@shared/websocket/messages';

export interface EpicEventHandlers {
  /** Called right before every (re)subscribe — refetch state that may have moved on. */
  onSubscribed?: () => void;
  onAgentRunUpdated?: (msg: ServerMessageOf<'agent-run-updated'>) => void;
  /** The epic row itself changed — a stage was signed off. */
  onEpicUpdated?: (msg: ServerMessageOf<'epic-updated'>) => void;
  onConversationAdded?: (msg: ServerMessageOf<'conversation-added'>) => void;
  /**
   * A conversation was renamed — in practice the AI title landing after its
   * first turn. The Delivery list labels its rows with that name, so it has to
   * re-read them.
   */
  onConversationNameUpdated?: (msg: ServerMessageOf<'conversation-name-updated'>) => void;
  onStreamingStarted?: (msg: ServerMessageOf<'streaming-started'>) => void;
  onStreamingEnded?: (msg: ServerMessageOf<'streaming-ended'>) => void;
}

export function useEpicEvents(
  epicId: EpicId | null | undefined,
  handlers: EpicEventHandlers,
): void {
  const { isConnected, subscribe, unsubscribe, sendMessage } = useWebSocket();
  // Handlers live in a ref so the subscription effect doesn't churn on every
  // page render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!isConnected || !epicId) return;

    const handleAgentRun = (msg: ServerMessageOf<'agent-run-updated'>) => {
      if (msg.epicId !== epicId) return;
      handlersRef.current.onAgentRunUpdated?.(msg);
    };
    const handleEpicUpdated = (msg: ServerMessageOf<'epic-updated'>) => {
      if (msg.epicId !== epicId) return;
      handlersRef.current.onEpicUpdated?.(msg);
    };
    const handleConversationAdded = (msg: ServerMessageOf<'conversation-added'>) => {
      if (msg.epicId !== epicId) return;
      handlersRef.current.onConversationAdded?.(msg);
    };
    const handleConversationNameUpdated = (
      msg: ServerMessageOf<'conversation-name-updated'>,
    ) => {
      if (msg.epicId !== epicId) return;
      handlersRef.current.onConversationNameUpdated?.(msg);
    };
    const handleStreamingStarted = (msg: ServerMessageOf<'streaming-started'>) => {
      if (msg.epicId !== epicId) return;
      handlersRef.current.onStreamingStarted?.(msg);
    };
    const handleStreamingEnded = (msg: ServerMessageOf<'streaming-ended'>) => {
      if (msg.epicId !== epicId) return;
      handlersRef.current.onStreamingEnded?.(msg);
    };

    subscribe('agent-run-updated', handleAgentRun);
    subscribe('epic-updated', handleEpicUpdated);
    subscribe('conversation-added', handleConversationAdded);
    subscribe('conversation-name-updated', handleConversationNameUpdated);
    subscribe('streaming-started', handleStreamingStarted);
    subscribe('streaming-ended', handleStreamingEnded);
    handlersRef.current.onSubscribed?.();
    sendMessage('subscribe-epic', { epicId });

    return () => {
      sendMessage('unsubscribe-epic', { epicId });
      unsubscribe('agent-run-updated', handleAgentRun);
      unsubscribe('epic-updated', handleEpicUpdated);
      unsubscribe('conversation-added', handleConversationAdded);
      unsubscribe('conversation-name-updated', handleConversationNameUpdated);
      unsubscribe('streaming-started', handleStreamingStarted);
      unsubscribe('streaming-ended', handleStreamingEnded);
    };
  }, [epicId, isConnected, sendMessage, subscribe, unsubscribe]);
}

export default useEpicEvents;
