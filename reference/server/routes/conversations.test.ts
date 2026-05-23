import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock the database module
vi.mock('../database/db.js', () => ({
  tasksDb: {
    getWithProject: vi.fn(),
    updateStatus: vi.fn()
  },
  conversationsDb: {
    create: vi.fn(),
    getByTask: vi.fn(),
    getById: vi.fn(),
    updateClaudeId: vi.fn(),
    updateName: vi.fn(),
    delete: vi.fn(),
    getContextUsage: vi.fn()
  },
  projectsDb: {
    getById: vi.fn()
  }
}));

// Mock the projectService
vi.mock('../services/projectService.js', () => ({
  hasProjectAccess: vi.fn(),
  getProject: vi.fn()
}));

// Mock the conversation content store
vi.mock('../services/conversationContentStore.js', () => ({
  conversationContentStore: {
    getSessionMessages: vi.fn(),
    getSessionTokenUsage: vi.fn()
  },
  purgeConversationMessages: vi.fn().mockResolvedValue(undefined)
}));

// Mock the conversationAdapter service
vi.mock('../services/conversationAdapter.js', () => ({
  startConversation: vi.fn()
}));

// Mock the documentation service
vi.mock('../services/documentation.js', () => ({
  buildContextPrompt: vi.fn()
}));

// Mock the notifications service
vi.mock('../services/notifications.js', () => ({
  updateUserBadge: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../services/claudeCredentials.js', () => ({
  validateClaudeCredentials: vi.fn()
}));

import conversationsRoutes from './conversations.js';
import { tasksDb, conversationsDb } from '../database/db.js';
import { hasProjectAccess, getProject } from '../services/projectService.js';
import { conversationContentStore, purgeConversationMessages } from '../services/conversationContentStore.js';
import { startConversation } from '../services/conversationAdapter.js';
import { buildContextPrompt } from '../services/documentation.js';
import { validateClaudeCredentials } from '../services/claudeCredentials.js';

