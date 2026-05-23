// WebSocket message dispatch — extracted from server/index.js so the routing
// of ClientToServerMessage variants is type-checkable end-to-end against the
// shared discriminated union.
//
// The module owns the per-connection subscription Maps:
// - `taskSubscriptions` for task-scoped broadcasts (agent runs, task lifecycle)
// - `conversationSubscriptions` for conversation-scoped broadcasts (streaming
//   transcripts, status, completion)
//
// Every handler that touches a user-scoped resource (a conversation, a task,
// a session) authorizes against project membership via the shared
// `hasProjectAccess` helper before doing the work. WS auth mirrors REST auth.

import { WebSocket, type WebSocketServer } from 'ws';
import type {
  BroadcastFn,
  BroadcastToConversationSubscribersFn,
  BroadcastToTaskSubscribersFn,
  ClientToServerMessage,
  ConversationId,
  ServerToClientMessage,
  TaskId,
} from '@shared/websocket/messages';
import {
  sendMessage as adapterSendMessage,
  abortSession,
  isSessionActive,
  getActiveSessions,
  getActiveStreamingByConversation,
  resolveAskUserQuestion,
} from '../services/conversationAdapter.js';
import {
  conversationsDb,
  tasksDb,
} from '../database/db.js';
import { hasProjectAccess } from '../services/projectService.js';
import { activeSessions } from '../services/conversation/sessionState.js';

const taskSubscriptions = new Map<WebSocket, Set<TaskId>>();
const conversationSubscriptions = new Map<WebSocket, Set<ConversationId>>();

/**
 * Build a `broadcastToTaskSubscribers` function bound to the given
 * WebSocketServer and the dispatch module's task-subscription state.
 *
 * The returned function is stable for the lifetime of the server and can be
 * stashed on `app.locals` so REST handlers can fan out task-scoped events
 * (conversation-added, agent-run-updated) without re-walking subscriptions
 * themselves.
 */
export function makeBroadcastToTaskSubscribers(
  wss: WebSocketServer,
): BroadcastToTaskSubscribersFn {
  return (taskId, message) => {
    const messageWithTaskId = { ...message, taskId };
    const payload = JSON.stringify(messageWithTaskId);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        const subscribed = taskSubscriptions.get(client);
        if (subscribed?.has(taskId)) {
          client.send(payload);
        }
      }
    });
  };
}

/**
 * Build a `broadcastToConversationSubscribers` function bound to the given
 * WebSocketServer and the dispatch module's conversation-subscription state.
 *
 * Mirrors `makeBroadcastToTaskSubscribers`. The channel key is the
 * `conversationId` function argument; the message payload itself does not
 * need to carry it (streaming payloads like `claude-response` /
 * `claude-status` don't), so the message type is the full
 * ServerToClientMessage union.
 */
export function makeBroadcastToConversationSubscribers(
  wss: WebSocketServer,
): BroadcastToConversationSubscribersFn {
  return (conversationId, message) => {
    const payload = JSON.stringify(message);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        const subscribed = conversationSubscriptions.get(client);
        if (subscribed?.has(conversationId)) {
          client.send(payload);
        }
      }
    });
  };
}

/**
 * Drop all subscriptions for a disconnected WebSocket client.
 */
export function cleanupClientSubscriptions(ws: WebSocket): void {
  taskSubscriptions.delete(ws);
  conversationSubscriptions.delete(ws);
}

