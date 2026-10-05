import { describe, it, expect, beforeEach, vi } from 'vitest';

// Use vi.hoisted so `vi.mock` can reach the mock function before module init.
const { mockRunCommand, mockAccess, mockMkdir, mockRm, mockExistsSync } = vi.hoisted(
  () => ({
    mockRunCommand: vi.fn(),
    mockAccess: vi.fn(),
    mockMkdir: vi.fn(),
    mockRm: vi.fn(),
    mockExistsSync: vi.fn(),
  }),
);

// Mock the central shell helper. Every shell-out in worktree.ts is now
// supposed to flow through runCommand(cmd, args[], opts), so we can assert
// on (cmd, args) shape directly — and adversarial inputs end up as argv
// elements, never interpreted by a shell.
// `runCommandGroup` (the process-group runner `git worktree add` uses) routes
// through the same mock, so every git call is recorded in one place; the real
// `CommandGroupError` is kept for `instanceof`.
vi.mock('./shell.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shell.js')>()),
  runCommand: mockRunCommand,
  runCommandGroup: (...args: unknown[]) => mockRunCommand(...args),
}));

// Mock fs
vi.mock('fs', () => ({
  default: {
    existsSync: mockExistsSync,
    constants: { X_OK: 1 },
    promises: {
      access: mockAccess,
      mkdir: mockMkdir,
      rm: mockRm,
    },
  },
  existsSync: mockExistsSync,
  constants: { X_OK: 1 },
  promises: {
    access: mockAccess,
    mkdir: mockMkdir,
    rm: mockRm,
  },
}));

import {
  getWorktreePath,
  getWorktreesDir,
  worktreeExists,
  isGitRepository,
  getDefaultBranch,
  getBranchName,
  createWorktree,
  removeWorktree,
  getWorktreeStatus,
  syncWithBase,
  createPullRequest,
  getPullRequestStatus,
  getPullRequestStatusByUrl,
  mergePullRequest,
  cleanupMergedWorktree,
  mergeAndCleanup,
  hasUncommittedChanges,
  commitAllChanges,
  pushChanges,
  worktreeProvisioningMode,
} from './worktree.js';

// Helper: configure mockRunCommand to dispatch on (cmd, args) so each test
// only has to declare the responses it cares about.
type RunArgs = readonly string[];
type RunHandler = (cmd: string, args: RunArgs) => Promise<{ stdout: string; stderr: string }>;

function withDispatch(handler: RunHandler): void {
  mockRunCommand.mockImplementation(
    (cmd: string, args: RunArgs) => handler(cmd, args),
  );
}

