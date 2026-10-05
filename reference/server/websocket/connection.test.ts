/**
 * The regression here is the whole process dying, so these tests run the real
 * per-connection wiring against a real `WebSocketServer` on an ephemeral port
 * and feed it the exact bytes that killed the service: a fake socket that
 * never emits `'error'` would prove nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

// The handler routes messages through dispatch.ts, whose imports would open
// the SQLite database and the provider adapters; same mocks as dispatch.test.ts.
vi.mock('../services/conversationAdapter.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  abortSession: vi.fn().mockResolvedValue(true),
  isSessionActive: vi.fn().mockReturnValue(true),
  getActiveSessions: vi.fn().mockReturnValue([]),
  getActiveStreamingByConversation: vi.fn().mockReturnValue(null),
  resolveAskUserQuestion: vi.fn().mockResolvedValue({ kind: 'ok' }),
}));

vi.mock('../database/db.js', () => ({
  conversationsDb: {
    getById: vi.fn(),
    findByClaudeSessionId: vi.fn(),
  },
  tasksDb: {
    getById: vi.fn(),
  },
  projectMembersDb: {
    isMember: vi.fn(),
  },
}));

vi.mock('../database/epics.js', () => ({
  epicsDb: {
    getById: vi.fn(),
  },
}));

vi.mock('../services/projectService.js', () => ({
  hasProjectAccess: vi.fn(),
}));

vi.mock('../services/conversation/sessionState.js', () => ({
  activeSessions: new Map(),
}));

vi.mock('../services/atlas/bridge.js', () => ({
  resolveAtlasAck: vi.fn(),
}));

import { makeConnectionHandler, type HeartbeatWebSocket } from './connection.js';
import type { AuthenticatedUpgradeRequest } from './verifyClient.js';
import {
  makeBroadcastToTaskSubscribers,
  makeBroadcastToConversationSubscribers,
  makeBroadcastToEpicSubscribers,
  __resetSubscriptionsForTesting,
  __getTaskSubscriptionsForTesting,
} from './dispatch.js';
import { tasksDb } from '../database/db.js';
import { hasProjectAccess } from '../services/projectService.js';

const USER_ID = 7;

/**
 * A text frame ("A") with the MASK bit clear. Every client-to-server frame
 * must be masked (RFC 6455 §5.1); the `ws` receiver answers this with
 * `WS_ERR_EXPECTED_MASK` — the frame from the 2026-09-02 crash.
 */
const UNMASKED_TEXT_FRAME = Buffer.from([0x81, 0x01, 0x41]);

interface Harness {
  server: http.Server;
  wss: WebSocketServer;
  port: number;
  /** Server-side sockets, in connection order. */
  serverSockets: WebSocket[];
  clients: Array<WebSocket | Socket>;
}

let h: Harness;
let warn: MockInstance<typeof console.warn>;