export interface DispatchContext {
  ws: WebSocket;
  wss: WebSocketServer;
  userId: number | undefined;
  broadcastToTaskSubscribersFn: BroadcastToTaskSubscribersFn;
  broadcastToConversationSubscribersFn: BroadcastToConversationSubscribersFn;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ConversationAccessOk {
  ok: true;
  conversation: ReturnType<typeof conversationsDb.getById> & object;
  taskId: number;
  projectId: number;
}
interface ConversationAccessFail {
  ok: false;
  reason: 'not_found' | 'not_authorized';
}
type ConversationAccess = ConversationAccessOk | ConversationAccessFail;

/**
 * Verify that `userId` is allowed to act on `conversationId`. Walks
 * conversation → task → project and delegates to `hasProjectAccess` (admin OR
 * project member). Returns the resolved project id on success so handlers
 * don't have to repeat the lookups.
 *
 * Returns `not_found` if any link in the chain is missing — handlers should
 * respond with the same payload as `not_authorized` to avoid leaking the
 * existence of foreign resources.
 */
function authorizeConversationAccess(
  conversationId: number,
  userId: number | undefined,
): ConversationAccess {
  const conversation = conversationsDb.getById(conversationId);
  if (!conversation || !conversation.task_id) {
    return { ok: false, reason: 'not_found' };
  }
  const task = tasksDb.getById(conversation.task_id);
  if (!task) {
    return { ok: false, reason: 'not_found' };
  }
  if (!hasProjectAccess(task.project_id, userId)) {
    return { ok: false, reason: 'not_authorized' };
  }
  return {
    ok: true,
    conversation,
    taskId: conversation.task_id,
    projectId: task.project_id,
  };
}

interface TaskAccessOk {
  ok: true;
  taskId: number;
  projectId: number;
}
interface TaskAccessFail {
  ok: false;
  reason: 'not_found' | 'not_authorized';
}
type TaskAccess = TaskAccessOk | TaskAccessFail;

function authorizeTaskAccess(
  taskId: number,
  userId: number | undefined,
): TaskAccess {
  const task = tasksDb.getById(taskId);
  if (!task) return { ok: false, reason: 'not_found' };
  if (!hasProjectAccess(task.project_id, userId)) {
    return { ok: false, reason: 'not_authorized' };
  }
  return { ok: true, taskId, projectId: task.project_id };
}

/**
 * Verify that `userId` is allowed to control the active Claude session
 * `sessionId`. Looks up the in-memory `activeSessions` map for the owning
 * project. Falls back to a DB lookup
 * (`conversationsDb.findByClaudeSessionId`) when the session has already
 * ended — that lets `check-session-status` distinguish "your session is
 * inactive" from "you have no business asking about this session" without
 * leaking which is which.
 */
function authorizeSessionAccess(
  sessionId: string,
  userId: number | undefined,
): { authorized: boolean; projectId: number | null } {
  const active = activeSessions.get(sessionId);
  if (active && active.projectId !== null) {
    if (!hasProjectAccess(active.projectId, userId)) {
      return { authorized: false, projectId: active.projectId };
    }
    return { authorized: true, projectId: active.projectId };
  }
  const conv = conversationsDb.findByClaudeSessionId(sessionId);
  if (!conv || !conv.task_id) return { authorized: false, projectId: null };
  const task = tasksDb.getById(conv.task_id);
  if (!task) return { authorized: false, projectId: null };
  if (!hasProjectAccess(task.project_id, userId)) {
    return { authorized: false, projectId: task.project_id };
  }
  return { authorized: true, projectId: task.project_id };
}

function sendError(ws: WebSocket, msg: ServerToClientMessage): void {
  ws.send(JSON.stringify(msg));
}

/**
 * Route a single parsed client message to its handler. Each `case` narrows
 * `data` via the ClientToServerMessage discriminated union.
 */
export async function dispatchClientMessage(
  ctx: DispatchContext,
  data: ClientToServerMessage,
): Promise<void> {
  const {
    ws,
    userId,
    broadcastToTaskSubscribersFn,
    broadcastToConversationSubscribersFn,
  } = ctx;

  switch (data.type) {
    case 'claude-command': {
      console.log(
        '[DEBUG] User message:',
        data.command || '[Continue/Resume]',
      );

      const options = data.options ?? {};
      const { conversationId, images, permissionMode } = options;

      if (!conversationId) {
        sendError(ws, {
          type: 'claude-error',
          error:
            'New conversations must be created via REST API. Use the modal to start a conversation.',
        });
        return;
      }

      const access = authorizeConversationAccess(conversationId, userId);
      if (!access.ok) {
        console.warn(
          `[WS] not authorized: claude-command conversationId=${conversationId} userId=${userId} reason=${access.reason}`,
        );
        sendError(ws, { type: 'claude-error', error: 'Not authorized' });
        return;
      }

      // One conversation = one process. If a turn is already streaming for
      // this conversation (including while parked on an AskUserQuestion),
      // reject rather than spawn a second SDK subprocess on the same session
      // — two concurrent turns fork the transcript and race on task files.
      // This catches the common case where the composer was still enabled
      // (e.g. the client missed `streaming-started` across a reconnect) and
      // the user sent a message into a live turn.
      if (getActiveStreamingByConversation(conversationId)) {
        console.warn(
          `[WS] rejected claude-command: conversation ${conversationId} already has a turn in flight`,
        );
        sendError(ws, {
          type: 'conversation-busy',
          conversationId,
          error:
            'Claude is still working on this conversation — wait for the current turn to finish before sending another message.',
        });
        return;
      }

      const broadcastFn: BroadcastFn = (convId, msg) =>
        broadcastToConversationSubscribersFn(convId, msg);

      try {
        console.log('[DEBUG] Resuming conversation:', conversationId);

        await adapterSendMessage(conversationId, data.command, {
          broadcastFn,
          broadcastToTaskSubscribersFn,
          userId,
          images,
          permissionMode: permissionMode || 'bypassPermissions',
        });
      } catch (error) {
        console.error('[WebSocket] Conversation error:', error);
        sendError(ws, { type: 'claude-error', error: errorMessage(error) });
      }
      return;
    }

    case 'abort-session': {
      console.log('[DEBUG] Abort session request:', data.sessionId);
      const auth = authorizeSessionAccess(data.sessionId, userId);
      if (!auth.authorized) {
        console.warn(
          `[WS] not authorized: abort-session sessionId=${data.sessionId} userId=${userId}`,
        );
        ws.send(
          JSON.stringify({
            type: 'session-aborted',
            sessionId: data.sessionId,
            success: false,
          }),
        );
        return;
      }
      const success = await abortSession(data.sessionId);
      ws.send(
        JSON.stringify({
          type: 'session-aborted',
          sessionId: data.sessionId,
          success,
        }),
      );
      return;
    }

    case 'ask-user-question-answer': {
      // User submitted answers from the AskUserQuestionPanel wizard.
      // Resolves the parked canUseTool callback (happy path) or, after a
      // server restart, recovers by yielding a synthesised tool_result for
      // the orphan tool_use as the next prompt.
      const { conversationId, answers } = data;

      if (!conversationId || !answers || typeof answers !== 'object') {
        sendError(ws, {
          type: 'ask-user-question-error',
          conversationId,
          error: 'conversationId and answers are required',
        });
        return;
      }

      const access = authorizeConversationAccess(conversationId, userId);
      if (!access.ok) {
        console.warn(
          `[WS] not authorized: ask-user-question-answer conversationId=${conversationId} userId=${userId} reason=${access.reason}`,
        );
        sendError(ws, {
          type: 'ask-user-question-error',
          conversationId,
          error: 'Not authorized',
        });
        return;
      }

      const broadcastFn: BroadcastFn = (convId, msg) =>
        broadcastToConversationSubscribersFn(convId, msg);

      try {
        const result = await resolveAskUserQuestion(conversationId, answers, {
          broadcastFn,
          broadcastToTaskSubscribersFn,
          userId,
        });
        ws.send(
          JSON.stringify({
            type: 'ask-user-question-resolved',
            conversationId,
            kind: result.kind,
          }),
        );
      } catch (error) {
        console.error('[WebSocket] ask-user-question-answer error:', error);
        sendError(ws, {
          type: 'ask-user-question-error',
          conversationId,
          error: errorMessage(error),
        });
      }
      return;
    }

    case 'check-session-status': {
      // Quietly answer "not processing" for unknown/foreign sessions so the
      // probe doesn't double as an enumeration oracle.
      const auth = authorizeSessionAccess(data.sessionId, userId);
      if (!auth.authorized) {
        console.warn(
          `[WS] not authorized: check-session-status sessionId=${data.sessionId} userId=${userId}`,
        );
        ws.send(
          JSON.stringify({
            type: 'session-status',
            sessionId: data.sessionId,
            isProcessing: false,
          }),
        );
        return;
      }
      const isActive = isSessionActive(data.sessionId);
      ws.send(
        JSON.stringify({
          type: 'session-status',
          sessionId: data.sessionId,
          isProcessing: isActive,
        }),
      );
      return;
    }

    case 'get-active-sessions': {
      // Filter the global active-sessions list to the caller's accessible
      // projects. Admins keep the full list (hasProjectAccess short-circuits).
      const all = getActiveSessions();
      const visible = all.filter((sid) => {
        const session = activeSessions.get(sid);
        if (!session || session.projectId === null) return false;
        return hasProjectAccess(session.projectId, userId);
      });
      ws.send(
        JSON.stringify({
          type: 'active-sessions',
          sessions: { claude: visible },
        }),
      );
      return;
    }

    case 'subscribe-conversation': {
      const { conversationId } = data;
      if (typeof conversationId !== 'number' || !Number.isFinite(conversationId)) {
        console.warn('[WS] subscribe-conversation: invalid conversationId');
        return;
      }
      const access = authorizeConversationAccess(conversationId, userId);
      if (!access.ok) {
        console.warn(
          `[WS] not authorized: subscribe-conversation conversationId=${conversationId} userId=${userId} reason=${access.reason}`,
        );
        return;
      }
      let bucket = conversationSubscriptions.get(ws);
      if (!bucket) {
        bucket = new Set();
        conversationSubscriptions.set(ws, bucket);
      }
      bucket.add(conversationId);
      ws.send(
        JSON.stringify({
          type: 'conversation-subscribed',
          conversationId,
          success: true,
        }),
      );
      return;
    }

    case 'unsubscribe-conversation': {
      const { conversationId } = data;
      conversationSubscriptions.get(ws)?.delete(conversationId);
      ws.send(
        JSON.stringify({
          type: 'conversation-unsubscribed',
          conversationId,
          success: true,
        }),
      );
      return;
    }

    case 'subscribe-task': {
      const { taskId } = data;
      if (typeof taskId !== 'number' || !Number.isFinite(taskId)) {
        console.warn('[WS] subscribe-task: invalid taskId');
        return;
      }
      const access = authorizeTaskAccess(taskId, userId);
      if (!access.ok) {
        console.warn(
          `[WS] not authorized: subscribe-task taskId=${taskId} userId=${userId} reason=${access.reason}`,
        );
        return;
      }
      let bucket = taskSubscriptions.get(ws);
      if (!bucket) {
        bucket = new Set();
        taskSubscriptions.set(ws, bucket);
      }
      bucket.add(taskId);
      ws.send(
        JSON.stringify({
          type: 'task-subscribed',
          taskId,
          success: true,
        }),
      );
      return;
    }

    case 'unsubscribe-task': {
      const { taskId } = data;
      taskSubscriptions.get(ws)?.delete(taskId);
      ws.send(
        JSON.stringify({
          type: 'task-unsubscribed',
          taskId,
          success: true,
        }),
      );
      return;
    }

    default: {
      // Exhaustiveness check — TS reports if a new ClientToServerMessage
      // variant is added without a matching case.
      const _exhaustive: never = data;
      void _exhaustive;
      return;
    }
  }
}

// ---- Test-only helpers ----
//
// Exposed so unit tests can reset module state between cases and inspect the
// internal subscription Maps. Not part of the runtime surface.

export function __resetSubscriptionsForTesting(): void {
  taskSubscriptions.clear();
  conversationSubscriptions.clear();
}

export function __getTaskSubscriptionsForTesting(): Map<
  WebSocket,
  Set<TaskId>
> {
  return taskSubscriptions;
}

export function __getConversationSubscriptionsForTesting(): Map<
  WebSocket,
  Set<ConversationId>
> {
  return conversationSubscriptions;
}
