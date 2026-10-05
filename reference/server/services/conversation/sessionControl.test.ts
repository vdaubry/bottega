import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./media.js', () => ({
  cleanupTempFiles: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../projectService.js', () => ({
  hasProjectAccess: vi.fn((projectId: number, userId: number | undefined) => {
    // Admin (userId === 999) sees everything; member-of-1 (userId === 1)
    // sees project 1 only; nobody else sees anything. Keep this tight so the
    // filtering behaviour is the assertion.
    if (userId === 999) return true;
    if (userId === 1 && projectId === 1) return true;
    return false;
  }),
}));

vi.mock('../../database/conversations.js', () => ({
  conversationsDb: { findByClaudeSessionId: vi.fn(), getById: vi.fn() },
}));

// Owner questions (linked-run pre-fail, project resolution) go through the
// owner-adapter registry; the fake task adapter delegates to shared spies.
const { interruptLinkedRunMock, resolveOwnerMock } = vi.hoisted(() => ({
  interruptLinkedRunMock: vi.fn(),
  resolveOwnerMock: vi.fn(),
}));
vi.mock('./ownerAdapters.js', () => ({
  ownerAdapterFor: vi.fn(() => ({
    interruptLinkedRun: interruptLinkedRunMock,
    resolveOwner: resolveOwnerMock,
  })),
}));

// The Stop path now resolves the conversation's provider and dispatches to
// its `abortTurn` for the server-side abort (OpenCode's turn runs in an
// out-of-process `opencode serve`). Mock the registry so we can assert which
// provider was asked to abort, and so the real provider modules aren't loaded.
const { abortTurnMock } = vi.hoisted(() => ({ abortTurnMock: vi.fn() }));
vi.mock('../providers/registry.js', () => ({
  getProvider: vi.fn(() => ({ abortTurn: abortTurnMock })),
}));

import {
  abortSession,
  isSessionActive,
  getActiveSessions,
  getActiveStreamingByConversation,
  getAllActiveStreamingSessions,
  getOngoingAtlasGenerationConversationId,
  clearStreamingSessionsForTask
} from './sessionControl.js';
import {
  activeSessions,
  activeStreamingSessions,
} from './sessionState.js';
import { cleanupTempFiles } from './media.js';
import { conversationsDb } from '../../database/conversations.js';
import { getProvider } from '../providers/registry.js';

beforeEach(() => {
  activeSessions.clear();
  activeStreamingSessions.clear();
  vi.clearAllMocks();
  // Default: the conversation resolves to an Anthropic row. Individual tests
  // override `getById` to exercise other providers.
  vi.mocked(conversationsDb.getById).mockReturnValue({ provider: 'anthropic' } as never);
});

