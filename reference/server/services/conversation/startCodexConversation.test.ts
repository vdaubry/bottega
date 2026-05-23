import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedMessage } from '@shared/providers/types';

vi.mock('../../database/db.js', () => ({
  tasksDb: {
    getWithProject: vi.fn(),
  },
  conversationsDb: {
    create: vi.fn(),
    getById: vi.fn(),
    updateClaudeId: vi.fn(),
    updateProviderSessionId: vi.fn(),
    updateModelEffort: vi.fn(),
    updateSessionPath: vi.fn(),
  },
  agentRunsDb: {
    getByTask: vi.fn(() => []),
    updateStatus: vi.fn(),
  },
  userDb: { getUserById: vi.fn() },
  db: {},
}));

vi.mock('../agentModelSettings.js', () => ({
  // Resume keeps the row's stored model/effort here (no per-user override).
  resolveResumeModelEffort: vi.fn((conversation: { model: string | null; effort: string | null }) => ({
    model: conversation.model,
    effort: conversation.effort,
  })),
}));

vi.mock('../worktree.js', () => ({
  worktreeExists: vi.fn(async () => false),
  getWorktreeProjectPath: vi.fn((p: string) => p),
}));

vi.mock('../titleGenerator.js', () => ({
  generateConversationTitle: vi.fn(),
}));

vi.mock('../contextUsageTracker.js', () => ({
  createContextUsageTracker: vi.fn(() => ({
    onAssistant: vi.fn(),
    onResult: vi.fn(async () => {}),
  })),
}));

vi.mock('../credentials/registry.js', () => ({
  getCredentialStore: vi.fn(() => ({
    buildSdkEnv: () => ({ CODEX_HOME: '/fake', HOME: '/h', PATH: '/p' }),
  })),
}));

vi.mock('../providers/openai/index.js', () => ({
  codexProvider: {
    startTurn: vi.fn(),
    abortTurn: vi.fn(() => false),
  },
}));

vi.mock('./media.js', () => ({
  handleImages: vi.fn(async (msg: string) => ({
    modifiedCommand: msg,
    tempImagePaths: [],
    tempDir: null,
  })),
  cleanupTempFiles: vi.fn(async () => {}),
  handleVideoRecording: vi.fn(async () => {}),
}));

vi.mock('./slashCommands.js', () => ({
  resolveSlashCommand: vi.fn(async (m: string | null) => m),
}));

import { tasksDb, conversationsDb } from '../../database/db.js';
import { codexProvider } from '../providers/openai/index.js';
import { startCodexConversation, sendCodexMessage } from './startCodexConversation.js';

const SID = 'thread-id-zzz';

/**
 * Wait for `broadcastFn` to be called with a message whose type matches
 * `targetType`. Used so tests can synchronize on the end-of-stream
 * lifecycle event (the conversation promise resolves on the first
 * event; the stream keeps draining in a background async IIFE).
 */
