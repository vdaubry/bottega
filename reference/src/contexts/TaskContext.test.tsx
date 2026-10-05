import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { TaskContextProvider, useTaskContext } from './TaskContext';
import type { ServerMessageOf } from '../../shared/websocket/messages';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `/api/streaming-sessions` is the source of truth the context reconciles
// against. We only need `streamingSessions.getActive`; the rest of `api` is
// touched by other effects (loadProjects on mount) so stub `projects.list`.
const getActiveMock = vi.fn();
const createTaskMock = vi.fn();
const retryWorktreeSetupMock = vi.fn();
vi.mock('../utils/api', () => ({
  api: {
    streamingSessions: { getActive: () => getActiveMock() },
    projects: { list: () => Promise.resolve({ ok: false, json: async () => ({}) }) },
    tasks: {
      create: (...args: unknown[]) => createTaskMock(...args),
      retryWorktreeSetup: (...args: unknown[]) => retryWorktreeSetupMock(...args),
    },
  },
}));

// Controllable WebSocket context. `subscribe` records handlers by type so a
// test can dispatch a `streaming-started` event without a real socket.
type Handler = (msg: unknown) => void;
const subscribedHandlers = new Map<string, Set<Handler>>();
const wsState: { isConnected: boolean } = { isConnected: false };

const subscribeMock = vi.fn((type: string, cb: Handler) => {
  let bucket = subscribedHandlers.get(type);
  if (!bucket) {
    bucket = new Set();
    subscribedHandlers.set(type, bucket);
  }
  bucket.add(cb);
});
const unsubscribeMock = vi.fn((type: string, cb: Handler) => {
  subscribedHandlers.get(type)?.delete(cb);
});

vi.mock('./WebSocketContext', () => ({
  useWebSocket: () => ({
    isConnected: wsState.isConnected,
    subscribe: subscribeMock,
    unsubscribe: unsubscribeMock,
  }),
}));

function dispatchWs(type: string, message: unknown): void {
  for (const cb of subscribedHandlers.get(type) ?? []) cb(message);
}

const mockResponse = <T,>(json: T, ok = true) =>
  ({ ok, json: async () => json }) as unknown as Response & { json(): Promise<T> };

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

function Probe() {
  const { liveTaskIds } = useTaskContext();
  return (
    <span data-testid="live-ids">
      {Array.from(liveTaskIds).sort((a, b) => a - b).join(',')}
    </span>
  );
}

function renderProbe() {
  return render(
    <TaskContextProvider>
      <Probe />
    </TaskContextProvider>,
  );
}

function liveIds(): string {
  return screen.getByTestId('live-ids').textContent ?? '';
}

describe('TaskContext — liveTaskIds reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscribedHandlers.clear();
    wsState.isConnected = false;
    getActiveMock.mockResolvedValue(
      mockResponse({ sessions: [] as Array<{ sessionId: string; taskId: number; conversationId: number }> }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconciles on mount: a task returned by the endpoint becomes live with no WS event', async () => {
    getActiveMock.mockResolvedValue(
      mockResponse({ sessions: [{ sessionId: 's1', taskId: 7, conversationId: 100 }] }),
    );

    renderProbe();

    await waitFor(() => expect(liveIds()).toBe('7'));
    expect(getActiveMock).toHaveBeenCalled();
  });

  it('re-reconciles on WebSocket reconnect and overwrites the set', async () => {
    getActiveMock.mockResolvedValueOnce(
      mockResponse({ sessions: [{ sessionId: 's1', taskId: 7, conversationId: 100 }] }),
    );

    const { rerender } = render(
      <TaskContextProvider>
        <Probe />
      </TaskContextProvider>,
    );
    await waitFor(() => expect(liveIds()).toBe('7'));

    // Reconnect: the endpoint now reports a different live task. The full
    // overwrite drops 7 and adds 9.
    getActiveMock.mockResolvedValueOnce(
      mockResponse({ sessions: [{ sessionId: 's2', taskId: 9, conversationId: 200 }] }),
    );
    act(() => {
      wsState.isConnected = true;
    });
    rerender(
      <TaskContextProvider>
        <Probe />
      </TaskContextProvider>,
    );

    await waitFor(() => expect(liveIds()).toBe('9'));
  });

  it('reconciles when the tab regains visibility (visibilitychange → visible)', async () => {
    renderProbe();
    await waitFor(() => expect(getActiveMock).toHaveBeenCalledTimes(1));
    expect(liveIds()).toBe('');

    // The endpoint now reports a live task that the client missed (Bug #2).
    getActiveMock.mockResolvedValue(
      mockResponse({ sessions: [{ sessionId: 's1', taskId: 42, conversationId: 100 }] }),
    );

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(liveIds()).toBe('42'));
  });

  it('reconciles on the periodic interval tick', async () => {
    vi.useFakeTimers();
    try {
      // Render under fake timers; flush the mount reconcile microtask.
      render(
        <TaskContextProvider>
          <Probe />
        </TaskContextProvider>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(liveIds()).toBe('');

      // Endpoint now reports a live task; advance past the 30s resync.
      getActiveMock.mockResolvedValue(
        mockResponse({ sessions: [{ sessionId: 's1', taskId: 5, conversationId: 100 }] }),
      );
      await act(async () => {
        vi.advanceTimersByTime(30000);
        await Promise.resolve();
      });

      expect(liveIds()).toBe('5');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a streaming-started WS event marks the task live without a reconcile', async () => {
    renderProbe();
    await waitFor(() => expect(liveIds()).toBe(''));

    act(() => {
      dispatchWs('streaming-started', {
        type: 'streaming-started',
        conversationId: 100,
        taskId: 13,
      } satisfies ServerMessageOf<'streaming-started'>);
    });

    await waitFor(() => expect(liveIds()).toBe('13'));
  });

  it('ignores a non-ok reconcile response (keeps the existing set)', async () => {
    getActiveMock.mockResolvedValue(
      mockResponse({ sessions: [{ sessionId: 's1', taskId: 7, conversationId: 100 }] }),
    );
    renderProbe();
    await waitFor(() => expect(liveIds()).toBe('7'));

    // A failed resync must not wipe the live set.
    getActiveMock.mockResolvedValue(mockResponse({ sessions: [] }, false));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Give the (ignored) fetch a chance to settle, then assert no change.
    await act(async () => {
      await Promise.resolve();
    });
    expect(liveIds()).toBe('7');
  });
});

