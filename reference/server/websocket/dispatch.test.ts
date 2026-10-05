import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket as WS, WebSocketServer } from 'ws';
import type {
  ClientToServerMessage,
  ServerToClientMessage,
} from '@shared/websocket/messages';

vi.mock('../services/conversationAdapter.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  abortSession: vi.fn().mockResolvedValue(true),
  isSessionActive: vi.fn().mockReturnValue(true),
  getActiveSessions: vi.fn().mockReturnValue([]),
  // Default: no turn in flight, so the busy guard never trips. Tests that
  // exercise the guard override this per-case.
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

// dispatch.ts reads the epic table for channel authorization from the epic
// DB module (it is the epic channel's transport adapter).
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

import {
  dispatchClientMessage,
  cleanupClientSubscriptions,
  makeBroadcastToTaskSubscribers,
  makeBroadcastToConversationSubscribers,
  makeBroadcastToAtlasSubscribers,
  makeGetAtlasSubscriberCount,
  makeBroadcastToEpicSubscribers,
  __resetSubscriptionsForTesting,
  __getTaskSubscriptionsForTesting,
  __getConversationSubscriptionsForTesting,
  __getAtlasSubscriptionsForTesting,
  __getEpicSubscriptionsForTesting,
  type DispatchContext,
} from './dispatch.js';
import { resolveAtlasAck } from '../services/atlas/bridge.js';
import {
  sendMessage as adapterSendMessage,
  abortSession,
  isSessionActive,
  getActiveSessions,
  getActiveStreamingByConversation,
  resolveAskUserQuestion,
} from '../services/conversationAdapter.js';
import { conversationsDb, tasksDb } from '../database/db.js';
import { epicsDb } from '../database/epics.js';
import { hasProjectAccess } from '../services/projectService.js';
import { registerOwnerAdapter } from '../services/conversation/ownerAdapters.js';
import { activeSessions } from '../services/conversation/sessionState.js';

interface FakeWs {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
}

interface FakeWss {
  clients: Set<FakeWs>;
}

function makeWs(): FakeWs {
  return {
    readyState: WS.OPEN,
    send: vi.fn(),
  };
}

interface CtxOverrides {
  ws?: FakeWs;
  wss?: FakeWss;
  userId?: number;
  broadcastToTaskSubscribersFn?: DispatchContext['broadcastToTaskSubscribersFn'];
  broadcastToConversationSubscribersFn?: DispatchContext['broadcastToConversationSubscribersFn'];
  broadcastToEpicSubscribersFn?: DispatchContext['broadcastToEpicSubscribersFn'];
}

function makeCtx(overrides: CtxOverrides = {}): DispatchContext {
  const ws = (overrides.ws ?? makeWs()) as unknown as WS;
  const wss = (overrides.wss ?? {
    clients: new Set([overrides.ws ?? ws]),
  }) as unknown as WebSocketServer;
  return {
    ws,
    wss,
    userId: overrides.userId ?? 42,
    broadcastToTaskSubscribersFn:
      overrides.broadcastToTaskSubscribersFn ?? vi.fn(),
    broadcastToConversationSubscribersFn:
      overrides.broadcastToConversationSubscribersFn ?? vi.fn(),
    broadcastToEpicSubscribersFn: overrides.broadcastToEpicSubscribersFn ?? vi.fn(),
  };
}

function lastSent(ws: FakeWs): ServerToClientMessage {
  const last = ws.send.mock.calls.at(-1);
  if (!last) throw new Error('ws.send was not called');
  return JSON.parse(last[0] as string) as ServerToClientMessage;
}

// Set up the standard "auth always succeeds" world for conversation- and
// task-keyed handlers. Tests that need negative cases override the relevant
// mock per-test.
// The owner-adapter registry resolves conversation owners; register fakes
// over the same mocked tables this suite already drives.
registerOwnerAdapter({
  kind: 'task',
  resolveOwner: (conversation: { task_id: number | null }) => {
    if (conversation.task_id == null) return null;
    const task = tasksDb.getById(conversation.task_id) as
      | { id: number; project_id: number }
      | undefined;
    return task ? { taskId: task.id, epicId: null, projectId: task.project_id } : null;
  },
} as never);
registerOwnerAdapter({
  kind: 'epic',
  resolveOwner: (conversation: { epic_id: number | null }) => {
    if (conversation.epic_id == null) return null;
    const epic = epicsDb.getById(conversation.epic_id) as
      | { id: number; project_id: number }
      | undefined;
    return epic ? { taskId: null, epicId: epic.id, projectId: epic.project_id } : null;
  },
} as never);

function seedAuthSuccess(): void {
  vi.mocked(conversationsDb.getById).mockReturnValue({
    id: 99,
    owner_kind: 'task',
    task_id: 7,
  } as never);
  vi.mocked(tasksDb.getById).mockReturnValue({ id: 7, project_id: 3 } as never);
  vi.mocked(hasProjectAccess).mockReturnValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSubscriptionsForTesting();
  (activeSessions as Map<string, unknown>).clear();
});

