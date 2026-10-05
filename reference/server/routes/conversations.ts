import express, { type Request, type Response } from 'express';
import { tasksDb, conversationsDb, projectsDb } from '../database/db.js';
import { resolveScopeFromConversation } from '../services/conversation/conversationScope.js';
import { hasProjectAccess, getProject } from '../services/projectService.js';
import {
  conversationContentStore,
  purgeConversationMessages,
  type PaginatedMessagesResult,
} from '../services/conversationContentStore.js';
import { updateUserBadge } from '../services/notifications.js';
import {
  startConversation,
  sendMessage,
  getActiveStreamingByConversation,
} from '../services/conversationAdapter.js';
import { buildContextPrompt } from '../services/documentation.js';
import { getConversationImagePath } from '../services/conversationImages.js';
import { generatedImageMimeType } from '../../shared/providers/generatedImage.js';
import { createConversationHandler } from './conversationHandlers.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import {
  CreateConversationBodySchema,
  PostMessageBodySchema,
  type PostMessageBody,
  MessagesQuerySchema,
  type MessagesQuery,
  ConversationImageParamsSchema,
  type ConversationImageParams,
} from '../../shared/schemas/conversations.js';
import {
  TaskConversationParamsSchema,
  type TaskConversationParams,
} from '../../shared/schemas/_common.js';
import type { ApiError } from '../../shared/api/_common.js';
import type { ConversationRow } from '../../shared/types/db.js';
import type {
  GetTaskConversationResponse,
  PostMessageResponse,
  ConversationBusyResponse,
} from '../../shared/api/conversations.js';
import type {
  BroadcastFn,
  BroadcastToTaskSubscribersFn,
  ServerToClientMessage,
  PermissionMode,
} from '../../shared/websocket/messages.js';

const router = express.Router();

/**
 * Owner-aware access check for a conversation. A conversation belongs to a task
 * or to an epic; either way membership of the OWNING project decides access
 * (404-not-403, as everywhere else). Returns null when the caller may not see
 * it, or when the owner row is gone.
 */
function resolveConversationAccess(
  conversation: ConversationRow,
  userId: number,
): { projectId: number; repoFolderPath: string } | null {
  if (conversation.task_id) {
    const taskWithProject = tasksDb.getWithProject(conversation.task_id);
    if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) return null;
    return {
      projectId: taskWithProject.project_id,
      repoFolderPath: taskWithProject.repo_folder_path,
    };
  }
  if (conversation.epic_id) {
    const owner = resolveScopeFromConversation(conversation);
    if (!owner || !hasProjectAccess(owner.projectId, userId)) return null;
    const project = projectsDb.getByIdAdmin(owner.projectId);
    if (!project) return null;
    return { projectId: owner.projectId, repoFolderPath: project.repo_folder_path };
  }
  return null;
}

router.get(
  '/tasks/:taskId/conversations',
  (req: Request<{ taskId: string }>, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const taskId = parseInt(req.params.taskId, 10);

      if (isNaN(taskId)) {
        return res.status(400).json({ error: 'Invalid task ID' } satisfies ApiError);
      }

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const conversations = conversationsDb.getByTask(taskId);
      res.json(conversations);
    } catch (error) {
      console.error('Error listing conversations:', error);
      res.status(500).json({ error: 'Failed to list conversations' } satisfies ApiError);
    }
  },
);

const createTaskConversationHandler = createConversationHandler({
  getId: (req) => parseInt(req.params.taskId, 10),
  invalidIdMessage: 'Invalid task ID',
  notFoundMessage: 'Task not found',
  generalErrorMessage: 'Failed to create conversation',
  generalErrorLogPrefix: 'Error creating conversation:',
  sessionErrorLogPrefix: '[REST] Failed to create session:',
  precreateConversation: true,
  getEntityWithProject: (taskId) => tasksDb.getWithProject(taskId),
  createConversation: (taskId, provider, model, effort) =>
    conversationsDb.create(taskId, provider, model, effort),
  markAtlasEnabled: (conversationId) => {
    conversationsDb.setAtlasEnabled(conversationId);
  },
  deleteConversation: (conversationId) => {
    conversationsDb.delete(conversationId);
  },
  cleanupConversationOnSessionError: true,
  getConversationById: (conversationId) =>
    conversationsDb.getById(conversationId) as unknown as { id: number; [k: string]: unknown },
  buildSystemPrompt: (_effectivePath, taskId, _projectPath, entityWithProject) =>
    buildContextPrompt(entityWithProject.project_id, taskId),
  startSession: (taskId, message, options) =>
    startConversation({ kind: 'task', taskId }, message, options),
  getWorktreeTaskId: (taskId) => taskId,
  onConversationCreated: ({ userId, entityId, entityWithProject }) => {
    if ((entityWithProject as { status?: string }).status === 'pending') {
      tasksDb.updateStatus(entityId, 'in_progress');
      updateUserBadge(userId).catch((err: unknown) => {
        console.error('[Notifications] Failed to update badge on conversation creation:', err);
      });
    }
  },
});

