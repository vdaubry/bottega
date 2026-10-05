import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRunCommand, mockAccess } = vi.hoisted(() => ({
  mockRunCommand: vi.fn(),
  mockAccess: vi.fn(),
}));

vi.mock('./shell.js', () => ({ runCommand: mockRunCommand }));

vi.mock('fs', () => ({
  default: { promises: { access: mockAccess } },
  promises: { access: mockAccess },
}));

import {
  getWorktreeSafety,
  assertWorktreeSafeToDestroy,
  describeUnsavedWork,
  isUnsavedWorktreeWorkError,
  UnsavedWorktreeWorkError,
  MAX_LISTED_FILES,
} from './worktreeSafety.js';

const WT = '/repo-worktrees/task-1';

/**
 * Drive `runCommand` by the git subcommand being run, so a test only has to
 * state the answers it cares about.
 */
function gitResponses(answers: {
  status?: string;
  branch?: string | null;
  /** Whether the repo has any `refs/remotes/origin/*` at all. Defaults true. */
  hasOriginRefs?: boolean;
  unpushed?: string;
}) {
  mockRunCommand.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === 'status') {
      if (answers.status === undefined) throw new Error('not a git repo');
      return { stdout: answers.status, stderr: '' };
    }
    if (args[0] === 'branch') return { stdout: answers.branch ?? '', stderr: '' };
    if (args[0] === 'for-each-ref') {
      return { stdout: answers.hasOriginRefs === false ? '' : 'refs/remotes/origin/main', stderr: '' };
    }
    if (args[0] === 'rev-list') return { stdout: answers.unpushed ?? '0', stderr: '' };
    throw new Error(`unexpected git ${args.join(' ')}`);
  });
}

describe('worktreeSafety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
  });

  describe('getWorktreeSafety', () => {
    it('reports clean when the tree is clean and the branch is pushed', async () => {
      gitResponses({ status: '', branch: 'task/1-thing', unpushed: '0' });

      const safety = await getWorktreeSafety(WT);

      expect(safety).toMatchObject({ clean: true, dirtyFiles: 0, unpushedCommits: 0 });
    });

    it('counts uncommitted paths and parses porcelain status codes', async () => {
      gitResponses({
        status: ' M src/app.ts\n?? notes.md\nA  server/new.ts\n',
        branch: 'task/1-thing',
      });

      const safety = await getWorktreeSafety(WT);

      expect(safety.clean).toBe(false);
      expect(safety.dirtyFiles).toBe(3);
      expect(safety.files).toEqual(['src/app.ts', 'notes.md', 'server/new.ts']);
    });

    it('takes the destination path of a rename', async () => {
      gitResponses({ status: 'R  old/name.ts -> new/name.ts\n', branch: null });

      const safety = await getWorktreeSafety(WT);

      expect(safety.files).toEqual(['new/name.ts']);
    });

    it('truncates the file list but keeps the true count', async () => {
      const many = Array.from({ length: MAX_LISTED_FILES + 10 }, (_, i) => ` M f${i}.ts`).join('\n');
      gitResponses({ status: many, branch: null });

      const safety = await getWorktreeSafety(WT);

      expect(safety.dirtyFiles).toBe(MAX_LISTED_FILES + 10);
      expect(safety.files).toHaveLength(MAX_LISTED_FILES);
    });

    // The whole point of the module: a committed-but-unpushed branch reports a
    // perfectly clean tree, and `gh pr merge` would land without those commits.
    it('flags unpushed commits on an otherwise clean tree', async () => {
      gitResponses({ status: '', branch: 'task/1-thing', unpushed: '3' });

      const safety = await getWorktreeSafety(WT);

      expect(safety).toMatchObject({ clean: false, dirtyFiles: 0, unpushedCommits: 3 });
    });

    // No base branch is threaded in: "what has no remote at all" needs no
    // parameter and is what makes a never-pushed branch count correctly.
    it('asks git for commits reachable from HEAD but from no origin ref', async () => {
      gitResponses({ status: '', branch: 'task/1-thing', unpushed: '2' });

      await getWorktreeSafety(WT);

      expect(mockRunCommand).toHaveBeenCalledWith(
        'git',
        ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'],
        { cwd: WT },
      );
    });

    it('reports 0 unpushed in a repo with no origin refs — nowhere to push', async () => {
      gitResponses({ status: '', branch: 'task/1-thing', hasOriginRefs: false, unpushed: '9' });

      const safety = await getWorktreeSafety(WT);

      expect(safety).toMatchObject({ clean: true, unpushedCommits: 0 });
    });

    it('lists untracked files individually rather than collapsing a directory', async () => {
      gitResponses({ status: '', branch: null });

      await getWorktreeSafety(WT);

      expect(mockRunCommand).toHaveBeenCalledWith(
        'git',
        ['status', '--porcelain', '--untracked-files=all'],
        { cwd: WT },
      );
    });

    it('never runs git fetch — these paths are interactive', async () => {
      gitResponses({ status: '', branch: 'task/1-thing' });

      await getWorktreeSafety(WT);

      expect(mockRunCommand).not.toHaveBeenCalledWith('git', ['fetch', 'origin'], expect.anything());
    });

    it('reports clean for a worktree that is not on disk', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      expect(await getWorktreeSafety(WT)).toMatchObject({ clean: true });
      expect(mockRunCommand).not.toHaveBeenCalled();
    });

    // A worktree git cannot read is already broken; blocking would leave the
    // user unable to clean it up.
    it('reports clean when git status itself fails', async () => {
      gitResponses({ branch: null });

      expect(await getWorktreeSafety(WT)).toMatchObject({ clean: true });
    });
  });

  describe('assertWorktreeSafeToDestroy', () => {
    it('resolves for a clean worktree', async () => {
      gitResponses({ status: '', branch: 'task/1-thing' });

      await expect(assertWorktreeSafeToDestroy(WT, 1)).resolves.toBeUndefined();
    });

    it('throws a typed error carrying the report', async () => {
      gitResponses({ status: ' M src/app.ts\n', branch: 'task/1-thing', unpushed: '2' });

      const err = await assertWorktreeSafeToDestroy(WT, 42).catch((e: unknown) => e);

      expect(isUnsavedWorktreeWorkError(err)).toBe(true);
      const typed = err as UnsavedWorktreeWorkError;
      expect(typed.taskId).toBe(42);
      expect(typed.code).toBe('worktree-has-unsaved-work');
      expect(typed.safety).toMatchObject({ dirtyFiles: 1, unpushedCommits: 2 });
    });

    it('skips the check entirely when forced', async () => {
      await expect(assertWorktreeSafeToDestroy(WT, 1, { force: true })).resolves.toBeUndefined();
      expect(mockRunCommand).not.toHaveBeenCalled();
    });
  });

  describe('describeUnsavedWork', () => {
    it.each([
      [{ dirtyFiles: 1, unpushedCommits: 0 }, '1 uncommitted file'],
      [{ dirtyFiles: 4, unpushedCommits: 0 }, '4 uncommitted files'],
      [{ dirtyFiles: 0, unpushedCommits: 1 }, '1 unpushed commit'],
      [{ dirtyFiles: 2, unpushedCommits: 3 }, '2 uncommitted files and 3 unpushed commits'],
      [{ dirtyFiles: 0, unpushedCommits: 0 }, 'no unsaved work'],
    ])('renders %o as "%s"', (safety, expected) => {
      expect(describeUnsavedWork(safety)).toBe(expected);
    });
  });
});