// ---------------------------------------------------------------------------
// Worktree setup state
// ---------------------------------------------------------------------------

function SetupProbe() {
  const { tasks, createTask, retryWorktreeSetup } = useTaskContext();
  return (
    <div>
      <button onClick={() => void createTask(1, 'New task')}>create</button>
      <button onClick={() => void retryWorktreeSetup(42)}>retry</button>
      <span data-testid="setup">
        {tasks.map((t) => `${t.id}:${t.worktree_state}:${t.worktree_error ?? ''}`).join(',')}
      </span>
    </div>
  );
}

describe('TaskContext — worktree setup state', () => {
  beforeEach(() => {
    subscribedHandlers.clear();
    getActiveMock.mockResolvedValue(mockResponse({ sessions: [] }));
    createTaskMock.mockResolvedValue(
      mockResponse({ id: 42, title: 'New task', worktree_state: 'provisioning', worktree_error: null }),
    );
  });

  async function renderWithProvisioningTask() {
    render(
      <TaskContextProvider>
        <SetupProbe />
      </TaskContextProvider>,
    );
    act(() => {
      screen.getByText('create').click();
    });
    await waitFor(() => expect(screen.getByTestId('setup').textContent).toBe('42:provisioning:'));
  }

  it('patches the task when its background setup finishes or fails', async () => {
    await renderWithProvisioningTask();

    act(() => {
      dispatchWs('task-worktree-updated', {
        type: 'task-worktree-updated',
        taskId: 42,
        worktreeState: 'failed',
        worktreeError: 'hook died',
      } satisfies ServerMessageOf<'task-worktree-updated'>);
    });
    await waitFor(() => expect(screen.getByTestId('setup').textContent).toBe('42:failed:hook died'));

    act(() => {
      dispatchWs('task-worktree-updated', {
        type: 'task-worktree-updated',
        taskId: 42,
        worktreeState: 'ready',
        worktreeError: null,
      } satisfies ServerMessageOf<'task-worktree-updated'>);
    });
    await waitFor(() => expect(screen.getByTestId('setup').textContent).toBe('42:ready:'));
  });

  it('a retry puts the returned row back in the list', async () => {
    await renderWithProvisioningTask();
    retryWorktreeSetupMock.mockResolvedValue(
      mockResponse({ id: 42, worktree_state: 'provisioning', worktree_error: null }),
    );
    act(() => {
      dispatchWs('task-worktree-updated', {
        type: 'task-worktree-updated',
        taskId: 42,
        worktreeState: 'failed',
        worktreeError: 'x',
      } satisfies ServerMessageOf<'task-worktree-updated'>);
    });

    act(() => {
      screen.getByText('retry').click();
    });

    await waitFor(() => expect(retryWorktreeSetupMock).toHaveBeenCalledWith(42));
    await waitFor(() => expect(screen.getByTestId('setup').textContent).toBe('42:provisioning:'));
  });
});
