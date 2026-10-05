/**
 * useAtlasEvents — the Explore view's WebSocket lifecycle. Subscribes to the
 * task's atlas channel, routes the three agent-driven UI commands to the
 * page's handlers, and sends the `atlas-ack` each command requires (the MCP
 * tool result only reports success once a view actually applied the change —
 * the CodeAtlas UiBridge protocol over Bottega's WS).
 */

import { useEffect, useRef } from 'react';
import { useWebSocket } from '../../contexts/WebSocketContext';
import type { ServerMessageOf, TaskId } from '@shared/websocket/messages';

export interface AtlasEventHandlers {
  /** Apply the command synchronously; throw to ack with an error. */
  onOpenFile: (msg: ServerMessageOf<'atlas-open-file'>) => void;
  onHighlight: (msg: ServerMessageOf<'atlas-highlight'>) => void;
  /** Resolve with a short ack-detail JSON; reject to ack the error. */
  onRenderArtifact: (msg: ServerMessageOf<'atlas-render-artifact'>) => Promise<string>;
  /** Called on every (re)subscribe — refetch state changed while away. */
  onSubscribed: () => void;
}

export function useAtlasEvents(taskId: TaskId | null | undefined, handlers: AtlasEventHandlers): void {
  const { isConnected, subscribe, unsubscribe, sendMessage } = useWebSocket();
  // Handlers live in a ref so the subscription effect doesn't churn on every
  // page render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!isConnected || !taskId) return;

    sendMessage('subscribe-atlas', { taskId });
    // Re-fetch on every (re)subscribe — an agent may have rendered an artifact
    // while this client was disconnected.
    handlersRef.current.onSubscribed();

    const ack = (requestId: string, error?: string, detail?: string) => {
      sendMessage('atlas-ack', {
        taskId,
        requestId,
        ...(error !== undefined ? { error } : {}),
        ...(detail !== undefined ? { detail } : {}),
      });
    };

    const handleOpenFile = (msg: ServerMessageOf<'atlas-open-file'>) => {
      if (msg.taskId !== taskId) return;
      try {
        handlersRef.current.onOpenFile(msg);
        ack(msg.requestId);
      } catch (err) {
        ack(msg.requestId, err instanceof Error ? err.message : String(err));
      }
    };

    const handleHighlight = (msg: ServerMessageOf<'atlas-highlight'>) => {
      if (msg.taskId !== taskId) return;
      try {
        handlersRef.current.onHighlight(msg);
        ack(msg.requestId);
      } catch (err) {
        ack(msg.requestId, err instanceof Error ? err.message : String(err));
      }
    };

    const handleRenderArtifact = (msg: ServerMessageOf<'atlas-render-artifact'>) => {
      if (msg.taskId !== taskId) return;
      handlersRef.current
        .onRenderArtifact(msg)
        .then((detail) => ack(msg.requestId, undefined, detail))
        .catch((err: unknown) =>
          ack(msg.requestId, err instanceof Error ? err.message : String(err)),
        );
    };

    subscribe('atlas-open-file', handleOpenFile);
    subscribe('atlas-highlight', handleHighlight);
    subscribe('atlas-render-artifact', handleRenderArtifact);

    return () => {
      sendMessage('unsubscribe-atlas', { taskId });
      unsubscribe('atlas-open-file', handleOpenFile);
      unsubscribe('atlas-highlight', handleHighlight);
      unsubscribe('atlas-render-artifact', handleRenderArtifact);
    };
  }, [taskId, isConnected, sendMessage, subscribe, unsubscribe]);
}

export default useAtlasEvents;