describe('Worktree Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getWorktreePath', () => {
    it('should return correct worktree path for a task', () => {
      expect(getWorktreePath('/home/user/myproject', 15)).toBe(
        '/home/user/myproject-worktrees/task-15',
      );
    });

    it('should handle paths without trailing slash', () => {
      expect(getWorktreePath('/path/to/repo', 42)).toBe('/path/to/repo-worktrees/task-42');
    });
  });

  describe('getWorktreesDir', () => {
    it('should return worktrees directory path', () => {
      expect(getWorktreesDir('/home/user/myproject')).toBe('/home/user/myproject-worktrees');
    });
  });

  describe('worktreeExists', () => {
    it('should return true when worktree directory exists', async () => {
      vi.mocked(mockAccess).mockResolvedValue(undefined);

      const result = await worktreeExists('/home/user/repo', 10);

      expect(result).toBe(true);
      expect(mockAccess).toHaveBeenCalledWith('/home/user/repo-worktrees/task-10');
    });

    it('should return false when worktree directory does not exist', async () => {
      vi.mocked(mockAccess).mockRejectedValue(new Error('ENOENT'));

      const result = await worktreeExists('/home/user/repo', 10);

      expect(result).toBe(false);
    });
  });

  describe('isGitRepository', () => {
    it('returns true for valid git repository', async () => {
      withDispatch(async () => ({ stdout: '.git', stderr: '' }));

      expect(await isGitRepository('/path/to/repo')).toBe(true);
      expect(mockRunCommand).toHaveBeenCalledWith(
        'git',
        ['rev-parse', '--git-dir'],
        { cwd: '/path/to/repo' },
      );
    });

    it('returns false for non-git directory', async () => {
      withDispatch(async () => {
        throw new Error('not a git repository');
      });

      expect(await isGitRepository('/path/to/not-repo')).toBe(false);
    });
  });

  describe('getDefaultBranch', () => {
    it('returns the branch when symbolic-ref succeeds', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('symbolic-ref')) {
          return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        }
        throw new Error('unexpected');
      });

      expect(await getDefaultBranch('/path/to/repo')).toBe('main');
    });

    it('falls back to abbrev-ref when symbolic-ref fails (no shell ||)', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('symbolic-ref')) throw new Error('not set');
        if (args.includes('--abbrev-ref')) return { stdout: 'master\n', stderr: '' };
        throw new Error('unexpected');
      });

      expect(await getDefaultBranch('/path/to/repo')).toBe('master');
    });

    it('returns "main" when both git invocations fail', async () => {
      withDispatch(async () => {
        throw new Error('boom');
      });

      expect(await getDefaultBranch('/path/to/repo')).toBe('main');
    });
  });

  describe('getBranchName', () => {
    it('returns the current branch', async () => {
      withDispatch(async () => ({ stdout: 'task/15-add-feature\n', stderr: '' }));

      expect(await getBranchName('/path/to/worktree')).toBe('task/15-add-feature');
      expect(mockRunCommand).toHaveBeenCalledWith(
        'git',
        ['branch', '--show-current'],
        { cwd: '/path/to/worktree' },
      );
    });

    it('returns null on error', async () => {
      withDispatch(async () => {
        throw new Error('failed');
      });

      expect(await getBranchName('/path/to/worktree')).toBeNull();
    });
  });

  describe('createWorktree', () => {
    beforeEach(() => {
      vi.mocked(mockExistsSync).mockReturnValue(false);
      vi.mocked(mockMkdir).mockResolvedValue(undefined);
      vi.mocked(mockRm).mockResolvedValue(undefined);
    });

    it('passes branch / base / path as separate argv elements', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('symbolic-ref')) {
          return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await createWorktree('/home/user/repo', 15, 'Add User Login');

      expect(result.success).toBe(true);
      expect((result as { branch: string }).branch).toBe('task/15-add-user-login');

      const worktreeAddCall = mockRunCommand.mock.calls.find(
        (c) => c[0] === 'git' && (c[1] as string[]).includes('worktree'),
      );
      expect(worktreeAddCall).toBeDefined();
      expect(worktreeAddCall![1]).toEqual([
        'worktree',
        'add',
        '-b',
        'task/15-add-user-login',
        '/home/user/repo-worktrees/task-15',
        'main',
      ]);
    });

    it('fetches an explicit base branch first and forks off the remote ref', async () => {
      const calls: string[][] = [];
      withDispatch(async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { stdout: '', stderr: '' };
      });

      const result = await createWorktree(
        '/home/user/repo',
        15,
        'Add User Login',
        'epic/8-nimbus-pricing',
      );

      expect(result.success).toBe(true);
      // No default-branch lookup: the caller already resolved the base.
      expect(calls.some((c) => c.includes('symbolic-ref'))).toBe(false);
      expect(calls).toContainEqual(['git', 'fetch', 'origin', 'epic/8-nimbus-pricing']);
      const add = calls.find((c) => c.includes('worktree'))!;
      expect(add[add.length - 1]).toBe('origin/epic/8-nimbus-pricing');
    });

    it('falls back to the local ref when the base branch is not on origin', async () => {
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'fetch') throw new Error("couldn't find remote ref");
        return { stdout: '', stderr: '' };
      });

      const result = await createWorktree('/repo', 15, 'Task', 'epic/8-nimbus');

      expect(result.success).toBe(true);
      const add = mockRunCommand.mock.calls.find((c) => (c[1] as string[]).includes('worktree'))!;
      expect((add[1] as string[]).at(-1)).toBe('epic/8-nimbus');
    });

    it('rejects an invalid base branch returned from git rather than executing it', async () => {
      withDispatch(async (_cmd, args) => {
        // Simulate a malicious upstream HEAD with a flag-looking name.
        if (args.includes('symbolic-ref')) {
          return { stdout: '--upload-pack=/tmp/evil\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await createWorktree('/repo', 1, 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid|branch/);
    });

    it('truncates long titles to 30 characters', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const longTitle = 'This is a very long task title that should be truncated';
      const result = await createWorktree('/repo', 1, longTitle);

      const slug = (result as { branch: string }).branch.replace('task/1-', '');
      expect(slug.length).toBeLessThanOrEqual(30);
    });

    it('returns error on git failure', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('worktree')) throw new Error('fatal: branch already exists');
        return { stdout: '', stderr: '' };
      });

      const result = await createWorktree('/repo', 1, 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('branch already exists');
    });

    // Provisioning belongs to the project's own post-checkout hook, which git
    // runs inside `git worktree add`. Bottega adds nothing: no env symlinks,
    // no dependency copies, no stack-specific directories.
    it('runs no provisioning of its own', async () => {
      vi.mocked(mockExistsSync).mockImplementation((p) => p === '/repo/.env');
      withDispatch(async (_cmd, args) => {
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await createWorktree('/repo', 1, 'Test');

      expect(result.success).toBe(true);
      expect(mockRunCommand.mock.calls.every((c) => c[0] === 'git')).toBe(true);
      // Only the worktrees parent dir; nothing inside the worktree.
      expect(mockMkdir).toHaveBeenCalledTimes(1);
      expect(mockMkdir).toHaveBeenCalledWith('/repo-worktrees', { recursive: true });
    });

    // The hook may do a real dependency install; the 30 s runCommand default
    // would kill git mid-provisioning.
    it('gives `git worktree add` a 10-minute budget for the post-checkout hook', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      await createWorktree('/repo', 1, 'Test');

      const add = mockRunCommand.mock.calls.find((c) => (c[1] as string[])[1] === 'add')!;
      expect(add[2]).toEqual({ cwd: '/repo', timeout: 600_000 });
    });

    // post-checkout runs AFTER the checkout, so a failing (or timed-out) hook
    // leaves the worktree and branch on disk while `git worktree add` reports
    // failure. They must not survive as orphans.
    it('sweeps the worktree and branch when the add fails', async () => {
      const calls: string[][] = [];
      withDispatch(async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[1] === 'add') throw new Error('post-checkout hook failed');
        return { stdout: 'main\n', stderr: '' };
      });

      const result = await createWorktree('/repo', 1, 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('post-checkout hook failed');
      expect(calls).toContainEqual([
        'git',
        'worktree',
        'remove',
        '/repo-worktrees/task-1',
        '--force',
      ]);
      expect(calls).toContainEqual(['git', 'branch', '-D', 'task/1-test']);
      expect(mockRm).not.toHaveBeenCalled();
    });

    it('runs the add as a process group and hands it the caller\'s abort signal', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });
      const controller = new AbortController();

      await createWorktree('/repo', 1, 'Test', null, { signal: controller.signal });

      const add = mockRunCommand.mock.calls.find((c) => (c[1] as string[])[1] === 'add')!;
      expect(add[2]).toEqual({ cwd: '/repo', timeout: 600_000, signal: controller.signal });
    });

    // The failure has to be explainable to the user: git sends the hook's
    // output to stderr, and its tail travels back with the error.
    it('returns the tail of the hook output when the add fails', async () => {
      const { CommandGroupError } = await import('./shell.js');
      const hookLines = Array.from({ length: 60 }, (_, i) => `hook line ${i + 1}`);
      withDispatch(async (_cmd, args) => {
        if (args[1] === 'add') {
          throw new CommandGroupError(
            'git worktree add timed out after 600s',
            '',
            `${hookLines.join('\n')}\n`,
            null,
            true,
            false,
          );
        }
        return { stdout: 'main\n', stderr: '' };
      });

      const result = await createWorktree('/repo', 1, 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "The project's setup did not finish within 10 minutes, so it was stopped",
      );
      expect(result.aborted).toBe(false);
      const output = result.output!.split('\n');
      expect(output).toHaveLength(40);
      expect(output.at(-1)).toBe('hook line 60');
      expect(output[0]).toBe('hook line 21');
    });

    it('reports a cancelled add as aborted, and still sweeps it', async () => {
      const { CommandGroupError } = await import('./shell.js');
      const calls: string[][] = [];
      withDispatch(async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[1] === 'add') {
          throw new CommandGroupError('git worktree add was cancelled', '', '', null, false, true);
        }
        return { stdout: 'main\n', stderr: '' };
      });

      const result = await createWorktree('/repo', 1, 'Test');

      expect(result).toMatchObject({ success: false, aborted: true });
      expect(calls).toContainEqual(['git', 'branch', '-D', 'task/1-test']);
    });

    it('falls back to rm + prune when the failed worktree is not registered', async () => {
      const calls: string[][] = [];
      withDispatch(async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[1] === 'add') throw new Error('hook timed out');
        if (args[1] === 'remove') throw new Error('is not a working tree');
        return { stdout: 'main\n', stderr: '' };
      });

      const result = await createWorktree('/repo', 1, 'Test');

      expect(result.success).toBe(false);
      expect(mockRm).toHaveBeenCalledWith('/repo-worktrees/task-1', {
        recursive: true,
        force: true,
      });
      expect(calls).toContainEqual(['git', 'worktree', 'prune']);
    });
  });

  describe('removeWorktree', () => {
    it('removes worktree and branch successfully', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('--show-current')) return { stdout: 'task/15-feature\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await removeWorktree('/repo', 15);

      expect(result.success).toBe(true);
      const removeCall = mockRunCommand.mock.calls.find(
        (c) => (c[1] as string[]).includes('remove'),
      );
      expect(removeCall![1]).toEqual(['worktree', 'remove', '/repo-worktrees/task-15', '--force']);
      const branchDelete = mockRunCommand.mock.calls.find(
        (c) => (c[1] as string[]).includes('-D'),
      );
      expect(branchDelete![1]).toEqual(['branch', '-D', 'task/15-feature']);
    });

    // The guard lives inside the primitive so no caller can route around it.
    it('refuses to remove a worktree holding unsaved work', async () => {
      mockAccess.mockResolvedValue(undefined);
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'status') return { stdout: ' M src/app.ts\n', stderr: '' };
        if (args[0] === 'for-each-ref') return { stdout: 'refs/remotes/origin/main', stderr: '' };
        if (args.includes('--show-current')) return { stdout: 'task/15-feature\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      await expect(removeWorktree('/repo', 15)).rejects.toMatchObject({
        code: 'worktree-has-unsaved-work',
        taskId: 15,
        safety: { dirtyFiles: 1 },
      });
      expect(
        mockRunCommand.mock.calls.some((c) => (c[1] as string[]).includes('remove')),
      ).toBe(false);
    });

    it('removes a worktree holding unsaved work when forced', async () => {
      mockAccess.mockResolvedValue(undefined);
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'status') return { stdout: ' M src/app.ts\n', stderr: '' };
        if (args.includes('--show-current')) return { stdout: 'task/15-feature\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await removeWorktree('/repo', 15, { force: true });

      expect(result.success).toBe(true);
    });

    it('succeeds even if branch deletion fails', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('--show-current')) return { stdout: 'task/15-feature\n', stderr: '' };
        if (args.includes('-D')) throw new Error('branch not found');
        return { stdout: '', stderr: '' };
      });

      const result = await removeWorktree('/repo', 15);

      expect(result.success).toBe(true);
    });

    it('returns error when worktree removal fails', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('--show-current')) return { stdout: 'task/15-feature\n', stderr: '' };
        if (args.includes('worktree') && args.includes('remove')) {
          throw new Error('worktree not found');
        }
        return { stdout: '', stderr: '' };
      });

      const result = await removeWorktree('/repo', 15);

      expect(result.success).toBe(false);
      expect(result.error).toContain('worktree not found');
    });
  });

  describe('getWorktreeStatus', () => {
    it('returns ahead/behind counts', async () => {
      vi.mocked(mockAccess).mockResolvedValue(undefined);
      withDispatch(async (_cmd, args) => {
        if (args.includes('--show-current')) return { stdout: 'task/10-feature\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('rev-list')) return { stdout: '2\t5\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await getWorktreeStatus('/repo', 10);

      expect(result.success).toBe(true);
      expect(result.branch).toBe('task/10-feature');
      expect(result.ahead).toBe(5);
      expect(result.behind).toBe(2);
      expect(result.worktreePath).toBe('/repo-worktrees/task-10');
    });

    it('counts against the given base branch and echoes it back', async () => {
      mockAccess.mockResolvedValue(undefined);
      withDispatch(async (_cmd, args) => {
        if (args.includes('--show-current')) return { stdout: 'task/10-feature\n', stderr: '' };
        if (args[0] === 'rev-list') return { stdout: '2\t5\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await getWorktreeStatus('/repo', 10, 'epic/8-nimbus');

      expect(result.behind).toBe(2);
      expect(result.ahead).toBe(5);
      expect(result.baseBranch).toBe('epic/8-nimbus');
      // Kept as an alias so the existing worktree panel keeps rendering.
      expect(result.mainBranch).toBe('epic/8-nimbus');
      const revList = mockRunCommand.mock.calls.find((c) => (c[1] as string[])[0] === 'rev-list');
      expect(revList![1]).toContain('origin/epic/8-nimbus...HEAD');
    });

    it('handles worktree not existing', async () => {
      vi.mocked(mockAccess).mockRejectedValue(new Error('ENOENT'));

      const result = await getWorktreeStatus('/repo', 99);

      expect(result.success).toBe(false);
    });
  });

  describe('syncWithBase', () => {
    it('merges the repo default branch when no base is given', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await syncWithBase('/repo', 10);

      expect(result.success).toBe(true);
      const mergeCall = mockRunCommand.mock.calls.find((c) => (c[1] as string[])[0] === 'merge');
      expect(mergeCall![1]).toEqual(['merge', 'origin/main']);
    });

    it('merges the given base branch without consulting the repo default', async () => {
      withDispatch(async () => ({ stdout: '', stderr: '' }));

      const result = await syncWithBase('/repo', 10, 'epic/8-nimbus');

      expect(result.success).toBe(true);
      const mergeCall = mockRunCommand.mock.calls.find((c) => (c[1] as string[])[0] === 'merge');
      expect(mergeCall![1]).toEqual(['merge', 'origin/epic/8-nimbus']);
      expect(
        mockRunCommand.mock.calls.some((c) => (c[1] as string[]).includes('symbolic-ref')),
      ).toBe(false);
    });

    it('aborts the merge on conflict so the worktree is never left mid-merge', async () => {
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'merge' && args[1] !== '--abort') throw new Error('merge conflict');
        return { stdout: '', stderr: '' };
      });

      const result = await syncWithBase('/repo', 10, 'epic/8-nimbus');

      expect(result.success).toBe(false);
      expect(result.error).toContain('merge conflict');
      expect(mockRunCommand).toHaveBeenCalledWith(
        'git',
        ['merge', '--abort'],
        expect.objectContaining({ cwd: '/repo-worktrees/task-10' }),
      );
    });

    it('swallows a failing merge --abort (nothing was in progress)', async () => {
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'fetch') throw new Error('network down');
        if (args[0] === 'merge' && args[1] === '--abort') throw new Error('no merge in progress');
        return { stdout: '', stderr: '' };
      });

      const result = await syncWithBase('/repo', 10, 'epic/8-nimbus');

      expect(result.success).toBe(false);
      expect(result.error).toContain('network down');
    });
  });

  describe('createPullRequest', () => {
    it('passes title and body as separate argv elements — no shell escaping', async () => {
      let capturedTitle: string | undefined;
      let capturedBody: string | undefined;

      withDispatch(async (cmd, args) => {
        if (args.includes('--show-current')) return { stdout: 'task/1-test\n', stderr: '' };
        if (cmd === 'gh' && args.includes('create')) {
          const titleIdx = args.indexOf('--title');
          const bodyIdx = args.indexOf('--body');
          capturedTitle = args[titleIdx + 1];
          capturedBody = args[bodyIdx + 1];
          return { stdout: 'https://github.com/u/r/pull/1\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const adversarialTitle = 'task $(whoami) `id` "quoted"';
      const adversarialBody = "It's $(rm -rf ~) \"quoted\" `evil`";

      const result = await createPullRequest('/repo', 1, adversarialTitle, adversarialBody);

      expect(result.success).toBe(true);
      expect(capturedTitle).toBe(adversarialTitle);
      expect(capturedBody).toBe(adversarialBody);
    });

    it('targets the given base branch with --base', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('--show-current')) return { stdout: 'task/1-test\n', stderr: '' };
        return { stdout: 'https://github.com/o/r/pull/1\n', stderr: '' };
      });

      const result = await createPullRequest('/repo', 1, 'Title', 'Body', 'epic/8-nimbus');

      expect(result.success).toBe(true);
      const prCall = mockRunCommand.mock.calls.find((c) => c[0] === 'gh')!;
      expect(prCall[1]).toEqual([
        'pr',
        'create',
        '--title',
        'Title',
        '--body',
        'Body',
        '--base',
        'epic/8-nimbus',
      ]);
    });

    it('omits --base when no base branch is given', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('--show-current')) return { stdout: 'task/1-test\n', stderr: '' };
        return { stdout: 'https://github.com/o/r/pull/1\n', stderr: '' };
      });

      await createPullRequest('/repo', 1, 'Title', 'Body');

      const prCall = mockRunCommand.mock.calls.find((c) => c[0] === 'gh')!;
      expect(prCall[1]).not.toContain('--base');
    });

    it('returns error on gh CLI failure', async () => {
      withDispatch(async (cmd, args) => {
        if (args.includes('--show-current')) return { stdout: 'task/10-feature\n', stderr: '' };
        if (cmd === 'gh') throw new Error('gh: not authenticated');
        return { stdout: '', stderr: '' };
      });

      const result = await createPullRequest('/repo', 10, 'Title', 'Body');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not authenticated');
    });

    it('refuses to proceed if branch name is missing', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('--show-current')) return { stdout: '\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await createPullRequest('/repo', 1, 'Title', 'Body');

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/branch/i);
    });
  });

  describe('getPullRequestStatus', () => {
    it('returns PR status when PR exists', async () => {
      withDispatch(async () => ({
        stdout: JSON.stringify({
          url: 'https://github.com/user/repo/pull/123',
          state: 'OPEN',
          mergeable: 'MERGEABLE',
        }),
        stderr: '',
      }));

      const result = await getPullRequestStatus('/repo', 10);

      expect(result.success).toBe(true);
      expect(result.exists).toBe(true);
      expect(result.url).toBe('https://github.com/user/repo/pull/123');
      expect(result.state).toBe('OPEN');
      expect(result.mergeable).toBe('MERGEABLE');
    });

    it('returns exists:false when no PR', async () => {
      withDispatch(async () => {
        throw new Error('no pull request found');
      });

      const result = await getPullRequestStatus('/repo', 10);

      expect(result.success).toBe(true);
      expect(result.exists).toBe(false);
    });
  });

  describe('mergeAndCleanup', () => {
    const openPr = {
      url: 'https://github.com/o/r/pull/10',
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      headRefName: 'task/10-feature',
      baseRefName: 'main',
      mergeCommit: null,
      mergedAt: null,
    };
    const mergedPr = {
      ...openPr,
      state: 'MERGED',
      mergeCommit: { oid: 'abc123' },
      mergedAt: '2026-08-24T12:00:00Z',
    };

    it('queries a durable PR URL from the main checkout', async () => {
      withDispatch(async () => ({ stdout: JSON.stringify(mergedPr), stderr: '' }));

      const result = await getPullRequestStatusByUrl('/repo', openPr.url);

      expect(result).toMatchObject({
        success: true,
        exists: true,
        state: 'MERGED',
        headBranch: 'task/10-feature',
        baseBranch: 'main',
        mergeCommitSha: 'abc123',
      });
      expect(mockRunCommand).toHaveBeenCalledWith(
        'gh',
        ['pr', 'view', openPr.url, '--json', expect.stringContaining('mergeCommit')],
        { cwd: '/repo' },
      );
    });

    it('treats an ambiguous merge error as success when GitHub says MERGED', async () => {
      let viewCount = 0;
      withDispatch(async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return { stdout: JSON.stringify(viewCount++ === 0 ? openPr : mergedPr), stderr: '' };
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
          throw new Error('response timed out');
        }
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      });

      const result = await mergePullRequest('/repo', openPr.url);

      expect(result).toMatchObject({ success: true, merged: true, state: 'MERGED' });
    });

    it('does not retry or re-merge a PR already reported MERGED', async () => {
      withDispatch(async () => ({ stdout: JSON.stringify(mergedPr), stderr: '' }));

      const result = await mergePullRequest('/repo', openPr.url);

      expect(result.merged).toBe(true);
      expect(mockRunCommand).toHaveBeenCalledTimes(1);
    });

    it('returns the real merge error while the PR remains open', async () => {
      withDispatch(async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return { stdout: JSON.stringify(openPr), stderr: '' };
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
          throw new Error('PR is not mergeable');
        }
        throw new Error('unexpected command');
      });

      const result = await mergePullRequest('/repo', openPr.url);

      expect(result).toMatchObject({ success: false, merged: false });
      expect(result.error).toContain('not mergeable');
    });

    it('does not complete from a zero exit until GitHub confirms MERGED', async () => {
      withDispatch(async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return { stdout: JSON.stringify(openPr), stderr: '' };
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
          return { stdout: 'auto-merge enabled', stderr: '' };
        }
        throw new Error('unexpected command');
      });

      const result = await mergePullRequest('/repo', openPr.url);

      expect(result).toMatchObject({ success: false, merged: false, state: 'OPEN' });
      expect(result.error).toContain('has not confirmed');
    });

    it('gives large worktree removal its own ten-minute deadline', async () => {
      mockExistsSync.mockReturnValue(true);
      const calls: Array<[string, readonly string[], Record<string, unknown> | undefined]> = [];
      mockRunCommand.mockImplementation(
        async (cmd: string, args: readonly string[], options?: Record<string, unknown>) => {
          calls.push([cmd, args, options]);
          if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
          return { stdout: '', stderr: '' };
        },
      );

      const result = await cleanupMergedWorktree('/repo', 10, 'task/10-feature', 'main');

      expect(result.success).toBe(true);
      expect(calls).toContainEqual([
        'git',
        ['worktree', 'remove', '/repo-worktrees/task-10', '--force'],
        { cwd: '/repo', timeout: 600_000 },
      ]);
    });

    it('reports cleanup failure without changing the already-merged fact', async () => {
      mockExistsSync.mockReturnValue(true);
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'worktree') throw new Error('cleanup timed out');
        return { stdout: '', stderr: '' };
      });

      const result = await cleanupMergedWorktree('/repo', 10, 'task/10-feature', 'main');

      expect(result).toEqual({ success: false, error: 'cleanup timed out' });
    });

    it('keeps the compatibility wrapper safe before touching GitHub', async () => {
      mockAccess.mockResolvedValue(undefined);
      const calls: string[][] = [];
      withDispatch(async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[0] === 'status') return { stdout: '', stderr: '' };
        if (args.includes('--show-current')) return { stdout: 'task/10-feature\n', stderr: '' };
        if (args[0] === 'for-each-ref') return { stdout: 'refs/remotes/origin/main', stderr: '' };
        if (args[0] === 'rev-list') return { stdout: '2\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      await expect(mergeAndCleanup('/repo', 10)).rejects.toMatchObject({
        code: 'worktree-has-unsaved-work',
        safety: { dirtyFiles: 0, unpushedCommits: 2 },
      });
      expect(calls.some((c) => c[0] === 'gh')).toBe(false);
    });

    // Checked *before* `gh pr merge`: the merge lands the branch's remote head,
    // so refusing afterwards would leave the PR merged and the work stranded.
    it('refuses to merge before touching the PR when work is unpushed', async () => {
      mockAccess.mockResolvedValue(undefined);
      const calls: string[][] = [];
      withDispatch(async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[0] === 'status') return { stdout: '', stderr: '' };
        if (args.includes('--show-current')) return { stdout: 'task/10-feature\n', stderr: '' };
        if (args[0] === 'for-each-ref') return { stdout: 'refs/remotes/origin/main', stderr: '' };
        if (args[0] === 'rev-list') return { stdout: '2\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      await expect(mergeAndCleanup('/repo', 10)).rejects.toMatchObject({
        code: 'worktree-has-unsaved-work',
        safety: { dirtyFiles: 0, unpushedCommits: 2 },
      });
      expect(calls.some((c) => c[0] === 'gh')).toBe(false);
      expect(calls.some((c) => c.join(' ').includes('worktree remove'))).toBe(false);
    });
  });

  describe('hasUncommittedChanges', () => {
    it('returns true when there are uncommitted changes', async () => {
      withDispatch(async () => ({ stdout: ' M src/file.js\n?? newfile.txt\n', stderr: '' }));

      const result = await hasUncommittedChanges('/repo', 10);

      expect(result.success).toBe(true);
      expect(result.hasChanges).toBe(true);
    });

    it('returns false when working tree is clean', async () => {
      withDispatch(async () => ({ stdout: '', stderr: '' }));

      const result = await hasUncommittedChanges('/repo', 10);

      expect(result.success).toBe(true);
      expect(result.hasChanges).toBe(false);
    });

    it('returns error when git status fails', async () => {
      withDispatch(async () => {
        throw new Error('not a git repository');
      });

      const result = await hasUncommittedChanges('/repo', 10);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not a git repository');
    });
  });

  describe('commitAllChanges (no shell escaping needed)', () => {
    it('passes the commit message verbatim as an argv element', async () => {
      let captured: string | undefined;
      withDispatch(async (cmd, args) => {
        if (cmd === 'git' && args[0] === 'commit') {
          captured = args[2]; // ['commit', '-m', <message>]
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const adversarial = '"quoted" $(rm -rf ~) `evil`\n\nbody';
      const result = await commitAllChanges('/repo', 10, adversarial);

      expect(result.success).toBe(true);
      expect(captured).toBe(adversarial);
    });
  });

  describe('pushChanges', () => {
    it('passes the validated branch to git push as a separate argv element', async () => {
      withDispatch(async (cmd, args) => {
        if (args.includes('--porcelain')) return { stdout: '', stderr: '' };
        if (args.includes('--show-current')) return { stdout: 'task/1-test\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await pushChanges('/repo', 1, 'commit msg');

      expect(result.success).toBe(true);
      const pushCall = mockRunCommand.mock.calls.find(
        (c) => c[0] === 'git' && (c[1] as string[])[0] === 'push',
      );
      expect(pushCall![1]).toEqual(['push', 'origin', 'task/1-test']);
    });
  });
});


/**
 * Who provisions a worktree.
 *
 * A worktree is only *runnable* once the gitignored files git does not carry
 * are there — dependencies, env files, runtime directories. Which files those
 * are is the project's business, not Bottega's, and git already has the right
 * mechanism: `post-checkout` runs inside `git worktree add`, with the new
 * worktree as cwd, for every worktree however it was created.
 */
describe('worktreeProvisioningMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports `hook` when the repo has an executable post-checkout hook', async () => {
    mockRunCommand.mockResolvedValue({ stdout: '/repo/.git/hooks/post-checkout\n', stderr: '' });
    mockAccess.mockResolvedValue(undefined);

    expect(await worktreeProvisioningMode('/repo')).toBe('hook');
  });

  // Detection must ask git, not guess a path: that is what makes a COMMITTED
  // hook work (`.githooks/post-checkout` + `core.hooksPath .githooks`), which
  // is the only way the mechanism travels with the repo.
  it('asks git for the path, from the repo root, so core.hooksPath is honoured', async () => {
    mockRunCommand.mockResolvedValue({ stdout: '/repo/.githooks/post-checkout\n', stderr: '' });
    mockAccess.mockResolvedValue(undefined);

    await worktreeProvisioningMode('/repo');

    expect(mockRunCommand).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/post-checkout'],
      { cwd: '/repo' },
    );
  });

  // git does not run a non-executable hook either, so neither do we.
  it('reports `none` when the hook file is not executable', async () => {
    mockRunCommand.mockResolvedValue({ stdout: '/repo/.git/hooks/post-checkout\n', stderr: '' });
    mockAccess.mockRejectedValue(new Error('EACCES'));

    expect(await worktreeProvisioningMode('/repo')).toBe('none');
  });

  it('reports `none` when there is no hook at all', async () => {
    mockRunCommand.mockResolvedValue({ stdout: '/repo/.git/hooks/post-checkout\n', stderr: '' });
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    expect(await worktreeProvisioningMode('/repo')).toBe('none');
  });

  // `--path-format` needs git >= 2.31.
  it('falls back to the relative form on an older git', async () => {
    mockRunCommand
      .mockRejectedValueOnce(new Error('unknown option `path-format`'))
      .mockResolvedValueOnce({ stdout: '.git/hooks/post-checkout\n', stderr: '' });
    mockAccess.mockResolvedValue(undefined);

    expect(await worktreeProvisioningMode('/repo')).toBe('hook');
    expect(mockRunCommand).toHaveBeenLastCalledWith(
      'git',
      ['rev-parse', '--git-path', 'hooks/post-checkout'],
      { cwd: '/repo' },
    );
  });

  it('reports `none` when git cannot answer at all', async () => {
    mockRunCommand.mockRejectedValue(new Error('not a git repository'));

    expect(await worktreeProvisioningMode('/repo')).toBe('none');
  });
});
