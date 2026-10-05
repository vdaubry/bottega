import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedMessage } from '@shared/providers/types';

vi.mock('../../database/conversations.js', () => ({
  conversationsDb: {
    create: vi.fn(),
    getById: vi.fn(),
    updateClaudeId: vi.fn(),
    updateProviderSessionId: vi.fn(),
    updateModelEffort: vi.fn(),
    updateSessionPath: vi.fn(),
  },
}));

vi.mock('../../database/db.js', () => ({
  db: {},
  tasksDb: {
    getWithProject: vi.fn(),
  },
  userDb: {
    getUserById: vi.fn().mockReturnValue({ id: 1, username: 'test', is_technical: 1 }),
  },
}));

vi.mock('../../database/tasks.js', () => ({
  tasksDb: {
    getWithProject: vi.fn(),
    getById: vi.fn(),
    markRefinementComplete: vi.fn(),
    blockWorkflow: vi.fn(),
  },
}));

vi.mock('../agentModelSettings.js', () => ({
  // Resume keeps the row's stored model here (no per-user override).
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
    buildSdkEnv: () => ({
      BOTTEGA_USER_ID: '1',
      XDG_DATA_HOME: '/fake/data',
      XDG_CONFIG_HOME: '/fake/config',
      XDG_STATE_HOME: '/fake/state',
      XDG_CACHE_HOME: '/fake/cache',
      OPENCODE_CONFIG: '/dev/null',
      HOME: '/h',
      PATH: '/p',
    }),
  })),
}));

vi.mock('../providers/opencode/index.js', () => ({
  openCodeProvider: {
    startTurn: vi.fn(),
    sendTurnMessage: vi.fn(),
    abortTurn: vi.fn(() => false),
  },
}));

