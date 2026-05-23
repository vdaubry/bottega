import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock the database module
vi.mock('../database/db.js', () => ({
  projectsDb: {
    getById: vi.fn()
  },
  tasksDb: {
    create: vi.fn(),
    getAll: vi.fn(),
    getByProject: vi.fn(),
    getById: vi.fn(),
    getWithProject: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    blockWorkflow: vi.fn(),
    unblockWorkflow: vi.fn(),
    incrementRunCount: vi.fn(),
    resetRunCount: vi.fn(),
    markPrAgentComplete: vi.fn(),
    markRefinementComplete: vi.fn(),
    resetRefinementComplete: vi.fn(),
    getOldCompletedTasks: vi.fn()
  },
  conversationsDb: {
    getByTask: vi.fn().mockReturnValue([])
  }
}));

vi.mock('../services/conversationContentStore.js', () => ({
  purgeConversationMessages: vi.fn().mockResolvedValue(undefined)
}));

// Mock the projectService
vi.mock('../services/projectService.js', () => ({
  hasProjectAccess: vi.fn(),
  getProject: vi.fn()
}));

// Mock the taskService
vi.mock('../services/taskService.js', () => ({
  getAllTasks: vi.fn()
}));

// Mock the documentation service
vi.mock('../services/documentation.js', () => ({
  readTaskDoc: vi.fn(),
  writeTaskDoc: vi.fn(),
  deleteTaskArchive: vi.fn(),
  listTaskInputFiles: vi.fn().mockReturnValue([]),
  saveTaskInputFile: vi.fn(),
  deleteTaskInputFile: vi.fn(),
  getRecordingPath: vi.fn()
}));

// Mock the upload middleware
vi.mock('../middleware/upload.js', async () => {
  const multer = await import('multer');
  return {
    MulterError: multer.default.MulterError,
    upload: multer.default({ storage: multer.default.memoryStorage() })
  };
});

// Mock the notifications service
vi.mock('../services/notifications.js', () => ({
  notifyTaskStatusChange: vi.fn().mockResolvedValue(undefined)
}));

// Mock the agentRunner service
vi.mock('../services/agentRunner.js', () => ({
  forceCompleteRunningAgents: vi.fn()
}));

// Mock the worktree service
vi.mock('../services/worktree.js', () => ({
  isGitRepository: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  worktreeExists: vi.fn(),
  getWorktreeProjectPath: vi.fn(),
  getWorktreeStatus: vi.fn(),
  syncWithMain: vi.fn(),
  createPullRequest: vi.fn(),
  getPullRequestStatus: vi.fn(),
  mergeAndCleanup: vi.fn(),
  hasUncommittedChanges: vi.fn(),
  commitAllChanges: vi.fn(),
  pushChanges: vi.fn()
}));

// Mock the webServerManager service
vi.mock('../services/webServerManager.js', () => ({
  switchWorktree: vi.fn()
}));

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import tasksRoutes from './tasks.js';
import { tasksDb, conversationsDb } from '../database/db.js';
import { purgeConversationMessages } from '../services/conversationContentStore.js';
import { hasProjectAccess, getProject } from '../services/projectService.js';
import { getAllTasks } from '../services/taskService.js';
import { readTaskDoc, writeTaskDoc, deleteTaskArchive, getRecordingPath } from '../services/documentation.js';
import { forceCompleteRunningAgents } from '../services/agentRunner.js';
import {
  isGitRepository,
  createWorktree,
  removeWorktree,
  worktreeExists,
  getWorktreeStatus,
  syncWithMain,
  createPullRequest,
  getPullRequestStatus,
  mergeAndCleanup,
  hasUncommittedChanges,
  commitAllChanges,
  pushChanges
} from '../services/worktree.js';
import { switchWorktree } from '../services/webServerManager.js';

