import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies before importing the module under test
vi.mock('../database/db.js', () => ({
  tasksDb: {
    getById: vi.fn(),
    getWithProject: vi.fn(),
    update: vi.fn(),
    incrementRunCount: vi.fn()
  },
  agentRunsDb: {
    create: vi.fn(),
    getByTask: vi.fn(),
    linkConversation: vi.fn(),
    updateStatus: vi.fn()
  },
  conversationsDb: {
    create: vi.fn(),
    updateClaudeId: vi.fn()
  },
  userDb: {
    getUserById: vi.fn()
  }
}));

vi.mock('./conversationAdapter.js', () => ({
  startConversation: vi.fn()
}));

vi.mock('./notifications.js', () => ({
  notifyClaudeComplete: vi.fn().mockResolvedValue(undefined),
  updateUserBadge: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./documentation.js', () => ({
  buildContextPrompt: vi.fn().mockReturnValue('test context prompt'),
  getTaskDocPath: vi.fn((projectId, taskId) => `/archive/projects/${projectId}/tasks/task-${taskId}.md`),
  getRecordingPath: vi.fn((projectId, taskId) => `/archive/projects/${projectId}/recordings/task-${taskId}.webm`)
}));

vi.mock('../constants/agentPrompts.js', () => ({
  generatePlanificationMessage: vi.fn().mockReturnValue('planification message'),
  generateImplementationMessage: vi.fn().mockReturnValue('implementation message'),
  generateReviewMessage: vi.fn().mockReturnValue('review message'),
  generateRefinementMessage: vi.fn().mockReturnValue('refinement message')
}));

vi.mock('./worktree.js', () => ({
  getWorktreePath: vi.fn(),
  getWorktreeProjectPath: vi.fn(),
  worktreeExists: vi.fn()
}));

vi.mock('./claudeCredentials.js', () => ({
  validateClaudeCredentials: vi.fn(),
}));

// Phase 6 + credential registry: agentRunner now goes through
// getCredentialStore(provider).read(userId) for the validate-before-run
// step. The fakeRead function is mutable so individual tests can flip
// it to throw (mirroring the old validateClaudeCredentials path).
const credentialStoreReadMock = vi.hoisted(() => vi.fn(() => ({ token: 'tkn', tokenPath: '/x' })));

vi.mock('./credentials/registry.js', () => ({
  getCredentialStore: vi.fn(() => ({
    read: credentialStoreReadMock,
    write: vi.fn(),
    clear: vi.fn(),
    getStatus: vi.fn(),
    buildSdkEnv: vi.fn(),
  })),
  registerCredentialStore: vi.fn(),
  hasCredentialStore: vi.fn(() => true),
}));

vi.mock('./agentModelSettings.js', () => ({
  loadAgentModelSettings: vi.fn().mockReturnValue({
    planification: { provider: 'anthropic', model: 'opus', effort: 'high' },
    implementation: { provider: 'anthropic', model: 'opus', effort: 'high' },
    refinement: { provider: 'anthropic', model: 'opus', effort: 'high' },
    review: { provider: 'anthropic', model: 'opus', effort: 'high' },
    pr: { provider: 'anthropic', model: 'opus', effort: 'high' },
    yolo: { provider: 'anthropic', model: 'opus', effort: 'high' }
  })
}));

import {
  startAgentRun,
  getRunningAgentForTask,
  forceCompleteRunningAgents
} from './agentRunner.js';

import { tasksDb, agentRunsDb, conversationsDb, userDb } from '../database/db.js';
import { startConversation } from './conversationAdapter.js';
import { updateUserBadge } from './notifications.js';
import { buildContextPrompt } from './documentation.js';
import {
  generatePlanificationMessage,
  generateImplementationMessage,
  generateReviewMessage,
  generateRefinementMessage
} from '../constants/agentPrompts.js';
import { getWorktreeProjectPath, worktreeExists } from './worktree.js';
import { validateClaudeCredentials } from './claudeCredentials.js';
import { loadAgentModelSettings } from './agentModelSettings.js';