describe('abortSession', () => {
  it('returns false when the session id is not tracked', async () => {
    const result = await abortSession('unknown-session');
    expect(result).toBe(false);
  });

  it('aborts and keeps the busy guard until the old completion hook finishes', async () => {
    const abortController = { abort: vi.fn() } as unknown as AbortController;
    activeSessions.set('s1', {
      instance: {},
      abortController,
      startTime: Date.now(),
      status: 'active',
      tempImagePaths: ['/tmp/foo.png'],
      tempDir: '/tmp/dir',
      conversationId: 42,
      taskId: 7,
      epicId: null,
      projectId: 1,
      userId: 1,
    });
    activeStreamingSessions.set('s1', { taskId: 7, conversationId: 42 });
    interruptLinkedRunMock.mockReturnValue(null);

    const result = await abortSession('s1');

    expect(result).toBe(true);
    expect(abortController.abort).toHaveBeenCalledOnce();
    expect(activeSessions.has('s1')).toBe(false);
    expect(activeStreamingSessions.has('s1')).toBe(true);
    expect(cleanupTempFiles).toHaveBeenCalledWith(['/tmp/foo.png'], '/tmp/dir');
  });

  it('records the owner interruption BEFORE the abort fires', async () => {
    let agentMarkedAtAbortTime = false;
    interruptLinkedRunMock.mockImplementation(() => {
      return { id: 99, agent_type: 'review', status: 'running', conversation_id: 42 };
    });
    const abortController = {
      abort: vi.fn(() => {
        agentMarkedAtAbortTime = interruptLinkedRunMock.mock.calls.length > 0;
      }),
    };
    activeSessions.set('s2', {
      abortController: abortController as unknown as AbortController,
      status: 'active',
      conversationId: 42,
    } as never);
    vi.mocked(conversationsDb.getById).mockReturnValue({
      id: 42,
      owner_kind: 'task',
      provider: 'anthropic',
    } as never);

    await abortSession('s2');

    expect(agentMarkedAtAbortTime).toBe(true);
    expect(interruptLinkedRunMock).toHaveBeenCalledWith(42);
  });

  it('leaves a run untouched when its owner reports no interruption', async () => {
    // A manual chat (no agent_run) or an already-completed run must not be
    // overwritten by an abort.
    activeSessions.set('s3', {
      abortController: { abort: vi.fn() } as unknown as AbortController,
      status: 'active',
      conversationId: 42,
    } as never);
    // The adapter decides whether the linked run is interruptible. A manual
    // chat or already-completed run reports no state change.
    interruptLinkedRunMock.mockReturnValue(null);
    vi.mocked(conversationsDb.getById).mockReturnValue({
      id: 42,
      owner_kind: 'task',
      provider: 'anthropic',
    } as never);

    await abortSession('s3');

    expect(interruptLinkedRunMock).toHaveBeenCalledWith(42);
  });

  it('dispatches a server-side abort to the conversation provider (opencode)', async () => {
    // The crux of the fix: for OpenCode the running turn lives out-of-process
    // in `opencode serve`. Flipping the local controller only cancels
    // Bottega's SSE subscription; the server-side turn keeps editing the
    // worktree. abortSession must resolve the conversation's provider and
    // call its abortTurn (which issues `client.session.abort()`).
    const abortController = { abort: vi.fn() } as unknown as AbortController;
    activeSessions.set('oc-session-1', {
      abortController,
      status: 'active',
      conversationId: 77,
      tempImagePaths: [],
      tempDir: null,
    } as never);
    vi.mocked(conversationsDb.getById).mockReturnValue({ provider: 'opencode' } as never);
    interruptLinkedRunMock.mockReturnValue(null);

    const result = await abortSession('oc-session-1');

    expect(result).toBe(true);
    // The conversation row drove the provider lookup…
    expect(conversationsDb.getById).toHaveBeenCalledWith(77);
    expect(getProvider).toHaveBeenCalledWith('opencode');
    // …and the provider session id (== the activeSessions key) was passed
    // straight to abortTurn so the server-side turn is cancelled.
    expect(abortTurnMock).toHaveBeenCalledWith('oc-session-1');
    // The local controller is still flipped (stops Bottega's SSE listener).
    expect(abortController.abort).toHaveBeenCalledOnce();
  });

  it('defaults the provider to anthropic when the conversation row is missing', async () => {
    activeSessions.set('s4', {
      abortController: { abort: vi.fn() } as unknown as AbortController,
      status: 'active',
      conversationId: 42,
      tempImagePaths: [],
      tempDir: null,
    } as never);
    vi.mocked(conversationsDb.getById).mockReturnValue(undefined);
    interruptLinkedRunMock.mockReturnValue(null);

    await abortSession('s4');

    expect(getProvider).toHaveBeenCalledWith('anthropic');
    expect(abortTurnMock).toHaveBeenCalledWith('s4');
  });

  it('completes local cleanup even if provider.abortTurn throws', async () => {
    // A best-effort server-side abort must never block tearing down the
    // local session state (controller flip, temp-file cleanup, map removal).
    const abortController = { abort: vi.fn() } as unknown as AbortController;
    activeSessions.set('s5', {
      abortController,
      status: 'active',
      conversationId: 42,
      tempImagePaths: ['/tmp/x.png'],
      tempDir: '/tmp/d',
    } as never);
    activeStreamingSessions.set('s5', { taskId: 7, conversationId: 42 });
    vi.mocked(conversationsDb.getById).mockReturnValue({ provider: 'opencode' } as never);
    interruptLinkedRunMock.mockReturnValue(null);
    abortTurnMock.mockImplementationOnce(() => {
      throw new Error('server unreachable');
    });

    const result = await abortSession('s5');

    expect(result).toBe(true);
    expect(abortController.abort).toHaveBeenCalledOnce();
    expect(cleanupTempFiles).toHaveBeenCalledWith(['/tmp/x.png'], '/tmp/d');
    expect(activeSessions.has('s5')).toBe(false);
    expect(activeStreamingSessions.has('s5')).toBe(true);
  });
});

describe('isSessionActive', () => {
  it('returns true only when status === "active"', () => {
    activeSessions.set('a', { status: 'active' } as never);
    activeSessions.set('b', { status: 'aborted' } as never);

    expect(isSessionActive('a')).toBe(true);
    expect(isSessionActive('b')).toBe(false);
    expect(isSessionActive('missing')).toBeFalsy();
  });
});

describe('getActiveSessions', () => {
  it('returns all session ids', () => {
    activeSessions.set('s1', { status: 'active' } as never);
    activeSessions.set('s2', { status: 'aborted' } as never);
    expect(getActiveSessions()).toEqual(['s1', 's2']);
  });
});

