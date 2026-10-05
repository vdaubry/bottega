import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies before importing the module under test
vi.mock('../database/db.js', () => ({
  tasksDb: {
    getById: vi.fn(),
    getWithProject: vi.fn(),
    assertWorktreeReady: vi.fn(),
    update: vi.fn(),
    incrementRunCount: vi.fn(),
    blockWorkflow: vi.fn()
  },
  taskAgentRunsDb: {
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
  buildEpicContextPrompt: vi.fn().mockReturnValue('epic context prompt'),
  ensureEpicDirs: vi.fn(),
  getTaskDocPath: vi.fn((projectId, taskId) => `/archive/projects/${projectId}/tasks/task-${taskId}.md`),
  getRecordingPath: vi.fn((projectId, taskId) => `/archive/projects/${projectId}/recordings/task-${taskId}.webm`)
}));

vi.mock('../constants/agentPrompts.js', () => ({
  generatePlanificationMessage: vi.fn().mockReturnValue('planification message'),
  generateImplementationMessage: vi.fn().mockReturnValue('implementation message'),
  generateReviewMessage: vi.fn().mockReturnValue('review message'),
  generateRefinementMessage: vi.fn().mockReturnValue('refinement message'),
  generatePrAgentMessage: vi.fn().mockReturnValue('pr message'),
  generatePrAgentCommentMessage: vi.fn().mockReturnValue('pr comment message'),
  generatePrAgentReviewMessage: vi.fn().mockReturnValue('pr review message'),
  generateYoloMessage: vi.fn().mockReturnValue('yolo message')
}));


vi.mock('./worktree.js', () => ({
  getWorktreePath: vi.fn(),
  getWorktreeProjectPath: vi.fn(),
  worktreeExists: vi.fn(),
  hasUncommittedChanges: vi.fn(),
  syncWithBase: vi.fn(),
  getPullRequestStatus: vi.fn(),
}));

// Base-branch resolution (a task property since v2 step 3). Auto-sync keys
// on the task row's base_branch directly.
vi.mock('./tasks/baseBranch.js', () => ({
  resolveBaseBranch: vi.fn(),
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
    yolo: { provider: 'anthropic', model: 'opus', effort: 'high' },
    'epic-architecture': { provider: 'anthropic', model: 'sonnet', effort: 'high' },
    'epic-specification': { provider: 'anthropic', model: 'opus', effort: 'high' },
    'epic-stories': { provider: 'anthropic', model: 'opus', effort: 'high' },
    'epic-spec-review': { provider: 'anthropic', model: 'opus', effort: 'high' },
    'epic-orchestrator': { provider: 'anthropic', model: 'opus', effort: 'high' },
    'epic-pr-review': { provider: 'anthropic', model: 'opus', effort: 'high' },
    'epic-delivery': { provider: 'anthropic', model: 'opus', effort: 'high' }
  })
}));

import {
  startAgentRun,
  BaseSyncConflictError,
  TaskAgentRunConflictError,
  forceCompleteRunningAgents
} from './agentRunner.js';

