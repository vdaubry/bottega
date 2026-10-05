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
  taskAgentRunsDb: {
    getByConversationId: vi.fn(),
    getByTask: vi.fn(() => []),
    updateStatus: vi.fn(),
  },
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

vi.mock('../conversationImages.js', () => ({
  storeConversationImage: vi.fn(async () => {}),
}));

vi.mock('./slashCommands.js', () => ({
  resolveSlashCommand: vi.fn(async (m: string | null) => m),
}));

import { tasksDb } from '../../database/db.js';
import { conversationsDb } from '../../database/conversations.js';
import { taskAgentRunsDb } from '../../database/tasks.js';
// The completion/fail paths dispatch through the owner-adapter registry.
// Only the task adapter is registered: these are task-only provider flows,
// and the epic adapter's import graph would drag the whole epic layer in.
import { initTasks } from '../tasks/adapter.js';
initTasks();
import { codexProvider } from '../providers/openai/index.js';
import { storeConversationImage } from '../conversationImages.js';
import { startCodexConversation, sendCodexMessage } from './startCodexConversation.js';
import { activeStreamingSessions } from './sessionState.js';

// The completion handler looks the linked run up by CONVERSATION id (task runs
// and epic runs share one table), while several assertions here still describe
// the task's runs. This helper keeps both accessors in sync from one list.
function setLinkedRuns(runs: unknown): void {
  vi.mocked(taskAgentRunsDb.getByTask).mockReturnValue(runs as never);
  vi.mocked(taskAgentRunsDb.getByConversationId).mockImplementation(((
    conversationId: number,
  ) =>
    (runs as Array<{ conversation_id: number | null }>).find(
      (r) => r.conversation_id === conversationId,
    )) as never);
}


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
    // Re-establish taskAgentRunsDb defaults each test so a prior test's
    // per-test override (mockReturnValue / mockImplementation, which
    // vi.clearAllMocks does NOT reset) can't leak forward.
    setLinkedRuns([]);
    vi.mocked(taskAgentRunsDb.updateStatus).mockReset();
    // The owner-adapter dispatch (fail-linked-run, completion) resolves the
    // conversation row first; default to the task-owned row this suite drives.
    vi.mocked(conversationsDb.getById).mockReturnValue({
      id: 11,
      owner_kind: 'task',
      task_id: 1,
      epic_id: null,
    } as never);
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
      provider: 'openai',
      provider_session_id: null,
      model: 'gpt-6.1-sol',
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
      model: 'gpt-6.1-sol',
      broadcastFn,
    });
    expect(out.conversationId).toBe(11);
    expect(out.claudeSessionId).toBe(SID);
    expect(conversationsDb.create).toHaveBeenCalledWith(1, 'openai', 'gpt-6.1-sol', null);
    expect(conversationsDb.updateClaudeId).toHaveBeenCalledWith(11, SID);
    expect(conversationsDb.updateProviderSessionId).toHaveBeenCalledWith(11, SID);
  });

  it('marks the linked agent run failed on a terminal result error (stops the runaway chain)', async () => {
    // A running review agent run linked to the conversation we're about to
    // drive. This is the task-1267 scenario: Codex returns "you've hit your
    // usage limit" as an in-band result event with isError:true.
    const run = {
      id: 99,
      task_id: 1,
      epic_id: null,
      agent_type: 'review',
      status: 'running',
      conversation_id: 11,
      provider: 'openai',
      created_at: '',
      completed_at: null,
    };
    setLinkedRuns([run] as never);
    // Mutate on updateStatus so the post-stream completion handler reads the
    // freshly-failed status and takes its no-chain branch — matching real DB
    // semantics, where the failed write is durable before chaining is decided.
    vi.mocked(taskAgentRunsDb.updateStatus).mockImplementation(((id: number, status: string) => {
      if (id === run.id) run.status = status;
      return run;
    }) as never);

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
        type: 'result',
        id: 'result',
        provider: 'openai',
        providerSessionId: SID,
        raw: null,
        isError: true,
        errors: [{ message: "You've hit your usage limit." }],
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
      model: 'gpt-6.1-sol',
      broadcastFn,
    });
    // streaming-ended fires from inside the post-stream completion handler,
    // so once we see it the chaining decision has already been made.
    await waitForBroadcast(broadcastFn, 'streaming-ended');

    // The run was pre-marked failed off the isError result...
    expect(taskAgentRunsDb.updateStatus).toHaveBeenCalledWith(99, 'failed');
    // ...and never marked completed, so the implementation↔review loop stops.
    expect(taskAgentRunsDb.updateStatus).not.toHaveBeenCalledWith(99, 'completed');
  });

  it('surfaces the terminal error as a synthetic assistant message so the failure reason is visible', async () => {
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
        type: 'result',
        id: 'turn_failed:1',
        provider: 'openai',
        providerSessionId: SID,
        raw: null,
        isError: true,
        errors: [{ message: "You've hit your usage limit." }],
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
      model: 'gpt-6.1-sol',
      broadcastFn,
    });
    await waitForBroadcast(broadcastFn, 'streaming-ended');

    // A synthetic assistant message carrying the error text was broadcast, so
    // the chat UI renders the failure reason (not just an empty failed turn).
    const synthetic = broadcastFn.mock.calls.find((call) => {
      const msg = call[1] as {
        type?: string;
        data?: { type?: string; message?: { content?: Array<{ text?: string }> } };
      };
      return (
        msg.type === 'ai-response' &&
        msg.data?.type === 'assistant' &&
        (msg.data.message?.content?.[0]?.text ?? '').includes('usage limit')
      );
    });
    expect(synthetic).toBeTruthy();
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
      model: 'gpt-6.1-sol',
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

  describe('generated images', () => {
    const imageEvents: UnifiedMessage[] = [
      {
        type: 'system',
        id: 'thread_started',
        provider: 'openai',
        providerSessionId: SID,
        raw: null,
        subtype: 'thread_started',
      },
      {
        type: 'assistant_image',
        id: 'generated_image:exec-1.png',
        provider: 'openai',
        providerSessionId: SID,
        raw: null,
        sourcePath: '/fake/generated_images/thread-id-zzz/exec-1.png',
        fileName: 'exec-1.png',
        mimeType: 'image/png',
        width: 1536,
        height: 1024,
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

    async function runImageTurn(): Promise<Array<{ data?: { message?: { content?: unknown[] } } }>> {
      const fakeRun = buildFakeRun(imageEvents);
      vi.mocked(codexProvider.startTurn).mockResolvedValueOnce({
        providerSessionId$: fakeRun.providerSessionId$,
        abort: fakeRun.abort,
        pid: null,
        events: fakeRun.events(),
      });
      await startCodexConversation(1, 'draw', {
        userId: 1,
        provider: 'openai',
        model: 'gpt-6.1-sol',
        broadcastFn,
      });
      await waitForBroadcast(broadcastFn, 'claude-complete');
      return broadcastFn.mock.calls
        .map((call) => call[1])
        .filter((msg) => msg.type === 'ai-response');
    }

    it('copies the image into the conversation store, then broadcasts a block naming the file', async () => {
      const ai = await runImageTurn();

      expect(storeConversationImage).toHaveBeenCalledWith(
        11,
        '/fake/generated_images/thread-id-zzz/exec-1.png',
        'exec-1.png',
      );
      const image = ai.find((msg) => JSON.stringify(msg).includes('generated_image'));
      expect(image?.data).toMatchObject({
        type: 'assistant',
        uuid: 'generated_image:exec-1.png',
        message: {
          content: [
            {
              type: 'generated_image',
              file_name: 'exec-1.png',
              media_type: 'image/png',
              width: 1536,
              height: 1024,
            },
          ],
        },
      });
      // The per-user Codex path stays on the server.
      expect(JSON.stringify(image)).not.toContain('/fake/');
    });

    it('drops the image when it cannot be stored, instead of pointing the chat at a missing file', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(storeConversationImage).mockRejectedValueOnce(new Error('ENOSPC'));

      const ai = await runImageTurn();

      expect(ai.some((msg) => JSON.stringify(msg).includes('generated_image'))).toBe(false);
      warn.mockRestore();
    });
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
      model: 'gpt-6.1-sol',
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
      model: 'gpt-6.1-sol',
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
      provider: 'openai',
      provider_session_id: SID,
      session_path: '/repo',
      context_usage_json: null,
      name: null,
      model: 'gpt-6.1-sol',
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
          provider: 'openai',
          providerSessionId: SID,
          raw: null,
          isError: false,
        };
      })(),
    }));
    (codexProvider as unknown as { sendTurnMessage: typeof sendSpy }).sendTurnMessage = sendSpy;

    const turn = sendCodexMessage(11, 'User has answered your questions: "Tier?"="Pro".', {
      userId: 1,
      provider: 'openai',
      model: 'gpt-6.1-sol',
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
      model: 'gpt-6.1-sol',
      broadcastFn,
    });

    const callArg = vi.mocked(codexProvider.startTurn).mock.calls[0]![0];
    expect(callArg.env).toEqual({ CODEX_HOME: '/fake', HOME: '/h', PATH: '/p' });
  });
});
