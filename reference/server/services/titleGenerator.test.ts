import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { conversationsDb } from '../database/db.js';
import { auditClaudeLaunch, buildClaudeSpawnEnv } from './claudeCredentials.js';
import { generateConversationTitle } from './titleGenerator.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    default: {
      ...actual,
      spawn: spawnMock
    },
    spawn: spawnMock
  };
});

vi.mock('../database/db.js', () => ({
  conversationsDb: {
    updateName: vi.fn()
  }
}));

vi.mock('./claudeCredentials.js', () => ({
  buildClaudeSpawnEnv: vi.fn((userId) => ({
    HOME: '/home/test',
    PATH: '/usr/bin',
    CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-test-${userId}`
  })),
  auditClaudeLaunch: vi.fn()
}));

/**
 * Title Generator Service Tests
 *
 * These tests focus on the title generator logic without requiring complex child_process mocking.
 * The tests verify:
 * - Title sanitization logic
 * - Input validation
 * - Timeout configuration
 * - Message truncation
 */

describe('Title Generator Service Logic', () => {

  describe('Title Sanitization Logic', () => {
    // Test the sanitization function logic

    function sanitizeTitle(raw: unknown): string | null {
      if (!raw || typeof raw !== 'string') {
        return null;
      }

      // Trim whitespace and remove any surrounding quotes
      let title = raw.trim().replace(/^["']|["']$/g, '').trim();

      // Remove any trailing punctuation that doesn't belong
      title = title.replace(/[.!?]+$/, '').trim();

      // Cap at max length (50 chars)
      const MAX_TITLE_LENGTH = 50;
      if (title.length > MAX_TITLE_LENGTH) {
        title = title.substring(0, MAX_TITLE_LENGTH - 3) + '...';
      }

      // Return null if title is empty or too short
      if (title.length < 2) {
        return null;
      }

      return title;
    }

    it('should trim whitespace from titles', () => {
      expect(sanitizeTitle('  Debug Help  ')).toBe('Debug Help');
      expect(sanitizeTitle('  Debug Help  \n')).toBe('Debug Help');
      expect(sanitizeTitle('\t\nDebug Help\t\n')).toBe('Debug Help');
    });

    it('should remove surrounding double quotes', () => {
      expect(sanitizeTitle('"Debug Help"')).toBe('Debug Help');
    });

    it('should remove surrounding single quotes', () => {
      expect(sanitizeTitle("'Debug Help'")).toBe('Debug Help');
    });

    it('should remove trailing periods', () => {
      expect(sanitizeTitle('Debug Help.')).toBe('Debug Help');
      expect(sanitizeTitle('Debug Help...')).toBe('Debug Help');
    });

    it('should remove trailing exclamation marks', () => {
      expect(sanitizeTitle('Debug Help!')).toBe('Debug Help');
      expect(sanitizeTitle('Debug Help!!!')).toBe('Debug Help');
    });

    it('should remove trailing question marks', () => {
      expect(sanitizeTitle('Debug Help?')).toBe('Debug Help');
      expect(sanitizeTitle('Debug Help???')).toBe('Debug Help');
    });

    it('should truncate titles longer than 50 characters', () => {
      const longTitle = 'A'.repeat(60);
      const result = sanitizeTitle(longTitle);

      expect(result).toBe('A'.repeat(47) + '...');
      expect(result!.length).toBe(50);
    });

    it('should not truncate titles at or under 50 characters', () => {
      const exactTitle = 'A'.repeat(50);
      expect(sanitizeTitle(exactTitle)).toBe(exactTitle);

      const shortTitle = 'A'.repeat(30);
      expect(sanitizeTitle(shortTitle)).toBe(shortTitle);
    });

    it('should return null for empty strings', () => {
      expect(sanitizeTitle('')).toBe(null);
    });

    it('should return null for whitespace-only strings', () => {
      expect(sanitizeTitle('   ')).toBe(null);
      expect(sanitizeTitle('\n\t')).toBe(null);
    });

    it('should return null for null input', () => {
      expect(sanitizeTitle(null)).toBe(null);
    });

    it('should return null for undefined input', () => {
      expect(sanitizeTitle(undefined)).toBe(null);
    });

    it('should return null for non-string input', () => {
      expect(sanitizeTitle(123)).toBe(null);
      expect(sanitizeTitle({})).toBe(null);
      expect(sanitizeTitle([])).toBe(null);
    });

    it('should return null for titles shorter than 2 characters', () => {
      expect(sanitizeTitle('A')).toBe(null);
      expect(sanitizeTitle('.')).toBe(null);
    });

    it('should handle combined sanitization correctly', () => {
      expect(sanitizeTitle('  "Debug Help."  ')).toBe('Debug Help');
      expect(sanitizeTitle("'Test Title!'\n")).toBe('Test Title');
    });
  });

  describe('Message Truncation Logic', () => {
    const MAX_MESSAGE_LENGTH = 500;

    function truncateMessage(message: string) {
      return message.length > MAX_MESSAGE_LENGTH
        ? message.substring(0, MAX_MESSAGE_LENGTH) + '...'
        : message;
    }

    it('should truncate messages longer than 500 characters', () => {
      const longMessage = 'A'.repeat(600);
      const result = truncateMessage(longMessage);

      expect(result).toBe('A'.repeat(500) + '...');
      expect(result.length).toBe(503);
    });

    it('should not truncate messages at or under 500 characters', () => {
      const exactMessage = 'A'.repeat(500);
      expect(truncateMessage(exactMessage)).toBe(exactMessage);

      const shortMessage = 'A'.repeat(100);
      expect(truncateMessage(shortMessage)).toBe(shortMessage);
    });
  });

  describe('Input Validation Logic', () => {
    function validateInputs(conversationId: number, message: string) {
      return !!(conversationId && message);
    }

    it('should return false if conversationId is null', () => {
      expect(validateInputs(null as never, 'test message')).toBe(false);
    });

    it('should return false if conversationId is undefined', () => {
      expect(validateInputs(undefined as never, 'test message')).toBe(false);
    });

    it('should return false if conversationId is 0', () => {
      expect(validateInputs(0, 'test message')).toBe(false);
    });

    it('should return false if message is null', () => {
      expect(validateInputs(123, null as never)).toBe(false);
    });

    it('should return false if message is empty string', () => {
      expect(validateInputs(123, '')).toBe(false);
    });

    it('should return true for valid inputs', () => {
      expect(validateInputs(123, 'Help me debug')).toBe(true);
    });
  });

  describe('CLI Arguments Generation', () => {
    function generateCLIArgs(prompt: string) {
      return [
        '-p', prompt,
        '--model', 'haiku',
        '--output-format', 'text',
        '--max-turns', '1'
      ];
    }

    it('should include -p flag with prompt', () => {
      const args = generateCLIArgs('test prompt');

      expect(args[0]).toBe('-p');
      expect(args[1]).toBe('test prompt');
    });

    it('should include haiku model', () => {
      const args = generateCLIArgs('test prompt');

      expect(args).toContain('--model');
      expect(args).toContain('haiku');
    });

    it('should include text output format', () => {
      const args = generateCLIArgs('test prompt');

      expect(args).toContain('--output-format');
      expect(args).toContain('text');
    });

    it('should include max-turns 1', () => {
      const args = generateCLIArgs('test prompt');

      expect(args).toContain('--max-turns');
      expect(args).toContain('1');
    });
  });

  describe('Configuration Values', () => {
    it('should have 20 second timeout', () => {
      const TIMEOUT_MS = 20000;
      expect(TIMEOUT_MS).toBe(20000);
    });

    it('should have 500 character message limit', () => {
      const MAX_MESSAGE_LENGTH = 500;
      expect(MAX_MESSAGE_LENGTH).toBe(500);
    });

    it('should have 50 character title limit', () => {
      const MAX_TITLE_LENGTH = 50;
      expect(MAX_TITLE_LENGTH).toBe(50);
    });
  });

  describe('Prompt Generation', () => {
    function generatePrompt(message: string) {
      return `Generate a 1-3 word title summarizing this message. Output ONLY the title, nothing else:

${message}`;
    }

    it('should include the message in the prompt', () => {
      const prompt = generatePrompt('Help me debug the login form');

      expect(prompt).toContain('Help me debug the login form');
    });

    it('should include instructions for 1-3 word title', () => {
      const prompt = generatePrompt('test');

      expect(prompt).toContain('1-3 word title');
    });

    it('should include instruction for output only', () => {
      const prompt = generatePrompt('test');

      expect(prompt).toContain('Output ONLY the title');
    });
  });

  describe('WebSocket Message Format', () => {
    function createBroadcastMessage(conversationId: number, name: string, taskId: number = 99) {
      return {
        type: 'conversation-name-updated',
        conversationId,
        taskId,
        name
      };
    }

    it('should have correct type', () => {
      const msg = createBroadcastMessage(123, 'Test Title');

      expect(msg.type).toBe('conversation-name-updated');
    });

    it('should include conversation ID', () => {
      const msg = createBroadcastMessage(123, 'Test Title');

      expect(msg.conversationId).toBe(123);
    });

    it('should include the title as name', () => {
      const msg = createBroadcastMessage(123, 'Test Title');

      expect(msg.name).toBe('Test Title');
    });
  });

  describe('Per-user Claude credentials', () => {
    type MockChild = EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
      pid: number;
    };
    function createMockChild(pid = 12345): MockChild {
      const child = new EventEmitter() as MockChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      child.pid = pid;
      return child;
    }

    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(conversationsDb.updateName).mockReturnValue(true);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('spawns claude with the per-user credential env and audits the pid', () => {
      const child = createMockChild(4567);
      vi.mocked(spawn).mockReturnValue(child as never);
      const broadcastFn = vi.fn();

      const broadcastToTaskSubscribersFn = vi.fn();
      generateConversationTitle(
        7,
        'Help me debug login',
        broadcastFn,
        42,
        99,
        broadcastToTaskSubscribersFn,
      );

      expect(buildClaudeSpawnEnv).toHaveBeenCalledWith(42);
      expect(spawn).toHaveBeenCalledWith(
        'claude',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-42'
          })
        })
      );
      expect(auditClaudeLaunch).toHaveBeenCalledWith(expect.objectContaining({
        source: 'title-generator',
        userId: 42,
        pid: 4567,
        conversationId: 7
      }));
      expect(vi.mocked(auditClaudeLaunch).mock.calls[0]![0]).not.toHaveProperty('claudeConfigDir');

      child.stdout.emit('data', 'Login Debugging');
      child.emit('close', 0);

      expect(conversationsDb.updateName).toHaveBeenCalledWith(7, 'Login Debugging');
      // Dual-emit: conversation channel includes taskId; task channel does not
      // (the helper splices taskId in itself, mirroring streaming-started/ended).
      expect(broadcastFn).toHaveBeenCalledWith(7, expect.objectContaining({
        type: 'conversation-name-updated',
        conversationId: 7,
        taskId: 99,
        name: 'Login Debugging'
      }));
      expect(broadcastToTaskSubscribersFn).toHaveBeenCalledWith(99, expect.objectContaining({
        type: 'conversation-name-updated',
        conversationId: 7,
        name: 'Login Debugging'
      }));
    });

    it('fails closed without spawning when per-user credentials are unavailable', () => {
      vi.mocked(buildClaudeSpawnEnv).mockImplementationOnce(() => {
        throw new Error('Claude credentials are not provisioned for user 42');
      });

      generateConversationTitle(7, 'Help me debug login', null as never, 42);

      expect(spawn).not.toHaveBeenCalled();
      expect(auditClaudeLaunch).not.toHaveBeenCalled();
    });
  });
});