function waitForBroadcast(
  broadcastFn: { mock: { calls: unknown[][] } },
  targetType: string,
  timeoutMs = 1500,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const seen = broadcastFn.mock.calls.some((call) => {
        const msg = call[1] as { type?: string };
        return msg.type === targetType;
      });
      if (seen) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out waiting for ${targetType} broadcast`));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function buildFakeRun(events: UnifiedMessage[]) {
  let resolveSid!: (id: string) => void;
  const providerSessionId$ = new Promise<string>((resolve) => {
    resolveSid = resolve;
  });
  return {
    providerSessionId$,
    abort: vi.fn(),
    pid: null,
    async *events() {
      for (const e of events) {
        if (e.providerSessionId) resolveSid(e.providerSessionId);
        yield e;
      }
    },
  };
}

describe('startCodexConversation', () => {
  const broadcastFn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tasksDb.getWithProject).mockReturnValue({
      id: 1,
      project_id: 7,
      title: 't',
      status: 'pending',
      repo_folder_path: '/repo',
      user_id: 1,
      workflow_complete: 0,
    } as never);
    vi.mocked(conversationsDb.create).mockReturnValue({
      id: 11,
      task_id: 1,
      claude_conversation_id: null,
      provider: 'openai',
      provider_session_id: null,
      model: 'gpt-5.5',
      effort: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a conversation row with provider='openai' and persists the thread id once seen", async () => {
    const events: UnifiedMessage[] = [
      {
        type: 'system',
        id: 'thread_started',
        provider: 'openai',
        providerSessionId: SID,
        raw: null,
        subtype: 'thread_started',
      },
      {
        type: 'assistant',
        id: 'msg-1',
        provider: 'openai',
        providerSessionId: SID,
        raw: null,
        text: 'hello from codex',
        isSubAgent: false,
      },
      {
        type: 'result',
        id: 'result',
        provider: 'openai',
        providerSessionId: SID,
        raw: null,
        isError: false,
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ];

    const fakeRun = buildFakeRun(events);
    vi.mocked(codexProvider.startTurn).mockResolvedValueOnce({
      providerSessionId$: fakeRun.providerSessionId$,
      abort: fakeRun.abort,
      pid: null,
      events: fakeRun.events(),
    });

    const out = await startCodexConversation(1, 'hi', {
      userId: 1,
      provider: 'openai',
      model: 'gpt-5.5',
      broadcastFn,
    });
    expect(out.conversationId).toBe(11);
    expect(out.claudeSessionId).toBe(SID);
    expect(conversationsDb.create).toHaveBeenCalledWith(1, 'openai', 'gpt-5.5', null);
    expect(conversationsDb.updateClaudeId).toHaveBeenCalledWith(11, SID);
    expect(conversationsDb.updateProviderSessionId).toHaveBeenCalledWith(11, SID);
  });

  it("broadcasts ai-response + claude-response per UnifiedMessage; ai-response carries provider='openai'", async () => {
    const events: UnifiedMessage[] = [
      {
        type: 'assistant',
        id: 'msg-A',
        provider: 'openai',
        providerSessionId: SID,
        raw: null,
        text: 'hi',
        isSubAgent: false,
      },
      {
        type: 'result',
        id: 'r',
        provider: 'openai',
        providerSessionId: SID,
        raw: null,
        isError: false,
      },
    ];
    const fakeRun = buildFakeRun(events);
    vi.mocked(codexProvider.startTurn).mockResolvedValueOnce({
      providerSessionId$: fakeRun.providerSessionId$,
      abort: fakeRun.abort,
      pid: null,
      events: fakeRun.events(),
    });

    await startCodexConversation(1, 'hi', {
      userId: 1,
      provider: 'openai',
      model: 'gpt-5.5',
      broadcastFn,
    });
    await waitForBroadcast(broadcastFn, 'claude-complete');

    // Find the ai-response broadcasts. Debug first if needed.
    const allTypes = broadcastFn.mock.calls.map((call) => (call[1] as { type?: string }).type);
    const ai = broadcastFn.mock.calls
      .map((call) => call[1])
      .filter((msg) => msg.type === 'ai-response');
    expect(ai.length, `all broadcasts: ${allTypes.join(', ')}`).toBeGreaterThanOrEqual(2);
    for (const msg of ai) {
      expect(msg.provider).toBe('openai');
    }
    // And the matching claude-response back-compat dual-emit.
    const cr = broadcastFn.mock.calls
      .map((call) => call[1])
      .filter((msg) => msg.type === 'claude-response');
    expect(cr.length).toBeGreaterThanOrEqual(2);
  });

  it('sendCodexMessage calls codexProvider.sendTurnMessage with the conversation thread id', async () => {
    vi.mocked(conversationsDb.getById).mockReturnValue({
      id: 11,
      task_id: 1,
      claude_conversation_id: SID,
      provider: 'openai',
      provider_session_id: SID,
      session_path: '/repo',
      context_usage_json: null,
      name: null,
      model: 'gpt-5.5',
      effort: null,
      created_at: '',
    } as never);

    const events: UnifiedMessage[] = [
      {
        type: 'assistant',
        id: 'msg-resume',
        provider: 'openai',
        providerSessionId: SID,
        raw: null,
        text: 'resumed',
        isSubAgent: false,
      },
      {
        type: 'result',
        id: 'r',
        provider: 'openai',
        providerSessionId: SID,
        raw: null,
        isError: false,
      },
    ];

    const fakeRun = buildFakeRun(events);
    const sendSpy = vi.fn(async () => ({
      providerSessionId$: fakeRun.providerSessionId$,
      abort: fakeRun.abort,
      pid: null,
      events: fakeRun.events(),
    }));
    (codexProvider as unknown as { sendTurnMessage: typeof sendSpy }).sendTurnMessage = sendSpy;

    await sendCodexMessage(11, 'follow-up', {
      userId: 1,
      provider: 'openai',
      model: 'gpt-5.5',
      broadcastFn,
    });
    await waitForBroadcast(broadcastFn, 'claude-complete');

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const firstCallArgs = sendSpy.mock.calls[0] as unknown as unknown[];
    expect(firstCallArgs[0]).toMatchObject({
      cwd: '/repo',
      prompt: 'follow-up',
      resumeSessionId: SID,
    });
  });

  it("requests CODEX_HOME-shaped env from the OpenAI credential store, not Claude's", async () => {
    const fakeRun = buildFakeRun([
      {
        type: 'result',
        id: 'r',
        provider: 'openai',
        providerSessionId: SID,
        raw: null,
        isError: false,
      },
    ]);
    vi.mocked(codexProvider.startTurn).mockResolvedValueOnce({
      providerSessionId$: fakeRun.providerSessionId$,
      abort: fakeRun.abort,
      pid: null,
      events: fakeRun.events(),
    });

    await startCodexConversation(1, 'hi', {
      userId: 1,
      provider: 'openai',
      model: 'gpt-5.5',
      broadcastFn,
    });

    const callArg = vi.mocked(codexProvider.startTurn).mock.calls[0]![0];
    expect(callArg.env).toEqual({ CODEX_HOME: '/fake', HOME: '/h', PATH: '/p' });
  });
});
