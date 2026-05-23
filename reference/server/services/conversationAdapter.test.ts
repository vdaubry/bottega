import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

// Mock all dependencies before importing the module under test
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  const queryFn = vi.fn() as unknown as ((...args: unknown[]) => unknown) & {
    _originalMockImplementation: unknown;
    mockReturnValue: (val: unknown) => unknown;
  };
  // Intercept to inject mcpServerStatus/reconnectMcpServer on returned iterators
  queryFn._originalMockImplementation = null;
  const originalMockReturnValue = vi.mocked(queryFn).mockReturnValue.bind(queryFn);
  const patchedMockReturnValue = (val: unknown) => {
    return originalMockReturnValue(val);
  };
  vi.mocked(queryFn).mockReturnValue = patchedMockReturnValue;

  // Use a Proxy so vitest still sees queryFn as a spy, but we intercept calls
  const handler = {
    apply(target: (...args: unknown[]) => unknown, thisArg: unknown, args: unknown[]) {
      const iter = target.apply(thisArg, args) as Record<string, unknown> & {
        mcpServerStatus?: unknown;
        reconnectMcpServer?: unknown;
      };
      if (iter && !iter.mcpServerStatus) {
        iter.mcpServerStatus = vi.fn().mockResolvedValue([
          { name: 'context7', status: 'connected' },
          { name: 'playwright', status: 'connected' }
        ]);
      }
      if (iter && !iter.reconnectMcpServer) {
        iter.reconnectMcpServer = vi.fn().mockResolvedValue(undefined);
      }
      return iter;
    },
    get(target: object, prop: string | symbol, receiver: unknown) {
      return Reflect.get(target, prop, receiver);
    }
  };
  const proxiedQuery = new Proxy(queryFn, handler);
  return { query: proxiedQuery };
});