import { tasksDb, taskAgentRunsDb, conversationsDb, userDb } from '../database/db.js';
import { startConversation } from './conversationAdapter.js';
import { updateUserBadge } from './notifications.js';
import { buildContextPrompt } from './documentation.js';
import {
  generatePlanificationMessage,
  generateImplementationMessage,
  generateReviewMessage,
  generateRefinementMessage,
  generatePrAgentMessage,
  generatePrAgentCommentMessage,
  generateYoloMessage
} from '../constants/agentPrompts.js';
import {
  getWorktreeProjectPath,
  worktreeExists,
  hasUncommittedChanges,
  syncWithBase,
  getPullRequestStatus,
} from './worktree.js';
import { resolveBaseBranch } from './tasks/baseBranch.js';
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
  } as unknown as import('../database/db.js').TaskAgentRunRow;

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
      vi.mocked(taskAgentRunsDb.getByTask).mockReturnValue([]);
      vi.mocked(taskAgentRunsDb.create).mockReturnValue(mockAgentRun);
      vi.mocked(conversationsDb.create).mockReturnValue(mockConversation as never);
      vi.mocked(taskAgentRunsDb.linkConversation).mockReturnValue({ ...mockAgentRun, conversation_id: 1 });
      vi.mocked(startConversation).mockResolvedValue({ conversationId: 1, claudeSessionId: 'session-123' });
      vi.mocked(worktreeExists).mockResolvedValue(false);
      vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, username: 'test', is_technical: 1 } as never);
      // Standalone ticket on a `main`-default repo unless a test says otherwise.
      vi.mocked(resolveBaseBranch).mockResolvedValue('main');
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
      expect(taskAgentRunsDb.create).not.toHaveBeenCalled();
      expect(conversationsDb.create).not.toHaveBeenCalled();
      expect(startConversation).not.toHaveBeenCalled();
    });

    it('refuses a second running task agent at the final write boundary', async () => {
      const running = {
        id: 8,
        task_id: 1,
        agent_type: 'review',
        status: 'running',
      };
      vi.mocked(taskAgentRunsDb.getByTask).mockReturnValue([running] as never);

      await expect(startAgentRun(1, 'implementation')).rejects.toBeInstanceOf(
        TaskAgentRunConflictError,
      );
      expect(tasksDb.incrementRunCount).not.toHaveBeenCalled();
      expect(taskAgentRunsDb.create).not.toHaveBeenCalled();
      expect(conversationsDb.create).not.toHaveBeenCalled();
    });

    it('should create agent run and conversation for planification agent', async () => {
      const result = await startAgentRun(1, 'planification');

      expect(generatePlanificationMessage).toHaveBeenCalledWith('/archive/projects/1/tasks/task-1.md', 1, true, null);
      expect(taskAgentRunsDb.create).toHaveBeenCalledWith(1, 'planification', null, 'anthropic', 'human');
      expect(conversationsDb.create).toHaveBeenCalledWith(1, 'anthropic', 'opus', 'high');
      expect(taskAgentRunsDb.linkConversation).toHaveBeenCalledWith(1, 1);
      expect(result.agentRun).toEqual(mockAgentRun);
      expect(result.conversation).toEqual(mockConversation);
    });

    it('hands the project sensitive-areas list to the planification prompt builder', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue({
        ...mockTaskWithProject,
        sensitive_areas: '- the orders tables and every query that reads them',
      } as never);
      vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, username: 'owner', is_technical: 0 } as never);

      await startAgentRun(1, 'planification');

      expect(generatePlanificationMessage).toHaveBeenCalledWith(
        '/archive/projects/1/tasks/task-1.md',
        1,
        false,
        '- the orders tables and every query that reads them',
      );
    });

    it('should fall back to the task owner is_technical when no userId is supplied', async () => {
      // No userId on options → effectiveUserId falls back to taskWithProject.user_id (= 1).
      vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, username: 'owner', is_technical: 0 } as never);

      await startAgentRun(1, 'planification');

      expect(userDb.getUserById).toHaveBeenCalledWith(1);
      expect(generatePlanificationMessage).toHaveBeenCalledWith('/archive/projects/1/tasks/task-1.md', 1, false, null);
    });

    it('should use the acting user is_technical even when the task owner differs (non-tech actor on tech-owned task)', async () => {
      // Task owner is user 1 (technical); acting user is 2 (non-technical).
      vi.mocked(userDb.getUserById).mockImplementation(((id: number) =>
        id === 2
          ? { id: 2, username: 'actor', is_technical: 0 }
          : { id: 1, username: 'owner', is_technical: 1 }) as never);

      await startAgentRun(1, 'planification', { userId: 2 });

      expect(userDb.getUserById).toHaveBeenCalledWith(2);
      expect(generatePlanificationMessage).toHaveBeenCalledWith('/archive/projects/1/tasks/task-1.md', 1, false, null);
    });

    it('should use the acting user is_technical even when the task owner differs (tech actor on non-tech-owned task)', async () => {
      // Task owner is user 1 (non-technical); acting user is 2 (technical).
      vi.mocked(userDb.getUserById).mockImplementation(((id: number) =>
        id === 2
          ? { id: 2, username: 'actor', is_technical: 1 }
          : { id: 1, username: 'owner', is_technical: 0 }) as never);

      await startAgentRun(1, 'planification', { userId: 2 });

      expect(userDb.getUserById).toHaveBeenCalledWith(2);
      expect(generatePlanificationMessage).toHaveBeenCalledWith('/archive/projects/1/tasks/task-1.md', 1, true, null);
    });

    it('an automation-driven planification always gets the technical prompt variant', async () => {
      // Driver policy 1: the automation reviews the plan itself, so the
      // non-technical variant (which only exists to auto-chain) would be
      // reviewing nothing — even when the acting user is non-technical.
      vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, username: 'owner', is_technical: 0 } as never);

      await startAgentRun(1, 'planification', { driver: 'automation' });

      expect(generatePlanificationMessage).toHaveBeenCalledWith('/archive/projects/1/tasks/task-1.md', 1, true, null);
      expect(taskAgentRunsDb.create).toHaveBeenCalledWith(1, 'planification', null, 'anthropic', 'automation');
    });

    it('should create agent run and conversation for implementation agent', async () => {
      const result = await startAgentRun(1, 'implementation');

      expect(generateImplementationMessage).toHaveBeenCalledWith('/archive/projects/1/tasks/task-1.md', 1);
      expect(taskAgentRunsDb.create).toHaveBeenCalledWith(1, 'implementation', null, 'anthropic', 'human');
      expect(conversationsDb.create).toHaveBeenCalledWith(1, 'anthropic', 'opus', 'high');
      expect(result.agentRun).toEqual(mockAgentRun);
    });

    it('should create agent run and conversation for review agent', async () => {
      const result = await startAgentRun(1, 'review');

      expect(generateReviewMessage).toHaveBeenCalledWith('/archive/projects/1/tasks/task-1.md', 1);
      expect(taskAgentRunsDb.create).toHaveBeenCalledWith(1, 'review', null, 'anthropic', 'human');
      expect(conversationsDb.create).toHaveBeenCalledWith(1, 'anthropic', 'opus', 'high');
      expect(result.agentRun).toEqual(mockAgentRun);
    });

    it('should create agent run and conversation for refinement agent', async () => {
      const result = await startAgentRun(1, 'refinement');

      expect(generateRefinementMessage).toHaveBeenCalledWith(
        '/archive/projects/1/tasks/task-1.md',
        1,
        'main',
      );
      expect(taskAgentRunsDb.create).toHaveBeenCalledWith(1, 'refinement', null, 'anthropic', 'human');
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
        { kind: 'task', taskId: 1 },
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
        yolo: { provider: 'anthropic', model: 'opus', effort: 'high' },
        schema: { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-architecture': { provider: 'anthropic', model: 'sonnet', effort: 'high' },
        'epic-specification': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-stories': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-spec-review': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-orchestrator': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-pr-review': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-delivery': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-qa-scenarios': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-qa-execution': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-qa-fix': { provider: 'anthropic', model: 'opus', effort: 'high' }
      });

      await startAgentRun(1, 'planification');

      expect(startConversation).toHaveBeenCalledWith(
        { kind: 'task', taskId: 1 },
        'planification message',
        expect.objectContaining({
          model: 'sonnet',
          effort: 'low'
        })
      );
    });

    it('should stamp the configured provider on the conversation row (regression: an OpenAI model id → Anthropic SDK 404)', async () => {
      vi.mocked(loadAgentModelSettings).mockReturnValueOnce({
        planification: { provider: 'openai', model: 'gpt-6.1-sol', effort: 'medium' },
        implementation: { provider: 'anthropic', model: 'opus', effort: 'high' },
        refinement: { provider: 'anthropic', model: 'opus', effort: 'high' },
        review: { provider: 'anthropic', model: 'opus', effort: 'high' },
        pr: { provider: 'anthropic', model: 'opus', effort: 'high' },
        yolo: { provider: 'anthropic', model: 'opus', effort: 'high' },
        schema: { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-architecture': { provider: 'anthropic', model: 'sonnet', effort: 'high' },
        'epic-specification': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-stories': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-spec-review': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-orchestrator': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-pr-review': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-delivery': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-qa-scenarios': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-qa-execution': { provider: 'anthropic', model: 'opus', effort: 'high' },
        'epic-qa-fix': { provider: 'anthropic', model: 'opus', effort: 'high' }
      });

      await startAgentRun(1, 'planification');

      expect(conversationsDb.create).toHaveBeenCalledWith(1, 'openai', 'gpt-6.1-sol', 'medium');
    });

    it('should default each agent to opus + high when no overrides exist', async () => {
      await startAgentRun(1, 'review');

      expect(startConversation).toHaveBeenCalledWith(
        { kind: 'task', taskId: 1 },
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
        { kind: 'task', taskId: 1 },
        'implementation message',
        expect.objectContaining({
          disallowedTools: ['Agent']
        })
      );
    });

    it('should not disallow Agent tool for planification agent', async () => {
      await startAgentRun(1, 'planification');

      expect(startConversation).toHaveBeenCalledWith(
        { kind: 'task', taskId: 1 },
        'planification message',
        expect.objectContaining({
          disallowedTools: []
        })
      );
    });

    it('should not disallow Agent tool for review agent', async () => {
      await startAgentRun(1, 'review');

      expect(startConversation).toHaveBeenCalledWith(
        { kind: 'task', taskId: 1 },
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
        { kind: 'task', taskId: 1 },
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
        { kind: 'task', taskId: 1 },
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
        { kind: 'task', taskId: 1 },
        'implementation message',
        expect.objectContaining({
          videoConfig: null
        })
      );
    });
  });

  // Epic tickets are brought up to date with their epic's feature branch, but
  // only when a new pass over the ticket starts and only on a clean tree.
  describe('startAgentRun — auto-sync with the epic feature branch', () => {
    const broadcastToTaskSubscribersFn = vi.fn();

    beforeEach(() => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue({
        ...mockTaskWithProject,
        base_branch: 'epic/8-nimbus',
      } as never);
      vi.mocked(taskAgentRunsDb.create).mockReturnValue(mockAgentRun);
      vi.mocked(conversationsDb.create).mockReturnValue(mockConversation as never);
      vi.mocked(startConversation).mockResolvedValue({ conversationId: 1, claudeSessionId: 's' });
      vi.mocked(userDb.getUserById).mockReturnValue({ id: 1, is_technical: 1 } as never);
      vi.mocked(getPullRequestStatus).mockResolvedValue({ success: true, exists: false });
      vi.mocked(resolveBaseBranch).mockResolvedValue('epic/8-nimbus');
      vi.mocked(worktreeExists).mockResolvedValue(true);
      vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: false });
      vi.mocked(syncWithBase).mockResolvedValue({ success: true });
    });

    it.each(['planification', 'yolo', 'pr'] as const)(
      'syncs before a %s run (loop entry point)',
      async (agentType) => {
        await startAgentRun(1, agentType);

        expect(syncWithBase).toHaveBeenCalledWith('/path/to/project', 1, 'epic/8-nimbus');
      },
    );

    it.each(['implementation', 'review', 'refinement'] as const)(
      'does NOT sync before a %s run (mid-loop worktree holds in-flight state)',
      async (agentType) => {
        await startAgentRun(1, agentType);

        expect(syncWithBase).not.toHaveBeenCalled();
      },
    );

    it('does not sync a task with no explicit base (base_branch NULL)', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue({
        ...mockTaskWithProject,
        base_branch: null,
      } as never);
      vi.mocked(resolveBaseBranch).mockResolvedValue('main');

      await startAgentRun(1, 'planification');

      expect(syncWithBase).not.toHaveBeenCalled();
    });

    it('does not sync when the worktree does not exist', async () => {
      vi.mocked(worktreeExists).mockResolvedValue(false);

      await startAgentRun(1, 'planification');

      expect(syncWithBase).not.toHaveBeenCalled();
    });

    it('does not sync over uncommitted changes', async () => {
      vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: true });

      await startAgentRun(1, 'planification');

      expect(syncWithBase).not.toHaveBeenCalled();
    });

    it('fails the run, blocks the task and throws on a conflict', async () => {
      vi.mocked(syncWithBase).mockResolvedValue({ success: false, error: 'CONFLICT (content)' });

      await expect(
        startAgentRun(1, 'planification', { broadcastToTaskSubscribersFn }),
      ).rejects.toBeInstanceOf(BaseSyncConflictError);

      expect(taskAgentRunsDb.updateStatus).toHaveBeenCalledWith(1, 'failed');
      expect(tasksDb.blockWorkflow).toHaveBeenCalledWith(1);
      expect(broadcastToTaskSubscribersFn).toHaveBeenCalledWith(1, {
        type: 'task-blocked',
        reason: 'base-sync-conflict',
      });
      expect(broadcastToTaskSubscribersFn).toHaveBeenCalledWith(1, {
        type: 'agent-run-updated',
        agentRun: expect.objectContaining({ id: 1, status: 'failed' }),
      });
      // The conversation never starts on a conflicted worktree.
      expect(startConversation).not.toHaveBeenCalled();
    });
  });

  describe('startAgentRun — base branch in prompts', () => {
    beforeEach(() => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(taskAgentRunsDb.create).mockReturnValue(mockAgentRun);
      vi.mocked(conversationsDb.create).mockReturnValue(mockConversation as never);
      vi.mocked(startConversation).mockResolvedValue({ conversationId: 1, claudeSessionId: 's' });
      vi.mocked(worktreeExists).mockResolvedValue(false);
      vi.mocked(getPullRequestStatus).mockResolvedValue({ success: true, exists: false });
          });

    it('passes the resolved base branch to the PR prompt (not a hardcoded main)', async () => {
      vi.mocked(resolveBaseBranch).mockResolvedValue('master');

      await startAgentRun(1, 'pr');

      expect(generatePrAgentMessage).toHaveBeenCalledWith(
        expect.any(String),
        1,
        null,
        'master',
      );
    });

    it('passes the epic feature branch to the YOLO prompt', async () => {
      vi.mocked(resolveBaseBranch).mockResolvedValue('epic/8-nimbus');

      await startAgentRun(1, 'yolo');

      expect(generateYoloMessage).toHaveBeenCalledWith(
        expect.any(String),
        1,
        null,
        'epic/8-nimbus',
      );
    });

    it('passes the base branch to the webhook-triggered PR-feedback prompt', async () => {
      vi.mocked(resolveBaseBranch).mockResolvedValue('master');

      await startAgentRun(1, 'pr', { webhookContext: { commentBody: 'fix this' } });

      expect(generatePrAgentCommentMessage).toHaveBeenCalledWith(
        expect.any(String),
        1,
        null,
        expect.objectContaining({ commentBody: 'fix this' }),
        'master',
      );
    });
  });


  describe('forceCompleteRunningAgents', () => {
    it('should return 0 when no agents are running', () => {
      vi.mocked(taskAgentRunsDb.getByTask).mockReturnValue([
        { id: 1, status: 'completed' } as never,
        { id: 2, status: 'failed' } as never
      ]);

      const result = forceCompleteRunningAgents(1);

      expect(result).toBe(0);
      expect(taskAgentRunsDb.updateStatus).not.toHaveBeenCalled();
    });

    it('should force-complete single running agent', () => {
      vi.mocked(taskAgentRunsDb.getByTask).mockReturnValue([
        { id: 1, status: 'completed' } as never,
        { id: 2, status: 'running' } as never
      ]);

      const result = forceCompleteRunningAgents(1);

      expect(result).toBe(1);
      expect(taskAgentRunsDb.updateStatus).toHaveBeenCalledWith(2, 'completed');
    });

    it('should force-complete multiple running agents', () => {
      vi.mocked(taskAgentRunsDb.getByTask).mockReturnValue([
        { id: 1, status: 'running' } as never,
        { id: 2, status: 'completed' } as never,
        { id: 3, status: 'running' } as never
      ]);

      const result = forceCompleteRunningAgents(1);

      expect(result).toBe(2);
      expect(taskAgentRunsDb.updateStatus).toHaveBeenCalledWith(1, 'completed');
      expect(taskAgentRunsDb.updateStatus).toHaveBeenCalledWith(3, 'completed');
    });
  });


});
