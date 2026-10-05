import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockTasksDb, mockCreateWorktree, mockCleanup, mockWorktreeExists, mockGetBranchName, mockEmit } =
  vi.hoisted(() => ({
    mockTasksDb: {
      getWithProject: vi.fn(),
      getById: vi.fn(),
      setWorktreeState: vi.fn(),
      failInterruptedWorktreeSetups: vi.fn(),
    },
    mockCreateWorktree: vi.fn(),
    mockCleanup: vi.fn(),
    mockWorktreeExists: vi.fn(),
    mockGetBranchName: vi.fn(),
    mockEmit: vi.fn(),
  }));

vi.mock('../../database/tasks.js', () => ({ tasksDb: mockTasksDb }));
vi.mock('../worktree.js', () => ({
  createWorktree: mockCreateWorktree,
  cleanupFailedWorktreeAdd: mockCleanup,
  worktreeExists: mockWorktreeExists,
  getBranchName: mockGetBranchName,
  getWorktreePath: (repo: string, id: number) => `${repo}-worktrees/task-${id}`,
  sanitizeTitle: (title: string | null) => (title ?? 'task').toLowerCase(),
}));
vi.mock('./events.js', () => ({ emitTaskEvent: mockEmit }));

import {
  INTERRUPTED_SETUP_ERROR,
  cancelWorktreeSetup,
  failInterruptedWorktreeSetups,
  isWorktreeSetupRunning,
  retryWorktreeSetup,
  startWorktreeSetup,
} from './worktreeSetup.js';

type Rows = Record<number, { repo: string; state: string; title?: string }>;

/** A tiny in-memory tasks table behind the mocked tasksDb. */
function useRows(rows: Rows): void {
  mockTasksDb.getWithProject.mockImplementation((id: number) =>
    rows[id]
      ? {
          id,
          repo_folder_path: rows[id].repo,
          title: rows[id].title ?? 'Ticket',
          base_branch: null,
          worktree_state: rows[id].state,
        }
      : undefined,
  );
  mockTasksDb.getById.mockImplementation((id: number) =>
    rows[id] ? { id, worktree_state: rows[id].state } : undefined,
  );
  mockTasksDb.setWorktreeState.mockImplementation((id: number, state: string) => {
    if (rows[id]) rows[id].state = state;
  });
}