describe('dispatchClientMessage', () => {
  describe('claude-command', () => {
    it('resumes existing conversations when authorized', async () => {
      seedAuthSuccess();
      const ws = makeWs();
      const ctx = makeCtx({ ws });
      const msg: ClientToServerMessage = {
        type: 'claude-command',
        command: 'hello',
        options: { conversationId: 99, permissionMode: 'acceptEdits' },
      };

      await dispatchClientMessage(ctx, msg);

      expect(adapterSendMessage).toHaveBeenCalledWith(
        99,
        'hello',
        expect.objectContaining({
          permissionMode: 'acceptEdits',
          userId: 42,
        }),
      );
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('rejects with conversation-busy when a turn is already in flight', async () => {
      seedAuthSuccess();
      // A turn is already streaming for this conversation. `…Once` so the
      // override doesn't leak into later cases (clearAllMocks resets call
      // history, not implementations).
      vi.mocked(getActiveStreamingByConversation).mockReturnValueOnce({
        sessionId: 'sess-abc',
        taskId: 7,
        conversationId: 99,
      });
      const ws = makeWs();
      const ctx = makeCtx({ ws });
      const msg: ClientToServerMessage = {
        type: 'claude-command',
        command: 'did you get my answer?',
        options: { conversationId: 99, permissionMode: 'acceptEdits' },
      };

      await dispatchClientMessage(ctx, msg);

      // No second SDK subprocess is spawned...
      expect(adapterSendMessage).not.toHaveBeenCalled();
      // ...and the sender is told why, on a dedicated message type.
      const sent = lastSent(ws);
      expect(sent.type).toBe('conversation-busy');
      expect(sent).toMatchObject({ type: 'conversation-busy', conversationId: 99 });
    });

    it('rejects new conversations (must use REST API)', async () => {
      const ws = makeWs();
      const ctx = makeCtx({ ws });
      const msg: ClientToServerMessage = {
        type: 'claude-command',
        command: 'hello',
        options: {},
      };

      await dispatchClientMessage(ctx, msg);

      expect(adapterSendMessage).not.toHaveBeenCalled();
      expect(lastSent(ws)).toMatchObject({
        type: 'claude-error',
        error: expect.stringContaining('REST API'),
      });
    });

    it('refuses resume for foreign conversation (not authorized)', async () => {
      vi.mocked(conversationsDb.getById).mockReturnValue({
        id: 99,
        owner_kind: 'task',
        task_id: 7,
      } as never);
      vi.mocked(tasksDb.getById).mockReturnValue({
        id: 7,
        project_id: 3,
      } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, {
        type: 'claude-command',
        command: 'hello',
        options: { conversationId: 99 },
      });

      expect(adapterSendMessage).not.toHaveBeenCalled();
      expect(lastSent(ws)).toMatchObject({
        type: 'claude-error',
        error: 'Not authorized',
      });
    });

    it('returns 404-equivalent for missing conversation (no leak)', async () => {
      vi.mocked(conversationsDb.getById).mockReturnValue(undefined);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, {
        type: 'claude-command',
        command: 'hello',
        options: { conversationId: 99 },
      });

      expect(adapterSendMessage).not.toHaveBeenCalled();
      expect(lastSent(ws)).toMatchObject({
        type: 'claude-error',
        error: 'Not authorized',
      });
    });

    it('forwards adapter errors as claude-error', async () => {
      seedAuthSuccess();
      vi.mocked(adapterSendMessage).mockRejectedValueOnce(
        new Error('adapter boom'),
      );
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, {
        type: 'claude-command',
        command: 'hello',
        options: { conversationId: 99 },
      });

      expect(lastSent(ws)).toMatchObject({
        type: 'claude-error',
        error: 'adapter boom',
      });
    });
  });

  describe('abort-session', () => {
    it('refuses abort when the session is not in activeSessions and not in DB', async () => {
      vi.mocked(conversationsDb.findByClaudeSessionId).mockReturnValue(
        undefined,
      );
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, {
        type: 'abort-session',
        sessionId: 'unknown-sess',
      });

      expect(abortSession).not.toHaveBeenCalled();
      expect(lastSent(ws)).toMatchObject({
        type: 'session-aborted',
        sessionId: 'unknown-sess',
        success: false,
      });
    });

    it('refuses abort for a foreign session', async () => {
      (activeSessions as Map<string, unknown>).set('sess-foreign', {
        projectId: 99,
      });
      vi.mocked(hasProjectAccess).mockReturnValue(false);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, {
        type: 'abort-session',
        sessionId: 'sess-foreign',
      });

      expect(abortSession).not.toHaveBeenCalled();
      expect(lastSent(ws)).toMatchObject({
        type: 'session-aborted',
        success: false,
      });
    });

    it('aborts when the user has project access', async () => {
      (activeSessions as Map<string, unknown>).set('sess-123', {
        projectId: 3,
      });
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, {
        type: 'abort-session',
        sessionId: 'sess-123',
      });

      expect(abortSession).toHaveBeenCalledWith('sess-123');
      expect(lastSent(ws)).toMatchObject({
        type: 'session-aborted',
        sessionId: 'sess-123',
        success: true,
      });
    });
  });

  describe('ask-user-question-answer', () => {
    it('rejects when conversationId or answers missing', async () => {
      const ws = makeWs();
      const ctx = makeCtx({ ws });
      const msg = {
        type: 'ask-user-question-answer',
        conversationId: 0,
        answers: null,
        toolUseId: 't',
      } as unknown as ClientToServerMessage;

      await dispatchClientMessage(ctx, msg);

      expect(lastSent(ws)).toMatchObject({
        type: 'ask-user-question-error',
        error: 'conversationId and answers are required',
      });
      expect(resolveAskUserQuestion).not.toHaveBeenCalled();
    });

    it('rejects when conversation not found', async () => {
      vi.mocked(conversationsDb.getById).mockReturnValue(undefined);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, {
        type: 'ask-user-question-answer',
        conversationId: 5,
        toolUseId: 't',
        answers: { q1: 'a' },
      });

      expect(lastSent(ws)).toMatchObject({
        type: 'ask-user-question-error',
        error: 'Not authorized',
      });
    });

    it('rejects when user is not a project member', async () => {
      vi.mocked(conversationsDb.getById).mockReturnValue({
        id: 5,
        owner_kind: 'task',
        task_id: 9,
      } as never);
      vi.mocked(tasksDb.getById).mockReturnValue({
        id: 9,
        project_id: 3,
      } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, {
        type: 'ask-user-question-answer',
        conversationId: 5,
        toolUseId: 't',
        answers: { q1: 'a' },
      });

      expect(lastSent(ws)).toMatchObject({
        type: 'ask-user-question-error',
        error: 'Not authorized',
      });
    });

    it('resolves and replies on success (member or admin)', async () => {
      vi.mocked(conversationsDb.getById).mockReturnValue({
        id: 5,
        owner_kind: 'task',
        task_id: 9,
      } as never);
      vi.mocked(tasksDb.getById).mockReturnValue({
        id: 9,
        project_id: 3,
      } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, {
        type: 'ask-user-question-answer',
        conversationId: 5,
        toolUseId: 't',
        answers: { q1: 'a' },
      });

      expect(resolveAskUserQuestion).toHaveBeenCalledWith(
        5,
        { q1: 'a' },
        expect.objectContaining({ userId: 42 }),
      );
      expect(lastSent(ws)).toMatchObject({
        type: 'ask-user-question-resolved',
        conversationId: 5,
        kind: 'ok',
      });
    });
  });

  describe('check-session-status', () => {
    it('reports isProcessing for authorized sessions', async () => {
      (activeSessions as Map<string, unknown>).set('s1', { projectId: 3 });
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, {
        type: 'check-session-status',
        sessionId: 's1',
      });

      expect(isSessionActive).toHaveBeenCalledWith('s1');
      expect(lastSent(ws)).toMatchObject({
        type: 'session-status',
        sessionId: 's1',
        isProcessing: true,
      });
    });

    it('answers isProcessing=false for foreign / unknown sessions (no leak)', async () => {
      vi.mocked(conversationsDb.findByClaudeSessionId).mockReturnValue(
        undefined,
      );
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, {
        type: 'check-session-status',
        sessionId: 'stranger',
      });

      expect(isSessionActive).not.toHaveBeenCalled();
      expect(lastSent(ws)).toMatchObject({
        type: 'session-status',
        sessionId: 'stranger',
        isProcessing: false,
      });
    });
  });

  describe('get-active-sessions', () => {
    it('filters to the caller-accessible sessions', async () => {
      (activeSessions as Map<string, unknown>).set('mine', { projectId: 3 });
      (activeSessions as Map<string, unknown>).set('theirs', { projectId: 4 });
      vi.mocked(getActiveSessions).mockReturnValue(['mine', 'theirs']);
      vi.mocked(hasProjectAccess).mockImplementation(
        (projectId: number) => projectId === 3,
      );
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, { type: 'get-active-sessions' });

      expect(lastSent(ws)).toMatchObject({
        type: 'active-sessions',
        sessions: { claude: ['mine'] },
      });
    });
  });

  describe('subscribe-conversation / unsubscribe-conversation', () => {
    it('records the subscription on authorize, replies conversation-subscribed', async () => {
      seedAuthSuccess();
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, {
        type: 'subscribe-conversation',
        conversationId: 99,
      });

      const subs = __getConversationSubscriptionsForTesting();
      const wsKey = subs.keys().next().value!;
      expect(subs.get(wsKey)?.has(99)).toBe(true);
      expect(lastSent(ws)).toMatchObject({
        type: 'conversation-subscribed',
        conversationId: 99,
        success: true,
      });
    });

    it('refuses subscription for foreign conversations', async () => {
      vi.mocked(conversationsDb.getById).mockReturnValue({
        id: 99,
        owner_kind: 'task',
        task_id: 7,
      } as never);
      vi.mocked(tasksDb.getById).mockReturnValue({
        id: 7,
        project_id: 3,
      } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, {
        type: 'subscribe-conversation',
        conversationId: 99,
      });

      expect(__getConversationSubscriptionsForTesting().size).toBe(0);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('removes the conversationId on unsubscribe-conversation', async () => {
      seedAuthSuccess();
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, {
        type: 'subscribe-conversation',
        conversationId: 99,
      });
      await dispatchClientMessage(ctx, {
        type: 'unsubscribe-conversation',
        conversationId: 99,
      });

      const subs = __getConversationSubscriptionsForTesting();
      const wsKey = subs.keys().next().value!;
      expect(subs.get(wsKey)?.has(99)).toBe(false);
      expect(lastSent(ws)).toMatchObject({
        type: 'conversation-unsubscribed',
        conversationId: 99,
        success: true,
      });
    });
  });

  describe('subscribe-task / unsubscribe-task', () => {
    it('adds the taskId to the per-client Set when authorized', async () => {
      vi.mocked(tasksDb.getById).mockReturnValue({
        id: 7,
        project_id: 3,
      } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, { type: 'subscribe-task', taskId: 7 });

      const subs = __getTaskSubscriptionsForTesting();
      const wsKey = subs.keys().next().value!;
      expect(subs.get(wsKey)?.has(7)).toBe(true);
      expect(lastSent(ws)).toMatchObject({
        type: 'task-subscribed',
        taskId: 7,
        success: true,
      });
    });

    it('refuses subscription for foreign tasks', async () => {
      vi.mocked(tasksDb.getById).mockReturnValue({
        id: 7,
        project_id: 3,
      } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, { type: 'subscribe-task', taskId: 7 });

      expect(__getTaskSubscriptionsForTesting().size).toBe(0);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('removes the taskId on unsubscribe-task', async () => {
      vi.mocked(tasksDb.getById).mockReturnValue({
        id: 7,
        project_id: 3,
      } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, { type: 'subscribe-task', taskId: 7 });
      await dispatchClientMessage(ctx, {
        type: 'unsubscribe-task',
        taskId: 7,
      });

      const subs = __getTaskSubscriptionsForTesting();
      const wsKey = subs.keys().next().value!;
      expect(subs.get(wsKey)?.has(7)).toBe(false);
      expect(lastSent(ws)).toMatchObject({
        type: 'task-unsubscribed',
        taskId: 7,
        success: true,
      });
    });
  });

  describe('subscribe-atlas / unsubscribe-atlas', () => {
    it('adds the taskId to the atlas Set when authorized', async () => {
      vi.mocked(tasksDb.getById).mockReturnValue({
        id: 7,
        project_id: 3,
      } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, { type: 'subscribe-atlas', taskId: 7 });

      const subs = __getAtlasSubscriptionsForTesting();
      const wsKey = subs.keys().next().value!;
      expect(subs.get(wsKey)?.has(7)).toBe(true);
      // The atlas channel is separate — no task subscription was created.
      expect(__getTaskSubscriptionsForTesting().size).toBe(0);
      expect(lastSent(ws)).toMatchObject({
        type: 'atlas-subscribed',
        taskId: 7,
        success: true,
      });
    });

    it('refuses subscription for foreign tasks', async () => {
      vi.mocked(tasksDb.getById).mockReturnValue({
        id: 7,
        project_id: 3,
      } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, { type: 'subscribe-atlas', taskId: 7 });

      expect(__getAtlasSubscriptionsForTesting().size).toBe(0);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('removes the taskId on unsubscribe-atlas', async () => {
      vi.mocked(tasksDb.getById).mockReturnValue({
        id: 7,
        project_id: 3,
      } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, { type: 'subscribe-atlas', taskId: 7 });
      await dispatchClientMessage(ctx, { type: 'unsubscribe-atlas', taskId: 7 });

      const subs = __getAtlasSubscriptionsForTesting();
      const wsKey = subs.keys().next().value!;
      expect(subs.get(wsKey)?.has(7)).toBe(false);
      expect(lastSent(ws)).toMatchObject({
        type: 'atlas-unsubscribed',
        taskId: 7,
        success: true,
      });
    });
  });

  describe('subscribe-epic / unsubscribe-epic', () => {
    function seedEpic(): void {
      vi.mocked(epicsDb.getById).mockReturnValue({
        id: 42,
        project_id: 3,
        status: 'active',
      } as never);
    }

    it('adds the epicId to the epic Set when authorized and acks', async () => {
      seedEpic();
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, { type: 'subscribe-epic', epicId: 42 });

      const subs = __getEpicSubscriptionsForTesting();
      const wsKey = subs.keys().next().value!;
      expect(subs.get(wsKey)?.has(42)).toBe(true);
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'epic-subscribed', epicId: 42, success: true }),
      );
    });

    it('refuses subscription for an epic in a foreign project', async () => {
      seedEpic();
      vi.mocked(hasProjectAccess).mockReturnValue(false);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, { type: 'subscribe-epic', epicId: 42 });

      expect(__getEpicSubscriptionsForTesting().size).toBe(0);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('refuses subscription for an unknown epic', async () => {
      vi.mocked(epicsDb.getById).mockReturnValue(undefined);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, { type: 'subscribe-epic', epicId: 42 });

      expect(__getEpicSubscriptionsForTesting().size).toBe(0);
    });

    it('removes the epicId on unsubscribe-epic', async () => {
      seedEpic();
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      const ws = makeWs();
      const ctx = makeCtx({ ws });

      await dispatchClientMessage(ctx, { type: 'subscribe-epic', epicId: 42 });
      await dispatchClientMessage(ctx, { type: 'unsubscribe-epic', epicId: 42 });

      const subs = __getEpicSubscriptionsForTesting();
      const wsKey = subs.keys().next().value!;
      expect(subs.get(wsKey)?.has(42)).toBe(false);
      expect(lastSent(ws)).toMatchObject({
        type: 'epic-unsubscribed',
        epicId: 42,
        success: true,
      });
    });
  });

  describe('atlas-ack', () => {
    async function subscribeAtlas(ctx: DispatchContext, taskId: number): Promise<void> {
      vi.mocked(tasksDb.getById).mockReturnValue({
        id: taskId,
        project_id: 3,
      } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      await dispatchClientMessage(ctx, { type: 'subscribe-atlas', taskId });
    }

    it('routes acks from atlas-subscribed sockets to the bridge', async () => {
      const ws = makeWs();
      const ctx = makeCtx({ ws });
      await subscribeAtlas(ctx, 7);

      await dispatchClientMessage(ctx, {
        type: 'atlas-ack',
        taskId: 7,
        requestId: 'req-1',
        detail: '{"nodeCount":3}',
      });

      expect(resolveAtlasAck).toHaveBeenCalledWith('req-1', {
        taskId: 7,
        error: undefined,
        detail: '{"nodeCount":3}',
      });
    });

    it('forwards client-side errors (e.g. mermaid parse failures)', async () => {
      const ws = makeWs();
      const ctx = makeCtx({ ws });
      await subscribeAtlas(ctx, 7);

      await dispatchClientMessage(ctx, {
        type: 'atlas-ack',
        taskId: 7,
        requestId: 'req-2',
        error: 'Parse error on line 2',
      });

      expect(resolveAtlasAck).toHaveBeenCalledWith('req-2', {
        taskId: 7,
        error: 'Parse error on line 2',
        detail: undefined,
      });
    });

    it('drops acks from sockets that are not atlas-subscribed to the task', async () => {
      const ws = makeWs();
      const ctx = makeCtx({ ws });
      await subscribeAtlas(ctx, 7);

      await dispatchClientMessage(ctx, {
        type: 'atlas-ack',
        taskId: 8, // subscribed to 7, acking 8
        requestId: 'req-3',
      });

      expect(resolveAtlasAck).not.toHaveBeenCalled();
    });
  });

  describe('exhaustiveness', () => {
    it('silently drops messages with an unknown type at runtime', async () => {
      const ws = makeWs();
      const ctx = makeCtx({ ws });
      const fake = {
        type: 'unknown-future-message',
      } as unknown as ClientToServerMessage;

      await dispatchClientMessage(ctx, fake);

      expect(ws.send).not.toHaveBeenCalled();
    });
  });
});