router.post(
  '/tasks/:taskId/conversations',
  validateBody(CreateConversationBodySchema),
  createTaskConversationHandler,
);

router.get(
  '/conversations/:id',
  async (req: Request<{ id: string }>, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const conversationId = parseInt(req.params.id, 10);

      if (isNaN(conversationId)) {
        return res
          .status(400)
          .json({ error: 'Invalid conversation ID' } satisfies ApiError);
      }

      const conversation = conversationsDb.getById(conversationId);

      if (!conversation) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

      const access = resolveConversationAccess(conversation, userId);
      if (!access) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }
      const projectId = access.projectId;

      let metadata: { tokenUsage: unknown } | null = null;
      if (conversation.claude_conversation_id && projectId) {
        const project = getProject(projectId, userId);
        if (project) {
          const tokenUsage = await conversationContentStore.getSessionTokenUsage(
            conversation.claude_conversation_id,
            conversation.session_path || project.repo_folder_path,
            { userId },
          );
          metadata = { tokenUsage };
        }
      }

      res.json({
        ...conversation,
        metadata,
      });
    } catch (error) {
      console.error('Error getting conversation:', error);
      res
        .status(500)
        .json({ error: 'Failed to get conversation' } satisfies ApiError);
    }
  },
);

router.delete(
  '/conversations/:id',
  async (req: Request<{ id: string }>, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const conversationId = parseInt(req.params.id, 10);

      if (isNaN(conversationId)) {
        return res
          .status(400)
          .json({ error: 'Invalid conversation ID' } satisfies ApiError);
      }

      const conversation = conversationsDb.getById(conversationId);

      if (!conversation) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

      const deleteAccess = resolveConversationAccess(conversation, userId);
      if (!deleteAccess) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }
      const fallbackRepoPath = deleteAccess.repoFolderPath;

      try {
        await purgeConversationMessages(conversation, fallbackRepoPath);
      } catch (purgeError) {
        console.error(
          `Failed to purge messages for conversation ${conversationId}:`,
          purgeError,
        );
      }

      const deleted = conversationsDb.delete(conversationId);

      if (!deleted) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting conversation:', error);
      res
        .status(500)
        .json({ error: 'Failed to delete conversation' } satisfies ApiError);
    }
  },
);

router.patch(
  '/conversations/:id',
  (
    req: Request<{ id: string }, unknown, { name?: string | null }>,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const conversationId = parseInt(req.params.id, 10);

      if (isNaN(conversationId)) {
        return res
          .status(400)
          .json({ error: 'Invalid conversation ID' } satisfies ApiError);
      }

      const { name } = req.body;

      if (name === undefined) {
        return res
          .status(400)
          .json({ error: 'No update fields provided' } satisfies ApiError);
      }

      const conversation = conversationsDb.getById(conversationId);

      if (!conversation) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

      if (!resolveConversationAccess(conversation, userId)) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

      const updated = conversationsDb.updateName(conversationId, name || null);

      if (!updated) {
        return res
          .status(500)
          .json({ error: 'Failed to update conversation' } satisfies ApiError);
      }

      const updatedConversation = conversationsDb.getById(conversationId);
      res.json(updatedConversation);
    } catch (error) {
      console.error('Error updating conversation:', error);
      res
        .status(500)
        .json({ error: 'Failed to update conversation' } satisfies ApiError);
    }
  },
);

router.patch(
  '/conversations/:id/claude-id',
  (
    req: Request<{ id: string }, unknown, { claudeConversationId?: string }>,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const conversationId = parseInt(req.params.id, 10);

      if (isNaN(conversationId)) {
        return res
          .status(400)
          .json({ error: 'Invalid conversation ID' } satisfies ApiError);
      }

      const { claudeConversationId } = req.body;

      if (!claudeConversationId) {
        return res
          .status(400)
          .json({ error: 'Claude conversation ID is required' } satisfies ApiError);
      }

      const conversation = conversationsDb.getById(conversationId);

      if (!conversation) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

      if (!resolveConversationAccess(conversation, userId)) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

      const updated = conversationsDb.updateClaudeId(conversationId, claudeConversationId);

      if (!updated) {
        return res
          .status(500)
          .json({ error: 'Failed to update Claude conversation ID' } satisfies ApiError);
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error updating Claude conversation ID:', error);
      res
        .status(500)
        .json({ error: 'Failed to update Claude conversation ID' } satisfies ApiError);
    }
  },
);