describe('getActiveStreamingByConversation', () => {
  it('returns the entry matching the conversation id, including the session id', () => {
    activeStreamingSessions.set('s1', { taskId: 1, conversationId: 100 });
    activeStreamingSessions.set('s2', { taskId: 2, conversationId: 200 });
    expect(getActiveStreamingByConversation(200)).toEqual({
      sessionId: 's2',
      taskId: 2,
      conversationId: 200
    });
  });

  it('returns null when no entry matches', () => {
    activeStreamingSessions.set('s1', { taskId: 1, conversationId: 100 });
    expect(getActiveStreamingByConversation(999)).toBe(null);
  });
});

describe('getOngoingAtlasGenerationConversationId', () => {
  it('returns the conversation id of a streaming atlas generation for the task', () => {
    activeStreamingSessions.set('s1', { taskId: 7, conversationId: 100 });
    vi.mocked(conversationsDb.getById).mockReturnValue({ atlas_enabled: 1 } as never);
    expect(getOngoingAtlasGenerationConversationId(7)).toBe(100);
  });

  it('ignores streaming conversations for other tasks', () => {
    activeStreamingSessions.set('s1', { taskId: 9, conversationId: 100 });
    vi.mocked(conversationsDb.getById).mockReturnValue({ atlas_enabled: 1 } as never);
    expect(getOngoingAtlasGenerationConversationId(7)).toBe(null);
  });

  it('ignores non-atlas streaming conversations (e.g. a normal coding turn)', () => {
    activeStreamingSessions.set('s1', { taskId: 7, conversationId: 100 });
    vi.mocked(conversationsDb.getById).mockReturnValue({ atlas_enabled: 0 } as never);
    expect(getOngoingAtlasGenerationConversationId(7)).toBe(null);
  });

  it('returns null when nothing is streaming for the task', () => {
    expect(getOngoingAtlasGenerationConversationId(7)).toBe(null);
  });
});

describe('getAllActiveStreamingSessions', () => {
  function seedSession(
    sessionId: string,
    taskId: number,
    conversationId: number,
    projectId: number,
  ): void {
    activeStreamingSessions.set(sessionId, { taskId, conversationId });
    activeSessions.set(sessionId, {
      status: 'active',
      projectId,
      taskId,
      conversationId,
      userId: 1,
    } as never);
  }

  it('returns only sessions in projects the user can access', () => {
    seedSession('s1', 1, 100, 1); // accessible to userId=1
    seedSession('s2', 2, 200, 2); // NOT accessible to userId=1
    expect(getAllActiveStreamingSessions(1)).toEqual([
      { sessionId: 's1', taskId: 1, conversationId: 100 },
    ]);
  });

  it('admins see every session', () => {
    seedSession('s1', 1, 100, 1);
    seedSession('s2', 2, 200, 2);
    expect(getAllActiveStreamingSessions(999)).toEqual([
      { sessionId: 's1', taskId: 1, conversationId: 100 },
      { sessionId: 's2', taskId: 2, conversationId: 200 },
    ]);
  });

  it('drops sessions with no resolvable project (no leak)', () => {
    activeStreamingSessions.set('orphan', { taskId: 5, conversationId: 500 });
    expect(getAllActiveStreamingSessions(999)).toEqual([]);
  });

  it('returns [] when nothing is streaming', () => {
    expect(getAllActiveStreamingSessions(undefined)).toEqual([]);
  });
});

describe('clearStreamingSessionsForTask', () => {
  it('deletes and returns only the entries for the given task', () => {
    activeStreamingSessions.set('s1', { taskId: 42, conversationId: 100 });
    activeStreamingSessions.set('s2', { taskId: 42, conversationId: 101 });
    activeStreamingSessions.set('s3', { taskId: 99, conversationId: 200 });

    const cleared = clearStreamingSessionsForTask(42);

    expect(cleared).toEqual([
      { sessionId: 's1', conversationId: 100 },
      { sessionId: 's2', conversationId: 101 },
    ]);
    // The task-42 entries are gone…
    expect(activeStreamingSessions.has('s1')).toBe(false);
    expect(activeStreamingSessions.has('s2')).toBe(false);
    // …and the task-99 entry is left untouched.
    expect(activeStreamingSessions.has('s3')).toBe(true);
    expect(activeStreamingSessions.get('s3')).toEqual({
      taskId: 99,
      conversationId: 200,
    });
  });

  it('returns [] and changes nothing when no session matches', () => {
    activeStreamingSessions.set('s3', { taskId: 99, conversationId: 200 });

    const cleared = clearStreamingSessionsForTask(42);

    expect(cleared).toEqual([]);
    expect(activeStreamingSessions.has('s3')).toBe(true);
  });
});