/** A createWorktree call the test settles by hand. */
function deferredWorktree() {
  let settle!: (value: unknown) => void;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('worktreeSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCleanup.mockResolvedValue(undefined);
    mockWorktreeExists.mockResolvedValue(false);
    mockGetBranchName.mockResolvedValue(null);
  });

  it('marks the task ready and announces it when the worktree is created', async () => {
    useRows({ 1: { repo: '/a', state: 'provisioning' } });
    mockCreateWorktree.mockResolvedValue({ success: true });

    await startWorktreeSetup(1);

    expect(mockCreateWorktree).toHaveBeenCalledWith('/a', 1, 'Ticket', null, {
      signal: expect.any(AbortSignal),
    });
    expect(mockTasksDb.setWorktreeState).toHaveBeenCalledWith(1, 'ready');
    expect(mockEmit).toHaveBeenCalledWith('worktree-state-changed', {
      taskId: 1,
      state: 'ready',
      error: null,
    });
  });

  it('keeps a failed task as failed, with the reason and the hook output', async () => {
    useRows({ 1: { repo: '/a', state: 'provisioning' } });
    mockCreateWorktree.mockResolvedValue({
      success: false,
      error: 'git worktree add timed out after 600s',
      output: 'bun install\nBuilding…',
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await startWorktreeSetup(1);

    const error = 'git worktree add timed out after 600s\n\nbun install\nBuilding…';
    expect(mockTasksDb.setWorktreeState).toHaveBeenCalledWith(1, 'failed', error);
    expect(mockEmit).toHaveBeenCalledWith('worktree-state-changed', {
      taskId: 1,
      state: 'failed',
      error,
    });
    // Logged, so the service journal says what happened.
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Task 1: worktree setup failed'));
    consoleError.mockRestore();
  });

  it('records nothing when the setup was cancelled', async () => {
    useRows({ 1: { repo: '/a', state: 'provisioning' } });
    mockCreateWorktree.mockResolvedValue({ success: false, error: 'cancelled', aborted: true });

    await startWorktreeSetup(1);

    expect(mockTasksDb.setWorktreeState).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('records nothing when the task was deleted while its worktree was being created', async () => {
    const rows: Rows = { 1: { repo: '/a', state: 'provisioning' } };
    useRows(rows);
    mockCreateWorktree.mockImplementation(async () => {
      delete rows[1];
      return { success: true };
    });

    await startWorktreeSetup(1);

    expect(mockTasksDb.setWorktreeState).not.toHaveBeenCalled();
  });

  it('runs one setup at a time per repository, and repositories in parallel', async () => {
    useRows({
      1: { repo: '/a', state: 'provisioning' },
      2: { repo: '/a', state: 'provisioning' },
      3: { repo: '/b', state: 'provisioning' },
    });
    const first = deferredWorktree();
    mockCreateWorktree.mockImplementation((_repo: string, id: number) =>
      id === 1 ? first.promise : Promise.resolve({ success: true }),
    );

    const one = startWorktreeSetup(1);
    const two = startWorktreeSetup(2);
    const three = startWorktreeSetup(3);
    await three;
    await flush();

    const startedIds = () => mockCreateWorktree.mock.calls.map((c) => c[1]);
    expect(startedIds()).toEqual([1, 3]);

    first.settle({ success: true });
    await Promise.all([one, two]);
    expect(startedIds()).toEqual([1, 3, 2]);
  });

  it('cancels a running setup through its abort signal and waits for it to clean up', async () => {
    useRows({ 1: { repo: '/a', state: 'provisioning' } });
    let cleanedUp = false;
    mockCreateWorktree.mockImplementation(
      (_r: string, _i: number, _t: string, _b: null, { signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            cleanedUp = true;
            resolve({ success: false, aborted: true });
          });
        }),
    );

    void startWorktreeSetup(1);
    await flush();
    await cancelWorktreeSetup(1);

    expect(cleanedUp).toBe(true);
    expect(isWorktreeSetupRunning(1)).toBe(false);
  });

  it('cancels a queued setup at once, and it never creates anything', async () => {
    useRows({
      1: { repo: '/a', state: 'provisioning' },
      2: { repo: '/a', state: 'provisioning' },
    });
    const first = deferredWorktree();
    mockCreateWorktree.mockImplementation((_repo: string, id: number) =>
      id === 1 ? first.promise : Promise.resolve({ success: true }),
    );

    const one = startWorktreeSetup(1);
    const two = startWorktreeSetup(2);
    await flush();

    // Does not wait behind setup 1.
    await cancelWorktreeSetup(2);

    first.settle({ success: true });
    await Promise.all([one, two]);
    expect(mockCreateWorktree.mock.calls.map((c) => c[1])).toEqual([1]);
  });

  describe('retryWorktreeSetup', () => {
    it('refuses a task whose setup did not fail', () => {
      useRows({ 1: { repo: '/a', state: 'ready' } });

      expect(retryWorktreeSetup(1)).toBe(false);
      expect(retryWorktreeSetup(99)).toBe(false);
      expect(mockTasksDb.setWorktreeState).not.toHaveBeenCalled();
    });

    it('flips a failed task back to provisioning, clears the leftovers, and sets it up again', async () => {
      useRows({ 1: { repo: '/a', state: 'failed', title: 'Ticket' } });
      mockWorktreeExists.mockResolvedValue(true);
      mockGetBranchName.mockResolvedValue('task/1-ticket');
      mockCreateWorktree.mockResolvedValue({ success: true });

      expect(retryWorktreeSetup(1)).toBe(true);
      // Flipped synchronously, so a second retry is refused.
      expect(mockTasksDb.setWorktreeState).toHaveBeenCalledWith(1, 'provisioning');
      expect(retryWorktreeSetup(1)).toBe(false);
      expect(mockEmit).toHaveBeenCalledWith('worktree-state-changed', {
        taskId: 1,
        state: 'provisioning',
        error: null,
      });

      await vi.waitFor(() =>
        expect(mockTasksDb.setWorktreeState).toHaveBeenCalledWith(1, 'ready'),
      );
      expect(mockCleanup).toHaveBeenCalledWith('/a', '/a-worktrees/task-1', 'task/1-ticket');
      expect(mockCleanup.mock.invocationCallOrder[0]).toBeLessThan(
        mockCreateWorktree.mock.invocationCallOrder[0]!,
      );
    });

    it('clears the expected branch when no worktree is left', async () => {
      useRows({ 1: { repo: '/a', state: 'failed', title: 'Ticket' } });
      mockCreateWorktree.mockResolvedValue({ success: true });

      retryWorktreeSetup(1);
      await vi.waitFor(() => expect(mockCreateWorktree).toHaveBeenCalled());

      expect(mockCleanup).toHaveBeenCalledWith('/a', '/a-worktrees/task-1', 'task/1-ticket');
    });
  });

  it('fails every setup a restart interrupted, and announces each', () => {
    mockTasksDb.failInterruptedWorktreeSetups.mockReturnValue([4, 9]);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(failInterruptedWorktreeSetups()).toEqual([4, 9]);

    expect(mockTasksDb.failInterruptedWorktreeSetups).toHaveBeenCalledWith(INTERRUPTED_SETUP_ERROR);
    expect(mockEmit).toHaveBeenCalledWith('worktree-state-changed', {
      taskId: 9,
      state: 'failed',
      error: INTERRUPTED_SETUP_ERROR,
    });
    consoleWarn.mockRestore();
  });
});
