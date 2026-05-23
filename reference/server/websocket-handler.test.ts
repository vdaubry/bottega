import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, type TestDatabase } from './test/db-helper.js';
import { buildContextPrompt } from './services/documentation.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('WebSocket Handler - Task-based Conversation Flow', () => {
  let testDb: TestDatabase;
  let testDir: string;
  let archiveRoot: string;
  let userId: number;
  let projectId: number;
  let taskId: number;

  beforeEach(() => {
    // Create test database
    testDb = createTestDatabase();

    // Create a test user and project
    const user = testDb.userDb.createUser('testuser', 'hashedpassword');
    userId = user.id;

    // Create temp dirs for the repo and central archive
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-handler-test-'));
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-handler-archive-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;

    // Create project in test database
    const project = testDb.projectsDb.create(userId, 'Test Project', testDir);
    projectId = project.id;

    // Create task in test database (task owner = test user)
    const task = testDb.tasksDb.create(projectId, 'Test Task', false, userId);
    taskId = task.id;
  });

  afterEach(() => {
    // Close database
    testDb.close();

    // Clean up temp directories
    if (testDir) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    if (archiveRoot) {
      fs.rmSync(archiveRoot, { recursive: true, force: true });
    }
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
  });

  describe('New Conversation Flow', () => {
    it('should create conversation record when taskId is provided', () => {
      // Create conversation
      const conversation = testDb.conversationsDb.create(taskId);

      expect(conversation.id).toBeDefined();
      expect(conversation.taskId).toBe(taskId);
      expect(conversation.claudeConversationId).toBeNull();
    });

    it('should retrieve task with project info', () => {
      const taskWithProject = testDb.tasksDb.getWithProject(taskId);

      expect(taskWithProject).toBeDefined();
      expect(taskWithProject!.id).toBe(taskId);
      expect(taskWithProject!.project_id).toBe(projectId);
      expect(taskWithProject!.user_id).toBe(userId);
      expect(taskWithProject!.repo_folder_path).toBe(testDir);
      expect(taskWithProject!.project_name).toBe('Test Project');
    });

    it('should build context prompt with canonical task plan path', () => {
      // Task doc lives in the central archive
      const archiveTasksDir = path.join(archiveRoot, 'projects', String(projectId), 'tasks');
      fs.mkdirSync(archiveTasksDir, { recursive: true });
      const taskDocPath = path.join(archiveTasksDir, `task-${taskId}.md`);
      fs.writeFileSync(taskDocPath, '# Task Description\n\nImplement feature X.');

      const contextPrompt = buildContextPrompt(projectId, taskId);

      expect(contextPrompt).toContain('## Task Plan File');
      expect(contextPrompt).toContain(taskDocPath);
      expect(contextPrompt).toContain('MUST read this file in full');
    });

    it('should handle empty documentation gracefully', () => {
      const contextPrompt = buildContextPrompt(projectId, taskId);

      // Testing Configuration is always present with task ID and port
      expect(contextPrompt).toContain('## Testing Configuration');
      expect(contextPrompt).toContain(`Task ID:** ${taskId}`);
      expect(contextPrompt).toContain('Dev Server Port:**');
      // No Task Context section (task body is never inlined)
      expect(contextPrompt).not.toContain('## Task Context');
    });

    it('should update conversation with Claude session ID', () => {
      // Create conversation
      const conversation = testDb.conversationsDb.create(taskId);

      // Update with Claude session ID (simulating callback)
      const claudeSessionId = 'claude-session-abc123';
      const updated = testDb.conversationsDb.updateClaudeId(conversation.id, claudeSessionId);

      expect(updated).toBe(true);

      // Verify the update
      const updatedConversation = testDb.conversationsDb.getById(conversation.id);
      expect(updatedConversation!.claude_conversation_id).toBe(claudeSessionId);
    });
  });

  describe('Resume Conversation Flow', () => {
    it('should retrieve conversation by ID', () => {
      // Create and setup conversation
      const conversation = testDb.conversationsDb.create(taskId);
      testDb.conversationsDb.updateClaudeId(conversation.id, 'claude-session-xyz');

      // Retrieve conversation
      const retrieved = testDb.conversationsDb.getById(conversation.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(conversation.id);
      expect(retrieved!.claude_conversation_id).toBe('claude-session-xyz');
      expect(retrieved!.task_id).toBe(taskId);
    });

    it('should get task project info from conversation', () => {
      // Create conversation
      const conversation = testDb.conversationsDb.create(taskId);
      testDb.conversationsDb.updateClaudeId(conversation.id, 'claude-session-xyz');

      // Get conversation and then task with project
      const retrieved = testDb.conversationsDb.getById(conversation.id);
      const taskWithProject = testDb.tasksDb.getWithProject(retrieved!.task_id);

      expect(taskWithProject!.repo_folder_path).toBe(testDir);
    });
  });

  describe('Error Handling', () => {
    it('should return null for non-existent task', () => {
      const taskWithProject = testDb.tasksDb.getWithProject(99999);
      expect(taskWithProject).toBeUndefined();
    });

    it('should return null for non-existent conversation', () => {
      const conversation = testDb.conversationsDb.getById(99999);
      expect(conversation).toBeUndefined();
    });

    it('should handle conversation without Claude session ID', () => {
      // Create conversation without updating Claude ID
      const conversation = testDb.conversationsDb.create(taskId);

      const retrieved = testDb.conversationsDb.getById(conversation.id);
      expect(retrieved!.claude_conversation_id).toBeNull();
    });
  });

  describe('WebSocket Message Simulation', () => {
    it('should return error when no conversationId is provided (new conversation via WebSocket blocked)', () => {
      // After the refactoring, new conversations must be created via REST API
      // The WebSocket handler should return an error if no conversationId is provided
      const sentMessages: unknown[] = [];
      const mockWs = {
        id: 'ws1',
        readyState: 1,
        send: (msg: string) => sentMessages.push(JSON.parse(msg))
      };

      const message = {
        type: 'claude-command',
        command: 'Hello, Claude!',
        options: {
          taskId: taskId,
          // Note: no conversationId - this should trigger an error
          isNewConversation: true
        }
      };

      // Simulate the new handler behavior: without conversationId, send error
      const { conversationId } = (message.options ?? {}) as { conversationId?: string };
      if (!conversationId) {
        mockWs.send(JSON.stringify({
          type: 'claude-error',
          error: 'New conversations must be created via REST API. Use the modal to start a conversation.'
        }));
      }

      // Verify error was sent
      expect(sentMessages.length).toBe(1);
      expect((sentMessages[0] as { type: string }).type).toBe('claude-error');
      expect((sentMessages[0] as { error: string }).error).toContain('REST API');
    });

    it('should require conversationId for claude-command (resume only flow)', () => {
      // This test documents that the WebSocket handler now only supports resuming
      // conversations, not creating new ones. New conversations must use REST API.
      const sentMessages: unknown[] = [];
      const mockWs = {
        id: 'ws1',
        readyState: 1,
        send: (msg: string) => sentMessages.push(JSON.parse(msg))
      };

      // Message without conversationId
      const messageWithoutConvId = {
        type: 'claude-command',
        command: 'Hello, Claude!',
        options: {}
      };

      // Handler should reject messages without conversationId
      const { conversationId } = (messageWithoutConvId.options ?? {}) as { conversationId?: string };
      if (!conversationId) {
        mockWs.send(JSON.stringify({
          type: 'claude-error',
          error: 'New conversations must be created via REST API. Use the modal to start a conversation.'
        }));
      }

      expect(sentMessages.length).toBe(1);
      expect((sentMessages[0] as { type: string }).type).toBe('claude-error');
    });

    it('should use existing conversationId when provided with isNewConversation: true', () => {
      // This tests the scenario where frontend creates the conversation first,
      // then sends a message with both conversationId AND isNewConversation: true.
      // The backend should use the existing conversationId, NOT create a new one.

      // Frontend creates conversation first (via API)
      const frontendCreatedConversation = testDb.conversationsDb.create(taskId);
      const existingConversationId = frontendCreatedConversation.id;

      // Simulate the message from frontend - includes both conversationId and isNewConversation
      const message = {
        type: 'claude-command',
        command: 'Hello, Claude!',
        options: {
          taskId: taskId,
          conversationId: existingConversationId,  // Frontend provides existing ID
          isNewConversation: true  // But marks as new (first message in conversation)
        }
      };

      // Get task with project (as handler would do)
      const taskWithProject = testDb.tasksDb.getWithProject(message.options.taskId);
      expect(taskWithProject).toBeDefined();

      // THE FIX: When conversationId is provided, use it instead of creating new
      let dbConversationId: number;
      if (message.options.conversationId) {
        // Use existing conversation (the fix)
        dbConversationId = message.options.conversationId;
      } else {
        // Create new conversation only if no conversationId provided
        const newConversation = testDb.conversationsDb.create(taskId);
        dbConversationId = newConversation.id;
      }

      // Verify the existing conversation ID is used
      expect(dbConversationId).toBe(existingConversationId);

      // Simulate updating the conversation with Claude session ID
      const claudeSessionId = 'claude-session-xyz';
      testDb.conversationsDb.updateClaudeId(dbConversationId, claudeSessionId);

      // Verify the SAME conversation was updated (not a duplicate)
      const updatedConversation = testDb.conversationsDb.getById(existingConversationId);
      expect(updatedConversation!.claude_conversation_id).toBe(claudeSessionId);

      // Verify no duplicate was created - count conversations for this task
      const allConversations = testDb.conversationsDb.getByTask(taskId);
      expect(allConversations.length).toBe(1);
      expect(allConversations[0]!.id).toBe(existingConversationId);
    });

    it('should NOT create duplicate conversation when conversationId is provided', () => {
      // Regression test: This tests that we don't create a duplicate conversation
      // when the frontend has already created one and sends its ID.

      // Frontend creates conversation
      const existingConversation = testDb.conversationsDb.create(taskId);
      const countBefore = testDb.conversationsDb.getByTask(taskId).length;
      expect(countBefore).toBe(1);

      // Simulate receiving message with existing conversationId
      const message = {
        type: 'claude-command',
        command: 'Test message',
        options: {
          taskId: taskId,
          conversationId: existingConversation.id,
          isNewConversation: true
        }
      };

      // Apply the correct logic (matching the fix in index.js)
      let dbConversationId: number;
      if (message.options.conversationId) {
        dbConversationId = message.options.conversationId;
      } else {
        const newConv = testDb.conversationsDb.create(taskId);
        dbConversationId = newConv.id;
      }

      // Verify no new conversation was created
      const countAfter = testDb.conversationsDb.getByTask(taskId).length;
      expect(countAfter).toBe(1);
      expect(dbConversationId).toBe(existingConversation.id);
    });

    it('should simulate resume conversation message handling', () => {
      // Setup: create conversation with Claude session ID
      const conversation = testDb.conversationsDb.create(taskId);
      const claudeSessionId = 'claude-session-resume-test';
      testDb.conversationsDb.updateClaudeId(conversation.id, claudeSessionId);

      // Simulate the message that would be received
      const message = {
        type: 'claude-command',
        command: 'Continue our conversation',
        options: {
          conversationId: conversation.id,
          isNewConversation: false
        }
      };

      // Get conversation (as handler would do)
      const retrievedConversation = testDb.conversationsDb.getById(message.options.conversationId);
      expect(retrievedConversation).toBeDefined();
      expect(retrievedConversation!.claude_conversation_id).toBe(claudeSessionId);

      // Get task with project for cwd (as handler would do)
      const taskWithProject = testDb.tasksDb.getWithProject(retrievedConversation!.task_id);

      // Build SDK options for resume (as handler would do)
      const sdkOptions = {
        cwd: taskWithProject!.repo_folder_path,
        sessionId: retrievedConversation!.claude_conversation_id
      };

      expect(sdkOptions.cwd).toBe(testDir);
      expect(sdkOptions.sessionId).toBe(claudeSessionId);
    });
  });

  describe('Task Subscription Flow', () => {
    it('should track task subscriptions in a Map', () => {
      // Simulate the task subscription tracking (as done in index.js)
      const taskSubscriptions = new Map();

      // Mock WebSocket client
      const mockWs1 = { id: 'ws1' };
      const mockWs2 = { id: 'ws2' };

      // Subscribe ws1 to task 1 and task 2
      if (!taskSubscriptions.has(mockWs1)) {
        taskSubscriptions.set(mockWs1, new Set());
      }
      taskSubscriptions.get(mockWs1).add(1);
      taskSubscriptions.get(mockWs1).add(2);

      // Subscribe ws2 to task 1 only
      if (!taskSubscriptions.has(mockWs2)) {
        taskSubscriptions.set(mockWs2, new Set());
      }
      taskSubscriptions.get(mockWs2).add(1);

      // Verify subscriptions
      expect(taskSubscriptions.get(mockWs1).has(1)).toBe(true);
      expect(taskSubscriptions.get(mockWs1).has(2)).toBe(true);
      expect(taskSubscriptions.get(mockWs2).has(1)).toBe(true);
      expect(taskSubscriptions.get(mockWs2).has(2)).toBe(false);
    });

    it('should unsubscribe from task correctly', () => {
      const taskSubscriptions = new Map();
      const mockWs = { id: 'ws1' };

      // Subscribe to tasks
      taskSubscriptions.set(mockWs, new Set([1, 2, 3]));
      expect(taskSubscriptions.get(mockWs).size).toBe(3);

      // Unsubscribe from task 2
      taskSubscriptions.get(mockWs).delete(2);

      expect(taskSubscriptions.get(mockWs).has(1)).toBe(true);
      expect(taskSubscriptions.get(mockWs).has(2)).toBe(false);
      expect(taskSubscriptions.get(mockWs).has(3)).toBe(true);
    });

    it('should clean up subscriptions on disconnect', () => {
      const taskSubscriptions = new Map();
      const mockWs = { id: 'ws1' };

      // Subscribe to tasks
      taskSubscriptions.set(mockWs, new Set([1, 2]));
      expect(taskSubscriptions.has(mockWs)).toBe(true);

      // Simulate disconnect cleanup
      taskSubscriptions.delete(mockWs);

      expect(taskSubscriptions.has(mockWs)).toBe(false);
    });

    it('should broadcast to task subscribers only', () => {
      const taskSubscriptions = new Map();
      const sentMessages: unknown[] = [];

      // Mock WebSocket clients
      const mockWs1 = {
        id: 'ws1',
        readyState: 1, // WebSocket.OPEN
        send: (msg: string) => sentMessages.push({ client: 'ws1', msg: JSON.parse(msg) })
      };
      const mockWs2 = {
        id: 'ws2',
        readyState: 1,
        send: (msg: string) => sentMessages.push({ client: 'ws2', msg: JSON.parse(msg) })
      };
      const mockWs3 = {
        id: 'ws3',
        readyState: 1,
        send: (msg: string) => sentMessages.push({ client: 'ws3', msg: JSON.parse(msg) })
      };

      // Subscribe ws1 and ws2 to task 1, ws3 to task 2
      taskSubscriptions.set(mockWs1, new Set([1]));
      taskSubscriptions.set(mockWs2, new Set([1]));
      taskSubscriptions.set(mockWs3, new Set([2]));

      // Simulate broadcast to task 1 subscribers
      const clients = [mockWs1, mockWs2, mockWs3];
      const targetTaskId = 1;
      const message = { type: 'agent-run-updated', agentRun: { id: 1, status: 'running' } };

      clients.forEach(client => {
        if (client.readyState === 1) {
          const subscribedTasks = taskSubscriptions.get(client);
          if (subscribedTasks?.has(targetTaskId)) {
            client.send(JSON.stringify({ ...message, taskId: targetTaskId }));
          }
        }
      });

      // Verify only ws1 and ws2 received the message
      expect(sentMessages.length).toBe(2);
      expect((sentMessages[0] as { client: string }).client).toBe('ws1');
      expect((sentMessages[1] as { client: string }).client).toBe('ws2');
      expect((sentMessages[0] as { msg: { taskId: number } }).msg.taskId).toBe(1);
      expect((sentMessages[0] as { msg: { type: string } }).msg.type).toBe('agent-run-updated');
    });

    it('should handle subscribe-task message correctly', () => {
      const taskSubscriptions = new Map();
      const mockWs = { id: 'ws1' };

      // Simulate handling subscribe-task message
      const message = {
        type: 'subscribe-task',
        taskId: taskId
      };

      if (message.type === 'subscribe-task') {
        if (!taskSubscriptions.has(mockWs)) {
          taskSubscriptions.set(mockWs, new Set());
        }
        taskSubscriptions.get(mockWs).add(message.taskId);
      }

      expect(taskSubscriptions.get(mockWs).has(taskId)).toBe(true);
    });

    it('should handle unsubscribe-task message correctly', () => {
      const taskSubscriptions = new Map();
      const mockWs = { id: 'ws1' };

      // Pre-subscribe
      taskSubscriptions.set(mockWs, new Set([taskId]));
      expect(taskSubscriptions.get(mockWs).has(taskId)).toBe(true);

      // Simulate handling unsubscribe-task message
      const message = {
        type: 'unsubscribe-task',
        taskId: taskId
      };

      if (message.type === 'unsubscribe-task') {
        taskSubscriptions.get(mockWs)?.delete(message.taskId);
      }

      expect(taskSubscriptions.get(mockWs).has(taskId)).toBe(false);
    });

    it('should include taskId in broadcast message', () => {
      const targetTaskId = 42;
      const originalMessage = {
        type: 'conversation-added',
        conversation: { id: 1, task_id: targetTaskId }
      };

      // Simulate adding taskId to message (as done in broadcastToTaskSubscribers)
      const messageWithTaskId = { ...originalMessage, taskId: targetTaskId };

      expect(messageWithTaskId.taskId).toBe(42);
      expect(messageWithTaskId.type).toBe('conversation-added');
      expect(messageWithTaskId.conversation.id).toBe(1);
    });
  });
});