router.get(
  '/conversations/:id/context-usage',
  (req: Request<{ id: string }>, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const conversationId = parseInt(req.params.id, 10);

      if (isNaN(conversationId)) {
        return res
          .status(400)
          .json({ error: 'Invalid conversation ID' } satisfies ApiError);
      }

      const conversation = conversationsDb.getById(conversationId);
      if (!conversation || !resolveConversationAccess(conversation, userId)) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

      const snapshot = conversationsDb.getContextUsage(conversationId);
      if (!snapshot) {
        return res
          .status(404)
          .json({ error: 'No context usage data yet' } satisfies ApiError);
      }

      res.json(snapshot);
    } catch (error) {
      console.error('Error getting context usage:', error);
      res
        .status(500)
        .json({ error: 'Failed to get context usage' } satisfies ApiError);
    }
  },
);

router.get(
  '/conversations/:id/messages',
  async (
    req: Request<{ id: string }, unknown, unknown, { limit?: string; offset?: string }>,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const conversationId = parseInt(req.params.id, 10);
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
      const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;

      if (isNaN(conversationId)) {
        return res
          .status(400)
          .json({ error: 'Invalid conversation ID' } satisfies ApiError);
      }

      const conversation = conversationsDb.getById(conversationId);

      if (!conversation) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

      const messagesAccess = resolveConversationAccess(conversation, userId);
      if (!messagesAccess) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }
      const projectId = messagesAccess.projectId;

      if (!conversation.claude_conversation_id) {
        return res.json({ messages: [], total: 0, hasMore: false });
      }

      const project = getProject(projectId, userId);

      if (!project) {
        return res
          .status(404)
          .json({ error: 'Project not found' } satisfies ApiError);
      }

      const result = await conversationContentStore.getSessionMessages(
        conversation.claude_conversation_id,
        conversation.session_path || project.repo_folder_path,
        limit,
        offset,
        { userId },
      );

      res.json(result);
    } catch (error) {
      console.error('Error getting conversation messages:', error);
      res
        .status(500)
        .json({ error: 'Failed to get conversation messages' } satisfies ApiError);
    }
  },
);

