import { describe, it, expect, beforeEach, vi } from 'vitest';

// askUserQuestion.js transitively imports the DB, the SDK session store, and
// startConversation (which pulls in the whole Claude Agent SDK). None of that
// is needed to exercise buildCanUseTool's synchronous branches, so stub the
// heavy dependencies to keep this a fast, isolated unit test.
vi.mock('../../database/db.js', () => ({
  conversationsDb: { getById: vi.fn() },
  tasksDb: { getWithProject: vi.fn() },
}));
vi.mock('../conversationContentStore.js', () => ({
  resolveProjectKey: vi.fn(),
}));
vi.mock('../sqliteSessionStore.js', () => ({
  sqliteSessionStore: { load: vi.fn() },
}));
vi.mock('./startConversation.js', () => ({
  sendMessage: vi.fn(),
}));
vi.mock('../../database/conversations.js', () => ({
  conversationsDb: { getById: vi.fn() },
}));
vi.mock('../../database/conversationQuestions.js', () => ({
  conversationQuestionsDb: {
    pendingForConversation: vi.fn(),
    answer: vi.fn(),
    resolve: vi.fn(),
    reopen: vi.fn(),
  },
}));
vi.mock('./portableQuestionTool.js', () => ({
  emitPortableQuestionResult: vi.fn(),
  parkPortableQuestion: vi.fn(),
}));

import {
  buildCanUseTool,
  resolveAskUserQuestion,
  waitForConversationTurnToQuiesce,
} from './askUserQuestion.js';
import { conversationsDb } from '../../database/conversations.js';
import { conversationQuestionsDb } from '../../database/conversationQuestions.js';
import { sendMessage } from './startConversation.js';
import {
  activeSessions,
  activeStreamingSessions,
  pendingAskUserQuestions,
} from './sessionState.js';

beforeEach(() => {
  pendingAskUserQuestions.clear();
  activeSessions.clear();
  activeStreamingSessions.clear();
  vi.clearAllMocks();
});

describe('portable question continuation handoff', () => {
  it('waits until both provider and streaming lifecycle state are quiescent', async () => {
    activeSessions.set('session-42', {
      instance: {},
      abortController: new AbortController(),
      startTime: Date.now(),
      status: 'active',
      tempImagePaths: [],
      tempDir: null,
      conversationId: 42,
      taskId: null,
      epicId: 9,
      projectId: 7,
      userId: 1,
    });
    activeStreamingSessions.set('session-42', { conversationId: 42, epicId: 9 });

    let settled = false;
    const waiting = waitForConversationTurnToQuiesce(42, 500).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    activeSessions.delete('session-42');
    activeStreamingSessions.delete('session-42');
    await waiting;
    expect(settled).toBe(true);
  });
});

describe('buildCanUseTool background/monitor normalization', () => {
  it('forces Bash run_in_background to false while preserving other input fields', async () => {
    const canUseTool = buildCanUseTool();
    const result = await canUseTool(
      'Bash',
      { command: 'bundle exec rspec', run_in_background: true, timeout: 600000 },
      {},
    );

    expect(result.behavior).toBe('allow');
    expect(result.updatedInput).toEqual({
      command: 'bundle exec rspec',
      run_in_background: false,
      timeout: 600000,
    });
  });

  it('passes a plain foreground Bash call through unchanged', async () => {
    const canUseTool = buildCanUseTool();
    const input = { command: 'ls -la' };
    const result = await canUseTool('Bash', input, {});

    expect(result.behavior).toBe('allow');
    expect(result.updatedInput).toEqual({ command: 'ls -la' });
  });

  it('denies the Monitor tool with actionable foreground guidance', async () => {
    const canUseTool = buildCanUseTool();
    const result = await canUseTool('Monitor', { until: 'file exists' }, {});

    expect(result.behavior).toBe('deny');
    expect(result.message).toMatch(/do not persist between turns/i);
    expect(result.message).toMatch(/foreground/i);
    expect(result.updatedInput).toBeUndefined();
  });

  it('passes an arbitrary other tool through unchanged', async () => {
    const canUseTool = buildCanUseTool();
    const input = { file_path: '/tmp/x' };
    const result = await canUseTool('Read', input, {});

    expect(result.behavior).toBe('allow');
    expect(result.updatedInput).toBe(input);
  });
});

describe('buildCanUseTool AskUserQuestion behavior is unchanged', () => {
  it('rejects AskUserQuestion when no conversationId is provided', async () => {
    const canUseTool = buildCanUseTool();
    const result = await canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'Which?' }] },
      {},
    );

    expect(result.behavior).toBe('deny');
    expect(result.message).toMatch(/not supported in this context/i);
  });

  it('parks on a pending promise and broadcasts when a conversationId is present', async () => {
    const broadcastFn = vi.fn();
    const canUseTool = buildCanUseTool({ conversationId: 42, broadcastFn });
    const questions = [{ question: 'Which?', header: 'Q1' }];

    // The callback never resolves on its own — it parks until answered. Race it
    // against a microtask to assert it stays pending while registering state.
    const pending = canUseTool('AskUserQuestion', { questions }, { toolUseID: 'tu-1' });
    const race = await Promise.race([
      pending.then(() => 'resolved'),
      Promise.resolve('still-pending'),
    ]);

    expect(race).toBe('still-pending');
    expect(pendingAskUserQuestions.get(42)).toBeDefined();
    expect(broadcastFn).toHaveBeenCalledWith(42, {
      type: 'awaiting-user-answer',
      conversationId: 42,
      toolUseId: 'tu-1',
      questions,
    });

    // Resolve the parked promise so the test doesn't leak a dangling handler.
    pendingAskUserQuestions.get(42)!.resolve({ behavior: 'allow' });
    await pending;
  });
});