describe('cleanupClientSubscriptions', () => {
  it('removes task, conversation, and atlas subscriptions for the ws', async () => {
    seedAuthSuccess();
    const ws = makeWs();
    const ctx = makeCtx({ ws });

    await dispatchClientMessage(ctx, {
      type: 'subscribe-task',
      taskId: 1,
    });
    await dispatchClientMessage(ctx, {
      type: 'subscribe-conversation',
      conversationId: 99,
    });
    await dispatchClientMessage(ctx, {
      type: 'subscribe-atlas',
      taskId: 1,
    });

    vi.mocked(epicsDb.getById).mockReturnValue({
      id: 42,
      project_id: 3,
      status: 'active',
    } as never);
    await dispatchClientMessage(ctx, {
      type: 'subscribe-epic',
      epicId: 42,
    });

    cleanupClientSubscriptions(ctx.ws);

    expect(__getTaskSubscriptionsForTesting().size).toBe(0);
    expect(__getConversationSubscriptionsForTesting().size).toBe(0);
    expect(__getAtlasSubscriptionsForTesting().size).toBe(0);
    expect(__getEpicSubscriptionsForTesting().size).toBe(0);
  });
});

describe('makeBroadcastToEpicSubscribers', () => {
  it('delivers epic events only to epic subscribers and splices epicId', async () => {
    seedAuthSuccess();
    vi.mocked(epicsDb.getById).mockReturnValue({
      id: 42,
      project_id: 3,
      status: 'active',
    } as never);
    const epicWs = makeWs();
    const taskOnlyWs = makeWs();
    const wss = { clients: new Set([epicWs, taskOnlyWs]) };

    await dispatchClientMessage(makeCtx({ ws: epicWs, wss }), {
      type: 'subscribe-epic',
      epicId: 42,
    });
    await dispatchClientMessage(makeCtx({ ws: taskOnlyWs, wss }), {
      type: 'subscribe-task',
      taskId: 5,
    });
    epicWs.send.mockClear();
    taskOnlyWs.send.mockClear();

    const broadcast = makeBroadcastToEpicSubscribers(wss as unknown as WebSocketServer);
    broadcast(42, {
      type: 'agent-run-updated',
      agentRun: {
        id: 7,
        status: 'completed',
        agent_type: 'epic-architecture',
        conversation_id: 11,
      },
    });

    expect(epicWs.send).toHaveBeenCalledTimes(1);
    expect(taskOnlyWs.send).not.toHaveBeenCalled();
    const payload = JSON.parse(
      epicWs.send.mock.calls[0]![0] as string,
    ) as ServerToClientMessage;
    expect(payload).toMatchObject({
      type: 'agent-run-updated',
      epicId: 42,
      agentRun: { id: 7, agent_type: 'epic-architecture' },
    });
  });
});