// An image the model generated during this conversation (Codex `image_gen`).
// Loaded by `<img>` tags, which cannot send an Authorization header, so the
// chat UI authenticates with `?token=` like the review-recording player.
router.get(
  '/conversations/:id/images/:fileName',
  validateParams(ConversationImageParamsSchema),
  (req: Request, res: Response<unknown>) => {
    const userId = req.user!.id;
    const { id: conversationId, fileName } = req.validated!.params as ConversationImageParams;

    const conversation = conversationsDb.getById(conversationId);
    const imagePath = getConversationImagePath(conversationId, fileName);
    const mimeType = generatedImageMimeType(fileName);
    if (!conversation || !resolveConversationAccess(conversation, userId) || !imagePath || !mimeType) {
      return res.status(404).json({ error: 'Image not found' } satisfies ApiError);
    }

    // A stored image is written once under a unique name, so it can be cached
    // for good — privately: the URL carries the caller's token.
    res.sendFile(
      imagePath,
      {
        // The archive root is a dot-directory (`~/.bottega`); the file name
        // itself can never start with a dot.
        dotfiles: 'allow',
        headers: {
          'Content-Type': mimeType,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=31536000, immutable',
        },
      },
      (err) => {
        if (!err || res.headersSent) return;
        res.status(404).json({ error: 'Image not found' } satisfies ApiError);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Nested, task-scoped conversation endpoints (external-API surface)
//
// These mirror the user's `GET/POST /ticket/{id}/conversation/{cid}` proposal
// as RESTful sub-resources of a task. The conversation ids come from
// `GET /api/tasks/:id/phases`. Both enforce the nesting (the conversation must
// belong to the task in the URL) so a client can't read or write across tasks.
// ---------------------------------------------------------------------------

router.get(
  '/tasks/:taskId/conversations/:conversationId',
  validateParams(TaskConversationParamsSchema),
  validateQuery(MessagesQuerySchema),
  async (req: Request, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const { taskId, conversationId } = req.validated!.params as TaskConversationParams;
      const { limit, offset } = req.validated!.query as MessagesQuery;

      const taskWithProject = tasksDb.getWithProject(taskId);
      if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const conversation = conversationsDb.getById(conversationId);
      // Enforce the nesting: the conversation must belong to this task. A
      // 404 (never 403) keeps cross-task existence from leaking.
      if (!conversation || conversation.task_id !== taskId) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

      if (!conversation.claude_conversation_id) {
        return res.json({
          conversation,
          messages: [],
          total: 0,
          hasMore: false,
        } satisfies GetTaskConversationResponse);
      }

      const project = getProject(taskWithProject.project_id, userId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' } satisfies ApiError);
      }

      // `getSessionMessages` returns a bare array when `limit === null` and the
      // paginated envelope otherwise. This endpoint always responds with the
      // `{ messages, total, hasMore }` envelope, so normalize the bare-array
      // case (no `?limit`) into one.
      const result = await conversationContentStore.getSessionMessages(
        conversation.claude_conversation_id,
        conversation.session_path || project.repo_folder_path,
        limit ?? null,
        offset ?? 0,
        { userId },
      );

      const envelope: PaginatedMessagesResult = Array.isArray(result)
        ? { messages: result, total: result.length, hasMore: false }
        : result;

      const body: GetTaskConversationResponse = {
        conversation,
        // `getSessionMessages` types entries loosely (`TranscriptEntry`);
        // the API contract names them `SDKMessage` — same wire shape.
        messages: envelope.messages as GetTaskConversationResponse['messages'],
        total: envelope.total,
        hasMore: envelope.hasMore,
      };
      res.json(body);
    } catch (error) {
      console.error('Error getting task conversation:', error);
      res
        .status(500)
        .json({ error: 'Failed to get conversation' } satisfies ApiError);
    }
  },
);

router.post(
  '/tasks/:taskId/conversations/:conversationId/messages',
  validateParams(TaskConversationParamsSchema),
  validateBody(PostMessageBodySchema),
  async (req: Request, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const { taskId, conversationId } = req.validated!.params as TaskConversationParams;
      const { message, permissionMode, images } = req.validated!.body as PostMessageBody;

      const taskWithProject = tasksDb.getWithProject(taskId);
      if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const conversation = conversationsDb.getById(conversationId);
      if (!conversation || conversation.task_id !== taskId) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

      // This endpoint resumes an existing session. A conversation with no
      // session yet must be (re)started via POST /tasks/:taskId/conversations.
      if (!conversation.claude_conversation_id) {
        return res.status(409).json({
          error: 'Conversation has not been started yet',
          code: 'CONVERSATION_NOT_STARTED',
        });
      }

      // Busy guard — one conversation = one in-flight turn. Mirrors the WS
      // `conversation-busy` rejection and the agent-run 409.
      if (getActiveStreamingByConversation(conversationId)) {
        return res.status(409).json({
          error: 'A turn is already in progress for this conversation',
          code: 'CONVERSATION_BUSY',
          conversation_id: conversationId,
        } satisfies ConversationBusyResponse);
      }

      // Count current messages so the caller knows the offset to poll from.
      // `null` limit returns the bare array; its length is the message count.
      let messagesBefore = 0;
      const project = getProject(taskWithProject.project_id, userId);
      if (project) {
        const existing = await conversationContentStore.getSessionMessages(
          conversation.claude_conversation_id,
          conversation.session_path || project.repo_folder_path,
          null,
          0,
          { userId },
        );
        messagesBefore = Array.isArray(existing) ? existing.length : existing.total;
      }

      // Wire the same broadcast fns the WS path and agent-runs use, so the
      // streamed reply reaches subscribers.
      const broadcastToConversationSubscribers =
        req.app.locals.broadcastToConversationSubscribers as
          | ((convId: number, msg: ServerToClientMessage) => void)
          | undefined;
      const broadcastFn: BroadcastFn = (convId, msg) => {
        broadcastToConversationSubscribers?.(convId, msg);
      };
      const broadcastToTaskSubscribersFn = req.app.locals
        .broadcastToTaskSubscribers as BroadcastToTaskSubscribersFn | undefined;

      // Fire-and-forget: the turn streams over WS and persists to SQLite. A
      // failure after the 202 still surfaces to subscribers via `claude-error`.
      void sendMessage(conversationId, message, {
        broadcastFn,
        broadcastToTaskSubscribersFn,
        userId,
        images,
        permissionMode: (permissionMode || 'bypassPermissions') as PermissionMode,
      }).catch((err: unknown) => {
        console.error(
          `[REST] sendMessage failed for conversation ${conversationId}:`,
          err,
        );
        broadcastFn(conversationId, {
          type: 'claude-error',
          error: err instanceof Error ? err.message : String(err),
        });
      });

      res.status(202).json({
        status: 'accepted',
        task_id: taskId,
        conversation_id: conversationId,
        messages_before: messagesBefore,
      } satisfies PostMessageResponse);
    } catch (error) {
      console.error('Error posting conversation message:', error);
      res
        .status(500)
        .json({ error: 'Failed to post conversation message' } satisfies ApiError);
    }
  },
);

export default router;
