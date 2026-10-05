/**
 * Per-connection wiring for the WebSocket server.
 *
 * `index.ts` owns the upgrade (auth lives in its `verifyClient`) and the
 * heartbeat loop; everything that happens on an accepted socket is installed
 * here, so it can be exercised against a real `WebSocketServer` in tests
 * without booting the app.
 */
import type { WebSocket, WebSocketServer } from 'ws';
import type {
  BroadcastToConversationSubscribersFn,
  BroadcastToEpicSubscribersFn,
  BroadcastToTaskSubscribersFn,
} from '@shared/websocket/messages';
import { cleanupClientSubscriptions, dispatchClientMessage } from './dispatch.js';
import { getSafeRequestPath } from './verifyClient.js';
import type { AuthenticatedUpgradeRequest } from './verifyClient.js';

/** A socket carrying the liveness flag the heartbeat loop in `index.ts` reads. */
export interface HeartbeatWebSocket extends WebSocket {
  isAlive?: boolean;
}

export interface ConnectionDeps {
  wss: WebSocketServer;
  broadcastToTaskSubscribersFn: BroadcastToTaskSubscribersFn;
  broadcastToConversationSubscribersFn: BroadcastToConversationSubscribersFn;
  broadcastToEpicSubscribersFn: BroadcastToEpicSubscribersFn;
}

/**
 * Keep one misbehaving client from taking the whole process down.
 *
 * `ws` reports a protocol violation — an unmasked frame, a bad close code,
 * an oversized message — by emitting `'error'` on that socket, and an
 * EventEmitter with no `'error'` listener throws. The throw surfaces from the
 * socket's data handler, where nothing catches it: on 2026-09-02 the backend
 * died twice on `WS_ERR_EXPECTED_MASK`, taking every in-flight turn with it.
 *
 * For a protocol violation, `ws` has already started a closing handshake
 * (`close(1002)`) by the time this listener runs. `terminate()` skips waiting
 * for a close frame the offending peer may never send; the `'close'` event it
 * triggers runs the same subscription cleanup as any other disconnect, so
 * nothing else is needed here.
 */
export function guardSocketErrors(ws: WebSocket, userId: number | undefined): void {
  ws.on('error', (err: Error) => {
    const code = (err as { code?: string }).code ?? 'n/a';
    console.warn(
      `[WS] Socket error (code ${code}, user ${userId ?? 'unknown'}): ${err.message} — terminating this connection`,
    );
    ws.terminate();
  });
}

/**
 * Build the `wss.on('connection')` listener: guard the socket, route it by
 * path, and wire the chat message loop onto `/ws`.
 */
export function makeConnectionHandler(
  deps: ConnectionDeps,
): (ws: WebSocket, request: AuthenticatedUpgradeRequest) => void {
  return (ws, request) => {
    const userId = request.user?.id;
    // Every accepted socket, whatever path it asked for: a socket being
    // closed for an unknown path can still be fed a bad frame.
    guardSocketErrors(ws, userId);

    const pathname = getSafeRequestPath(request.url);
    console.log('[INFO] Client connected to:', pathname);

    if (pathname === '/ws') {
      handleChatConnection(ws, userId, deps);
    } else {
      console.log('[WARN] Unknown WebSocket path:', pathname);
      ws.close();
    }
  };
}

function handleChatConnection(
  ws: WebSocket,
  userId: number | undefined,
  deps: ConnectionDeps,
): void {
  console.log('[INFO] Chat WebSocket connected');

  const hws = ws as HeartbeatWebSocket;
  hws.isAlive = true;
  ws.on('pong', () => {
    hws.isAlive = true;
  });

  const ctx = {
    ws,
    wss: deps.wss,
    userId,
    broadcastToTaskSubscribersFn: deps.broadcastToTaskSubscribersFn,
    broadcastToConversationSubscribersFn: deps.broadcastToConversationSubscribersFn,
    broadcastToEpicSubscribersFn: deps.broadcastToEpicSubscribersFn,
  };

  ws.on('message', async (message: Buffer | ArrayBuffer | Buffer[]) => {
    let data: unknown;
    try {
      const text = Array.isArray(message)
        ? Buffer.concat(message).toString('utf8')
        : Buffer.from(message as ArrayBuffer).toString('utf8');
      data = JSON.parse(text);
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : JSON.stringify(error);
      console.error('[ERROR] Chat WebSocket parse error:', errMessage);
      ws.send(JSON.stringify({ type: 'error', error: errMessage }));
      return;
    }

    if (typeof (data as { type?: unknown })?.type !== 'string') {
      // Malformed/unknown payload — silently drop, matching prior behavior.
      return;
    }

    try {
      await dispatchClientMessage(ctx, data as Parameters<typeof dispatchClientMessage>[1]);
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket dispatch error:', errMessage);
      ws.send(JSON.stringify({ type: 'error', error: errMessage }));
    }
  });

  ws.on('close', () => {
    console.log('🔌 Chat client disconnected');
    cleanupClientSubscriptions(ws);
  });
}