describe('durable ask_user answer delivery', () => {
  const durableRow = {
    id: 'q-1',
    conversation_id: 5,
    provider_tool_use_id: 'toolu_real_id',
    questions_json: '[]',
    answers_json: null,
    status: 'pending',
    created_at: '',
    answered_at: null,
    resolved_at: null,
  };

  beforeEach(() => {
    // `vi.clearAllMocks` keeps implementations; the turn shapes below must not
    // leak from one case into the next.
    vi.mocked(sendMessage).mockReset();
  });

  /** What every resume path does once the owner admitted the turn. */
  function registerContinuationTurn(conversationId: number): void {
    activeStreamingSessions.set(`session-${conversationId}`, { conversationId });
  }

  // Regression: Claude used to receive `message = null` plus a synthetic
  // tool_result. The id never matched a tool_use in the provider's own
  // history, so the CLI's transcript repair dropped the block and the user's
  // answers never reached the model — which then re-asked the same question.
  it.each(['anthropic', 'openai', 'opencode'])(
    'delivers the answers as an ordinary user message on %s',
    async (provider) => {
      vi.mocked(conversationsDb.getById).mockReturnValue({ id: 5, provider } as never);
      vi.mocked(conversationQuestionsDb.pendingForConversation).mockReturnValue(
        durableRow as never,
      );

      const result = await resolveAskUserQuestion(5, { 'Which color?': 'Blue' });

      expect(result.kind).toBe('durable-resolved');
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [conversationId, message, options] = vi.mocked(sendMessage).mock.calls[0]!;
      expect(conversationId).toBe(5);
      expect(String(message)).toContain('Blue');
      expect(options).not.toHaveProperty('askUserQuestionToolResult');
      expect(conversationQuestionsDb.answer).toHaveBeenCalledWith(durableRow.id, {
        'Which color?': 'Blue',
      });
      expect(conversationQuestionsDb.resolve).toHaveBeenCalledWith(durableRow.id);
      expect(conversationQuestionsDb.reopen).not.toHaveBeenCalled();
    },
  );

  // Regression: the row used to be resolved only when the continuation turn's
  // promise settled, minutes later — and in production that settlement never
  // reached this code, so every delivered round stayed `answered` until the
  // next boot sweep reopened it as pending (answers cleared), after which the
  // following ask_user reused the stale row instead of getting its own.
  it('resolves the row as soon as the continuation turn is accepted, without waiting for it to settle', async () => {
    vi.mocked(conversationsDb.getById).mockReturnValue({ id: 5, provider: 'openai' } as never);
    vi.mocked(conversationQuestionsDb.pendingForConversation).mockReturnValue(durableRow as never);
    let finishTurn!: () => void;
    vi.mocked(sendMessage).mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishTurn = resolve;
        registerContinuationTurn(5);
      }),
    );

    const result = await resolveAskUserQuestion(5, { 'Which color?': 'Blue' });

    expect(result.kind).toBe('durable-resolved');
    expect(conversationQuestionsDb.resolve).toHaveBeenCalledWith(durableRow.id);
    expect(conversationQuestionsDb.reopen).not.toHaveBeenCalled();
    finishTurn();
  });

  it('never reopens a round whose continuation turn fails after it was accepted', async () => {
    vi.mocked(conversationsDb.getById).mockReturnValue({ id: 5, provider: 'openai' } as never);
    vi.mocked(conversationQuestionsDb.pendingForConversation).mockReturnValue(durableRow as never);
    const failure = new Error('Codex resume error: AbortError');
    let failTurn!: (error: Error) => void;
    vi.mocked(sendMessage).mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => {
        failTurn = reject;
        registerContinuationTurn(5);
      }),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await resolveAskUserQuestion(5, { 'Which color?': 'Blue' });
    expect(conversationQuestionsDb.resolve).toHaveBeenCalledWith(durableRow.id);

    failTurn(failure);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(conversationQuestionsDb.reopen).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('failed after its answers were delivered'),
      failure,
    );
    consoleError.mockRestore();
  });

  it('reopens the round when the resume is rejected before any turn is accepted', async () => {
    vi.mocked(conversationsDb.getById).mockReturnValue({ id: 5, provider: 'openai' } as never);
    vi.mocked(conversationQuestionsDb.pendingForConversation).mockReturnValue(durableRow as never);
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error('no provider credentials'));

    await expect(resolveAskUserQuestion(5, { 'Which color?': 'Blue' })).rejects.toThrow(
      'no provider credentials',
    );

    expect(conversationQuestionsDb.reopen).toHaveBeenCalledWith(durableRow.id);
    expect(conversationQuestionsDb.resolve).not.toHaveBeenCalled();
  });
});