describe('makeBroadcastToAtlasSubscribers / makeGetAtlasSubscriberCount', () => {
  it('delivers UI commands only to atlas subscribers and splices taskId', async () => {
    seedAuthSuccess();
    const atlasWs = makeWs();
    const taskOnlyWs = makeWs();
    const wss = { clients: new Set([atlasWs, taskOnlyWs]) };

    await dispatchClientMessage(makeCtx({ ws: atlasWs, wss }), {
      type: 'subscribe-atlas',
      taskId: 5,
    });
    // A plain task-detail watcher must NOT receive file contents.
    await dispatchClientMessage(makeCtx({ ws: taskOnlyWs, wss }), {
      type: 'subscribe-task',
      taskId: 5,
    });
    atlasWs.send.mockClear();
    taskOnlyWs.send.mockClear();

    const broadcast = makeBroadcastToAtlasSubscribers(
      wss as unknown as WebSocketServer,
    );
    broadcast(5, {
      type: 'atlas-open-file',
      requestId: 'req-9',
      path: 'src/index.ts',
      content: 'hello',
    });

    expect(atlasWs.send).toHaveBeenCalledTimes(1);
    expect(taskOnlyWs.send).not.toHaveBeenCalled();
    const payload = JSON.parse(
      atlasWs.send.mock.calls[0]![0] as string,
    ) as ServerToClientMessage;
    expect(payload).toMatchObject({
      type: 'atlas-open-file',
      taskId: 5,
      requestId: 'req-9',
      path: 'src/index.ts',
    });
  });

  it('counts only OPEN sockets subscribed to the task', async () => {
    seedAuthSuccess();
    const ws1 = makeWs();
    const ws2 = makeWs();
    const wss = { clients: new Set([ws1, ws2]) };

    await dispatchClientMessage(makeCtx({ ws: ws1, wss }), {
      type: 'subscribe-atlas',
      taskId: 5,
    });
    await dispatchClientMessage(makeCtx({ ws: ws2, wss }), {
      type: 'subscribe-atlas',
      taskId: 5,
    });

    const count = makeGetAtlasSubscriberCount(wss as unknown as WebSocketServer);
    expect(count(5)).toBe(2);
    expect(count(6)).toBe(0);

    ws2.readyState = WS.CLOSING;
    expect(count(5)).toBe(1);
  });
});

