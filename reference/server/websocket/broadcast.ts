// Pure WebSocket broadcast helpers. No state lives here — `dispatch.ts` owns
// the per-connection subscription Maps and curries `broadcastToTaskSubscribers`
// on top of `wss.clients`.

import { WebSocket, type WebSocketServer } from 'ws';
import type { ServerToClientMessage } from '@shared/websocket/messages';

/**
 * Broadcast a message to every connected WebSocket client.
 */
export function broadcastToAll(
  wss: WebSocketServer,
  message: ServerToClientMessage,
): void {
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}