vi.mock('../database/db.js', () => ({
  db: {},
  conversationsDb: {
    create: vi.fn(),
    getById: vi.fn(),
    updateClaudeId: vi.fn(),
    updateProviderSessionId: vi.fn(),
    updateModelEffort: vi.fn(),
    updateSessionPath: vi.fn(),
    updateContextUsage: vi.fn(),
    getContextUsage: vi.fn()
  },
  tasksDb: {
    getById: vi.fn(),
    getWithProject: vi.fn(),
    markRefinementComplete: vi.fn()
  },
  agentRunsDb: {
    getByTask: vi.fn(),
    getByConversationId: vi.fn(),
    updateStatus: vi.fn(),
    create: vi.fn()
  },
  userDb: {
    getUserById: vi.fn().mockReturnValue({ id: 1, username: 'test', is_technical: 1 }),
    isAdmin: vi.fn().mockReturnValue(true),
  },
  projectMembersDb: {
    isMember: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('./projectService.js', () => ({
  hasProjectAccess: vi.fn().mockReturnValue(true),
}));

vi.mock('./notifications.js', () => ({
  notifyClaudeComplete: vi.fn().mockResolvedValue(undefined),
  updateUserBadge: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./titleGenerator.js', () => ({
  generateConversationTitle: vi.fn(),
  default: { generateConversationTitle: vi.fn() }
}));

vi.mock('./claudeCredentials.js', () => ({
  buildClaudeSdkEnv: vi.fn((userId) => ({
    CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-test-${userId}`,
    HOME: '/home/test',
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined
  })),
  getQueryProcessPid: vi.fn(() => null),
  resolveClaudeConfigDir: vi.fn((userId) => `/var/lib/ccui/users/${userId}/.claude`),
  validateClaudeCredentials: vi.fn(),
  auditClaudeLaunch: vi.fn()
}));

vi.mock('./sqliteSessionStore.js', () => ({
  sqliteSessionStore: {
    load: vi.fn().mockResolvedValue(null),
    append: vi.fn().mockResolvedValue(undefined)
  }
}));

vi.mock('./conversationContentStore.js', () => ({
  conversationContentStore: {},
  resolveProjectKey: vi.fn((p) => String(p ?? '').replace(/[/.]/g, '-'))
}));

vi.mock('./agentModelSettings.js', () => ({
  loadAgentModelSettings: vi.fn().mockReturnValue({
    planification: { model: 'opus', effort: 'high' },
    implementation: { model: 'opus', effort: 'high' },
    refinement: { model: 'opus', effort: 'high' },
    review: { model: 'opus', effort: 'high' },
    pr: { model: 'opus', effort: 'high' },
    yolo: { model: 'opus', effort: 'high' }
  }),
  // Resume re-resolution defaults to the row's stored model/effort here
  // (no per-user override in these fixtures), preserving prior behavior.
  resolveResumeModelEffort: vi.fn((conversation) => ({
    model: conversation.model,
    effort: conversation.effort,
  })),
}));

// The resolved (versioned) model ID returned by the SDK in
// `result.modelUsage` and `assistant.message.model`. Used in fixtures
// that simulate the SDK responding for an Opus-defaulted run.
const RESOLVED_DEFAULT_MODEL = 'claude-opus-4-7';

// Import after mocks
import { query } from '@anthropic-ai/claude-agent-sdk';
import { conversationsDb, tasksDb, agentRunsDb } from '../database/db.js';
import { notifyClaudeComplete } from './notifications.js';
import { auditClaudeLaunch, buildClaudeSdkEnv } from './claudeCredentials.js';
import { sqliteSessionStore } from './sqliteSessionStore.js';

import {
  startConversation,
  sendMessage,
  abortSession,
  isSessionActive,
  getActiveSessions,
  getActiveStreamingByConversation,
  getAllActiveStreamingSessions,
  resolveAskUserQuestion,
  _injectVideoRecording,
  _handleVideoRecording,
  _resolveSlashCommand
} from './conversationAdapter.js';
import { isClaudeAuthError, AUTH_RETRY_BACKOFF_MS } from './conversation/retryOn401.js';

describe('conversationAdapter', () => {
  const mockTaskWithProject = {
    id: 1,
    project_id: 1,
    title: 'Test Task',
    status: 'pending',
    repo_folder_path: '/path/to/project',
    user_id: 1,
    workflow_complete: 0
  };

  const mockConversation = {
    id: 1,
    task_id: 1,
    claude_conversation_id: null,
    provider: 'anthropic' as const,
    provider_session_id: null,
    model: 'opus',
    effort: null,
  };

  const mockConversationWithSession = {
    id: 1,
    task_id: 1,
    claude_conversation_id: 'existing-session-123',
    provider: 'anthropic' as const,
    provider_session_id: 'existing-session-123',
    model: 'opus',
    effort: null,
  };

  // Helper: creates a mock query iterator with mcpServerStatus support
  function createMockIterator(messages: unknown[], extras: Record<string, unknown> = {}) {
    const iter = {
      mcpServerStatus: vi.fn().mockResolvedValue([
        { name: 'context7', status: 'connected' },
        { name: 'playwright', status: 'connected' }
      ]),
      reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
      ...extras,
      [Symbol.asyncIterator]: () => {
        const nextFn = vi.fn();
        messages.forEach((msg) => {
          vi.mocked(nextFn).mockResolvedValueOnce({ value: msg, done: false });
        });
        vi.mocked(nextFn).mockResolvedValueOnce({ done: true });
        return { next: nextFn };
      }
    };
    return iter;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startConversation', () => {
    beforeEach(() => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(conversationsDb.create).mockReturnValue(mockConversation);
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([]);
      vi.mocked(tasksDb.getById).mockReturnValue(mockTaskWithProject as never);
    });

    it('should throw error if task not found', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(null as never);

      await expect(startConversation(999, 'Hello', { model: 'opus' })).rejects.toThrow('Task 999 not found');
    });

    it('should create conversation if conversationId not provided', async () => {
      // Create mock async iterator
      const mockMessages = [
        { session_id: 'session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const result = await startConversation(1, 'Hello', { model: 'opus' });

      expect(conversationsDb.create).toHaveBeenCalledWith(1, 'anthropic', 'opus', null);
      expect(result.conversationId).toBe(1);
    });

    it('should use provided conversationId', async () => {
      const mockMessages = [
        { session_id: 'session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const result = await startConversation(1, 'Hello', { model: 'opus', conversationId: 5 });

      expect(conversationsDb.create).not.toHaveBeenCalled();
      expect(result.conversationId).toBe(5);
    });

    it('should update conversation with Claude session ID', async () => {
      const mockMessages = [
        { session_id: 'session-456', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const result = await startConversation(1, 'Hello', { model: 'opus' });

      expect(conversationsDb.updateClaudeId).toHaveBeenCalledWith(1, 'session-456');
      expect(result.claudeSessionId).toBe('session-456');
    });

    it('should broadcast streaming-started event', async () => {
      const mockMessages = [
        { session_id: 'session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', broadcastFn });

      // Wait for streaming to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(broadcastFn).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ type: 'streaming-started' })
      );
    });

    it('should wait for MCP servers before delivering prompt', async () => {
      const mockReconnect = vi.fn().mockResolvedValue(undefined);
      // mcpServerStatus returns pending first, then connected
      const mockStatus = vi.fn()
        .mockResolvedValueOnce([
          { name: 'context7', status: 'connected' },
          { name: 'playwright', status: 'pending' }
        ])
        .mockResolvedValue([
          { name: 'context7', status: 'connected' },
          { name: 'playwright', status: 'connected' }
        ]);

      const mockMessages = [
        { session_id: 'session-mcp', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        reconnectMcpServer: mockReconnect,
        mcpServerStatus: mockStatus,
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await startConversation(1, 'Hello', { model: 'opus' });

      // waitForMcpServers runs concurrently — wait for it to complete
      await new Promise(resolve => setTimeout(resolve, 700));

      // Should have polled mcpServerStatus at least twice (pending, then connected)
      expect(mockStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
      // Should not have needed to reconnect (server went from pending to connected)
      expect(mockReconnect).not.toHaveBeenCalled();
    });

    it('should not reconnect connected or disabled MCP servers', async () => {
      const mockReconnect = vi.fn().mockResolvedValue(undefined);
      const mockMessages = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-mcp2',
          mcp_servers: [
            { name: 'context7', status: 'connected' },
            { name: 'old-server', status: 'disabled' }
          ]
        },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        reconnectMcpServer: mockReconnect,
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await startConversation(1, 'Hello', { model: 'opus' });

      // Wait for async streaming loop
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockReconnect).not.toHaveBeenCalled();
    });

    it('should broadcast claude-response messages', async () => {
      const mockMessages = [
        { session_id: 'session-123', type: 'text', content: 'Hello!' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', broadcastFn });

      // Wait for streaming to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(broadcastFn).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          type: 'claude-response',
          data: expect.objectContaining({ type: 'text' })
        })
      );
    });

    it('should broadcast claude-complete when streaming ends', async () => {
      const mockMessages = [
        { session_id: 'session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', broadcastFn });

      // Wait for streaming to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(broadcastFn).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          type: 'claude-complete',
          sessionId: 'session-123',
          exitCode: 0,
          isNewSession: true
        })
      );
    });

    it('canUseTool passes non-AskUserQuestion tools through unchanged', async () => {
      const mockMessages = [
        { session_id: 'cuse-pass-1', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      vi.mocked(query).mockReturnValue({
        mcpServerStatus: vi.fn().mockResolvedValue([]),
        reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      } as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', broadcastFn });
      await new Promise(resolve => setTimeout(resolve, 30));

      const canUseTool = vi.mocked(query).mock.calls[0]![0].options!.canUseTool!;
      const result = await canUseTool('Bash', { command: 'ls' }, {} as never);
      expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    });

    it('canUseTool parks on a Promise for AskUserQuestion and broadcasts awaiting-user-answer', async () => {
      // Canonical SDK pattern: the callback stays pending until the user
      // submits via resolveAskUserQuestion; then it returns the real answers
      // keyed by question text.
      let releaseHold: (value?: unknown) => void = () => {};
      const hold = new Promise(resolve => { releaseHold = resolve; });
      let nextCall = 0;
      vi.mocked(query).mockReturnValue({
        mcpServerStatus: vi.fn().mockResolvedValue([]),
        reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const i = nextCall++;
            if (i === 0) {
              return Promise.resolve({ value: { session_id: 'cuse-ask-1', type: 'message' }, done: false });
            }
            if (i === 1) {
              return hold.then(() => ({ value: { type: 'result', modelUsage: {} }, done: false }));
            }
            return Promise.resolve({ done: true });
          }
        })
      } as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', broadcastFn });
      await new Promise(resolve => setTimeout(resolve, 30));

      const canUseTool = vi.mocked(query).mock.calls[0]![0].options!.canUseTool!;

      const input = {
        questions: [
          { question: 'Which database?', header: 'DB', options: [{ label: 'pg' }] },
          { question: 'Which auth?', header: 'Auth', options: [{ label: 'jwt' }] }
        ]
      };

      const signal = new AbortController().signal;
      const callbackPromise = canUseTool('AskUserQuestion', input, { signal, toolUseID: 'tool-abc' });

      // Should NOT resolve immediately — it's parked.
      let settled = false;
      callbackPromise.then(() => { settled = true; }).catch(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(settled).toBe(false);

      // Should have broadcast an awaiting-user-answer event with the questions.
      expect(broadcastFn).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          type: 'awaiting-user-answer',
          conversationId: 1,
          toolUseId: 'tool-abc',
          questions: input.questions
        })
      );

      // Now resolve with real answers.
      const result = resolveAskUserQuestion(1, {
        'Which database?': 'pg',
        'Which auth?': 'jwt'
      }, { broadcastFn });

      const cuseResult = await callbackPromise;
      await result;

      expect(cuseResult).toEqual({
        behavior: 'allow',
        updatedInput: {
          questions: input.questions,
          answers: { 'Which database?': 'pg', 'Which auth?': 'jwt' }
        }
      });

      // streaming-started fires when the SDK turn resumes.
      expect(broadcastFn).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ type: 'streaming-started' })
      );

      releaseHold();
      await new Promise(resolve => setTimeout(resolve, 30));
    });

    it('canUseTool rejects the parked promise when the abort signal fires', async () => {
      let releaseHold: (value?: unknown) => void = () => {};
      const hold = new Promise(resolve => { releaseHold = resolve; });
      let nextCall = 0;
      vi.mocked(query).mockReturnValue({
        mcpServerStatus: vi.fn().mockResolvedValue([]),
        reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const i = nextCall++;
            if (i === 0) {
              return Promise.resolve({ value: { session_id: 'cuse-abort-1', type: 'message' }, done: false });
            }
            if (i === 1) {
              return hold.then(() => ({ value: { type: 'result', modelUsage: {} }, done: false }));
            }
            return Promise.resolve({ done: true });
          }
        })
      } as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', broadcastFn });
      await new Promise(resolve => setTimeout(resolve, 30));

      const canUseTool = vi.mocked(query).mock.calls[0]![0].options!.canUseTool!;
      const ac = new AbortController();
      const promise = canUseTool('AskUserQuestion', { questions: [{ question: 'Q?', header: 'H' }] }, {
        signal: ac.signal,
        toolUseID: 'tool-abort-1'
      });

      ac.abort();
      await expect(promise).rejects.toThrow(/aborted/i);

      releaseHold();
      await new Promise(resolve => setTimeout(resolve, 30));
    });

    it('canUseTool passes Bash and other tools through unchanged', async () => {
      const mockMessages = [
        { session_id: 'cuse-bash-1', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      vi.mocked(query).mockReturnValue({
        mcpServerStatus: vi.fn().mockResolvedValue([]),
        reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      } as never);

      await startConversation(1, 'Hello', { model: 'opus', broadcastFn: vi.fn() });
      await new Promise(resolve => setTimeout(resolve, 30));

      const canUseTool = vi.mocked(query).mock.calls[0]![0].options!.canUseTool!;
      const result = await canUseTool('Bash', { command: 'ls' }, {} as never);
      expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    });

it('should broadcast streaming-ended event when streaming completes', async () => {
      const mockMessages = [
        { session_id: 'session-ended-test', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', broadcastFn });

      // Wait for streaming to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(broadcastFn).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          type: 'streaming-ended',
          taskId: 1,
          conversationId: 1
        })
      );
    });

    it('should broadcast conversation-created event', async () => {
      const mockMessages = [
        { session_id: 'conv-created-test', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', broadcastFn });

      // Wait for streaming to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(broadcastFn).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          type: 'conversation-created',
          conversationId: 1,
          claudeSessionId: 'conv-created-test'
        })
      );
    });

    it('should broadcast session-created event', async () => {
      const mockMessages = [
        { session_id: 'session-created-test', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', broadcastFn });

      // Wait for streaming to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(broadcastFn).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          type: 'session-created',
          sessionId: 'session-created-test'
        })
      );
    });

    it('should call query with correct SDK options', async () => {
      const mockMessages = [
        { session_id: 'session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await startConversation(1, 'Hello', { model: 'opus', customSystemPrompt: 'Custom prompt' });

      // prompt is now an async generator (deferred until MCP servers ready)
      const callArgs = vi.mocked(query).mock.calls[0]![0];
      expect(callArgs.options!).toEqual(expect.objectContaining({
        cwd: '/path/to/project',
        // Custom prompt is preserved verbatim and the AskUserQuestion-limit
        // note is appended (the SDK's hardcoded `max(4)` makes the nudge worthwhile).
        systemPrompt: expect.stringContaining('Custom prompt'),
        settingSources: ['project', 'user', 'local']
      }));
      expect(callArgs.options!.systemPrompt).toMatch(/AskUserQuestion.*at most 4/);
      // model is always explicit now (passed by the caller, never inferred).
      expect(callArgs.options!.model).toBe('opus');
    });

    it('should pass model when explicitly provided', async () => {
      const mockMessages = [
        { session_id: 'session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await startConversation(1, 'Hello', { model: 'opus' });

      const callOptions = vi.mocked(query).mock.calls[0]![0].options;
      expect(callOptions!.model).toBe('opus');
    });

    it('should include permissionMode when specified', async () => {
      const mockMessages = [
        { session_id: 'session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await startConversation(1, 'Hello', { model: 'opus', permissionMode: 'bypassPermissions' });

      const callOptions = vi.mocked(query).mock.calls[0]![0].options;
      expect(callOptions).toEqual(expect.objectContaining({
        permissionMode: 'bypassPermissions'
      }));
    });

    it('should default to bypassPermissions when permissionMode not specified', async () => {
      const mockMessages = [
        { session_id: 'session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      // Call without permissionMode
      await startConversation(1, 'Hello', { model: 'opus', broadcastFn: vi.fn() });

      // Should default to bypassPermissions
      const callOptions = vi.mocked(query).mock.calls[0]![0].options;
      expect(callOptions).toEqual(expect.objectContaining({
        permissionMode: 'bypassPermissions'
      }));
    });

    it('should log warning when permissionMode is missing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mockMessages = [
        { session_id: 'session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      // Call without permissionMode
      await startConversation(1, 'Hello', { model: 'opus', broadcastFn: vi.fn() });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ConversationAdapter] Options validation (startConversation):'),
        expect.stringContaining('Missing permissionMode')
      );

      warnSpy.mockRestore();
    });

    it('should pass disallowedTools to SDK when specified', async () => {
      const mockMessages = [
        { session_id: 'session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await startConversation(1, 'Hello', { model: 'opus', disallowedTools: ['Agent'] });

      const callOptions = vi.mocked(query).mock.calls[0]![0].options;
      expect(callOptions!.disallowedTools).toEqual(['Agent']);
    });

    it('should not include disallowedTools in SDK options when empty', async () => {
      const mockMessages = [
        { session_id: 'session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await startConversation(1, 'Hello', { model: 'opus', disallowedTools: [] });

      const callOptions = vi.mocked(query).mock.calls[0]![0].options;
      expect(callOptions).not.toHaveProperty('disallowedTools');
    });

    it('should inject per-user Claude env into new SDK sessions', async () => {
      const mockMessages = [
        { session_id: 'session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await startConversation(1, 'Hello', { model: 'opus', userId: 42 });

      expect(buildClaudeSdkEnv).toHaveBeenCalledWith(42);
      expect(vi.mocked(query).mock.calls[0]![0].options!.env).toEqual(expect.objectContaining({
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-42',
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined
      }));
      expect(vi.mocked(query).mock.calls[0]![0].options!.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
      expect(auditClaudeLaunch).toHaveBeenCalledWith(expect.objectContaining({
        source: 'startConversation',
        userId: 42,
        conversationId: 1
      }));
      expect(vi.mocked(auditClaudeLaunch).mock.calls[0]![0]).not.toHaveProperty('claudeConfigDir');
    });

    it('should fail closed before creating a conversation when per-user credentials are missing', async () => {
      vi.mocked(buildClaudeSdkEnv).mockImplementationOnce(() => {
        throw new Error('Claude credentials are not provisioned for user 42');
      });

      await expect(startConversation(1, 'Hello', { model: 'opus', userId: 42 }))
        .rejects.toThrow('Claude credentials are not provisioned for user 42');

      expect(conversationsDb.create).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });

    it('should send push notification on completion', async () => {
      const mockMessages = [
        { session_id: 'session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await startConversation(1, 'Hello', { model: 'opus', userId: 42 });

      // Wait for streaming to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(notifyClaudeComplete).toHaveBeenCalledWith(
        42,
        'Test Task',
        1,
        1,
        1, // projectId
        expect.objectContaining({ agentType: null, workflowComplete: false })
      );
    });

    it('should update agent run status to completed when linked', async () => {
      const mockAgentRun = {
        id: 5,
        conversation_id: 1,
        agent_type: 'implementation',
        status: 'running'
      };
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([mockAgentRun] as never);

      const mockMessages = [
        { session_id: 'session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await startConversation(1, 'Hello', { model: 'opus', conversationId: 1 });

      // Wait for streaming to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(5, 'completed');
    });

    it("marks agent run 'completed' on SDK error and lets the loop chain to the next agent", async () => {
      // Under the new model the streaming loop never writes 'failed' on
      // catastrophic SDK errors. The catch path persists a synthetic
      // sdk_error system message into the transcript and marks the run
      // 'completed' so the next agent in the loop can pick up the recovery
      // (e.g. retrying after a transient 529 overloaded).
      const mockAgentRun = {
        id: 5,
        conversation_id: 1,
        agent_type: 'implementation',
        status: 'running'
      };
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([mockAgentRun] as never);

      // First message returns session, then throws error
      let callCount = 0;
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            callCount++;
            if (callCount === 1) {
              return Promise.resolve({ value: { session_id: 'session-123' }, done: false });
            }
            return Promise.reject(new Error('SDK Error'));
          }
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', conversationId: 1, broadcastFn });

      // Wait for error handling
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(5, 'completed');
      expect(agentRunsDb.updateStatus).not.toHaveBeenCalledWith(5, 'failed');
    });

    it('should timeout if session ID not received', async () => {
      // Mock iterator that never provides session_id
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}) // Never resolves
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const originalSetTimeout = global.setTimeout;
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((callback: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        if (delay === 60000) {
          callback(...args);
          return 0;
        }
        return originalSetTimeout(callback, delay, ...args);
      }) as never);

      try {
        await expect(startConversation(1, 'Hello', { model: 'opus' })).rejects.toThrow('Session creation timeout');
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60000);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it('broadcasts context-usage from queryInstance.getContextUsage() captured mid-stream', async () => {
      const snapshot = {
        totalTokens: 12345,
        maxTokens: 200000,
        percentage: 6.17,
        model: RESOLVED_DEFAULT_MODEL,
        categories: [
          { name: 'System prompt', tokens: 5000, color: '#3498db' },
          { name: 'Messages', tokens: 7345, color: '#9b59b6' }
        ],
        memoryFiles: [],
        mcpTools: []
      };
      const getContextUsage = vi.fn().mockResolvedValue(snapshot);
      const mockMessages = [
        { session_id: 'session-123', type: 'assistant', message: { id: 'm1' } },
        { type: 'result' }
      ];
      const mockIterator = createMockIterator(mockMessages, { getContextUsage });
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', broadcastFn });

      // Wait for streaming to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(getContextUsage).toHaveBeenCalled();
      expect(conversationsDb.updateContextUsage).toHaveBeenCalledWith(1, snapshot);
      expect(broadcastFn).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          type: 'context-usage',
          data: snapshot
        })
      );
    });

    it('falls back to baseline from result.modelUsage when getContextUsage rejects', async () => {
      const getContextUsage = vi.fn().mockRejectedValue(new Error('SDK gone'));
      const mockMessages = [
        { session_id: 'session-456', type: 'assistant', message: { id: 'm1' } },
        {
          type: 'result',
          modelUsage: {
            [RESOLVED_DEFAULT_MODEL]: {
              inputTokens: 1000,
              outputTokens: 500,
              cacheReadInputTokens: 200,
              cacheCreationInputTokens: 100,
              contextWindow: 200000
            }
          }
        }
      ];
      const mockIterator = createMockIterator(mockMessages, { getContextUsage });
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', broadcastFn });
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(getContextUsage).toHaveBeenCalled();
      const contextUsageCalls = broadcastFn.mock.calls.filter(
        ([, payload]) => payload?.type === 'context-usage'
      );
      expect(contextUsageCalls).toHaveLength(1);
      expect(contextUsageCalls[0]![1].data).toEqual(expect.objectContaining({
        model: RESOLVED_DEFAULT_MODEL,
        totalTokens: 1300, // input + cacheRead + cacheCreate
        maxTokens: 200000,
        categories: []
      }));
    });

    it('broadcasts baseline-only when no assistant message arrives (no live capture)', async () => {
      const getContextUsage = vi.fn().mockResolvedValue({ totalTokens: 999 });
      const mockMessages = [
        { session_id: 'session-789', type: 'system' },
        {
          type: 'result',
          modelUsage: {
            'claude-haiku-4-5': {
              inputTokens: 50,
              outputTokens: 10,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              contextWindow: 200000
            }
          }
        }
      ];
      const mockIterator = createMockIterator(mockMessages, { getContextUsage });
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', broadcastFn });
      await new Promise(resolve => setTimeout(resolve, 50));

      // No assistant message → captureContextUsage was never invoked
      expect(getContextUsage).not.toHaveBeenCalled();
      const contextUsageCalls = broadcastFn.mock.calls.filter(
        ([, payload]) => payload?.type === 'context-usage'
      );
      expect(contextUsageCalls).toHaveLength(1);
      expect(contextUsageCalls[0]![1].data.totalTokens).toBe(50);
      expect(contextUsageCalls[0]![1].data.maxTokens).toBe(200000);
    });
  });

  describe('sendMessage', () => {
    beforeEach(() => {
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversationWithSession as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.getById).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([]);
    });

    it('should throw error if conversation not found', async () => {
      vi.mocked(conversationsDb.getById).mockReturnValue(null as never);

      await expect(sendMessage(999, 'Hello')).rejects.toThrow('Conversation 999 not found');
    });

    it('should throw error if conversation has no Claude session ID', async () => {
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversation as never); // No session ID

      await expect(sendMessage(1, 'Hello')).rejects.toThrow('Conversation 1 has no Claude session ID yet');
    });

    it('should throw error if task not found', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(null as never);

      await expect(sendMessage(1, 'Hello')).rejects.toThrow('Task 1 not found');
    });

    it('resumes on the model+effort stored on the conversation row', async () => {
      // Resume reads the exact model+effort the conversation was created with,
      // off the row — not re-derived from agent settings or the SDK default.
      vi.mocked(conversationsDb.getById).mockReturnValue({
        ...mockConversationWithSession,
        model: 'sonnet',
        effort: 'high',
      } as never);
      const mockMessages = [
        { session_id: 'existing-session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await sendMessage(1, 'Hello');

      expect(vi.mocked(query).mock.calls[0]![0].options).toEqual(expect.objectContaining({
        model: 'sonnet',
        effort: 'high'
      }));
    });

    it('always carries the stored model on resume; omits effort when the row has none', async () => {
      // Even a plain manual conversation resumes on its stored model. The
      // default getById row carries model 'opus' and a null effort, so the
      // model is sent and the effort knob is left off.
      const mockMessages = [
        { session_id: 'existing-session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await sendMessage(1, 'Hello');

      const opts = vi.mocked(query).mock.calls[0]![0].options as { model?: string; effort?: string };
      expect(opts.model).toBe('opus');
      expect(opts.effort).toBeUndefined();
    });

    it('should call query with resume option', async () => {
      const mockMessages = [
        { session_id: 'existing-session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await sendMessage(1, 'Hello');

      const callArgs = vi.mocked(query).mock.calls[0]![0];
      expect(callArgs.options!).toEqual(expect.objectContaining({
        cwd: '/path/to/project',
        resume: 'existing-session-123'
      }));
    });

    it('should inject per-user Claude env into resumed SDK sessions', async () => {
      const mockMessages = [
        { session_id: 'existing-session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await sendMessage(1, 'Hello', { userId: 42 });

      expect(buildClaudeSdkEnv).toHaveBeenCalledWith(42);
      expect(vi.mocked(query).mock.calls[0]![0].options!.env).toEqual(expect.objectContaining({
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-42',
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined
      }));
      expect(vi.mocked(query).mock.calls[0]![0].options!.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
      expect(auditClaudeLaunch).toHaveBeenCalledWith(expect.objectContaining({
        source: 'sendMessage',
        userId: 42,
        conversationId: 1,
        claudeSessionId: 'existing-session-123'
      }));
    });

    it('should default to bypassPermissions when permissionMode not specified', async () => {
      const mockMessages = [
        { session_id: 'existing-session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      // Call without permissionMode
      await sendMessage(1, 'Hello', { broadcastFn: vi.fn() });

      // Should default to bypassPermissions
      const callOptions = vi.mocked(query).mock.calls[0]![0].options;
      expect(callOptions).toEqual(expect.objectContaining({
        permissionMode: 'bypassPermissions'
      }));
    });

    it('should log warning when permissionMode is missing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mockMessages = [
        { session_id: 'existing-session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      // Call without permissionMode
      await sendMessage(1, 'Hello', { broadcastFn: vi.fn() });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ConversationAdapter] Options validation (sendMessage):'),
        expect.stringContaining('Missing permissionMode')
      );

      warnSpy.mockRestore();
    });

    it('should broadcast streaming-started event', async () => {
      const mockMessages = [
        { session_id: 'existing-session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const broadcastFn = vi.fn();
      await sendMessage(1, 'Hello', { broadcastFn });

      expect(broadcastFn).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ type: 'streaming-started' })
      );
    });

    it('should broadcast claude-complete with isNewSession=false', async () => {
      const mockMessages = [
        { session_id: 'existing-session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const broadcastFn = vi.fn();
      await sendMessage(1, 'Hello', { broadcastFn });

      expect(broadcastFn).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          type: 'claude-complete',
          sessionId: 'existing-session-123',
          exitCode: 0,
          isNewSession: false
        })
      );
    });

    it('should update agent run status when linked', async () => {
      const mockAgentRun = {
        id: 3,
        conversation_id: 1,
        agent_type: 'review',
        status: 'running'
      };
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([mockAgentRun] as never);

      const mockMessages = [
        { session_id: 'existing-session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await sendMessage(1, 'Hello');

      expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(3, 'completed');
    });

    it('should throw error on SDK failure', async () => {
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('SDK Error'))
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      const broadcastFn = vi.fn();
      await expect(sendMessage(1, 'Hello', { broadcastFn })).rejects.toThrow('SDK Error');

      expect(broadcastFn).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ type: 'claude-error' })
      );
    });

    it('should use stored session_path as cwd for worktree consistency', async () => {
      // Conversation has a stored session_path (from worktree)
      const mockConversationWithWorktree = {
        id: 1,
        task_id: 1,
        claude_conversation_id: 'existing-session-123',
        session_path: '/path/to/project-worktrees/task-1',
        provider: 'anthropic' as const,
        provider_session_id: 'existing-session-123',
        model: 'opus',
        effort: null
      };
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversationWithWorktree as never);

      const mockMessages = [
        { session_id: 'existing-session-123', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await sendMessage(1, 'Hello');

      // Should use session_path, not repo_folder_path
      const callArgs = vi.mocked(query).mock.calls[0]![0];
      expect(callArgs.options!).toEqual(expect.objectContaining({
        cwd: '/path/to/project-worktrees/task-1',
        resume: 'existing-session-123'
      }));
    });
  });

  describe('abortSession', () => {
    it('should return false for non-existent session', async () => {
      const result = await abortSession('non-existent-session');
      expect(result).toBe(false);
    });

    it('should abort active session and return true', async () => {
      // First start a session to track it
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(conversationsDb.create).mockReturnValue(mockConversation);
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([]);
      vi.mocked(tasksDb.getById).mockReturnValue(mockTaskWithProject as never);

      const mockMessages = [
        { session_id: 'abort-test-session', type: 'message' }
      ];
      let messageIndex = 0;
      const mockIterator = {
        interrupt: vi.fn().mockResolvedValue(undefined),
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (messageIndex < mockMessages.length) {
              return Promise.resolve({ value: mockMessages[messageIndex++], done: false });
            }
            // Wait indefinitely to simulate streaming
            return new Promise(() => {});
          }
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      // Start conversation (don't await, it will hang)
      startConversation(1, 'Hello', { model: 'opus' });

      // Wait for session to be tracked
      await new Promise(resolve => setTimeout(resolve, 100));

      // Now abort
      const result = await abortSession('abort-test-session');

      expect(result).toBe(true);
      // abortSession uses abortController.abort() (SIGTERM) instead of cooperative interrupt()
      // The abortController is created internally and stored in activeSessions
    });
  });

  describe('session tracking', () => {
    beforeEach(() => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(conversationsDb.create).mockReturnValue(mockConversation);
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([]);
      vi.mocked(tasksDb.getById).mockReturnValue(mockTaskWithProject as never);
    });

    it('isSessionActive should return falsy for non-existent session', () => {
      expect(isSessionActive('non-existent')).toBeFalsy();
    });

    it('getActiveSessions should return empty array when no sessions', () => {
      expect(getActiveSessions()).toEqual([]);
    });

    it('getActiveStreamingByConversation should return null when not found', () => {
      expect(getActiveStreamingByConversation(999)).toBeNull();
    });

    it('getAllActiveStreamingSessions should return empty array when no sessions', () => {
      expect(getAllActiveStreamingSessions(undefined)).toEqual([]);
    });

    it('getActiveStreamingByConversation should return session when streaming is active', async () => {
      // Start a conversation to create an active streaming session
      let messageIndex = 0;
      const mockMessages = [
        { session_id: 'streaming-session-123', type: 'message' }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (messageIndex < mockMessages.length) {
              return Promise.resolve({ value: mockMessages[messageIndex++], done: false });
            }
            // Keep the streaming open
            return new Promise(() => {});
          }
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      // Start conversation (don't await)
      startConversation(1, 'Hello', { model: 'opus' });

      // Wait for session to be tracked
      await new Promise(resolve => setTimeout(resolve, 100));

      // Now check getActiveStreamingByConversation
      const result = getActiveStreamingByConversation(1);
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('streaming-session-123');
      expect(result!.taskId).toBe(1);
      expect(result!.conversationId).toBe(1);
    });

    it('getAllActiveStreamingSessions should return all active sessions', async () => {
      // Start a conversation to create an active streaming session
      let messageIndex = 0;
      const mockMessages = [
        { session_id: 'all-sessions-test-123', type: 'message' }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (messageIndex < mockMessages.length) {
              return Promise.resolve({ value: mockMessages[messageIndex++], done: false });
            }
            // Keep the streaming open
            return new Promise(() => {});
          }
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      // Start conversation (don't await)
      startConversation(1, 'Hello', { model: 'opus' });

      // Wait for session to be tracked
      await new Promise(resolve => setTimeout(resolve, 100));

      // Now check getAllActiveStreamingSessions
      const sessions = getAllActiveStreamingSessions(undefined);
      expect(sessions.length).toBeGreaterThan(0);
      const session = sessions.find(s => s.sessionId === 'all-sessions-test-123');
      expect(session).toBeDefined();
      expect(session!.taskId).toBe(1);
      expect(session!.conversationId).toBe(1);
    });

    it('isSessionActive should return true for active session', async () => {
      let messageIndex = 0;
      const mockMessages = [
        { session_id: 'active-check-session', type: 'message' }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (messageIndex < mockMessages.length) {
              return Promise.resolve({ value: mockMessages[messageIndex++], done: false });
            }
            return new Promise(() => {});
          }
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      startConversation(1, 'Hello', { model: 'opus' });
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(isSessionActive('active-check-session')).toBe(true);
    });

    it('getActiveSessions should return session IDs', async () => {
      let messageIndex = 0;
      const mockMessages = [
        { session_id: 'get-active-session-id', type: 'message' }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (messageIndex < mockMessages.length) {
              return Promise.resolve({ value: mockMessages[messageIndex++], done: false });
            }
            return new Promise(() => {});
          }
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      startConversation(1, 'Hello', { model: 'opus' });
      await new Promise(resolve => setTimeout(resolve, 100));

      const sessions = getActiveSessions();
      expect(sessions).toContain('get-active-session-id');
    });
  });

  // Note: MCP configuration loading and image handling tests are omitted
  // because they require fs mocking which is complex with ES modules.
  // These features are covered by integration/e2e tests.

  describe('injectVideoRecording', () => {
    it('should inject devtools capability and output dir into playwright MCP server args', () => {
      const mcpServers = {
        playwright: {
          command: 'npx',
          args: ['-y', '@playwright/mcp@latest']
        },
        other: {
          command: 'node',
          args: ['other-server.js']
        }
      };

      const result = _injectVideoRecording(mcpServers, { tempDir: '/tmp/video-test' });

      expect(result!.playwright!.args).toContain('-y');
      expect(result!.playwright!.args).toContain('@playwright/mcp@latest');
      expect(result!.playwright!.args).toContain('--caps=devtools');
      expect(result!.playwright!.args).toContain('--viewport-size=1440x900');
      expect(result!.playwright!.args).toContain('--output-dir=/tmp/video-test');
      // Other server should not be modified
      expect(result!.other!.args).toEqual(['other-server.js']);
    });

    it('should return original config when no playwright server found', () => {
      const mcpServers = {
        other: {
          command: 'node',
          args: ['other-server.js']
        }
      };

      const result = _injectVideoRecording(mcpServers, { tempDir: '/tmp/video-test' });

      expect(result!.other!.args).toEqual(['other-server.js']);
    });

    it('should return original config when videoConfig is null', () => {
      const mcpServers = {
        playwright: {
          command: 'npx',
          args: ['-y', '@playwright/mcp']
        }
      };

      const result = _injectVideoRecording(mcpServers, null);

      expect(result).toBe(mcpServers);
    });

    it('should return original config when mcpServers is null', () => {
      const result = _injectVideoRecording(null, { tempDir: '/tmp/test' });

      expect(result).toBeNull();
    });

    it('should not modify the original config object', () => {
      const mcpServers = {
        playwright: {
          command: 'npx',
          args: ['-y', '@playwright/mcp']
        }
      };

      _injectVideoRecording(mcpServers, { tempDir: '/tmp/video-test' });

      // Original should be unchanged
      expect(mcpServers.playwright.args).toEqual(['-y', '@playwright/mcp']);
    });
  });

  describe('handleVideoRecording', () => {
    let sandbox: string;
    let tempDir: string;
    let worktreePath: string;
    let archiveDir: string;
    let recordingDestPath: string;

    beforeEach(async () => {
      sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'handle-video-test-'));
      tempDir = path.join(sandbox, 'tempDir');
      worktreePath = path.join(sandbox, 'worktree');
      archiveDir = path.join(sandbox, 'archive', 'recordings');
      recordingDestPath = path.join(archiveDir, 'task-1.webm');
      await fsp.mkdir(tempDir, { recursive: true });
      await fsp.mkdir(worktreePath, { recursive: true });
    });

    afterEach(async () => {
      await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => {});
    });

    it('prefers the .webm in tempDir when present', async () => {
      const tempVideo = path.join(tempDir, 'video-1.webm');
      const orphanVideo = path.join(worktreePath, 'review-recording.webm');
      await fsp.writeFile(tempVideo, 'bigger-payload-in-tempdir');
      await fsp.writeFile(orphanVideo, 'x');

      await _handleVideoRecording({ tempDir, taskId: 1, recordingDestPath, worktreePath });

      // Archive file exists
      const stat = await fsp.stat(recordingDestPath);
      expect(stat.isFile()).toBe(true);
      // Orphan in worktree is NOT touched when tempDir had files
      expect((await fsp.stat(orphanVideo)).isFile()).toBe(true);
      // tempDir cleaned up
      await expect(fsp.access(tempDir)).rejects.toBeTruthy();
    });

    it('recovers orphan from worktree when tempDir is empty', async () => {
      const orphanVideo = path.join(worktreePath, 'review-recording.webm');
      await fsp.writeFile(orphanVideo, 'orphan-payload');

      await _handleVideoRecording({ tempDir, taskId: 1, recordingDestPath, worktreePath });

      // Archive file exists with recovered content
      const archived = await fsp.readFile(recordingDestPath, 'utf-8');
      expect(archived).toBe('orphan-payload');
      // Orphan is cleaned up from the worktree
      await expect(fsp.access(orphanVideo)).rejects.toBeTruthy();
      // tempDir cleaned up
      await expect(fsp.access(tempDir)).rejects.toBeTruthy();
    });

    it('does nothing when both tempDir and worktree have no .webm', async () => {
      await _handleVideoRecording({ tempDir, taskId: 1, recordingDestPath, worktreePath });

      // No archive file written
      await expect(fsp.access(recordingDestPath)).rejects.toBeTruthy();
      // tempDir cleaned up
      await expect(fsp.access(tempDir)).rejects.toBeTruthy();
    });

    it('does not scan worktree when worktreePath is absent', async () => {
      const orphanVideo = path.join(worktreePath, 'review-recording.webm');
      await fsp.writeFile(orphanVideo, 'orphan-payload');

      await _handleVideoRecording({ tempDir, taskId: 1, recordingDestPath });

      // Archive file NOT written (no worktreePath means no fallback)
      await expect(fsp.access(recordingDestPath)).rejects.toBeTruthy();
      // Orphan in worktree is untouched
      expect((await fsp.stat(orphanVideo)).isFile()).toBe(true);
    });
  });

  describe('agent chaining', () => {
    beforeEach(() => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(conversationsDb.create).mockReturnValue(mockConversation);
      vi.mocked(tasksDb.getById).mockReturnValue(mockTaskWithProject as never);
    });

    it('should not chain when workflow_complete is true', async () => {
      const completedTask = { ...mockTaskWithProject, workflow_complete: 1 };
      vi.mocked(tasksDb.getById).mockReturnValue(completedTask as never);

      const mockAgentRun = {
        id: 1,
        conversation_id: 1,
        agent_type: 'implementation',
        status: 'running'
      };
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([mockAgentRun] as never);

      const mockMessages = [
        { session_id: 'session-chain', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await startConversation(1, 'Hello', { model: 'opus', conversationId: 1 });

      // Wait for potential chaining
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Query should only be called once (no chaining)
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('should not chain for planification agent', async () => {
      const mockAgentRun = {
        id: 1,
        conversation_id: 1,
        agent_type: 'planification',
        status: 'running'
      };
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([mockAgentRun] as never);

      const mockMessages = [
        { session_id: 'session-plan', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      const mockIterator = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      };
      vi.mocked(query).mockReturnValue(mockIterator as never);

      await startConversation(1, 'Hello', { model: 'opus', conversationId: 1 });

      // Wait for potential chaining
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Query should only be called once (no chaining)
      expect(query).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveSlashCommand', () => {
    it('should return non-slash messages unchanged', async () => {
      expect(await _resolveSlashCommand('Hello world', '/tmp')).toBe('Hello world');
    });

    it('should return empty/null messages unchanged', async () => {
      expect(await _resolveSlashCommand('', '/tmp')).toBe('');
      expect(await _resolveSlashCommand(null, '/tmp')).toBe(null);
    });

    it('should return unknown slash commands unchanged', async () => {
      expect(await _resolveSlashCommand('/nonexistent-command-xyz', '/tmp')).toBe('/nonexistent-command-xyz');
    });

    it('should expand a command from user commands directory', async () => {
      const { promises: fs } = await import('fs');
      const os = await import('os');
      const path = await import('path');

      const commandDir = path.join(os.default.homedir(), '.claude', 'commands');
      const testFile = path.join(commandDir, '__test_slash_cmd__.md');

      try {
        await fs.mkdir(commandDir, { recursive: true });
        await fs.writeFile(testFile, '---\ndescription: test\n---\nDo the thing with $ARGUMENTS');

        const result = await _resolveSlashCommand('/__test_slash_cmd__ foo bar', '/tmp/no-project');
        expect(result).toBe('Do the thing with foo bar');
      } finally {
        await fs.unlink(testFile).catch(() => {});
      }
    });

    it('should replace positional arguments', async () => {
      const { promises: fs } = await import('fs');
      const os = await import('os');
      const path = await import('path');

      const commandDir = path.join(os.default.homedir(), '.claude', 'commands');
      const testFile = path.join(commandDir, '__test_positional__.md');

      try {
        await fs.mkdir(commandDir, { recursive: true });
        await fs.writeFile(testFile, '---\ndescription: test\n---\nFirst: $1, Second: $2');

        const result = await _resolveSlashCommand('/__test_positional__ alpha beta', '/tmp/no-project');
        expect(result).toBe('First: alpha, Second: beta');
      } finally {
        await fs.unlink(testFile).catch(() => {});
      }
    });
  });

  describe('resolveAskUserQuestion (restart fallback)', () => {
    beforeEach(() => {
      vi.mocked(conversationsDb.getById).mockReturnValue({
        id: 1,
        task_id: 1,
        claude_conversation_id: 'orphan-session-1',
        session_path: '/path/to/project',
        provider: 'anthropic' as const,
        provider_session_id: 'orphan-session-1',
        model: 'opus',
        effort: null
      } as never);
      vi.mocked(tasksDb.getById).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([]);
    });

    it('throws when no pending callback and no orphan tool_use is present', async () => {
      vi.mocked(sqliteSessionStore.load).mockResolvedValueOnce(null);
      await expect(resolveAskUserQuestion(1, { 'Q?': 'A' })).rejects.toThrow(
        'No pending AskUserQuestion to resolve for this conversation'
      );
    });

    it('finds the orphan AskUserQuestion and resumes the SDK with a synthesised tool_result', async () => {
      vi.mocked(sqliteSessionStore.load).mockResolvedValueOnce([
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-orphan-1',
                name: 'AskUserQuestion',
                input: { questions: [{ question: 'Pick one?', header: 'Pick' }] }
              }
            ]
          }
        }
      ]);

      const mockMessages = [
        { session_id: 'orphan-session-1', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      vi.mocked(query).mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      } as never);

      const broadcastFn = vi.fn();
      const result = await resolveAskUserQuestion(1, { 'Pick one?': 'Apple' }, { broadcastFn });

      expect(result).toEqual({ kind: 'recovered', conversationId: 1, toolUseId: 'tool-orphan-1' });

      // The SDK was invoked with a deferred prompt — drain it and check the
      // first yielded message is the synthesised tool_result for the orphan.
      const promptIter = vi.mocked(query).mock.calls[0]![0].prompt as unknown as AsyncIterator<unknown>;
      // Drain microtasks so the deferredPrompt reads past the MCP gate.
      await new Promise(resolve => setTimeout(resolve, 20));
      const first = await promptIter.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-orphan-1',
            content: expect.stringContaining('User has answered your questions:')
          }]
        }
      });
      expect(first.value.message.content[0].content).toContain('"Pick one?"="Apple"');
    });

    it('escapes embedded quotes in answers when synthesising the tool_result', async () => {
      vi.mocked(sqliteSessionStore.load).mockResolvedValueOnce([
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-orphan-2',
                name: 'AskUserQuestion',
                input: { questions: [{ question: 'What?', header: 'What' }] }
              }
            ]
          }
        }
      ]);

      const mockMessages = [
        { session_id: 'orphan-session-1', type: 'message' },
        { type: 'result', modelUsage: {} }
      ];
      vi.mocked(query).mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: vi.fn()
            .mockResolvedValueOnce({ value: mockMessages[0], done: false })
            .mockResolvedValueOnce({ value: mockMessages[1], done: false })
            .mockResolvedValueOnce({ done: true })
        })
      } as never);

      await resolveAskUserQuestion(1, { 'What?': 'He said "hi"' }, { broadcastFn: vi.fn() });

      const promptIter = vi.mocked(query).mock.calls[0]![0].prompt as unknown as AsyncIterator<unknown>;
      await new Promise(resolve => setTimeout(resolve, 20));
      const first = await promptIter.next();
      const text = first.value.message.content[0].content;
      // The parser regex /"([^"]*)"="([^"]*)"/g cannot tolerate quotes inside
      // values; we collapse them to single quotes defensively.
      expect(text).toContain(`"What?"="He said 'hi'"`);
      expect(text).not.toContain('He said "hi"');
    });

    it('skips tool_use blocks that already have a matching tool_result', async () => {
      vi.mocked(sqliteSessionStore.load).mockResolvedValueOnce([
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool-resolved-1',
                name: 'AskUserQuestion',
                input: { questions: [{ question: 'Old?', header: 'Old' }] }
              }
            ]
          }
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tool-resolved-1', content: 'User has answered your questions: "Old?"="X".' }
            ]
          }
        }
      ]);

      await expect(resolveAskUserQuestion(1, { 'Old?': 'A' })).rejects.toThrow(
        'No pending AskUserQuestion to resolve for this conversation'
      );
    });
  });

  describe('auth-401 subprocess recycle', () => {
    const AUTH_401_MESSAGE =
      'Claude Code returned an error result: Failed to authenticate. API Error: 401 Invalid authentication credentials';

    // Iterator that yields the given messages then rejects — simulates the SDK
    // throwing a 401 mid-stream after the session has been established.
    function iteratorThatYieldsThenThrows(yields: unknown[], error: Error) {
      return {
        mcpServerStatus: vi.fn().mockResolvedValue([
          { name: 'context7', status: 'connected' },
          { name: 'playwright', status: 'connected' }
        ]),
        reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
        [Symbol.asyncIterator]: () => {
          let i = 0;
          return {
            next: () =>
              i < yields.length
                ? Promise.resolve({ value: yields[i++], done: false })
                : Promise.reject(error)
          };
        }
      };
    }

    beforeEach(() => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(tasksDb.getById).mockReturnValue(mockTaskWithProject as never);
      vi.mocked(conversationsDb.create).mockReturnValue(mockConversation);
      vi.mocked(conversationsDb.getById).mockReturnValue(mockConversationWithSession as never);
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([]);
      vi.mocked(agentRunsDb.getByConversationId).mockReturnValue(undefined);
    });

    it('startConversation: retries once in a fresh subprocess on a 401, transparently', async () => {
      const dead = iteratorThatYieldsThenThrows([{ session_id: 'session-123' }], new Error(AUTH_401_MESSAGE));
      const alive = createMockIterator([
        { session_id: 'existing-session-123', type: 'assistant', message: { id: 'm1' } },
        { type: 'result', modelUsage: {} }
      ]);
      vi.mocked(query).mockReturnValueOnce(dead as never).mockReturnValueOnce(alive as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', conversationId: 1, broadcastFn });
      // First attempt streams, hits the 401, waits the backoff, then resumes.
      await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_BACKOFF_MS + 150));

      expect(query).toHaveBeenCalledTimes(2);
      // The second call is a resume of the established session.
      expect(vi.mocked(query).mock.calls[1]![0].options).toEqual(
        expect.objectContaining({ resume: 'existing-session-123' })
      );
      // Transparent: the failed attempt does not surface a claude-error.
      expect(broadcastFn).not.toHaveBeenCalledWith(1, expect.objectContaining({ type: 'claude-error' }));
      // And the retried turn completes normally.
      expect(broadcastFn).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'claude-complete' }));
    });

    it("startConversation: gives up after one retry — surfaces claude-error, marks 'completed' so the loop chains", async () => {
      // Two consecutive 401s exhaust the in-process retry budget. Under the
      // new deterministic-failed-writer model, the streaming loop does NOT
      // write 'failed' on its way out — that's reserved for user-Stop and
      // server-restart orphan recovery. The agent run is marked 'completed'
      // and a synthetic sdk_error system message has been written into the
      // conversation transcript. The next agent in the loop reads that
      // message and decides what to do.
      const agentRun = { id: 5, conversation_id: 1, agent_type: 'planification', status: 'running', task_id: 1 };
      vi.mocked(agentRunsDb.getByTask).mockReturnValue([agentRun] as never);

      vi.mocked(query)
        .mockReturnValueOnce(iteratorThatYieldsThenThrows([{ session_id: 'session-123' }], new Error(AUTH_401_MESSAGE)) as never)
        .mockReturnValueOnce(iteratorThatYieldsThenThrows([{ session_id: 'existing-session-123' }], new Error(AUTH_401_MESSAGE)) as never);

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', conversationId: 1, broadcastFn });
      await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_BACKOFF_MS + 150));

      expect(query).toHaveBeenCalledTimes(2);
      expect(broadcastFn).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'claude-error' }));
      expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(5, 'completed');
      expect(agentRunsDb.updateStatus).not.toHaveBeenCalledWith(5, 'failed');
    });

    it('startConversation: does not retry non-auth streaming errors', async () => {
      vi.mocked(query).mockReturnValueOnce(
        iteratorThatYieldsThenThrows([{ session_id: 'session-123' }], new Error('some other SDK failure')) as never
      );

      const broadcastFn = vi.fn();
      await startConversation(1, 'Hello', { model: 'opus', conversationId: 1, broadcastFn });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(query).toHaveBeenCalledTimes(1);
      expect(broadcastFn).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'claude-error' }));
    });

    it('sendMessage: retries once in a fresh subprocess on a 401', async () => {
      const dead = iteratorThatYieldsThenThrows([{ session_id: 'existing-session-123' }], new Error(AUTH_401_MESSAGE));
      const alive = createMockIterator([
        { session_id: 'existing-session-123', type: 'assistant', message: { id: 'm1' } },
        { type: 'result', modelUsage: {} }
      ]);
      vi.mocked(query).mockReturnValueOnce(dead as never).mockReturnValueOnce(alive as never);

      const broadcastFn = vi.fn();
      await sendMessage(1, 'Hello', { broadcastFn });

      expect(query).toHaveBeenCalledTimes(2);
      expect(broadcastFn).not.toHaveBeenCalledWith(1, expect.objectContaining({ type: 'claude-error' }));
      expect(broadcastFn).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'claude-complete' }));
    });

    it('sendMessage: does not auto-retry AskUserQuestion-resume turns', async () => {
      vi.mocked(query).mockReturnValueOnce(
        iteratorThatYieldsThenThrows([{ session_id: 'existing-session-123' }], new Error(AUTH_401_MESSAGE)) as never
      );

      const broadcastFn = vi.fn();
      await expect(
        sendMessage(1, 'Hello', {
          broadcastFn,
          askUserQuestionToolResult: { tool_use_id: 't1', content: 'answered' }
        })
      ).rejects.toThrow(/401|authenticate/i);

      expect(query).toHaveBeenCalledTimes(1);
      expect(broadcastFn).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'claude-error' }));
    });

    // Same root cause as the thrown-401 cases above, but here the SDK reports
    // the auth failure as *data* (synthetic assistant + SDKResultError) and
    // the iterator returns cleanly. Confirms parity between the two
    // representations of the same SDK condition.
    describe('in-band variant (SDK delivers 401 as data, no throw)', () => {
      const SYNTHETIC_AUTH_ASSISTANT = {
        type: 'assistant',
        session_id: 'session-123',
        message: {
          id: 'm-synth',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401 Invalid authentication credentials' }],
          error: 'authentication_failed',
        },
      };

      it('startConversation: in-band 401 transparently retries via sendMessage', async () => {
        const dead = createMockIterator([
          { session_id: 'session-123' },
          SYNTHETIC_AUTH_ASSISTANT,
        ]);
        const alive = createMockIterator([
          { session_id: 'existing-session-123', type: 'assistant', message: { id: 'm1' } },
          { type: 'result', modelUsage: {} },
        ]);
        vi.mocked(query).mockReturnValueOnce(dead as never).mockReturnValueOnce(alive as never);

        const broadcastFn = vi.fn();
        await startConversation(1, 'Hello', { model: 'opus', conversationId: 1, broadcastFn });
        await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_BACKOFF_MS + 150));

        expect(query).toHaveBeenCalledTimes(2);
        expect(vi.mocked(query).mock.calls[1]![0].options).toEqual(
          expect.objectContaining({ resume: 'existing-session-123' }),
        );
        // The synthetic auth-error message must not be forwarded to the UI.
        expect(broadcastFn).not.toHaveBeenCalledWith(
          1,
          expect.objectContaining({
            type: 'claude-response',
            data: expect.objectContaining({
              message: expect.objectContaining({ error: 'authentication_failed' }),
            }),
          }),
        );
        // And no claude-error should escape either — recovery is transparent.
        expect(broadcastFn).not.toHaveBeenCalledWith(1, expect.objectContaining({ type: 'claude-error' }));
        expect(broadcastFn).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'claude-complete' }));
      });

      it("startConversation: in-band 401 twice emits claude-error and marks 'completed' (loop continues)", async () => {
        // Same shape as the thrown-error case above: post-simplification the
        // streaming loop never writes 'failed'. The catch path persists a
        // synthetic sdk_error message into the transcript and marks the run
        // 'completed' so the loop can chain to the next agent.
        const agentRun = { id: 7, conversation_id: 1, agent_type: 'planification', status: 'running', task_id: 1 };
        vi.mocked(agentRunsDb.getByTask).mockReturnValue([agentRun] as never);

        const dead1 = createMockIterator([
          { session_id: 'session-123' },
          SYNTHETIC_AUTH_ASSISTANT,
        ]);
        const dead2 = createMockIterator([SYNTHETIC_AUTH_ASSISTANT]);
        vi.mocked(query).mockReturnValueOnce(dead1 as never).mockReturnValueOnce(dead2 as never);

        const broadcastFn = vi.fn();
        await startConversation(1, 'Hello', { model: 'opus', conversationId: 1, broadcastFn });
        await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_BACKOFF_MS + 150));

        expect(query).toHaveBeenCalledTimes(2);
        expect(broadcastFn).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'claude-error' }));
        expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(7, 'completed');
        expect(agentRunsDb.updateStatus).not.toHaveBeenCalledWith(7, 'failed');
      });

      it('sendMessage: in-band 401 transparently retries', async () => {
        const dead = createMockIterator([SYNTHETIC_AUTH_ASSISTANT]);
        const alive = createMockIterator([
          { session_id: 'existing-session-123', type: 'assistant', message: { id: 'm1' } },
          { type: 'result', modelUsage: {} },
        ]);
        vi.mocked(query).mockReturnValueOnce(dead as never).mockReturnValueOnce(alive as never);

        const broadcastFn = vi.fn();
        await sendMessage(1, 'Hello', { broadcastFn });

        expect(query).toHaveBeenCalledTimes(2);
        expect(broadcastFn).not.toHaveBeenCalledWith(1, expect.objectContaining({ type: 'claude-error' }));
        expect(broadcastFn).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'claude-complete' }));
      });
    });
  });

  describe('isClaudeAuthError', () => {
    it('matches the SDK 401 auth-failure signatures', () => {
      expect(
        isClaudeAuthError(
          new Error('Claude Code returned an error result: Failed to authenticate. API Error: 401 Invalid authentication credentials')
        )
      ).toBe(true);
      expect(isClaudeAuthError('401 Invalid authentication credentials')).toBe(true);
      expect(isClaudeAuthError(new Error('Failed to authenticate. API Error: 401'))).toBe(true);
    });

    it('does not match unrelated errors', () => {
      expect(isClaudeAuthError(new Error('Session creation timeout'))).toBe(false);
      expect(isClaudeAuthError(new Error('API Error: 500 internal'))).toBe(false);
      expect(isClaudeAuthError(undefined)).toBe(false);
    });
  });
});