describe('makeBroadcastToTaskSubscribers', () => {
  it('delivers the message only to clients subscribed to the taskId', async () => {
    seedAuthSuccess();
    const ws1 = makeWs();
    const ws2 = makeWs();
    const wss = { clients: new Set([ws1, ws2]) };

    await dispatchClientMessage(makeCtx({ ws: ws1, wss }), {
      type: 'subscribe-task',
      taskId: 5,
    });
    ws1.send.mockClear();
    ws2.send.mockClear();

    const broadcast = makeBroadcastToTaskSubscribers(
      wss as unknown as WebSocketServer,
    );
    broadcast(5, {
      type: 'conversation-added',
      conversation: {
        id: 1,
        task_id: 5,
        epic_id: null,
        claude_conversation_id: null,
        created_at: '2026-01-01T00:00:00Z',
      },
    });

    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).not.toHaveBeenCalled();
    const payload = JSON.parse(
      ws1.send.mock.calls[0]![0] as string,
    ) as ServerToClientMessage;
    expect(payload).toMatchObject({
      type: 'conversation-added',
      taskId: 5,
    });
  });

  it('skips clients whose ws is not OPEN', async () => {
    seedAuthSuccess();
    const ws1 = makeWs();
    ws1.readyState = WS.CLOSING;
    const wss = { clients: new Set([ws1]) };

    await dispatchClientMessage(makeCtx({ ws: ws1, wss }), {
      type: 'subscribe-task',
      taskId: 1,
    });
    ws1.send.mockClear();

    const broadcast = makeBroadcastToTaskSubscribers(
      wss as unknown as WebSocketServer,
    );
    broadcast(1, {
      type: 'task-blocked',
      reason: 'paused',
    });

    expect(ws1.send).not.toHaveBeenCalled();
  });
});