describe('Tasks Routes - Phase 3', () => {
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
    app.use('/api', tasksRoutes);
  });

  describe('GET /api/tasks', () => {
    it('should return all tasks for user', async () => {
      const mockTasks = [
        { id: 1, title: 'Task 1', status: 'pending', project_name: 'Project A' },
        { id: 2, title: 'Task 2', status: 'in_progress', project_name: 'Project B' }
      ];
      vi.mocked(getAllTasks).mockReturnValue(mockTasks as never);

      const response = await request(app).get('/api/tasks');

      expect(response.status).toBe(200);
      expect(response.body.tasks).toEqual(mockTasks);
      expect(getAllTasks).toHaveBeenCalledWith(testUserId, null);
    });

    it('should filter by status=pending', async () => {
      const mockTasks = [
        { id: 1, title: 'Pending Task', status: 'pending', project_name: 'Project A' }
      ];
      vi.mocked(getAllTasks).mockReturnValue(mockTasks as never);

      const response = await request(app).get('/api/tasks?status=pending');

      expect(response.status).toBe(200);
      expect(response.body.tasks).toEqual(mockTasks);
      expect(getAllTasks).toHaveBeenCalledWith(testUserId, 'pending');
    });

    it('should filter by status=in_progress', async () => {
      const mockTasks = [
        { id: 2, title: 'In Progress Task', status: 'in_progress', project_name: 'Project B' }
      ];
      vi.mocked(getAllTasks).mockReturnValue(mockTasks as never);

      const response = await request(app).get('/api/tasks?status=in_progress');

      expect(response.status).toBe(200);
      expect(response.body.tasks).toEqual(mockTasks);
      expect(getAllTasks).toHaveBeenCalledWith(testUserId, 'in_progress');
    });

    it('should filter by status=in_review', async () => {
      const mockTasks = [
        { id: 3, title: 'In Review Task', status: 'in_review', project_name: 'Project C' }
      ];
      vi.mocked(getAllTasks).mockReturnValue(mockTasks as never);

      const response = await request(app).get('/api/tasks?status=in_review');

      expect(response.status).toBe(200);
      expect(response.body.tasks).toEqual(mockTasks);
      expect(getAllTasks).toHaveBeenCalledWith(testUserId, 'in_review');
    });

    it('should filter by status=completed', async () => {
      const mockTasks = [
        { id: 3, title: 'Completed Task', status: 'completed', project_name: 'Project C' }
      ];
      vi.mocked(getAllTasks).mockReturnValue(mockTasks as never);

      const response = await request(app).get('/api/tasks?status=completed');

      expect(response.status).toBe(200);
      expect(response.body.tasks).toEqual(mockTasks);
      expect(getAllTasks).toHaveBeenCalledWith(testUserId, 'completed');
    });

    it('should return 400 for invalid status', async () => {
      const response = await request(app).get('/api/tasks?status=invalid');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(Array.isArray(response.body.issues)).toBe(true);
      expect(getAllTasks).not.toHaveBeenCalled();
    });

    it('should include project_name on tasks', async () => {
      const mockTasks = [
        { id: 1, title: 'Task 1', status: 'pending', project_name: 'My Project', repo_folder_path: '/path/to/project' }
      ];
      vi.mocked(getAllTasks).mockReturnValue(mockTasks as never);

      const response = await request(app).get('/api/tasks');

      expect(response.status).toBe(200);
      expect(response.body.tasks[0].project_name).toBe('My Project');
      expect(response.body.tasks[0].repo_folder_path).toBe('/path/to/project');
    });
  });

  describe('GET /api/projects/:projectId/tasks', () => {
    it('should return all tasks for a project', async () => {
      const mockProject = { id: 1, project_id: 1, repo_folder_path: '/path/1' };
      const mockTasks = [
        { id: 1, project_id: 1, title: 'Task 1' },
        { id: 2, project_id: 1, title: 'Task 2' }
      ];
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.getByProject).mockReturnValue(mockTasks as never);

      const response = await request(app).get('/api/projects/1/tasks');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockTasks);
      expect(getProject).toHaveBeenCalledWith(1, testUserId);
      expect(tasksDb.getByProject).toHaveBeenCalledWith(1);
    });

    it('should return 404 if project not found', async () => {
      vi.mocked(getProject).mockReturnValue(undefined);

      const response = await request(app).get('/api/projects/999/tasks');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Project not found');
    });
  });

  describe('POST /api/projects/:projectId/tasks', () => {
    it('should create a new task', async () => {
      const mockProject = { id: 1, project_id: 1, repo_folder_path: '/path/1' };
      const newTask = { id: 1, projectId: 1, title: 'New Task' };
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.create).mockReturnValue(newTask as never);
      vi.mocked(writeTaskDoc).mockReturnValue(undefined);

      const response = await request(app)
        .post('/api/projects/1/tasks')
        .send({ title: 'New Task' });

      expect(response.status).toBe(201);
      expect(response.body).toEqual(newTask);
      expect(tasksDb.create).toHaveBeenCalledWith(1, 'New Task', false, testUserId);
      expect(writeTaskDoc).toHaveBeenCalledWith(1, 1, '');
    });

    it('should create a task without title', async () => {
      const mockProject = { id: 1, project_id: 1, repo_folder_path: '/path/1' };
      const newTask = { id: 1, projectId: 1, title: null };
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.create).mockReturnValue(newTask as never);

      const response = await request(app)
        .post('/api/projects/1/tasks')
        .send({});

      expect(response.status).toBe(201);
      expect(tasksDb.create).toHaveBeenCalledWith(1, null, false, testUserId);
    });

    it('should forward yolo_mode=true when provided in body', async () => {
      const mockProject = { id: 1, project_id: 1, repo_folder_path: '/path/1' };
      const newTask = { id: 1, projectId: 1, title: 'YOLO Task', yolo_mode: 1 };
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.create).mockReturnValue(newTask as never);
      vi.mocked(writeTaskDoc).mockReturnValue(undefined);

      const response = await request(app)
        .post('/api/projects/1/tasks')
        .send({ title: 'YOLO Task', yolo_mode: true });

      expect(response.status).toBe(201);
      expect(tasksDb.create).toHaveBeenCalledWith(1, 'YOLO Task', true, testUserId);
    });

    it('should return 404 if project not found', async () => {
      vi.mocked(getProject).mockReturnValue(undefined);

      const response = await request(app)
        .post('/api/projects/999/tasks')
        .send({ title: 'New Task' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Project not found');
    });
  });

  describe('GET /api/tasks/:id', () => {
    it('should return a task by ID', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, title: 'Task 1' };
      const mockTask = { id: 1, project_id: 1, title: 'Task 1' };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.getById).mockReturnValue(mockTask as never);

      const response = await request(app).get('/api/tasks/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockTask);
    });

    it('should return 404 if task not found', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const response = await request(app).get('/api/tasks/999');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should return 404 if user is not a project member', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, title: 'Task 1' };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).get('/api/tasks/1');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });
  });

  describe('PUT /api/tasks/:id', () => {
    it('should update a task', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1 };
      const updatedTask = { id: 1, project_id: 1, title: 'Updated Title' };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.update).mockReturnValue(updatedTask as never);

      const response = await request(app)
        .put('/api/tasks/1')
        .send({ title: 'Updated Title' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(updatedTask);
      expect(tasksDb.update).toHaveBeenCalledWith(1, { title: 'Updated Title' });
    });

    it('should return 404 if task not found', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const response = await request(app)
        .put('/api/tasks/999')
        .send({ title: 'Updated Title' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should update task status', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, status: 'pending' };
      const updatedTask = { id: 1, project_id: 1, title: 'Task 1', status: 'in_progress' };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.update).mockReturnValue(updatedTask as never);

      const response = await request(app)
        .put('/api/tasks/1')
        .send({ status: 'in_progress' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('in_progress');
      expect(tasksDb.update).toHaveBeenCalledWith(1, { status: 'in_progress' });
    });

    it('should return 400 for invalid status', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1 };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);

      const response = await request(app)
        .put('/api/tasks/1')
        .send({ status: 'invalid_status' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(Array.isArray(response.body.issues)).toBe(true);
      expect(tasksDb.update).not.toHaveBeenCalled();
    });

    it('should update workflow_complete to 1', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, workflow_complete: 0 };
      const updatedTask = { id: 1, project_id: 1, title: 'Task 1', workflow_complete: 1 };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.update).mockReturnValue(updatedTask as never);

      const response = await request(app)
        .put('/api/tasks/1')
        .send({ workflow_complete: 1 });

      expect(response.status).toBe(200);
      expect(response.body.workflow_complete).toBe(1);
      expect(tasksDb.update).toHaveBeenCalledWith(1, { workflow_complete: 1 });
    });

    it('should update workflow_complete to 0', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, workflow_complete: 1 };
      const updatedTask = { id: 1, project_id: 1, title: 'Task 1', workflow_complete: 0 };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.update).mockReturnValue(updatedTask as never);

      const response = await request(app)
        .put('/api/tasks/1')
        .send({ workflow_complete: 0 });

      expect(response.status).toBe(200);
      expect(response.body.workflow_complete).toBe(0);
      expect(tasksDb.update).toHaveBeenCalledWith(1, { workflow_complete: 0 });
    });

    it('should update workflow_complete along with status', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, status: 'pending', workflow_complete: 0 };
      const updatedTask = { id: 1, project_id: 1, title: 'Task 1', status: 'completed', workflow_complete: 1 };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.update).mockReturnValue(updatedTask as never);

      const response = await request(app)
        .put('/api/tasks/1')
        .send({ status: 'completed', workflow_complete: 1 });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('completed');
      expect(response.body.workflow_complete).toBe(1);
      expect(tasksDb.update).toHaveBeenCalledWith(1, { status: 'completed', workflow_complete: 1 });
    });
  });

  describe('DELETE /api/tasks/:id', () => {
    it('should delete a task', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, repo_folder_path: '/path/1' };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.delete).mockReturnValue(true);
      vi.mocked(deleteTaskArchive).mockReturnValue(undefined);

      const response = await request(app).delete('/api/tasks/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(tasksDb.delete).toHaveBeenCalledWith(1);
      expect(deleteTaskArchive).toHaveBeenCalledWith(1, 1);
    });

    it('should purge messages for every conversation before cascading the delete', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, repo_folder_path: '/path/1' };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.delete).mockReturnValue(true);
      vi.mocked(conversationsDb.getByTask).mockReturnValue([
        { id: 11, claude_conversation_id: 'sess-1', session_path: '/path/1' },
        { id: 12, claude_conversation_id: 'sess-2', session_path: '/path/1/.worktrees/task-1' },
      ] as never);

      const response = await request(app).delete('/api/tasks/1');

      expect(response.status).toBe(200);
      expect(conversationsDb.getByTask).toHaveBeenCalledWith(1);
      expect(purgeConversationMessages).toHaveBeenCalledTimes(2);
      expect(purgeConversationMessages).toHaveBeenCalledWith(
        expect.objectContaining({ id: 11, claude_conversation_id: 'sess-1' }),
        '/path/1'
      );
      expect(purgeConversationMessages).toHaveBeenCalledWith(
        expect.objectContaining({ id: 12, claude_conversation_id: 'sess-2' }),
        '/path/1'
      );
    });

    it('should still delete the task when the message purge fails', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, repo_folder_path: '/path/1' };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.delete).mockReturnValue(true);
      vi.mocked(conversationsDb.getByTask).mockReturnValue([
        { id: 11, claude_conversation_id: 'sess-1', session_path: '/path/1' },
      ] as never);
      vi.mocked(purgeConversationMessages).mockRejectedValueOnce(new Error('boom'));

      const response = await request(app).delete('/api/tasks/1');

      expect(response.status).toBe(200);
      expect(tasksDb.delete).toHaveBeenCalledWith(1);
    });

    it('should return 404 if task not found', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const response = await request(app).delete('/api/tasks/999');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });
  });

  describe('DELETE /api/projects/:projectId/tasks/cleanup-old-completed', () => {
    it('should purge messages for every old task before deleting it', async () => {
      const mockProject = { id: 9, repo_folder_path: '/repo/9' };
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.getOldCompletedTasks).mockReturnValue([100, 101]);
      vi.mocked(tasksDb.delete).mockReturnValue(true);
      vi.mocked(worktreeExists).mockResolvedValue(false);
      vi.mocked(conversationsDb.getByTask).mockImplementation(((taskId: number) => {
        if (taskId === 100) return [{ id: 1000, claude_conversation_id: 'sess-100', session_path: '/repo/9' }];
        if (taskId === 101) return [{ id: 1010, claude_conversation_id: 'sess-101', session_path: '/repo/9' }];
        return [];
      }) as never);

      const response = await request(app).delete('/api/projects/9/tasks/cleanup-old-completed');

      expect(response.status).toBe(200);
      expect(response.body.deletedCount).toBe(2);
      expect(purgeConversationMessages).toHaveBeenCalledTimes(2);
      expect(purgeConversationMessages).toHaveBeenCalledWith(
        expect.objectContaining({ claude_conversation_id: 'sess-100' }),
        '/repo/9'
      );
      expect(purgeConversationMessages).toHaveBeenCalledWith(
        expect.objectContaining({ claude_conversation_id: 'sess-101' }),
        '/repo/9'
      );
    });
  });

  describe('GET /api/tasks/:id/documentation', () => {
    it('should return task documentation', async () => {
      const mockTaskWithProject = { id: 1, project_id: 7, repo_folder_path: '/path/1' };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(readTaskDoc).mockReturnValue('# Task Documentation');

      const response = await request(app).get('/api/tasks/1/documentation');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ content: '# Task Documentation' });
      expect(readTaskDoc).toHaveBeenCalledWith(7, 1);
    });

    it('should return 404 if task not found', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const response = await request(app).get('/api/tasks/999/documentation');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should read from the central archive regardless of task status', async () => {
      const mockTaskWithProject = { id: 1, project_id: 7, repo_folder_path: '/path/1', status: 'completed' };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(readTaskDoc).mockReturnValue('# Archived doc');

      const response = await request(app).get('/api/tasks/1/documentation');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ content: '# Archived doc' });
      expect(worktreeExists).not.toHaveBeenCalled();
      expect(readTaskDoc).toHaveBeenCalledWith(7, 1);
    });
  });

  describe('PUT /api/tasks/:id/documentation', () => {
    it('should update task documentation', async () => {
      const mockTaskWithProject = { id: 1, project_id: 7, repo_folder_path: '/path/1' };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(writeTaskDoc).mockReturnValue(undefined);

      const response = await request(app)
        .put('/api/tasks/1/documentation')
        .send({ content: '# Updated Documentation' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(writeTaskDoc).toHaveBeenCalledWith(7, 1, '# Updated Documentation');
    });

    it('should return 400 if content is missing', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, repo_folder_path: '/path/1' };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);

      const response = await request(app)
        .put('/api/tasks/1/documentation')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(Array.isArray(response.body.issues)).toBe(true);
    });
  });

  describe('PUT /api/tasks/:id/workflow-complete', () => {
    it('should set workflow_complete to true and mark refinement + PR agent complete', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, workflow_complete: 0 };
      const updatedTask = { id: 1, project_id: 1, workflow_complete: 1, refinement_complete: 1, pr_agent_complete: 1 };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.update).mockReturnValue(updatedTask as never);
      vi.mocked(tasksDb.markRefinementComplete).mockReturnValue(updatedTask as never);
      vi.mocked(tasksDb.markPrAgentComplete).mockReturnValue(updatedTask as never);
      vi.mocked(tasksDb.getById).mockReturnValue(updatedTask as never);
      vi.mocked(forceCompleteRunningAgents).mockReturnValue(0);

      const response = await request(app)
        .put('/api/tasks/1/workflow-complete')
        .send({ complete: true });

      expect(response.status).toBe(200);
      expect(response.body.workflow_complete).toBe(1);
      expect(response.body.pr_agent_complete).toBe(1);
      expect(response.body.refinement_complete).toBe(1);
      expect(tasksDb.update).toHaveBeenCalledWith(1, { workflow_complete: 1 });
      expect(tasksDb.markRefinementComplete).toHaveBeenCalledWith(1);
      expect(tasksDb.markPrAgentComplete).toHaveBeenCalledWith(1);
    });

    it('should set workflow_complete to false and reset refinement_complete', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, workflow_complete: 1 };
      const updatedTask = { id: 1, project_id: 1, workflow_complete: 0, pr_agent_complete: 0, refinement_complete: 0 };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.update).mockReturnValue(updatedTask as never);
      vi.mocked(tasksDb.getById).mockReturnValue(updatedTask as never);

      const response = await request(app)
        .put('/api/tasks/1/workflow-complete')
        .send({ complete: false });

      expect(response.status).toBe(200);
      expect(response.body.workflow_complete).toBe(0);
      expect(tasksDb.update).toHaveBeenCalledWith(1, { workflow_complete: 0 });
      // Should not call forceCompleteRunningAgents or markPrAgentComplete when setting to false
      expect(forceCompleteRunningAgents).not.toHaveBeenCalled();
      expect(tasksDb.markPrAgentComplete).not.toHaveBeenCalled();
      // Should reset refinement_complete when setting to false
      expect(tasksDb.resetRefinementComplete).toHaveBeenCalledWith(1);
    });

    it('should force-complete running agents when setting complete=true', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, workflow_complete: 0 };
      const updatedTask = { id: 1, project_id: 1, workflow_complete: 1, refinement_complete: 1, pr_agent_complete: 1 };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.update).mockReturnValue(updatedTask as never);
      vi.mocked(tasksDb.markRefinementComplete).mockReturnValue(updatedTask as never);
      vi.mocked(tasksDb.markPrAgentComplete).mockReturnValue(updatedTask as never);
      vi.mocked(tasksDb.getById).mockReturnValue(updatedTask as never);
      vi.mocked(forceCompleteRunningAgents).mockReturnValue(2); // 2 agents were force-completed

      const response = await request(app)
        .put('/api/tasks/1/workflow-complete')
        .send({ complete: true });

      expect(response.status).toBe(200);
      expect(forceCompleteRunningAgents).toHaveBeenCalledWith(1);
    });

    it('should return 400 for invalid task ID', async () => {
      const response = await request(app)
        .put('/api/tasks/invalid/workflow-complete')
        .send({ complete: true });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 400 if complete is missing', async () => {
      const response = await request(app)
        .put('/api/tasks/1/workflow-complete')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 400 if complete is not a boolean', async () => {
      const response = await request(app)
        .put('/api/tasks/1/workflow-complete')
        .send({ complete: 'yes' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 400 if complete is a number', async () => {
      const response = await request(app)
        .put('/api/tasks/1/workflow-complete')
        .send({ complete: 1 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 404 if task not found', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(null as never);

      const response = await request(app)
        .put('/api/tasks/999/workflow-complete')
        .send({ complete: true });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should return 404 if user is not a project member', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app)
        .put('/api/tasks/1/workflow-complete')
        .send({ complete: true });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should handle recovery scenario: stuck agent gets force-completed', async () => {
      // Simulate a stuck agent scenario
      const mockTaskWithProject = { id: 1, project_id: 1, workflow_complete: 0 };
      const updatedTask = { id: 1, project_id: 1, workflow_complete: 1, refinement_complete: 1, pr_agent_complete: 1 };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.update).mockReturnValue(updatedTask as never);
      vi.mocked(tasksDb.markRefinementComplete).mockReturnValue(updatedTask as never);
      vi.mocked(tasksDb.markPrAgentComplete).mockReturnValue(updatedTask as never);
      vi.mocked(tasksDb.getById).mockReturnValue(updatedTask as never);
      vi.mocked(forceCompleteRunningAgents).mockReturnValue(1); // 1 stuck agent

      const response = await request(app)
        .put('/api/tasks/1/workflow-complete')
        .send({ complete: true });

      expect(response.status).toBe(200);
      expect(response.body.workflow_complete).toBe(1);
      expect(response.body.refinement_complete).toBe(1);
      expect(response.body.pr_agent_complete).toBe(1);
      expect(forceCompleteRunningAgents).toHaveBeenCalledWith(1);
    });
  });

  // ============================================================================
  // Worktree Endpoints Tests
  // ============================================================================

  describe('POST /api/projects/:projectId/tasks (with worktree)', () => {
    it('should create worktree for git repository projects', async () => {
      const mockProject = { id: 1, project_id: 1, repo_folder_path: '/path/to/repo' };
      const newTask = { id: 5, projectId: 1, title: 'New Feature' };
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.create).mockReturnValue(newTask as never);
      vi.mocked(isGitRepository).mockResolvedValue(true);
      vi.mocked(createWorktree).mockResolvedValue({
        success: true,
        worktreePath: '/path/to/repo-worktrees/task-5',
        branch: 'task/5-new-feature'
      });
      vi.mocked(writeTaskDoc).mockReturnValue(undefined);

      const response = await request(app)
        .post('/api/projects/1/tasks')
        .send({ title: 'New Feature' });

      expect(response.status).toBe(201);
      expect(isGitRepository).toHaveBeenCalledWith('/path/to/repo');
      expect(createWorktree).toHaveBeenCalledWith('/path/to/repo', 5, 'New Feature', undefined);
      expect(response.body.worktree_path).toBe('/path/to/repo-worktrees/task-5');
      expect(response.body.worktree_branch).toBe('task/5-new-feature');
    });

    it('should skip worktree creation for non-git projects', async () => {
      const mockProject = { id: 1, project_id: 1, repo_folder_path: '/path/to/folder' };
      const newTask = { id: 5, projectId: 1, title: 'Task' };
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.create).mockReturnValue(newTask as never);
      vi.mocked(isGitRepository).mockResolvedValue(false);
      vi.mocked(writeTaskDoc).mockReturnValue(undefined);

      const response = await request(app)
        .post('/api/projects/1/tasks')
        .send({ title: 'Task' });

      expect(response.status).toBe(201);
      expect(createWorktree).not.toHaveBeenCalled();
    });

    it('should rollback task on worktree creation failure', async () => {
      const mockProject = { id: 1, project_id: 1, repo_folder_path: '/path/to/repo' };
      const newTask = { id: 5, projectId: 1, title: 'Task' };
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.create).mockReturnValue(newTask as never);
      vi.mocked(isGitRepository).mockResolvedValue(true);
      vi.mocked(createWorktree).mockResolvedValue({
        success: false,
        error: 'Branch already exists'
      });

      const response = await request(app)
        .post('/api/projects/1/tasks')
        .send({ title: 'Task' });

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('Failed to create worktree');
      expect(tasksDb.delete).toHaveBeenCalledWith(5);
    });
  });

  describe('DELETE /api/tasks/:id (with worktree)', () => {
    it('should remove worktree when deleting task', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.delete).mockReturnValue(true);
      vi.mocked(deleteTaskArchive).mockReturnValue(undefined);
      vi.mocked(worktreeExists).mockResolvedValue(true);
      vi.mocked(removeWorktree).mockResolvedValue({ success: true });

      const response = await request(app).delete('/api/tasks/1');

      expect(response.status).toBe(200);
      expect(worktreeExists).toHaveBeenCalledWith('/path/to/repo', 1);
      expect(removeWorktree).toHaveBeenCalledWith('/path/to/repo', 1);
    });

    it('should continue deletion if worktree removal fails', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.delete).mockReturnValue(true);
      vi.mocked(deleteTaskArchive).mockReturnValue(undefined);
      vi.mocked(worktreeExists).mockResolvedValue(true);
      vi.mocked(removeWorktree).mockResolvedValue({ success: false, error: 'Worktree locked' });

      const response = await request(app).delete('/api/tasks/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
    });

    it('should skip worktree removal if worktree does not exist', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.delete).mockReturnValue(true);
      vi.mocked(deleteTaskArchive).mockReturnValue(undefined);
      vi.mocked(worktreeExists).mockResolvedValue(false);

      const response = await request(app).delete('/api/tasks/1');

      expect(response.status).toBe(200);
      expect(removeWorktree).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/tasks/:id/review-recording', () => {
    let tempDir: string;
    let videoPath: string;
    let mockTaskWithProject: { id: number; project_id: number; repo_folder_path: string; subproject_path: string | null };

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'review-recording-test-'));
      videoPath = join(tempDir, 'task-1.webm');
      mockTaskWithProject = {
        id: 1,
        project_id: 42,
        repo_folder_path: '/path/to/repo',
        subproject_path: null
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);
      // Recording lives in the central archive (mocked via getRecordingPath)
      vi.mocked(getRecordingPath).mockReturnValue(videoPath);
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('should return 404 when task not found', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(null as never);

      const response = await request(app)
        .get('/api/tasks/999/review-recording');

      expect(response.status).toBe(404);
    });

    it('should return 404 when user has no access', async () => {
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app)
        .get('/api/tasks/1/review-recording');

      expect(response.status).toBe(404);
    });

    it('should return 404 when recording file does not exist', async () => {
      const response = await request(app)
        .get('/api/tasks/1/review-recording');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('No review recording found');
    });

    it('should return 400 for invalid task ID', async () => {
      const response = await request(app)
        .get('/api/tasks/abc/review-recording');

      expect(response.status).toBe(400);
    });

    it('should serve video with correct content type when recording exists', async () => {
      writeFileSync(videoPath, 'fake-video-data');

      const response = await request(app)
        .get('/api/tasks/1/review-recording');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('video/webm');
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(getRecordingPath).toHaveBeenCalledWith(42, 1);
    });

    it('should support range requests for video seeking', async () => {
      const videoContent = Buffer.alloc(10000, 'x');
      writeFileSync(videoPath, videoContent);

      const response = await request(app)
        .get('/api/tasks/1/review-recording')
        .set('Range', 'bytes=0-999');

      expect(response.status).toBe(206);
      expect(response.headers['content-range']).toBe('bytes 0-999/10000');
      expect(response.headers['content-type']).toBe('video/webm');
    });
  });

  describe('GET /api/tasks/:id/worktree', () => {
    it('should return worktree status', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(getWorktreeStatus).mockResolvedValue({
        success: true,
        branch: 'task/1-feature',
        ahead: 3,
        behind: 1,
        mainBranch: 'main',
        worktreePath: '/path/to/repo-worktrees/task-1'
      });

      const response = await request(app).get('/api/tasks/1/worktree');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.branch).toBe('task/1-feature');
      expect(response.body.ahead).toBe(3);
      expect(response.body.behind).toBe(1);
    });

    it('should return 404 for non-existent task', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const response = await request(app).get('/api/tasks/999/worktree');

      expect(response.status).toBe(404);
    });

    it('should return 404 for different user task', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).get('/api/tasks/1/worktree');

      expect(response.status).toBe(404);
    });

    it('should return 400 for invalid task ID', async () => {
      const response = await request(app).get('/api/tasks/invalid/worktree');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });
  });

  describe('POST /api/tasks/:id/sync', () => {
    it('should sync worktree with main', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(syncWithMain).mockResolvedValue({ success: true });

      const response = await request(app).post('/api/tasks/1/sync');

      expect(response.status).toBe(200);
      expect(syncWithMain).toHaveBeenCalledWith('/path/to/repo', 1);
      expect(response.body.success).toBe(true);
    });

    it('should return sync error', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(syncWithMain).mockResolvedValue({ success: false, error: 'Merge conflict' });

      const response = await request(app).post('/api/tasks/1/sync');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Merge conflict');
    });

    it('should return 404 for non-existent task', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const response = await request(app).post('/api/tasks/999/sync');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/tasks/:id/pull-request', () => {
    it('should create pull request without auto-commit when no uncommitted changes', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        title: 'My Task',
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: false });
      vi.mocked(getWorktreeStatus).mockResolvedValue({ success: true, ahead: 1, behind: 0 });
      vi.mocked(createPullRequest).mockResolvedValue({
        success: true,
        url: 'https://github.com/user/repo/pull/123'
      });

      const response = await request(app)
        .post('/api/tasks/1/pull-request')
        .send({ title: 'Add feature', body: 'Description' });

      expect(response.status).toBe(200);
      expect(hasUncommittedChanges).toHaveBeenCalledWith('/path/to/repo', 1);
      expect(commitAllChanges).not.toHaveBeenCalled();
      expect(createPullRequest).toHaveBeenCalledWith('/path/to/repo', 1, 'Add feature', 'Description');
      expect(response.body.success).toBe(true);
      expect(response.body.url).toBe('https://github.com/user/repo/pull/123');
    });

    it('should auto-commit uncommitted changes before creating PR', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        title: 'My Task Title',
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: true });
      vi.mocked(commitAllChanges).mockResolvedValue({ success: true });
      vi.mocked(getWorktreeStatus).mockResolvedValue({ success: true, ahead: 1, behind: 0 });
      vi.mocked(createPullRequest).mockResolvedValue({
        success: true,
        url: 'https://github.com/user/repo/pull/123'
      });

      const response = await request(app)
        .post('/api/tasks/1/pull-request')
        .send({ title: 'Add feature', body: 'Description' });

      expect(response.status).toBe(200);
      expect(hasUncommittedChanges).toHaveBeenCalledWith('/path/to/repo', 1);
      // Now uses PR title for commit message (via prService.createOrUpdatePR)
      expect(commitAllChanges).toHaveBeenCalledWith('/path/to/repo', 1, 'Add feature');
      expect(createPullRequest).toHaveBeenCalledWith('/path/to/repo', 1, 'Add feature', 'Description');
      expect(response.body.success).toBe(true);
    });

    it('should use PR title for commit message (even when task title is missing)', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        title: null,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: true });
      vi.mocked(commitAllChanges).mockResolvedValue({ success: true });
      vi.mocked(getWorktreeStatus).mockResolvedValue({ success: true, ahead: 1, behind: 0 });
      vi.mocked(createPullRequest).mockResolvedValue({ success: true, url: 'https://github.com/...' });

      await request(app)
        .post('/api/tasks/1/pull-request')
        .send({ title: 'PR Title' });

      // Now uses PR title for commit message (via prService.createOrUpdatePR)
      expect(commitAllChanges).toHaveBeenCalledWith('/path/to/repo', 1, 'PR Title');
    });

    it('should return error if commit fails', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        title: 'My Task',
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: true });
      vi.mocked(commitAllChanges).mockResolvedValue({ success: false, error: 'Git error' });

      const response = await request(app)
        .post('/api/tasks/1/pull-request')
        .send({ title: 'PR Title' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      // prService returns 'Failed to commit:' prefix
      expect(response.body.error).toContain('Failed to commit');
      expect(createPullRequest).not.toHaveBeenCalled();
    });

    it('should return error when no commits ahead of main branch', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        title: 'My Task',
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: false });
      vi.mocked(getWorktreeStatus).mockResolvedValue({ success: true, ahead: 0, behind: 0 });

      const response = await request(app)
        .post('/api/tasks/1/pull-request')
        .send({ title: 'PR Title' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('No changes to create a PR');
      expect(createPullRequest).not.toHaveBeenCalled();
    });

    it('should return 400 if title is missing', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);

      const response = await request(app)
        .post('/api/tasks/1/pull-request')
        .send({ body: 'Description' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should use empty string for missing body', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        title: 'Task',
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: false });
      vi.mocked(getWorktreeStatus).mockResolvedValue({ success: true, ahead: 1, behind: 0 });
      vi.mocked(createPullRequest).mockResolvedValue({ success: true, url: 'https://github.com/...' });

      await request(app)
        .post('/api/tasks/1/pull-request')
        .send({ title: 'Title only' });

      expect(createPullRequest).toHaveBeenCalledWith('/path/to/repo', 1, 'Title only', '');
    });

    it('should return 404 for non-existent task', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const response = await request(app)
        .post('/api/tasks/999/pull-request')
        .send({ title: 'Title' });

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/tasks/:id/pull-request', () => {
    it('should return pull request status when PR exists', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(getPullRequestStatus).mockResolvedValue({
        success: true,
        exists: true,
        url: 'https://github.com/user/repo/pull/123',
        state: 'OPEN',
        mergeable: 'MERGEABLE'
      });

      const response = await request(app).get('/api/tasks/1/pull-request');

      expect(response.status).toBe(200);
      expect(response.body.exists).toBe(true);
      expect(response.body.url).toBe('https://github.com/user/repo/pull/123');
    });

    it('should return exists:false when no PR', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(getPullRequestStatus).mockResolvedValue({ success: true, exists: false });

      const response = await request(app).get('/api/tasks/1/pull-request');

      expect(response.status).toBe(200);
      expect(response.body.exists).toBe(false);
    });

    it('should return 404 for non-existent task', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const response = await request(app).get('/api/tasks/999/pull-request');

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/tasks/:id/merge-cleanup', () => {
    it('should merge PR and cleanup worktree', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(mergeAndCleanup).mockResolvedValue({ success: true });

      const response = await request(app).post('/api/tasks/1/merge-cleanup');

      expect(response.status).toBe(200);
      expect(mergeAndCleanup).toHaveBeenCalledWith('/path/to/repo', 1);
      expect(response.body.success).toBe(true);
    });

    it('should return error on merge failure', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(mergeAndCleanup).mockResolvedValue({ success: false, error: 'PR not mergeable' });

      const response = await request(app).post('/api/tasks/1/merge-cleanup');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('PR not mergeable');
    });

    it('should return 404 for non-existent task', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const response = await request(app).post('/api/tasks/999/merge-cleanup');

      expect(response.status).toBe(404);
    });

    it('should return 404 for different user task', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).post('/api/tasks/1/merge-cleanup');

      expect(response.status).toBe(404);
    });

    it('should return 400 for invalid task ID', async () => {
      const response = await request(app).post('/api/tasks/invalid/merge-cleanup');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should auto-switch server to main when worktree was active server', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      const mockProject = {
        id: 1,
        project_id: 1,
        active_worktree_task_id: 1, // This task is the active server
        serve_symlink_path: '/tmp/serve'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(mergeAndCleanup).mockResolvedValue({ success: true });
      vi.mocked(switchWorktree).mockResolvedValue({ success: true, activeTaskId: null });

      const response = await request(app).post('/api/tasks/1/merge-cleanup');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.serverSwitched).toBe(true);
      expect(response.body.serverSwitchMessage).toBe('Server switched back to main repository');
      expect(switchWorktree).toHaveBeenCalledWith(1, null, testUserId);
    });

    it('should not switch server when worktree was not active server', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      const mockProject = {
        id: 1,
        project_id: 1,
        active_worktree_task_id: 2, // Different task is active server
        serve_symlink_path: '/tmp/serve'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(mergeAndCleanup).mockResolvedValue({ success: true });

      const response = await request(app).post('/api/tasks/1/merge-cleanup');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.serverSwitched).toBeUndefined();
      expect(switchWorktree).not.toHaveBeenCalled();
    });

    it('should not switch server when project has no web server configured', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      const mockProject = {
        id: 1,
        project_id: 1,
        active_worktree_task_id: 1,
        serve_symlink_path: null // No web server configured
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(mergeAndCleanup).mockResolvedValue({ success: true });

      const response = await request(app).post('/api/tasks/1/merge-cleanup');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.serverSwitched).toBeUndefined();
      expect(switchWorktree).not.toHaveBeenCalled();
    });

    it('should include warning when server switch has warning', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      const mockProject = {
        id: 1,
        project_id: 1,
        active_worktree_task_id: 1,
        serve_symlink_path: '/tmp/serve'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(mergeAndCleanup).mockResolvedValue({ success: true });
      vi.mocked(switchWorktree).mockResolvedValue({
        success: true,
        activeTaskId: null,
        warning: 'Service restart failed'
      });

      const response = await request(app).post('/api/tasks/1/merge-cleanup');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.serverSwitched).toBe(true);
      expect(response.body.serverSwitchWarning).toBe('Service restart failed');
    });

    it('should include error when server switch fails', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      const mockProject = {
        id: 1,
        project_id: 1,
        active_worktree_task_id: 1,
        serve_symlink_path: '/tmp/serve'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(mergeAndCleanup).mockResolvedValue({ success: true });
      vi.mocked(switchWorktree).mockResolvedValue({
        success: false,
        error: 'Failed to update symlink'
      });

      const response = await request(app).post('/api/tasks/1/merge-cleanup');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.serverSwitchError).toBe('Failed to update symlink');
    });
  });

  describe('POST /api/tasks/:id/push-changes', () => {
    it('should push changes successfully', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        title: 'My Task',
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(pushChanges).mockResolvedValue({ success: true });

      const response = await request(app).post('/api/tasks/1/push-changes');

      expect(response.status).toBe(200);
      expect(pushChanges).toHaveBeenCalledWith('/path/to/repo', 1, 'My Task');
      expect(response.body.success).toBe(true);
    });

    it('should use provided commit message', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        title: 'My Task',
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(pushChanges).mockResolvedValue({ success: true });

      const response = await request(app)
        .post('/api/tasks/1/push-changes')
        .send({ commitMessage: 'Custom commit message' });

      expect(response.status).toBe(200);
      expect(pushChanges).toHaveBeenCalledWith('/path/to/repo', 1, 'Custom commit message');
    });

    it('should fallback to Task #id if no title', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        title: null,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(pushChanges).mockResolvedValue({ success: true });

      const response = await request(app).post('/api/tasks/1/push-changes');

      expect(response.status).toBe(200);
      expect(pushChanges).toHaveBeenCalledWith('/path/to/repo', 1, 'Task #1');
    });

    it('should return error on push failure', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        title: 'My Task',
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(pushChanges).mockResolvedValue({ success: false, error: 'Push rejected' });

      const response = await request(app).post('/api/tasks/1/push-changes');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Push rejected');
    });

    it('should return 404 for non-existent task', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const response = await request(app).post('/api/tasks/999/push-changes');

      expect(response.status).toBe(404);
    });

    it('should return 404 for different user task', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).post('/api/tasks/1/push-changes');

      expect(response.status).toBe(404);
    });

    it('should return 400 for invalid task ID', async () => {
      const response = await request(app).post('/api/tasks/invalid/push-changes');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });
  });

  describe('DELETE /api/tasks/:id/worktree', () => {
    it('should discard worktree without uncommitted changes', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(worktreeExists).mockResolvedValue(true);
      vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: false });
      vi.mocked(removeWorktree).mockResolvedValue({ success: true });

      const response = await request(app).delete('/api/tasks/1/worktree');

      expect(response.status).toBe(200);
      expect(worktreeExists).toHaveBeenCalledWith('/path/to/repo', 1);
      expect(hasUncommittedChanges).toHaveBeenCalledWith('/path/to/repo', 1);
      expect(removeWorktree).toHaveBeenCalledWith('/path/to/repo', 1);
      expect(response.body.success).toBe(true);
    });

    it('should return 409 when worktree has uncommitted changes without force', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(worktreeExists).mockResolvedValue(true);
      vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: true });

      const response = await request(app).delete('/api/tasks/1/worktree');

      expect(response.status).toBe(409);
      expect(response.body.hasChanges).toBe(true);
      expect(response.body.error).toBe('Worktree has uncommitted changes');
      expect(removeWorktree).not.toHaveBeenCalled();
    });

    it('should discard worktree with uncommitted changes when force=true', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(worktreeExists).mockResolvedValue(true);
      vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: true });
      vi.mocked(removeWorktree).mockResolvedValue({ success: true });

      const response = await request(app).delete('/api/tasks/1/worktree?force=true');

      expect(response.status).toBe(200);
      expect(removeWorktree).toHaveBeenCalledWith('/path/to/repo', 1);
      expect(response.body.success).toBe(true);
    });

    it('should return 404 when worktree does not exist', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(worktreeExists).mockResolvedValue(false);

      const response = await request(app).delete('/api/tasks/1/worktree');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Worktree not found');
    });

    it('should return 404 for non-existent task', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const response = await request(app).delete('/api/tasks/999/worktree');

      expect(response.status).toBe(404);
    });

    it('should return 404 for different user task', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).delete('/api/tasks/1/worktree');

      expect(response.status).toBe(404);
    });

    it('should return 400 for invalid task ID', async () => {
      const response = await request(app).delete('/api/tasks/invalid/worktree');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return error on remove worktree failure', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        repo_folder_path: '/path/to/repo'
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(worktreeExists).mockResolvedValue(true);
      vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: false });
      vi.mocked(removeWorktree).mockResolvedValue({ success: false, error: 'Worktree locked' });

      const response = await request(app).delete('/api/tasks/1/worktree');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Worktree locked');
    });
  });

  // ============================================================================
  // Resume Blocked Workflow Tests
  // ============================================================================

  describe('POST /api/tasks/:id/resume', () => {
    it('should unblock workflow and reset run count', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        workflow_blocked: 1,
        workflow_run_count: 10
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.unblockWorkflow).mockReturnValue({ ...mockTaskWithProject, workflow_blocked: 0 } as never);
      vi.mocked(tasksDb.resetRunCount).mockReturnValue({ ...mockTaskWithProject, workflow_run_count: 0 } as never);

      const response = await request(app)
        .post('/api/tasks/1/resume')
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.workflow_blocked).toBe(false);
      expect(response.body.workflow_run_count).toBe(0);
      expect(tasksDb.unblockWorkflow).toHaveBeenCalledWith(1);
      expect(tasksDb.resetRunCount).toHaveBeenCalledWith(1);
    });

    it('should return 400 if task is not blocked', async () => {
      const mockTaskWithProject = {
        id: 1,
        project_id: 1,
        workflow_blocked: 0
      };
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);

      const response = await request(app)
        .post('/api/tasks/1/resume')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Task workflow is not blocked');
      expect(tasksDb.unblockWorkflow).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid task ID', async () => {
      const response = await request(app)
        .post('/api/tasks/invalid/resume')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 404 if task not found', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(null as never);

      const response = await request(app)
        .post('/api/tasks/999/resume')
        .send({});

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should return 404 if user is not a project member', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1, workflow_blocked: 1 } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app)
        .post('/api/tasks/1/resume')
        .send({});

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });
  });
});
