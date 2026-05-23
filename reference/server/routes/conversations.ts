import express, { type Request, type Response } from 'express';
import { tasksDb, conversationsDb } from '../database/db.js';
import { hasProjectAccess, getProject } from '../services/projectService.js';
import {
  conversationContentStore,
  purgeConversationMessages,
} from '../services/conversationContentStore.js';
import { updateUserBadge } from '../services/notifications.js';
import { startConversation } from '../services/conversationAdapter.js';
import { buildContextPrompt } from '../services/documentation.js';
import { createConversationHandler } from './conversationHandlers.js';
import { validateBody } from '../middleware/validate.js';
import { CreateConversationBodySchema } from '../../shared/schemas/conversations.js';
import type { ApiError } from '../../shared/api/_common.js';

const router = express.Router();

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
  deleteConversation: (conversationId) => {
    conversationsDb.delete(conversationId);
  },
  cleanupConversationOnSessionError: true,
  getConversationById: (conversationId) =>
    conversationsDb.getById(conversationId) as unknown as { id: number; [k: string]: unknown },
  buildSystemPrompt: (_effectivePath, taskId, _projectPath, entityWithProject) =>
    buildContextPrompt(entityWithProject.project_id, taskId),
  startSession: (taskId, message, options) =>
    startConversation(taskId, message, options),
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

      let projectId: number | null = null;

      if (conversation.task_id) {
        const taskWithProject = tasksDb.getWithProject(conversation.task_id);
        if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
          return res
            .status(404)
            .json({ error: 'Conversation not found' } satisfies ApiError);
        }
        projectId = taskWithProject.project_id;
      } else {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

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

      let fallbackRepoPath: string | null = null;
      if (conversation.task_id) {
        const taskWithProject = tasksDb.getWithProject(conversation.task_id);
        if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
          return res
            .status(404)
            .json({ error: 'Conversation not found' } satisfies ApiError);
        }
        fallbackRepoPath = taskWithProject.repo_folder_path;
      } else {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

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

      if (conversation.task_id) {
        const taskWithProject = tasksDb.getWithProject(conversation.task_id);
        if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
          return res
            .status(404)
            .json({ error: 'Conversation not found' } satisfies ApiError);
        }
      } else {
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

      if (conversation.task_id) {
        const taskWithProject = tasksDb.getWithProject(conversation.task_id);
        if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
          return res
            .status(404)
            .json({ error: 'Conversation not found' } satisfies ApiError);
        }
      } else {
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
      if (!conversation || !conversation.task_id) {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

      const taskWithProject = tasksDb.getWithProject(conversation.task_id);
      if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
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

      let projectId: number | null = null;
      if (conversation.task_id) {
        const taskWithProject = tasksDb.getWithProject(conversation.task_id);
        if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
          return res
            .status(404)
            .json({ error: 'Conversation not found' } satisfies ApiError);
        }
        projectId = taskWithProject.project_id;
      } else {
        return res
          .status(404)
          .json({ error: 'Conversation not found' } satisfies ApiError);
      }

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

export default router;