describe('Conversations Routes - Phase 3', () => {
  let app: import("express").Application;
  const testUserId = 1;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default to allowing access - tests can override if needed
    vi.mocked(hasProjectAccess).mockReturnValue(true);

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: testUserId, username: 'testuser' } as never;
      next();
    });
    app.use('/api', conversationsRoutes);
  });

  describe('GET /api/tasks/:taskId/conversations', () => {
    it('should return all conversations for a task', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1 };
      const mockConversations = [
        { id: 1, task_id: 1, claude_conversation_id: 'claude-1' },
        { id: 2, task_id: 1, claude_conversation_id: 'claude-2' }
      ];
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      vi.mocked(conversationsDb.getByTask).mockReturnValue(mockConversations as never);

      const response = await request(app).get('/api/tasks/1/conversations');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockConversations);
      expect(tasksDb.getWithProject).toHaveBeenCalledWith(1);
      expect(conversationsDb.getByTask).toHaveBeenCalledWith(1);
    });

    it('should return 404 if task not found', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const response = await request(app).get('/api/tasks/999/conversations');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should return 404 if user is not a project member', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1 };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).get('/api/tasks/1/conversations');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });
  });

  describe('POST /api/tasks/:taskId/conversations', () => {
    it('should create a new conversation', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, status: 'in_progress' };
      const newConversation = { id: 1, taskId: 1, claudeConversationId: null };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      vi.mocked(conversationsDb.create).mockReturnValue(newConversation as never);

      const response = await request(app)
        .post('/api/tasks/1/conversations')
        .send({ provider: 'anthropic', model: 'opus' });

      expect(response.status).toBe(201);
      expect(response.body).toEqual(newConversation);
      // Provider + model are explicit; manual conversations have no effort.
      expect(conversationsDb.create).toHaveBeenCalledWith(1, 'anthropic', 'opus', null);
    });

    it('should return 404 if task not found', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const response = await request(app)
        .post('/api/tasks/999/conversations')
        .send({ provider: 'anthropic', model: 'opus' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should set task status to in_progress when pending', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, status: 'pending' };
      const newConversation = { id: 1, taskId: 1, claudeConversationId: null };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      vi.mocked(conversationsDb.create).mockReturnValue(newConversation as never);
      vi.mocked(tasksDb.updateStatus).mockReturnValue({ ...mockTaskWithProject, status: 'in_progress' } as never);

      const response = await request(app)
        .post('/api/tasks/1/conversations')
        .send({ provider: 'anthropic', model: 'opus' });

      expect(response.status).toBe(201);
      expect(tasksDb.updateStatus).toHaveBeenCalledWith(1, 'in_progress');
    });

    it('should not change status if already in_progress', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, status: 'in_progress' };
      const newConversation = { id: 1, taskId: 1, claudeConversationId: null };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      vi.mocked(conversationsDb.create).mockReturnValue(newConversation as never);

      const response = await request(app)
        .post('/api/tasks/1/conversations')
        .send({ provider: 'anthropic', model: 'opus' });

      expect(response.status).toBe(201);
      expect(tasksDb.updateStatus).not.toHaveBeenCalled();
    });

    it('should not change status if completed', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, status: 'completed' };
      const newConversation = { id: 1, taskId: 1, claudeConversationId: null };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      vi.mocked(conversationsDb.create).mockReturnValue(newConversation as never);

      const response = await request(app)
        .post('/api/tasks/1/conversations')
        .send({ provider: 'anthropic', model: 'opus' });

      expect(response.status).toBe(201);
      expect(tasksDb.updateStatus).not.toHaveBeenCalled();
    });

    // Tests for the "with message" flow (modal-first conversation creation)
    describe('with message parameter (modal-first flow)', () => {
      it('should create conversation and start Claude session when message is provided', async () => {
        const mockTaskWithProject = {
          id: 1,
          project_id: 1,
          status: 'pending',
          repo_folder_path: '/path/to/repo'
        };
        const newConversation = { id: 5, task_id: 1, claude_conversation_id: null, provider: 'anthropic' as const, provider_session_id: null, model: 'opus', effort: null };

        vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
        vi.mocked(hasProjectAccess).mockReturnValue(true);
        vi.mocked(conversationsDb.create).mockReturnValue(newConversation);
        vi.mocked(conversationsDb.getById).mockReturnValue({ ...newConversation, claude_conversation_id: 'real-claude-session-id' } as never);
        vi.mocked(buildContextPrompt).mockReturnValue('Task context prompt');
        vi.mocked(startConversation).mockResolvedValue({
          conversationId: 5,
          claudeSessionId: 'real-claude-session-id'
        });

        const response = await request(app)
          .post('/api/tasks/1/conversations')
          .send({
            message: 'Hello Claude, help me with this task',
            permissionMode: 'bypassPermissions',
            provider: 'anthropic',
            model: 'opus'
          });

        expect(response.status).toBe(201);
        expect(response.body.claude_conversation_id).toBe('real-claude-session-id');
        expect(startConversation).toHaveBeenCalledWith(
          1, // taskId
          'Hello Claude, help me with this task', // message
          expect.objectContaining({
            permissionMode: 'bypassPermissions',
            customSystemPrompt: 'Task context prompt'
          })
        );
      });

      it('should build context prompt from project and task docs', async () => {
        const mockTaskWithProject = {
          id: 1,
          project_id: 1,
          status: 'in_progress',
          repo_folder_path: '/path/to/repo'
        };
        const newConversation = { id: 5, task_id: 1, claude_conversation_id: null, provider: 'anthropic' as const, provider_session_id: null, model: 'opus', effort: null };

        vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
        vi.mocked(hasProjectAccess).mockReturnValue(true);
        vi.mocked(conversationsDb.create).mockReturnValue(newConversation);
        vi.mocked(conversationsDb.getById).mockReturnValue({ ...newConversation, claude_conversation_id: 'session-123' } as never);
        vi.mocked(buildContextPrompt).mockReturnValue('# Task Context\nThis is the task context.');
        vi.mocked(startConversation).mockResolvedValue({
          conversationId: 5,
          claudeSessionId: 'session-123'
        });

        await request(app)
          .post('/api/tasks/1/conversations')
          .send({ message: 'Test message', provider: 'anthropic', model: 'opus' });

        expect(buildContextPrompt).toHaveBeenCalledWith(1, 1);
      });

      it('should use default permissionMode when not provided', async () => {
        const mockTaskWithProject = {
          id: 1,
          project_id: 1,
          status: 'in_progress',
          repo_folder_path: '/path/to/repo'
        };
        const newConversation = { id: 5, task_id: 1, claude_conversation_id: null, provider: 'anthropic' as const, provider_session_id: null, model: 'opus', effort: null };

        vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
        vi.mocked(hasProjectAccess).mockReturnValue(true);
        vi.mocked(conversationsDb.create).mockReturnValue(newConversation);
        vi.mocked(conversationsDb.getById).mockReturnValue({ ...newConversation, claude_conversation_id: 'session-123' } as never);
        vi.mocked(startConversation).mockResolvedValue({
          conversationId: 5,
          claudeSessionId: 'session-123'
        });

        const response = await request(app)
          .post('/api/tasks/1/conversations')
          .send({ message: 'Test message', provider: 'anthropic', model: 'opus' });

        expect(response.status).toBe(201);
        expect(startConversation).toHaveBeenCalledWith(
          1,
          'Test message',
          expect.objectContaining({
            permissionMode: 'bypassPermissions'
          })
        );
      });

      it('should return 500 if startConversation fails', async () => {
        const mockTaskWithProject = {
          id: 1,
          user_id: testUserId,
          status: 'in_progress',
          repo_folder_path: '/path/to/repo'
        };
        const newConversation = { id: 5, task_id: 1, claude_conversation_id: null, provider: 'anthropic' as const, provider_session_id: null, model: 'opus', effort: null };

        vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
        vi.mocked(conversationsDb.create).mockReturnValue(newConversation);
        vi.mocked(startConversation).mockRejectedValue(new Error('Claude SDK error'));

        const response = await request(app)
          .post('/api/tasks/1/conversations')
          .send({ message: 'Test message', provider: 'anthropic', model: 'opus' });

        expect(response.status).toBe(500);
        expect(response.body.error).toContain('Session creation failed');
      });

      it('should fail before precreating a conversation when Claude credentials are missing', async () => {
        const mockTaskWithProject = {
          id: 1,
          project_id: 1,
          status: 'pending',
          repo_folder_path: '/path/to/repo'
        };
        vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
        vi.mocked(validateClaudeCredentials).mockImplementationOnce(() => {
          throw new Error('Claude credentials are not provisioned for user 1');
        });

        const response = await request(app)
          .post('/api/tasks/1/conversations')
          .send({ message: 'Test message', provider: 'anthropic', model: 'opus' });

        expect(response.status).toBe(500);
        expect(response.body.error).toContain('Claude credentials are not provisioned for user 1');
        expect(conversationsDb.create).not.toHaveBeenCalled();
        expect(tasksDb.updateStatus).not.toHaveBeenCalled();
        expect(startConversation).not.toHaveBeenCalled();
      });

      it('should delete conversation if session creation fails', async () => {
        const mockTaskWithProject = {
          id: 1,
          user_id: testUserId,
          status: 'in_progress',
          repo_folder_path: '/path/to/repo'
        };
        const newConversation = { id: 5, task_id: 1, claude_conversation_id: null, provider: 'anthropic' as const, provider_session_id: null, model: 'opus', effort: null };

        vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
        vi.mocked(conversationsDb.create).mockReturnValue(newConversation);
        vi.mocked(conversationsDb.delete).mockReturnValue(true);
        vi.mocked(startConversation).mockRejectedValue(new Error('Claude SDK error'));

        await request(app)
          .post('/api/tasks/1/conversations')
          .send({ message: 'Test message', provider: 'anthropic', model: 'opus' });

        // Conversation should be cleaned up on failure
        expect(conversationsDb.delete).toHaveBeenCalledWith(5);
      });

      it('should trim message whitespace before sending to Claude', async () => {
        const mockTaskWithProject = {
          id: 1,
          user_id: testUserId,
          status: 'in_progress',
          repo_folder_path: '/path/to/repo'
        };
        const newConversation = { id: 5, task_id: 1, claude_conversation_id: null, provider: 'anthropic' as const, provider_session_id: null, model: 'opus', effort: null };

        vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
        vi.mocked(conversationsDb.create).mockReturnValue(newConversation);
        vi.mocked(conversationsDb.getById).mockReturnValue({ ...newConversation, claude_conversation_id: 'session-123' } as never);
        vi.mocked(startConversation).mockResolvedValue({
          conversationId: 5,
          claudeSessionId: 'session-123'
        });

        const response = await request(app)
          .post('/api/tasks/1/conversations')
          .send({ message: '  Hello with whitespace  ', provider: 'anthropic', model: 'opus' });

        expect(response.status).toBe(201);
        expect(startConversation).toHaveBeenCalledWith(
          1,
          'Hello with whitespace', // Trimmed
          expect.any(Object)
        );
      });

      it('should update task status to in_progress when pending and message provided', async () => {
        const mockTaskWithProject = {
          id: 1,
          user_id: testUserId,
          status: 'pending',
          repo_folder_path: '/path/to/repo'
        };
        const newConversation = { id: 5, task_id: 1, claude_conversation_id: null, provider: 'anthropic' as const, provider_session_id: null, model: 'opus', effort: null };

        vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
        vi.mocked(tasksDb.updateStatus).mockReturnValue({ ...mockTaskWithProject, status: 'in_progress' } as never);
        vi.mocked(conversationsDb.create).mockReturnValue(newConversation);
        vi.mocked(conversationsDb.getById).mockReturnValue({ ...newConversation, claude_conversation_id: 'session-123' } as never);
        vi.mocked(startConversation).mockResolvedValue({
          conversationId: 5,
          claudeSessionId: 'session-123'
        });

        const response = await request(app)
          .post('/api/tasks/1/conversations')
          .send({ message: 'Start working on this task', provider: 'anthropic', model: 'opus' });

        expect(response.status).toBe(201);
        expect(tasksDb.updateStatus).toHaveBeenCalledWith(1, 'in_progress');
      });
    });

    // Multi-provider manual conversations: the modal now sends a provider +
    // model pair. These prove the body is validated, the provider is stamped
    // on the row, the pair is threaded to startConversation, and the Claude
    // credential gate only fires for the anthropic backend.
    describe('with provider + model selection', () => {
      const taskWithProject = {
        id: 1,
        project_id: 1,
        status: 'in_progress',
        repo_folder_path: '/path/to/repo',
      };
      const precreated = {
        id: 9,
        task_id: 1,
        claude_conversation_id: null,
        provider: 'opencode' as const,
        provider_session_id: null,
      };

      function mockHappyPath(): void {
        vi.mocked(tasksDb.getWithProject).mockReturnValue(taskWithProject as never);
        vi.mocked(hasProjectAccess).mockReturnValue(true);
        vi.mocked(conversationsDb.create).mockReturnValue(precreated as never);
        vi.mocked(conversationsDb.getById).mockReturnValue({
          ...precreated,
          claude_conversation_id: 'oc-session-1',
        } as never);
        vi.mocked(buildContextPrompt).mockReturnValue('ctx');
        vi.mocked(startConversation).mockResolvedValue({
          conversationId: 9,
          claudeSessionId: 'oc-session-1',
        });
      }

      it('stamps the chosen provider on the row and threads provider+model to startConversation', async () => {
        mockHappyPath();

        const response = await request(app)
          .post('/api/tasks/1/conversations')
          .send({ message: 'count to 30', provider: 'opencode', model: 'opencode/kimi-k2.6' });

        expect(response.status).toBe(201);
        expect(conversationsDb.create).toHaveBeenCalledWith(1, 'opencode', 'opencode/kimi-k2.6', null);
        expect(startConversation).toHaveBeenCalledWith(
          1,
          'count to 30',
          expect.objectContaining({ provider: 'opencode', model: 'opencode/kimi-k2.6' }),
        );
      });

      it('does NOT run the Claude credential gate for a non-anthropic provider', async () => {
        mockHappyPath();
        // Would throw if invoked — proves we never call it for OpenCode.
        vi.mocked(validateClaudeCredentials).mockImplementation(() => {
          throw new Error('should not be called for opencode');
        });

        const response = await request(app)
          .post('/api/tasks/1/conversations')
          .send({ message: 'hi', provider: 'opencode', model: 'opencode/kimi-k2.6' });

        expect(response.status).toBe(201);
        expect(validateClaudeCredentials).not.toHaveBeenCalled();
      });

      it('still runs the Claude credential gate for the anthropic provider', async () => {
        vi.mocked(tasksDb.getWithProject).mockReturnValue(taskWithProject as never);
        vi.mocked(validateClaudeCredentials).mockImplementationOnce(() => {
          throw new Error('Claude credentials are not provisioned for user 1');
        });

        const response = await request(app)
          .post('/api/tasks/1/conversations')
          .send({ message: 'hi', provider: 'anthropic', model: 'opus' });

        expect(response.status).toBe(500);
        expect(response.body.error).toContain('Claude credentials are not provisioned');
        expect(validateClaudeCredentials).toHaveBeenCalledWith(testUserId);
      });

      it('rejects an unknown provider with 400', async () => {
        vi.mocked(tasksDb.getWithProject).mockReturnValue(taskWithProject as never);

        const response = await request(app)
          .post('/api/tasks/1/conversations')
          .send({ message: 'hi', provider: 'bogus', model: 'x' });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('Validation failed');
        expect(startConversation).not.toHaveBeenCalled();
      });

      it('rejects a model that does not belong to the provider with 400', async () => {
        vi.mocked(tasksDb.getWithProject).mockReturnValue(taskWithProject as never);

        const response = await request(app)
          .post('/api/tasks/1/conversations')
          .send({ message: 'hi', provider: 'anthropic', model: 'opencode/kimi-k2.6' });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('Validation failed');
        expect(startConversation).not.toHaveBeenCalled();
      });
    });
  });

  describe('GET /api/conversations/:id', () => {
    it('should return a conversation by ID', async () => {
      const mockConversation = { id: 1, task_id: 1, claude_conversation_id: 'claude-1', metadata: null };
      const mockTaskWithProject = { id: 1, user_id: testUserId };
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);

      const response = await request(app).get('/api/conversations/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockConversation);
    });

    it('should load token usage through the conversation content store', async () => {
      const mockConversation = {
        id: 1,
        task_id: 1,
        claude_conversation_id: 'claude-1',
        session_path: '/path/to/worktree'
      };
      const mockTaskWithProject = { id: 1, project_id: 1, user_id: testUserId };
      const mockProject = { id: 1, user_id: testUserId, repo_folder_path: '/path/to/project' };
      const tokenUsage = { tokens: 123, contextWindow: 1000000 };
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(conversationContentStore.getSessionTokenUsage).mockResolvedValue(tokenUsage);

      const response = await request(app).get('/api/conversations/1');

      expect(response.status).toBe(200);
      expect(response.body.metadata).toEqual({ tokenUsage });
      expect(conversationContentStore.getSessionTokenUsage).toHaveBeenCalledWith(
        'claude-1',
        '/path/to/worktree',
        { userId: testUserId }
      );
    });

    it('should return 404 if conversation not found', async () => {
      vi.mocked(conversationsDb.getById).mockReturnValue(undefined);

      const response = await request(app).get('/api/conversations/999');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Conversation not found');
    });

    it('should return 404 if user is not a project member', async () => {
      const mockConversation = { id: 1, task_id: 1 };
      const mockTaskWithProject = { id: 1, project_id: 1 };
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).get('/api/conversations/1');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Conversation not found');
    });
  });

  describe('DELETE /api/conversations/:id', () => {
    it('should delete a conversation', async () => {
      const mockConversation = { id: 1, task_id: 1 };
      const mockTaskWithProject = { id: 1, user_id: testUserId };
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(conversationsDb.delete).mockReturnValue(true);

      const response = await request(app).delete('/api/conversations/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(conversationsDb.delete).toHaveBeenCalledWith(1);
    });

    it('should purge messages for a task conversation, falling back to the project repo path', async () => {
      const mockConversation = {
        id: 1,
        task_id: 1,
        claude_conversation_id: 'sess-task',
        session_path: '/repo/task-conv',
      };
      const mockTaskWithProject = { id: 1, project_id: 7, repo_folder_path: '/repo/parent' };
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(conversationsDb.delete).mockReturnValue(true);

      const response = await request(app).delete('/api/conversations/1');

      expect(response.status).toBe(200);
      expect(purgeConversationMessages).toHaveBeenCalledWith(mockConversation, '/repo/parent');
      expect(conversationsDb.delete).toHaveBeenCalledWith(1);
    });

    it('should still delete the conversation when the message purge fails', async () => {
      const mockConversation = {
        id: 3,
        task_id: 1,
        claude_conversation_id: 'sess-x',
        session_path: '/repo/x',
      };
      const mockTaskWithProject = { id: 1, project_id: 7, repo_folder_path: '/repo/parent' };
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(conversationsDb.delete).mockReturnValue(true);
      vi.mocked(purgeConversationMessages).mockRejectedValueOnce(new Error('boom'));

      const response = await request(app).delete('/api/conversations/3');

      expect(response.status).toBe(200);
      expect(conversationsDb.delete).toHaveBeenCalledWith(3);
    });

    it('should return 404 if conversation not found', async () => {
      vi.mocked(conversationsDb.getById).mockReturnValue(undefined);

      const response = await request(app).delete('/api/conversations/999');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Conversation not found');
    });
  });

  describe('PATCH /api/conversations/:id', () => {
    it('should update conversation name', async () => {
      const mockConversation = { id: 1, task_id: 1, name: null };
      const mockTaskWithProject = { id: 1, project_id: 1, user_id: testUserId };
      vi.mocked(conversationsDb.getById)
        .mockReturnValueOnce(mockConversation as never)
        .mockReturnValueOnce({ ...mockConversation, name: 'My Chat' } as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(conversationsDb.updateName).mockReturnValue(true);

      const response = await request(app)
        .patch('/api/conversations/1')
        .send({ name: 'My Chat' });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('My Chat');
      expect(conversationsDb.updateName).toHaveBeenCalledWith(1, 'My Chat');
    });

    it('should clear conversation name when empty string is sent', async () => {
      const mockConversation = { id: 1, task_id: 1, name: 'Old Name' };
      const mockTaskWithProject = { id: 1, project_id: 1, user_id: testUserId };
      vi.mocked(conversationsDb.getById)
        .mockReturnValueOnce(mockConversation as never)
        .mockReturnValueOnce({ ...mockConversation, name: null } as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(conversationsDb.updateName).mockReturnValue(true);

      const response = await request(app)
        .patch('/api/conversations/1')
        .send({ name: '' });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe(null);
      expect(conversationsDb.updateName).toHaveBeenCalledWith(1, null);
    });

    it('should return 400 if no update fields provided', async () => {
      const response = await request(app)
        .patch('/api/conversations/1')
        .send({ provider: 'anthropic', model: 'opus' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('No update fields provided');
    });

    it('should return 404 if conversation not found', async () => {
      vi.mocked(conversationsDb.getById).mockReturnValue(undefined);

      const response = await request(app)
        .patch('/api/conversations/999')
        .send({ name: 'New Name' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Conversation not found');
    });

    it('should return 404 if user is not a project member', async () => {
      const mockConversation = { id: 1, task_id: 1, name: null };
      const mockTaskWithProject = { id: 1, project_id: 1 };
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app)
        .patch('/api/conversations/1')
        .send({ name: 'New Name' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Conversation not found');
    });

  });

  describe('PATCH /api/conversations/:id/claude-id', () => {
    it('should update Claude conversation ID', async () => {
      const mockConversation = { id: 1, task_id: 1 };
      const mockTaskWithProject = { id: 1, user_id: testUserId };
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(conversationsDb.updateClaudeId).mockReturnValue(true);

      const response = await request(app)
        .patch('/api/conversations/1/claude-id')
        .send({ claudeConversationId: 'claude-session-123' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(conversationsDb.updateClaudeId).toHaveBeenCalledWith(1, 'claude-session-123');
    });

    it('should return 400 if claudeConversationId is missing', async () => {
      const response = await request(app)
        .patch('/api/conversations/1/claude-id')
        .send({ provider: 'anthropic', model: 'opus' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Claude conversation ID is required');
    });

    it('should return 404 if conversation not found', async () => {
      vi.mocked(conversationsDb.getById).mockReturnValue(undefined);

      const response = await request(app)
        .patch('/api/conversations/999/claude-id')
        .send({ claudeConversationId: 'claude-session-123' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Conversation not found');
    });

    it('should return 404 if user is not a project member', async () => {
      const mockConversation = { id: 1, task_id: 1 };
      const mockTaskWithProject = { id: 1, project_id: 1 };
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app)
        .patch('/api/conversations/1/claude-id')
        .send({ claudeConversationId: 'claude-session-123' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Conversation not found');
    });
  });

  describe('GET /api/conversations/:id/context-usage', () => {
    it('returns the persisted snapshot', async () => {
      const mockConversation = { id: 1, task_id: 1 };
      const mockTaskWithProject = { id: 1, project_id: 1, user_id: testUserId };
      const snapshot = { totalTokens: 100, maxTokens: 200000, percentage: 0.05, model: 'claude' };

      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(conversationsDb.getContextUsage).mockReturnValue(snapshot);

      const response = await request(app).get('/api/conversations/1/context-usage');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(snapshot);
      expect(conversationsDb.getContextUsage).toHaveBeenCalledWith(1);
    });

    it('returns 404 when no snapshot has been persisted yet', async () => {
      const mockConversation = { id: 1, task_id: 1 };
      const mockTaskWithProject = { id: 1, project_id: 1, user_id: testUserId };

      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(conversationsDb.getContextUsage).mockReturnValue(null);

      const response = await request(app).get('/api/conversations/1/context-usage');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('No context usage data yet');
    });

    it('returns 404 when the user has no project access', async () => {
      const mockConversation = { id: 1, task_id: 1 };
      const mockTaskWithProject = { id: 1, project_id: 1 };
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).get('/api/conversations/1/context-usage');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/conversations/:id/messages', () => {
    it('should return messages for a conversation', async () => {
      const mockConversation = { id: 1, task_id: 1, claude_conversation_id: 'claude-session-123', session_path: '/path/to/project' };
      const mockTaskWithProject = { id: 1, project_id: 1, user_id: testUserId };
      const mockProject = { id: 1, user_id: testUserId, repo_folder_path: '/path/to/project' };
      const mockMessages = {
        messages: [
          { type: 'user', message: { content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' },
          { type: 'assistant', message: { content: 'Hi there!' }, timestamp: '2024-01-01T00:00:01Z' }
        ],
        total: 2,
        hasMore: false
      };

      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(conversationContentStore.getSessionMessages).mockResolvedValue(mockMessages);

      const response = await request(app).get('/api/conversations/1/messages');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockMessages);
      expect(conversationContentStore.getSessionMessages).toHaveBeenCalledWith(
        'claude-session-123',
        '/path/to/project',
        null,
        0,
        { userId: testUserId }
      );
    });

    it('should return empty messages when no claude_conversation_id', async () => {
      const mockConversation = { id: 1, task_id: 1, claude_conversation_id: null };
      const mockTaskWithProject = { id: 1, project_id: 1, user_id: testUserId };

      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);

      const response = await request(app).get('/api/conversations/1/messages');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ messages: [], total: 0, hasMore: false });
      expect(conversationContentStore.getSessionMessages).not.toHaveBeenCalled();
    });

    it('should pass limit and offset query params', async () => {
      const mockConversation = { id: 1, task_id: 1, claude_conversation_id: 'claude-session-123', session_path: '/path/to/project' };
      const mockTaskWithProject = { id: 1, project_id: 1, user_id: testUserId };
      const mockProject = { id: 1, user_id: testUserId, repo_folder_path: '/path/to/project' };
      const mockMessages = { messages: [], total: 0, hasMore: false };

      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(conversationContentStore.getSessionMessages).mockResolvedValue(mockMessages);

      const response = await request(app).get('/api/conversations/1/messages?limit=50&offset=10');

      expect(response.status).toBe(200);
      expect(conversationContentStore.getSessionMessages).toHaveBeenCalledWith(
        'claude-session-123',
        '/path/to/project',
        50,
        10,
        { userId: testUserId }
      );
    });

    it('should return 404 if conversation not found', async () => {
      vi.mocked(conversationsDb.getById).mockReturnValue(undefined);

      const response = await request(app).get('/api/conversations/999/messages');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Conversation not found');
    });

    it('should return 404 if user is not a project member', async () => {
      const mockConversation = { id: 1, task_id: 1 };
      const mockTaskWithProject = { id: 1, project_id: 1 };
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).get('/api/conversations/1/messages');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Conversation not found');
    });

    it('should return 404 if project not found', async () => {
      const mockConversation = { id: 1, task_id: 1, claude_conversation_id: 'claude-session-123' };
      const mockTaskWithProject = { id: 1, project_id: 1, user_id: testUserId };
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(getProject).mockReturnValue(undefined);

      const response = await request(app).get('/api/conversations/1/messages');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Project not found');
    });
  });
});