describe('agentRunner', () => {
  const mockTaskWithProject = {
    id: 1,
    project_id: 1,
    title: 'Test Task',
    status: 'pending',
    repo_folder_path: '/path/to/project',
    user_id: 1,
    workflow_complete: 0
  };

  const mockAgentRun = {
    id: 1,
    task_id: 1,
    agent_type: 'implementation',
    status: 'running',
    conversation_id: null
  };

  const mockConversation = {
    id: 1,
    task_id: 1,
    claude_session_id: null
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startAgentRun', () => {
    beforeEach(() => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(agentRunsDb.create).mockReturnValue(mockAgentRun as never);
      vi.mocked(conversationsDb.create).mockReturnValue(mockConversation as never);
      vi.mocked(agentRunsDb.linkConversation).mockReturnValue({ ...mockAgentRun, conversation_id: 1 } as never);
      vi.mocked(startConversation).mockResolvedValue({ conversationId: 1, claudeSessionId: 'session-123' });
      vi.mocked(worktreeExists).mockResolvedValue(false);
      vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, username: 'test', is_technical: 1 } as never);
    });

    it('should throw error if task not found', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(null as never);

      await expect(startAgentRun(999, 'implementation')).rejects.toThrow('Task 999 not found');
    });

    it('should throw error for unknown agent type', async () => {
      await expect(startAgentRun(1, 'unknown' as never)).rejects.toThrow('Unknown agent type: unknown');
    });

    it('should validate provider credentials before creating run records', async () => {
      credentialStoreReadMock.mockImplementationOnce(() => {
        throw new Error('Claude credentials are not provisioned for user 42');
      });

      await expect(startAgentRun(1, 'implementation', { userId: 42 }))
        .rejects.toThrow('Claude credentials are not provisioned for user 42');

      expect(tasksDb.incrementRunCount).not.toHaveBeenCalled();
      expect(agentRunsDb.create).not.toHaveBeenCalled();
      expect(conversationsDb.create).not.toHaveBeenCalled();
      expect(startConversation).not.toHaveBeenCalled();
    });

    it('should create agent run and conversation for planification agent', async () => {
      const result = await startAgentRun(1, 'planification');

      expect(generatePlanificationMessage).toHaveBeenCalledWith('/archive/projects/1/tasks/task-1.md', 1, true);
      expect(agentRunsDb.create).toHaveBeenCalledWith(1, 'planification', null, 'anthropic');
      expect(conversationsDb.create).toHaveBeenCalledWith(1, 'anthropic', 'opus', 'high');
      expect(agentRunsDb.linkConversation).toHaveBeenCalledWith(1, 1);
      expect(result.agentRun).toEqual(mockAgentRun);
      expect(result.conversation).toEqual(mockConversation);
    });

    it('should fall back to the task owner is_technical when no userId is supplied', async () => {
      // No userId on options → effectiveUserId falls back to taskWithProject.user_id (= 1).
      vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, username: 'owner', is_technical: 0 } as never);

      await startAgentRun(1, 'planification');

      expect(userDb.getUserById).toHaveBeenCalledWith(1);
      expect(generatePlanificationMessage).toHaveBeenCalledWith('/archive/projects/1/tasks/task-1.md', 1, false);
    });

    it('should use the acting user is_technical even when the task owner differs (non-tech actor on tech-owned task)', async () => {
      // Task owner is user 1 (technical); acting user is 2 (non-technical).
      vi.mocked(userDb.getUserById).mockImplementation(((id: number) =>
        id === 2
          ? { id: 2, username: 'actor', is_technical: 0 }
          : { id: 1, username: 'owner', is_technical: 1 }) as never);

      await startAgentRun(1, 'planification', { userId: 2 });

      expect(userDb.getUserById).toHaveBeenCalledWith(2);
      expect(generatePlanificationMessage).toHaveBeenCalledWith('/archive/projects/1/tasks/task-1.md', 1, false);
    });

    it('should use the acting user is_technical even when the task owner differs (tech actor on non-tech-owned task)', async () => {
      // Task owner is user 1 (non-technical); acting user is 2 (technical).
      vi.mocked(userDb.getUserById).mockImplementation(((id: number) =>
        id === 2
          ? { id: 2, username: 'actor', is_technical: 1 }
          : { id: 1, username: 'owner', is_technical: 0 }) as never);

      await startAgentRun(1, 'planification', { userId: 2 });

      expect(userDb.getUserById).toHaveBeenCalledWith(2);
      expect(generatePlanificationMessage).toHaveBeenCalledWith('/archive/projects/1/tasks/task-1.md', 1, true);
    });

    it('should create agent run and conversation for implementation agent', async () => {
      const result = await startAgentRun(1, 'implementation');

      expect(generateImplementationMessage).toHaveBeenCalledWith('/archive/projects/1/tasks/task-1.md', 1);
      expect(agentRunsDb.create).toHaveBeenCalledWith(1, 'implementation', null, 'anthropic');
      expect(conversationsDb.create).toHaveBeenCalledWith(1, 'anthropic', 'opus', 'high');
      expect(result.agentRun).toEqual(mockAgentRun);
    });

    it('should create agent run and conversation for review agent', async () => {
      const result = await startAgentRun(1, 'review');

      expect(generateReviewMessage).toHaveBeenCalledWith('/archive/projects/1/tasks/task-1.md', 1);
      expect(agentRunsDb.create).toHaveBeenCalledWith(1, 'review', null, 'anthropic');
      expect(conversationsDb.create).toHaveBeenCalledWith(1, 'anthropic', 'opus', 'high');
      expect(result.agentRun).toEqual(mockAgentRun);
    });

    it('should create agent run and conversation for refinement agent', async () => {
      const result = await startAgentRun(1, 'refinement');

      expect(generateRefinementMessage).toHaveBeenCalledWith('/archive/projects/1/tasks/task-1.md', 1);
      expect(agentRunsDb.create).toHaveBeenCalledWith(1, 'refinement', null, 'anthropic');
      expect(conversationsDb.create).toHaveBeenCalledWith(1, 'anthropic', 'opus', 'high');
      expect(result.agentRun).toEqual(mockAgentRun);
    });

    it('should update task status to in_progress when task is pending', async () => {
      await startAgentRun(1, 'implementation');

      expect(tasksDb.update).toHaveBeenCalledWith(1, { status: 'in_progress' });
    });

    it('should not update task status when task is already in_progress', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue({
        ...mockTaskWithProject,
        status: 'in_progress'
      } as never);

      await startAgentRun(1, 'implementation');

      expect(tasksDb.update).not.toHaveBeenCalled();
    });

    it('should send badge update notification when userId is provided', async () => {
      await startAgentRun(1, 'implementation', { userId: 1 });

      expect(updateUserBadge).toHaveBeenCalledWith(1);
    });

    it('should not send badge update notification when userId is not provided', async () => {
      await startAgentRun(1, 'implementation');

      expect(updateUserBadge).not.toHaveBeenCalled();
    });

    it('should build context prompt with project id and task id', async () => {
      await startAgentRun(1, 'implementation');

      expect(buildContextPrompt).toHaveBeenCalledWith(1, 1);
    });

    it('should pass the central-archive task doc path to the agent prompt', async () => {
      await startAgentRun(1, 'implementation');

      // Task doc always lives in the central archive (not the worktree)
      expect(generateImplementationMessage).toHaveBeenCalledWith(
        '/archive/projects/1/tasks/task-1.md',
        1
      );
    });

    it('should call startConversation with correct parameters', async () => {
      const broadcastFn = vi.fn();
      await startAgentRun(1, 'implementation', { broadcastFn, userId: 1 });

      expect(startConversation).toHaveBeenCalledWith(
        1,
        'implementation message',
        expect.objectContaining({
          broadcastFn,
          userId: 1,
          customSystemPrompt: 'test context prompt',
          permissionMode: 'bypassPermissions',
          conversationId: 1
        })
      );
    });

    it('should pass per-agent model and effort from agent_model_settings', async () => {
      vi.mocked(loadAgentModelSettings).mockReturnValueOnce({
        planification: { provider: 'anthropic', model: 'sonnet', effort: 'low' },
        implementation: { provider: 'anthropic', model: 'opus', effort: 'high' },
        refinement: { provider: 'anthropic', model: 'opus', effort: 'high' },
        review: { provider: 'anthropic', model: 'opus', effort: 'high' },
        pr: { provider: 'anthropic', model: 'opus', effort: 'high' },
        yolo: { provider: 'anthropic', model: 'opus', effort: 'high' }
      });

      await startAgentRun(1, 'planification');

      expect(startConversation).toHaveBeenCalledWith(
        1,
        'planification message',
        expect.objectContaining({
          model: 'sonnet',
          effort: 'low'
        })
      );
    });

    it('should stamp the configured provider on the conversation row (regression: gpt-5.5 → Anthropic SDK 404)', async () => {
      vi.mocked(loadAgentModelSettings).mockReturnValueOnce({
        planification: { provider: 'openai', model: 'gpt-5.5', effort: 'medium' },
        implementation: { provider: 'anthropic', model: 'opus', effort: 'high' },
        refinement: { provider: 'anthropic', model: 'opus', effort: 'high' },
        review: { provider: 'anthropic', model: 'opus', effort: 'high' },
        pr: { provider: 'anthropic', model: 'opus', effort: 'high' },
        yolo: { provider: 'anthropic', model: 'opus', effort: 'high' }
      });

      await startAgentRun(1, 'planification');

      expect(conversationsDb.create).toHaveBeenCalledWith(1, 'openai', 'gpt-5.5', 'medium');
    });

    it('should default each agent to opus + high when no overrides exist', async () => {
      await startAgentRun(1, 'review');

      expect(startConversation).toHaveBeenCalledWith(
        1,
        'review message',
        expect.objectContaining({
          model: 'opus',
          effort: 'high'
        })
      );
    });

    it('should disallow Agent tool for implementation agent', async () => {
      await startAgentRun(1, 'implementation');

      expect(startConversation).toHaveBeenCalledWith(
        1,
        'implementation message',
        expect.objectContaining({
          disallowedTools: ['Agent']
        })
      );
    });

    it('should not disallow Agent tool for planification agent', async () => {
      await startAgentRun(1, 'planification');

      expect(startConversation).toHaveBeenCalledWith(
        1,
        'planification message',
        expect.objectContaining({
          disallowedTools: []
        })
      );
    });

    it('should not disallow Agent tool for review agent', async () => {
      await startAgentRun(1, 'review');

      expect(startConversation).toHaveBeenCalledWith(
        1,
        'review message',
        expect.objectContaining({
          disallowedTools: []
        })
      );
    });

    it('should return claudeSessionId from adapter', async () => {
      const result = await startAgentRun(1, 'implementation');

      expect(result.claudeSessionId).toBe('session-123');
    });

    it('should pass videoConfig for review agent', async () => {
      await startAgentRun(1, 'review');

      expect(startConversation).toHaveBeenCalledWith(
        1,
        'review message',
        expect.objectContaining({
          videoConfig: expect.objectContaining({
            taskId: 1,
            recordingDestPath: '/archive/projects/1/recordings/task-1.webm',
            tempDir: expect.stringContaining('/tmp/bottega-video-1-'),
            worktreePath: '/path/to/project'
          })
        })
      );
    });

    it('should set videoConfig.worktreePath to the worktree path when a worktree exists', async () => {
      vi.mocked(worktreeExists).mockResolvedValue(true);
      vi.mocked(getWorktreeProjectPath).mockReturnValue('/path/to/project-worktrees/task-1');

      await startAgentRun(1, 'review');

      expect(startConversation).toHaveBeenCalledWith(
        1,
        'review message',
        expect.objectContaining({
          videoConfig: expect.objectContaining({
            worktreePath: '/path/to/project-worktrees/task-1'
          })
        })
      );
    });

    it('should not pass videoConfig for non-review agents', async () => {
      await startAgentRun(1, 'implementation');

      expect(startConversation).toHaveBeenCalledWith(
        1,
        'implementation message',
        expect.objectContaining({
          videoConfig: null
        })
      );
    });
  });

  describe('getRunningAgentForTask', () => {
    it('should return null when no agents are running', () => {
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([
        { id: 1, status: 'completed' } as never,
        { id: 2, status: 'failed' } as never
      ]);

      const result = getRunningAgentForTask(1);

      expect(result).toBeNull();
    });

    it('should return the running agent when one exists', () => {
      const runningAgent = { id: 2, status: 'running', agent_type: 'implementation' };
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([
        { id: 1, status: 'completed' } as never,
        runningAgent as never
      ]);

      const result = getRunningAgentForTask(1);

      expect(result).toEqual(runningAgent);
    });

    it('should return first running agent when multiple exist', () => {
      const firstRunning = { id: 2, status: 'running', agent_type: 'implementation' } as never;
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([
        { id: 1, status: 'completed' } as never,
        firstRunning,
        { id: 3, status: 'running', agent_type: 'review' } as never
      ]);

      const result = getRunningAgentForTask(1);

      expect(result).toEqual(firstRunning);
    });
  });

  describe('forceCompleteRunningAgents', () => {
    it('should return 0 when no agents are running', () => {
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([
        { id: 1, status: 'completed' } as never,
        { id: 2, status: 'failed' } as never
      ]);

      const result = forceCompleteRunningAgents(1);

      expect(result).toBe(0);
      expect(agentRunsDb.updateStatus).not.toHaveBeenCalled();
    });

    it('should force-complete single running agent', () => {
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([
        { id: 1, status: 'completed' } as never,
        { id: 2, status: 'running' } as never
      ]);

      const result = forceCompleteRunningAgents(1);

      expect(result).toBe(1);
      expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(2, 'completed');
    });

    it('should force-complete multiple running agents', () => {
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([
        { id: 1, status: 'running' } as never,
        { id: 2, status: 'completed' } as never,
        { id: 3, status: 'running' } as never
      ]);

      const result = forceCompleteRunningAgents(1);

      expect(result).toBe(2);
      expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(1, 'completed');
      expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(3, 'completed');
    });
  });
});