async function startHarness(): Promise<Harness> {
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    // index.ts authenticates in verifyClient and stamps the user on the
    // request; the handler under test only reads the stamp.
    verifyClient: (info: { req: AuthenticatedUpgradeRequest }) => {
      info.req.user = { id: USER_ID, userId: USER_ID, username: 'ws-test' };
      return true;
    },
  });
  const serverSockets: WebSocket[] = [];
  wss.on('connection', (ws) => {
    serverSockets.push(ws);
  });
  wss.on(
    'connection',
    makeConnectionHandler({
      wss,
      broadcastToTaskSubscribersFn: makeBroadcastToTaskSubscribers(wss),
      broadcastToConversationSubscribersFn: makeBroadcastToConversationSubscribers(wss),
      broadcastToEpicSubscribersFn: makeBroadcastToEpicSubscribers(wss),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, wss, port, serverSockets, clients: [] };
}

/** A well-behaved `ws` client, connected. */
async function connectClient(path = '/ws'): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${h.port}${path}`);
  h.clients.push(client);
  await once(client, 'open');
  return client;
}

/**
 * A client that completes the HTTP upgrade and hands back the bare TCP
 * socket, so a test can write frames the `ws` client would never produce.
 */
async function connectRaw(path = '/ws'): Promise<Socket> {
  const req = http.request({
    host: '127.0.0.1',
    port: h.port,
    path,
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    },
  });
  req.end();
  const [, socket] = (await once(req, 'upgrade')) as [http.IncomingMessage, Socket, Buffer];
  // http.request hands the socket over with reading paused; without a reader
  // it would never observe the server hanging up. A reset arrives as 'error'.
  socket.resume();
  socket.on('error', () => {});
  h.clients.push(socket);
  return socket;
}

async function nextMessage(client: WebSocket): Promise<unknown> {
  const [data] = (await once(client, 'message')) as [Buffer];
  return JSON.parse(data.toString('utf8')) as unknown;
}

/**
 * Resolves on 'close'. Not `events.once`: that rejects as soon as the emitter
 * emits 'error', which is exactly what these tests provoke.
 */
function closeOf(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.once('close', () => resolve()));
}

/**
 * Resolves once the server has hung up on a raw TCP client: its FIN arrives
 * as 'end' (the socket http.request hands over does not auto-close on it),
 * a reset as 'close'.
 */
function hangupOf(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    socket.once('end', () => resolve());
    socket.once('close', () => resolve());
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  __resetSubscriptionsForTesting();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  h = await startHarness();
});

afterEach(async () => {
  for (const client of h.clients) {
    if (client instanceof WebSocket) client.terminate();
    else client.destroy();
  }
  for (const ws of h.wss.clients) ws.terminate();
  await new Promise<void>((resolve) => h.wss.close(() => resolve()));
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('makeConnectionHandler', () => {
  describe('a malformed client', () => {
    it('loses only its own connection when it sends an unmasked frame', async () => {
      const bystander = await connectClient();
      const offender = await connectRaw();
      const [bystanderSocket, offenderSocket] = h.serverSockets as [WebSocket, WebSocket];
      __getTaskSubscriptionsForTesting().set(bystanderSocket, new Set([1]));
      __getTaskSubscriptionsForTesting().set(offenderSocket, new Set([1]));

      const offenderClosed = closeOf(offenderSocket);
      const tcpClosed = hangupOf(offender);
      offender.write(UNMASKED_TEXT_FRAME);
      await offenderClosed;
      await tcpClosed;

      // The offender is gone: socket terminated, TCP connection closed, and the
      // 'close' event ran the subscription cleanup.
      expect(offenderSocket.readyState).toBe(WebSocket.CLOSED);
      expect(__getTaskSubscriptionsForTesting().has(offenderSocket)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toContain('WS_ERR_EXPECTED_MASK');
      expect(line).toContain('MASK must be set');
      expect(line).toContain(`user ${USER_ID}`);

      // The bystander is untouched and still served.
      expect(bystanderSocket.readyState).toBe(WebSocket.OPEN);
      expect(__getTaskSubscriptionsForTesting().get(bystanderSocket)).toEqual(new Set([1]));
      const pong = once(bystanderSocket, 'pong');
      bystanderSocket.ping();
      await pong;
      expect(bystander.readyState).toBe(WebSocket.OPEN);
    });

    it('is terminated when it answers the close for an unknown path with a bad frame', async () => {
      const offender = await connectRaw('/not-a-channel');
      const [socket] = h.serverSockets as [WebSocket];
      // The server has sent its close frame; the peer replies with garbage
      // instead of a close frame.
      const closed = closeOf(socket);
      offender.write(UNMASKED_TEXT_FRAME);
      await closed;

      expect(socket.readyState).toBe(WebSocket.CLOSED);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('WS_ERR_EXPECTED_MASK');
    });

    it("logs and terminates only the socket an 'error' is emitted on", async () => {
      await connectClient();
      await connectClient();
      const [first, second] = h.serverSockets as [WebSocket, WebSocket];

      const closed = closeOf(first);
      const err = Object.assign(new Error('boom'), { code: 'E_TEST' });
      expect(() => first.emit('error', err)).not.toThrow();
      await closed;

      expect(first.readyState).toBe(WebSocket.CLOSED);
      expect(second.readyState).toBe(WebSocket.OPEN);
      expect(String(warn.mock.calls[0]?.[0])).toContain('(code E_TEST, user 7): boom');
    });
  });

  describe('the chat socket', () => {
    it('routes messages through dispatch and drops subscriptions on close', async () => {
      vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, project_id: 3 } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      const client = await connectClient();
      const [socket] = h.serverSockets as [WebSocket];

      const reply = nextMessage(client);
      client.send(JSON.stringify({ type: 'subscribe-task', taskId: 7 }));
      expect(await reply).toEqual({ type: 'task-subscribed', taskId: 7, success: true });
      expect(__getTaskSubscriptionsForTesting().get(socket)).toEqual(new Set([7]));

      const closed = closeOf(socket);
      client.close();
      await closed;
      expect(__getTaskSubscriptionsForTesting().has(socket)).toBe(false);
    });

    it('answers an unparseable payload in-band instead of failing the socket', async () => {
      const client = await connectClient();
      const [socket] = h.serverSockets as [WebSocket];

      const reply = nextMessage(client);
      client.send('not json');
      expect(await reply).toMatchObject({ type: 'error' });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    });

    it('marks the socket alive again on pong', async () => {
      await connectClient();
      const [socket] = h.serverSockets as [HeartbeatWebSocket];
      expect(socket.isAlive).toBe(true);

      socket.isAlive = false;
      const pong = once(socket, 'pong');
      socket.ping();
      await pong;
      expect(socket.isAlive).toBe(true);
    });
  });
});
