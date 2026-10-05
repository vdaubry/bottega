import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useWorktreeGuard, type GuardOutcome } from './useWorktreeGuard';
import type { UnsavedWorktreeWorkResponse } from '../../shared/api/tasks';

const mockPushChanges = vi.fn();
vi.mock('../utils/api', () => ({
  api: { tasks: { pushChanges: (...args: unknown[]) => mockPushChanges(...args) } },
}));

const CONFLICT: UnsavedWorktreeWorkResponse = {
  error: 'worktree-has-unsaved-work',
  summary: '2 uncommitted files and 1 unpushed commit',
  taskId: 7,
  branch: 'task/7-widget',
  dirtyPaths: ['src/a.ts', 'src/b.ts'],
  dirtyFiles: 2,
  unpushedCommits: 1,
  prUrl: 'https://github.com/user/repo/pull/42',
  prNumber: 42,
};

/** Minimal `TypedResponse` stand-in for the raw-response `guard` entry point. */
const responseOf = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as never;

/**
 * Harness: a button that runs the guard and records the outcome, plus whatever
 * modal the guard decides to show.
 */
function Harness({
  run,
  onOutcome,
}: {
  run: (force: boolean) => Promise<never>;
  onOutcome: (outcome: GuardOutcome<unknown>) => void;
}) {
  const { guard, guardModal } = useWorktreeGuard();
  return (
    <div>
      <button
        onClick={() => {
          void guard({ taskId: 7, intent: 'merge', run }).then(onOutcome);
        }}
      >
        go
      </button>
      {guardModal}
    </div>
  );
}

async function openConflictModal(run: (force: boolean) => Promise<never>) {
  const onOutcome = vi.fn();
  render(<Harness run={run} onOutcome={onOutcome} />);
  fireEvent.click(screen.getByText('go'));
  await screen.findByText('Merging would lose work');
  return onOutcome;
}

describe('useWorktreeGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPushChanges.mockResolvedValue(responseOf(200, { success: true }));
  });

  it('passes a clean action straight through without showing the modal', async () => {
    const run = vi.fn().mockResolvedValue(responseOf(200, { success: true }));
    const onOutcome = vi.fn();

    render(<Harness run={run} onOutcome={onOutcome} />);
    fireEvent.click(screen.getByText('go'));

    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith({
      status: 'ok',
      data: { success: true },
    }));
    expect(run).toHaveBeenCalledWith(false);
    expect(screen.queryByText('Merging would lose work')).not.toBeInTheDocument();
  });

  it('surfaces the unsaved-work report in the modal', async () => {
    const run = vi.fn().mockResolvedValue(responseOf(409, CONFLICT));
    await openConflictModal(run);

    expect(
      screen.getByText('2 uncommitted files and 1 unpushed commit would be permanently lost.'),
    ).toBeInTheDocument();
    // The PR number turns the vague "push" into a concrete destination.
    expect(screen.getByText('Commit & push to PR #42')).toBeInTheDocument();
    expect(screen.getByText('task/7-widget')).toBeInTheDocument();
  });

  it('labels the save option for a branch with no PR yet', async () => {
    const run = vi
      .fn()
      .mockResolvedValue(responseOf(409, { ...CONFLICT, prUrl: null, prNumber: null }));
    await openConflictModal(run);

    expect(screen.getByText('Commit & push branch')).toBeInTheDocument();
  });

  it('lists the uncommitted files on demand', async () => {
    const run = vi.fn().mockResolvedValue(responseOf(409, CONFLICT));
    await openConflictModal(run);

    expect(screen.queryByText('src/a.ts')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/Show uncommitted files/));

    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();
  });

  it('cancels without running the action again', async () => {
    const run = vi.fn().mockResolvedValue(responseOf(409, CONFLICT));
    const onOutcome = await openConflictModal(run);

    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith({ status: 'cancelled' }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  // The load-bearing behaviour: saving pushes and *stops*. The push moved the
  // PR head and re-triggered CI, so merging in the same breath would land a
  // head nobody has seen green.
  it('pushes and stops when the user chooses to save', async () => {
    const run = vi.fn().mockResolvedValue(responseOf(409, CONFLICT));
    const onOutcome = await openConflictModal(run);

    fireEvent.click(screen.getByText('Commit & push to PR #42'));

    await waitFor(() => expect(onOutcome).toHaveBeenCalledWith({ status: 'saved' }));
    expect(mockPushChanges).toHaveBeenCalledWith(7, undefined);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalledWith(true);
  });

  it('keeps the modal open and reports why when the push fails', async () => {
    mockPushChanges.mockResolvedValue(responseOf(500, { error: 'remote rejected' }));
    const run = vi.fn().mockResolvedValue(responseOf(409, CONFLICT));
    const onOutcome = await openConflictModal(run);

    fireEvent.click(screen.getByText('Commit & push to PR #42'));

    await screen.findByText('remote rejected');
    expect(onOutcome).not.toHaveBeenCalled();
    expect(screen.getByText('Merging would lose work')).toBeInTheDocument();
  });

  it('re-runs the action with force when the user chooses to discard', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(responseOf(409, CONFLICT))
      .mockResolvedValueOnce(responseOf(200, { success: true }));
    const onOutcome = await openConflictModal(run);

    fireEvent.click(screen.getByText('Discard and merge'));

    await waitFor(() =>
      expect(onOutcome).toHaveBeenCalledWith({ status: 'ok', data: { success: true } }),
    );
    expect(run).toHaveBeenNthCalledWith(2, true);
    expect(mockPushChanges).not.toHaveBeenCalled();
  });

  it('treats a 404 as success — the worktree is already gone', async () => {
    const run = vi.fn().mockResolvedValue(responseOf(404, { error: 'Worktree not found' }));
    const onOutcome = vi.fn();

    render(<Harness run={run} onOutcome={onOutcome} />);
    fireEvent.click(screen.getByText('go'));

    await waitFor(() =>
      expect(onOutcome).toHaveBeenCalledWith({ status: 'ok', data: undefined }),
    );
  });

  it('reports a non-conflict failure without opening the modal', async () => {
    const run = vi.fn().mockResolvedValue(responseOf(500, { error: 'Worktree locked' }));
    const onOutcome = vi.fn();

    render(<Harness run={run} onOutcome={onOutcome} />);
    fireEvent.click(screen.getByText('go'));

    await waitFor(() =>
      expect(onOutcome).toHaveBeenCalledWith({ status: 'error', error: 'Worktree locked' }),
    );
    expect(screen.queryByText('Merging would lose work')).not.toBeInTheDocument();
  });
});
