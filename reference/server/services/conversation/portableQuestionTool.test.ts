import { beforeEach, describe, expect, it, vi } from 'vitest';

const { append, onQuestionParked, pendingForConversation, row } = vi.hoisted(() => ({
  append: vi.fn().mockResolvedValue(undefined),
  onQuestionParked: vi.fn().mockResolvedValue(undefined),
  pendingForConversation: vi.fn(),
  row: {
    id: 'question-1',
    conversation_id: 42,
    provider_tool_use_id: 'portable-question:question-1',
    questions_json: '[]',
    answers_json: null,
    status: 'pending' as const,
    created_at: '2026-08-24T00:00:00.000Z',
    answered_at: null,
    resolved_at: null,
  },
}));

vi.mock('../../database/conversations.js', () => ({
  conversationsDb: {
    getById: vi.fn(() => ({
      id: 42,
      provider: 'openai',
      provider_session_id: 'thread-42',
      claude_conversation_id: 'thread-42',
      session_path: '/repo',
    })),
  },
}));
vi.mock('../../database/conversationQuestions.js', () => ({
  conversationQuestionsDb: { createOrGet: vi.fn(() => row), pendingForConversation },
}));
vi.mock('../../database/db.js', () => ({
  projectsDb: { getByIdAdmin: vi.fn() },
}));
vi.mock('../conversationContentStore.js', () => ({
  resolveProjectKey: vi.fn(() => 'repo-key'),
}));
vi.mock('../sqliteSessionStore.js', () => ({
  sqliteSessionStore: { append },
}));
vi.mock('./ownerAdapters.js', () => ({
  ownerAdapterFor: vi.fn(() => ({
    resolveOwner: vi.fn(),
    onQuestionParked,
  })),
}));

import {
  emitPortableQuestionResult,
  parkPortableQuestion,
} from './portableQuestionTool.js';
import { activeSessions, deferredQuestionConversations } from './sessionState.js';

function registerActiveTurn(conversationId: number): AbortController {
  const abortController = new AbortController();
  activeSessions.set(`session-${conversationId}`, {
    instance: {},
    abortController,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths: [],
    tempDir: null,
    conversationId,
    taskId: null,
    epicId: null,
    projectId: 1,
    userId: 1,
  } as never);
  return abortController;
}

describe('portable question transcript', () => {
  beforeEach(() => {
    append.mockClear();
    onQuestionParked.mockClear();
    pendingForConversation.mockReset();
    deferredQuestionConversations.clear();
    activeSessions.clear();
  });

  // Regression: createOrGet cancels a stale pending round when a different
  // question arrives (see conversationQuestions.test.ts). The chat must stop
  // offering to answer the superseded card, so it gets a dismissed result.
  it('closes the superseded card when a stale pending round is cancelled by a new question', async () => {
    const broadcast = vi.fn();
    const stale = {
      ...row,
      id: 'question-0',
      provider_tool_use_id: 'portable-question:question-0',
      questions_json: JSON.stringify([{ question: 'Deadline?', header: 'Deadline' }]),
    };
    pendingForConversation.mockReturnValue(stale);
    registerActiveTurn(42);

    await parkPortableQuestion(42, [{ question: 'Which tier?', header: 'Tier' }], broadcast);

    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'thread-42' }),
      [expect.objectContaining({
        uuid: 'portable-question:question-0:result',
        type: 'user',
        message: expect.objectContaining({
          content: [expect.objectContaining({
            type: 'tool_result',
            tool_use_id: 'portable-question:question-0',
            content: expect.stringMatching(/^User dismissed/),
          })],
        }),
      })],
    );
    // The new round still gets its own card and its own awaiting broadcast.
    expect(append).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ uuid: 'portable-question:question-1:use' })],
    );
    expect(broadcast).toHaveBeenCalledWith(42, expect.objectContaining({
      type: 'awaiting-user-answer',
      questionId: 'question-1',
    }));
  });

  it('leaves the transcript alone when the park reuses the same pending round', async () => {
    pendingForConversation.mockReturnValue(row);
    registerActiveTurn(42);

    await parkPortableQuestion(42, [{ question: 'Which tier?', header: 'Tier' }], vi.fn());

    const results = append.mock.calls.filter(([, entries]) =>
      (entries as Array<{ uuid: string }>).some((entry) => entry.uuid.endsWith(':result')),
    );
    expect(results).toHaveLength(0);
  });

  it('materializes a durable question card and matching answer for remote harnesses', async () => {
    const broadcast = vi.fn();
    const questions = [{ question: 'Which tier?', header: 'Tier' }];
    registerActiveTurn(42);

    await parkPortableQuestion(42, questions, broadcast);

    expect(append).toHaveBeenCalledWith(
      {
        projectKey: 'repo-key',
        sessionId: 'thread-42',
        subpath: '',
        provider: 'openai',
      },
      [expect.objectContaining({
        uuid: 'portable-question:question-1:use',
        type: 'assistant',
        message: expect.objectContaining({
          content: [{
            type: 'tool_use',
            id: 'portable-question:question-1',
            name: 'ask_user',
            input: { questions },
          }],
        }),
      })],
    );
    expect(broadcast).toHaveBeenCalledWith(42, expect.objectContaining({
      type: 'awaiting-user-answer',
      toolUseId: 'portable-question:question-1',
      questions,
    }));
    expect(deferredQuestionConversations.has(42)).toBe(true);

    await emitPortableQuestionResult(42, row, 'User has answered your questions.', broadcast);

    expect(append).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'thread-42', provider: 'openai' }),
      [expect.objectContaining({
        uuid: 'portable-question:question-1:result',
        type: 'user',
        message: expect.objectContaining({
          content: [{
            type: 'tool_result',
            tool_use_id: 'portable-question:question-1',
            content: 'User has answered your questions.',
          }],
        }),
      })],
    );
    expect(onQuestionParked).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }), questions);
  });

  it('aborts the live turn and marks it deferred when a turn is streaming', async () => {
    const abortController = registerActiveTurn(42);

    await parkPortableQuestion(42, [{ question: 'Which tier?', header: 'Tier' }], vi.fn());

    expect(abortController.signal.aborted).toBe(true);
    expect(deferredQuestionConversations.has(42)).toBe(true);
  });

  // Regression: the marker used to be set before the active-session lookup, so
  // a park that raced turn teardown left it set with no turn to consume it —
  // the NEXT turn on that conversation then took the deferred early-return and
  // never completed its agent run.
  it('does not mark a conversation deferred when no turn is active to consume it', async () => {
    await parkPortableQuestion(42, [{ question: 'Which tier?', header: 'Tier' }], vi.fn());

    expect(deferredQuestionConversations.has(42)).toBe(false);
  });
});