describe('makeBroadcastToConversationSubscribers', () => {
  it('delivers only to clients subscribed to the conversationId', async () => {
    seedAuthSuccess();
    const ws1 = makeWs();
    const ws2 = makeWs();
    const wss = { clients: new Set([ws1, ws2]) };

    // ws1 subscribes to conversation 99; ws2 does not.
    await dispatchClientMessage(makeCtx({ ws: ws1, wss }), {
      type: 'subscribe-conversation',
      conversationId: 99,
    });
    ws1.send.mockClear();
    ws2.send.mockClear();

    const broadcast = makeBroadcastToConversationSubscribers(
      wss as unknown as WebSocketServer,
    );
    broadcast(99, {
      type: 'claude-response',
      data: { type: 'assistant' } as never,
    });

    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).not.toHaveBeenCalled();
  });

  it('skips clients whose ws is not OPEN', async () => {
    seedAuthSuccess();
    const ws1 = makeWs();
    ws1.readyState = WS.CLOSED;
    const wss = { clients: new Set([ws1]) };

    await dispatchClientMessage(makeCtx({ ws: ws1, wss }), {
      type: 'subscribe-conversation',
      conversationId: 1,
    });
    ws1.send.mockClear();

    const broadcast = makeBroadcastToConversationSubscribers(
      wss as unknown as WebSocketServer,
    );
    broadcast(1, {
      type: 'claude-error',
      error: 'x',
    });

    expect(ws1.send).not.toHaveBeenCalled();
  });
});