vi.mock('../providers/opencode/messageMirror.js', () => ({
  mirrorOpenCodeEvent: vi.fn(async () => {}),
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

import { tasksDb } from '../../database/db.js';
import { conversationsDb } from '../../database/conversations.js';
// The completion/fail paths dispatch through the owner-adapter registry.
// Only the task adapter is registered: these are task-only provider flows,
// and the epic adapter's import graph would drag the whole epic layer in.
import { initTasks } from '../tasks/adapter.js';
initTasks();
import { openCodeProvider } from '../providers/opencode/index.js';
import { mirrorOpenCodeEvent } from '../providers/opencode/messageMirror.js';
import {
  startOpenCodeConversation,
  sendOpenCodeMessage,
} from './startOpenCodeConversation.js';
import { activeStreamingSessions } from './sessionState.js';

const SID = 'sess_oc_xyz';

function waitForBroadcast(
  broadcastFn: { mock: { calls: unknown[][] } },
  targetType: string,
  timeoutMs = 1500,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
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

describe('startOpenCodeConversation', () => {
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
      epic_id: null,
      claude_conversation_id: null,
      provider: 'opencode',
      provider_session_id: null,
      model: 'opencode/kimi-k2.7-code',
      effort: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a conversation row with provider='opencode' and stamps the session id once seen", async () => {
    const events: UnifiedMessage[] = [
      {
        type: 'user',
        id: 'user_synth',
        provider: 'opencode',
        providerSessionId: SID,
        raw: null,
        content: 'hi',
      },
      {
        type: 'assistant',
        id: 'msg-1',
        provider: 'opencode',
        providerSessionId: SID,
        raw: null,
        text: 'hello from opencode',
        isSubAgent: false,
      },
      {
        type: 'result',
        id: 'result',
        provider: 'opencode',
        providerSessionId: SID,
        raw: null,
        isError: false,
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ];

    const fakeRun = buildFakeRun(events);
    vi.mocked(openCodeProvider.startTurn).mockResolvedValueOnce({
      providerSessionId$: fakeRun.providerSessionId$,
      abort: fakeRun.abort,
      pid: null,
      events: fakeRun.events(),
    });

    const out = await startOpenCodeConversation(1, 'hi', {
      userId: 1,
      provider: 'opencode',
      model: 'opencode/kimi-k2.7-code',
      broadcastFn,
    });
    expect(out.conversationId).toBe(11);
    expect(out.claudeSessionId).toBe(SID);
    expect(conversationsDb.create).toHaveBeenCalledWith(1, 'opencode', 'opencode/kimi-k2.7-code', null);
    expect(conversationsDb.updateClaudeId).toHaveBeenCalledWith(11, SID);
    expect(conversationsDb.updateProviderSessionId).toHaveBeenCalledWith(11, SID);
  });

  it("broadcasts ai-response per UnifiedMessage with provider='opencode'", async () => {
    const events: UnifiedMessage[] = [
      {
        type: 'assistant',
        id: 'msg-A',
        provider: 'opencode',
        providerSessionId: SID,
        raw: null,
        text: 'hi',
        isSubAgent: false,
      },
      {
        type: 'result',
        id: 'r',
        provider: 'opencode',
        providerSessionId: SID,
        raw: null,
        isError: false,
      },
    ];
    const fakeRun = buildFakeRun(events);
    vi.mocked(openCodeProvider.startTurn).mockResolvedValueOnce({
      providerSessionId$: fakeRun.providerSessionId$,
      abort: fakeRun.abort,
      pid: null,
      events: fakeRun.events(),
    });

    await startOpenCodeConversation(1, 'hi', {
      userId: 1,
      provider: 'opencode',
      model: 'opencode/kimi-k2.7-code',
      broadcastFn,
    });
    await waitForBroadcast(broadcastFn, 'claude-complete');

    const ai = broadcastFn.mock.calls
      .map((call) => call[1])
      .filter((msg) => (msg as { type?: string }).type === 'ai-response');
    expect(ai.length).toBeGreaterThanOrEqual(2);
    for (const msg of ai) {
      expect((msg as { provider?: string }).provider).toBe('opencode');
    }
  });

  it('mirrors each UnifiedMessage to the messages table', async () => {
    const events: UnifiedMessage[] = [
      {
        type: 'assistant',
        id: 'msg-1',
        provider: 'opencode',
        providerSessionId: SID,
        raw: null,
        text: 'hi',
        isSubAgent: false,
      },
      {
        type: 'result',
        id: 'r',
        provider: 'opencode',
        providerSessionId: SID,
        raw: null,
        isError: false,
      },
    ];
    const fakeRun = buildFakeRun(events);
    vi.mocked(openCodeProvider.startTurn).mockResolvedValueOnce({
      providerSessionId$: fakeRun.providerSessionId$,
      abort: fakeRun.abort,
      pid: null,
      events: fakeRun.events(),
    });

    await startOpenCodeConversation(1, 'hi', {
      userId: 1,
      provider: 'opencode',
      model: 'opencode/kimi-k2.7-code',
      broadcastFn,
    });
    await waitForBroadcast(broadcastFn, 'claude-complete');

    expect(mirrorOpenCodeEvent).toHaveBeenCalled();
    const calls = vi.mocked(mirrorOpenCodeEvent).mock.calls;
    for (const call of calls) {
      expect(call[0]).toEqual({
        projectFolderPath: '/repo',
        providerSessionId: SID,
      });
    }
  });

  it('sendOpenCodeMessage calls openCodeProvider.sendTurnMessage with the conversation session id', async () => {
    vi.mocked(conversationsDb.getById).mockReturnValue({
      id: 11,
      task_id: 1,
      claude_conversation_id: SID,
      provider: 'opencode',
      provider_session_id: SID,
      session_path: '/repo',
      context_usage_json: null,
      name: null,
      model: 'opencode/kimi-k2.7-code',
      effort: null,
      created_at: '',
    } as never);

    const events: UnifiedMessage[] = [
      {
        type: 'assistant',
        id: 'msg-resume',
        provider: 'opencode',
        providerSessionId: SID,
        raw: null,
        text: 'resumed',
        isSubAgent: false,
      },
      {
        type: 'result',
        id: 'r',
        provider: 'opencode',
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
    (openCodeProvider as unknown as { sendTurnMessage: typeof sendSpy }).sendTurnMessage = sendSpy;

    await sendOpenCodeMessage(11, 'follow-up', {
      userId: 1,
      provider: 'opencode',
      model: 'opencode/kimi-k2.7-code',
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

  // The durable ask_user answer path resolves its question row the moment the
  // continuation turn is accepted, which it observes through this registration
  // (`waitForContinuationTurnToStart`). It must happen before the stream is
  // consumed, not when the turn ends.
  it('registers the conversation as streaming before the resumed turn ends', async () => {
    vi.mocked(conversationsDb.getById).mockReturnValue({
      id: 11,
      task_id: 1,
      claude_conversation_id: SID,
      provider: 'opencode',
      provider_session_id: SID,
      session_path: '/repo',
      context_usage_json: null,
      name: null,
      model: 'opencode/kimi-k2.7-code',
      effort: null,
      created_at: '',
    } as never);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sendSpy = vi.fn(async () => ({
      providerSessionId$: Promise.resolve(SID),
      abort: vi.fn(),
      pid: null,
      events: (async function* () {
        await gate;
        yield {
          type: 'result',
          id: 'r',
          provider: 'opencode',
          providerSessionId: SID,
          raw: null,
          isError: false,
        };
      })(),
    }));
    (openCodeProvider as unknown as { sendTurnMessage: typeof sendSpy }).sendTurnMessage = sendSpy;

    const turn = sendOpenCodeMessage(11, 'User has answered your questions: "Tier?"="Pro".', {
      userId: 1,
      provider: 'opencode',
      model: 'opencode/kimi-k2.7-code',
      broadcastFn,
    });
    await waitForBroadcast(broadcastFn, 'streaming-started');

    const streaming = () =>
      [...activeStreamingSessions.values()].some((session) => session.conversationId === 11);
    expect(streaming()).toBe(true);

    release();
    await turn;
    expect(streaming()).toBe(false);
  });

  it('requests the OpenCode-shaped env from the opencode credential store (BOTTEGA_USER_ID + XDG_*)', async () => {
    const fakeRun = buildFakeRun([
      {
        type: 'result',
        id: 'r',
        provider: 'opencode',
        providerSessionId: SID,
        raw: null,
        isError: false,
      },
    ]);
    vi.mocked(openCodeProvider.startTurn).mockResolvedValueOnce({
      providerSessionId$: fakeRun.providerSessionId$,
      abort: fakeRun.abort,
      pid: null,
      events: fakeRun.events(),
    });

    await startOpenCodeConversation(1, 'hi', {
      userId: 1,
      provider: 'opencode',
      model: 'opencode/kimi-k2.7-code',
      broadcastFn,
    });

    const callArg = vi.mocked(openCodeProvider.startTurn).mock.calls[0]![0];
    expect(callArg.env).toMatchObject({
      BOTTEGA_USER_ID: '1',
      XDG_DATA_HOME: '/fake/data',
      OPENCODE_CONFIG: '/dev/null',
    });
  });
});
