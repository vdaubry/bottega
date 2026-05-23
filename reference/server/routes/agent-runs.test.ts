import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock the database module
vi.mock('../database/db.js', () => ({
  tasksDb: {
    getWithProject: vi.fn()
  },
  agentRunsDb: {
    create: vi.fn(),
    getById: vi.fn(),
    getByTask: vi.fn(),
    updateStatus: vi.fn(),
    linkConversation: vi.fn(),
    delete: vi.fn()
  }
}));

// Mock the projectService
vi.mock('../services/projectService.js', () => ({
  hasProjectAccess: vi.fn()
}));

// Mock the agentRunner service
vi.mock('../services/agentRunner.js', () => ({
  startAgentRun: vi.fn(),
  getRunningAgentForTask: vi.fn()
}));

import agentRunsRoutes from './agent-runs.js';
import { tasksDb, agentRunsDb } from '../database/db.js';
import { hasProjectAccess } from '../services/projectService.js';
import { startAgentRun, getRunningAgentForTask } from '../services/agentRunner.js';

describe('Agent Runs Routes', () => {
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
    // Mock WebSocket server
    app.locals.wss = {
      clients: new Set()
    };
    app.use('/api', agentRunsRoutes);
  });

  describe('GET /api/tasks/:taskId/agent-runs', () => {
    it('should return all agent runs for a task', async () => {
      const mockTaskWithProject = { id: 1, project_id: 1, repo_folder_path: '/path' };
      const mockAgentRuns = [
        { id: 1, task_id: 1, agent_type: 'implementation', status: 'completed' },
        { id: 2, task_id: 1, agent_type: 'review', status: 'running' }
      ];
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(agentRunsDb.getByTask).mockReturnValue(mockAgentRuns as never);

      const response = await request(app).get('/api/tasks/1/agent-runs');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockAgentRuns);
      expect(tasksDb.getWithProject).toHaveBeenCalledWith(1);
      expect(agentRunsDb.getByTask).toHaveBeenCalledWith(1);
    });

    it('should return 400 for invalid task ID', async () => {
      const response = await request(app).get('/api/tasks/invalid/agent-runs');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid task ID');
    });

    it('should return 404 if task not found', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(null as never);

      const response = await request(app).get('/api/tasks/999/agent-runs');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should return 404 if user is not a project member', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).get('/api/tasks/1/agent-runs');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should return empty array when no agent runs exist', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([]);

      const response = await request(app).get('/api/tasks/1/agent-runs');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });
  });

  describe('POST /api/tasks/:taskId/agent-runs', () => {
    const mockTaskWithProject = {
      id: 1,
      project_id: 1,
      repo_folder_path: '/path/to/project'
    };

    const mockAgentRun = {
      id: 1,
      task_id: 1,
      agent_type: 'implementation',
      status: 'running',
      conversation_id: 1
    };

    beforeEach(() => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(getRunningAgentForTask).mockReturnValue(null);
      vi.mocked(startAgentRun).mockResolvedValue({ agentRun: mockAgentRun } as never);
    });

    it('should start a new implementation agent run', async () => {
      const response = await request(app)
        .post('/api/tasks/1/agent-runs')
        .send({ agentType: 'implementation' });

      expect(response.status).toBe(201);
      expect(response.body).toEqual(mockAgentRun);
      expect(startAgentRun).toHaveBeenCalledWith(
        1,
        'implementation',
        expect.objectContaining({ userId: testUserId })
      );
    });

    it('should start a new planification agent run', async () => {
      vi.mocked(startAgentRun).mockResolvedValue({
        agentRun: { ...mockAgentRun, agent_type: 'planification' }
      } as never);

      const response = await request(app)
        .post('/api/tasks/1/agent-runs')
        .send({ agentType: 'planification' });

      expect(response.status).toBe(201);
      expect(startAgentRun).toHaveBeenCalledWith(
        1,
        'planification',
        expect.any(Object)
      );
    });

    it('should start a new review agent run', async () => {
      vi.mocked(startAgentRun).mockResolvedValue({
        agentRun: { ...mockAgentRun, agent_type: 'review' }
      } as never);

      const response = await request(app)
        .post('/api/tasks/1/agent-runs')
        .send({ agentType: 'review' });

      expect(response.status).toBe(201);
      expect(startAgentRun).toHaveBeenCalledWith(
        1,
        'review',
        expect.any(Object)
      );
    });

    it('should start a new refinement agent run', async () => {
      vi.mocked(startAgentRun).mockResolvedValue({
        agentRun: { ...mockAgentRun, agent_type: 'refinement' }
      } as never);

      const response = await request(app)
        .post('/api/tasks/1/agent-runs')
        .send({ agentType: 'refinement' });

      expect(response.status).toBe(201);
      expect(startAgentRun).toHaveBeenCalledWith(
        1,
        'refinement',
        expect.any(Object)
      );
    });

    it('should return 400 for invalid task ID', async () => {
      const response = await request(app)
        .post('/api/tasks/invalid/agent-runs')
        .send({ agentType: 'implementation' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid task ID');
    });

    it("returns 403 with provider tag when configured provider has no credentials", async () => {
      const { ProviderCredentialsMissingError } = await import(
        '../services/credentials/types.js'
      );
      vi.mocked(startAgentRun).mockRejectedValueOnce(
        new ProviderCredentialsMissingError(
          'openai',
          'Codex auth.json is not provisioned for user 42',
        ),
      );

      const response = await request(app)
        .post('/api/tasks/1/agent-runs')
        .send({ agentType: 'implementation' });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('PROVIDER_CREDENTIALS_MISSING');
      expect(response.body.provider).toBe('openai');
    });

    it('should return 400 for missing agentType', async () => {
      const response = await request(app)
        .post('/api/tasks/1/agent-runs')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid agent type');
    });

    it('should return 400 for invalid agentType', async () => {
      const response = await request(app)
        .post('/api/tasks/1/agent-runs')
        .send({ agentType: 'invalid' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid agent type');
      expect(response.body.error).toContain('planification');
      expect(response.body.error).toContain('implementation');
      expect(response.body.error).toContain('review');
      expect(response.body.error).toContain('yolo');
    });

    it('should accept yolo as a valid agentType', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1, repo_folder_path: '/path' } as never);
      vi.mocked(getRunningAgentForTask).mockReturnValue(null);
      vi.mocked(startAgentRun).mockResolvedValue({
        agentRun: { id: 42, task_id: 1, agent_type: 'yolo', status: 'running' }
      } as never);

      const response = await request(app)
        .post('/api/tasks/1/agent-runs')
        .send({ agentType: 'yolo' });

      expect(response.status).toBe(201);
      expect(startAgentRun).toHaveBeenCalledWith(
        1,
        'yolo',
        expect.objectContaining({ userId: testUserId })
      );
    });

    it('should return 404 if task not found', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(null as never);

      const response = await request(app)
        .post('/api/tasks/999/agent-runs')
        .send({ agentType: 'implementation' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should return 404 if user is not a project member', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app)
        .post('/api/tasks/1/agent-runs')
        .send({ agentType: 'implementation' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Task not found');
    });

    it('should return 409 if an agent is already running', async () => {
      const runningAgent = {
        id: 1,
        task_id: 1,
        agent_type: 'review',
        status: 'running'
      };
      vi.mocked(getRunningAgentForTask).mockReturnValue(runningAgent as never);

      const response = await request(app)
        .post('/api/tasks/1/agent-runs')
        .send({ agentType: 'implementation' });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('An agent is already running for this task');
      expect(response.body.runningAgent).toEqual(runningAgent);
      expect(startAgentRun).not.toHaveBeenCalled();
    });

    it('should return 500 if startAgentRun throws an error', async () => {
      vi.mocked(startAgentRun).mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/api/tasks/1/agent-runs')
        .send({ agentType: 'implementation' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to start agent run');
    });
  });

  describe('GET /api/agent-runs/:id', () => {
    const mockAgentRun = {
      id: 1,
      task_id: 1,
      agent_type: 'implementation',
      status: 'running'
    };

    it('should return agent run by ID', async () => {
      vi.mocked(agentRunsDb.getById).mockReturnValue(mockAgentRun as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);

      const response = await request(app).get('/api/agent-runs/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockAgentRun);
    });

    it('should return 400 for invalid agent run ID', async () => {
      const response = await request(app).get('/api/agent-runs/invalid');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid agent run ID');
    });

    it('should return 404 if agent run not found', async () => {
      vi.mocked(agentRunsDb.getById).mockReturnValue(null as never);

      const response = await request(app).get('/api/agent-runs/999');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Agent run not found');
    });

    it('should return 404 if user is not a project member', async () => {
      vi.mocked(agentRunsDb.getById).mockReturnValue(mockAgentRun as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).get('/api/agent-runs/1');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Agent run not found');
    });
  });

  describe('PUT /api/agent-runs/:id/complete', () => {
    const mockAgentRun = {
      id: 1,
      task_id: 1,
      agent_type: 'implementation',
      status: 'running'
    };

    it('should mark agent run as completed', async () => {
      const completedRun = { ...mockAgentRun, status: 'completed' };
      vi.mocked(agentRunsDb.getById).mockReturnValue(mockAgentRun as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(agentRunsDb.updateStatus).mockReturnValue(completedRun as never);

      const response = await request(app).put('/api/agent-runs/1/complete');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('completed');
      expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(1, 'completed');
    });

    it('should return 400 for invalid agent run ID', async () => {
      const response = await request(app).put('/api/agent-runs/invalid/complete');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid agent run ID');
    });

    it('should return 404 if agent run not found', async () => {
      vi.mocked(agentRunsDb.getById).mockReturnValue(null as never);

      const response = await request(app).put('/api/agent-runs/999/complete');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Agent run not found');
    });

    it('should return 404 if user is not a project member', async () => {
      vi.mocked(agentRunsDb.getById).mockReturnValue(mockAgentRun as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).put('/api/agent-runs/1/complete');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Agent run not found');
    });
  });

  describe('PUT /api/agent-runs/:id/link-conversation', () => {
    const mockAgentRun = {
      id: 1,
      task_id: 1,
      agent_type: 'implementation',
      status: 'running',
      conversation_id: null
    };

    it('should link conversation to agent run', async () => {
      const linkedRun = { ...mockAgentRun, conversation_id: 5 };
      vi.mocked(agentRunsDb.getById).mockReturnValue(mockAgentRun as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(agentRunsDb.linkConversation).mockReturnValue(linkedRun as never);

      const response = await request(app)
        .put('/api/agent-runs/1/link-conversation')
        .send({ conversationId: 5 });

      expect(response.status).toBe(200);
      expect(response.body.conversation_id).toBe(5);
      expect(agentRunsDb.linkConversation).toHaveBeenCalledWith(1, 5);
    });

    it('should return 400 for invalid agent run ID', async () => {
      const response = await request(app)
        .put('/api/agent-runs/invalid/link-conversation')
        .send({ conversationId: 5 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid agent run ID');
    });

    it('should return 400 if conversationId is missing', async () => {
      const response = await request(app)
        .put('/api/agent-runs/1/link-conversation')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Conversation ID is required');
    });

    it('should return 404 if agent run not found', async () => {
      vi.mocked(agentRunsDb.getById).mockReturnValue(null as never);

      const response = await request(app)
        .put('/api/agent-runs/999/link-conversation')
        .send({ conversationId: 5 });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Agent run not found');
    });

    it('should return 404 if user is not a project member', async () => {
      vi.mocked(agentRunsDb.getById).mockReturnValue(mockAgentRun as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app)
        .put('/api/agent-runs/1/link-conversation')
        .send({ conversationId: 5 });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Agent run not found');
    });
  });

  describe('DELETE /api/agent-runs/:id', () => {
    const mockAgentRun = {
      id: 1,
      task_id: 1,
      agent_type: 'implementation',
      status: 'completed'
    };

    it('should delete agent run', async () => {
      vi.mocked(agentRunsDb.getById).mockReturnValue(mockAgentRun as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(agentRunsDb.delete).mockReturnValue(true);

      const response = await request(app).delete('/api/agent-runs/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(agentRunsDb.delete).toHaveBeenCalledWith(1);
    });

    it('should return 400 for invalid agent run ID', async () => {
      const response = await request(app).delete('/api/agent-runs/invalid');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid agent run ID');
    });

    it('should return 404 if agent run not found', async () => {
      vi.mocked(agentRunsDb.getById).mockReturnValue(null as never);

      const response = await request(app).delete('/api/agent-runs/999');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Agent run not found');
    });

    it('should return 404 if user is not a project member', async () => {
      vi.mocked(agentRunsDb.getById).mockReturnValue(mockAgentRun as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).delete('/api/agent-runs/1');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Agent run not found');
    });

    it('should return 404 if delete returns false', async () => {
      vi.mocked(agentRunsDb.getById).mockReturnValue(mockAgentRun as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue({ id: 1, project_id: 1 } as never);
      vi.mocked(agentRunsDb.delete).mockReturnValue(false);

      const response = await request(app).delete('/api/agent-runs/1');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Agent run not found');
    });
  });
});
