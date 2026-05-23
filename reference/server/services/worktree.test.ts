import { describe, it, expect, beforeEach, vi } from 'vitest';

// Use vi.hoisted so `vi.mock` can reach the mock function before module init.
const { mockRunCommand, mockAccess, mockMkdir, mockSymlink, mockExistsSync } = vi.hoisted(
  () => ({
    mockRunCommand: vi.fn(),
    mockAccess: vi.fn(),
    mockMkdir: vi.fn(),
    mockSymlink: vi.fn(),
    mockExistsSync: vi.fn(),
  }),
);

// Mock the central shell helper. Every shell-out in worktree.ts is now
// supposed to flow through runCommand(cmd, args[], opts), so we can assert
// on (cmd, args) shape directly — and adversarial inputs end up as argv
// elements, never interpreted by a shell.
vi.mock('./shell.js', () => ({
  runCommand: mockRunCommand,
}));

// Mock fs
vi.mock('fs', () => ({
  default: {
    existsSync: mockExistsSync,
    promises: {
      access: mockAccess,
      mkdir: mockMkdir,
      symlink: mockSymlink,
    },
  },
  existsSync: mockExistsSync,
  promises: {
    access: mockAccess,
    mkdir: mockMkdir,
    symlink: mockSymlink,
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
  syncWithMain,
  createPullRequest,
  getPullRequestStatus,
  mergeAndCleanup,
  hasUncommittedChanges,
  commitAllChanges,
  pushChanges,
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

    it('symlinks .env when it exists in the main repo', async () => {
      vi.mocked(mockSymlink).mockResolvedValue(undefined);
      vi.mocked(mockExistsSync).mockImplementation((p) => p === '/repo/.env');
      withDispatch(async (_cmd, args) => {
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await createWorktree('/repo', 1, 'Test');

      expect(result.success).toBe(true);
      expect(mockSymlink).toHaveBeenCalledWith('/repo/.env', '/repo-worktrees/task-1/.env');
    });

    it('does not overwrite an existing worktree .env', async () => {
      vi.mocked(mockExistsSync).mockImplementation(
        (p) => p === '/repo/.env' || p === '/repo-worktrees/task-1/.env',
      );
      withDispatch(async (_cmd, args) => {
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await createWorktree('/repo', 1, 'Test');

      expect(result.success).toBe(true);
      expect(mockSymlink).not.toHaveBeenCalled();
    });

    it('fires background cp -a for node_modules when source exists', async () => {
      vi.mocked(mockExistsSync).mockImplementation((p) => p === '/repo/node_modules');
      withDispatch(async (_cmd, args) => {
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      await createWorktree('/repo', 1, 'Test');

      const cpCall = mockRunCommand.mock.calls.find((c) => c[0] === 'cp');
      expect(cpCall).toBeDefined();
      expect(cpCall![1]).toEqual(['-a', '/repo/node_modules', '/repo-worktrees/task-1/node_modules']);
    });

    it('does not block worktree creation if dependency copy fails', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(mockExistsSync).mockImplementation((p) => p === '/repo/node_modules');

      withDispatch(async (cmd) => {
        if (cmd === 'cp') throw new Error('No space left on device');
        return { stdout: 'main\n', stderr: '' };
      });

      const result = await createWorktree('/repo', 1, 'Test');

      expect(result.success).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to copy node_modules'));
      consoleSpy.mockRestore();
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

    it('handles worktree not existing', async () => {
      vi.mocked(mockAccess).mockRejectedValue(new Error('ENOENT'));

      const result = await getWorktreeStatus('/repo', 99);

      expect(result.success).toBe(false);
    });
  });

  describe('syncWithMain', () => {
    it('passes the main branch as an argv element', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await syncWithMain('/repo', 10);

      expect(result.success).toBe(true);
      const mergeCall = mockRunCommand.mock.calls.find((c) => (c[1] as string[]).includes('merge'));
      expect(mergeCall![1]).toEqual(['merge', 'origin/main']);
    });

    it('returns error on merge conflict', async () => {
      withDispatch(async (_cmd, args) => {
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('merge')) throw new Error('merge conflict');
        return { stdout: '', stderr: '' };
      });

      const result = await syncWithMain('/repo', 10);

      expect(result.success).toBe(false);
      expect(result.error).toContain('merge conflict');
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
    it('merges PR and cleans up worktree', async () => {
      const calls: string[][] = [];
      withDispatch(async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args.includes('--show-current')) return { stdout: 'task/10-feature\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await mergeAndCleanup('/repo', 10);

      expect(result.success).toBe(true);
      expect(calls.some((c) => c.join(' ').includes('gh pr merge --merge'))).toBe(true);
      expect(calls.some((c) => c.join(' ').includes('git worktree remove'))).toBe(true);
      expect(calls.some((c) => c.join(' ').includes('git branch -D task/10-feature'))).toBe(true);
      expect(calls.some((c) => c.join(' ').includes('git checkout main'))).toBe(true);
      expect(calls.some((c) => c.join(' ').includes('git pull'))).toBe(true);
    });

    it('retries merge on 502 and succeeds on second attempt', async () => {
      let mergeCallCount = 0;
      withDispatch(async (cmd, args) => {
        if (args.includes('--show-current')) return { stdout: 'task/10-feature\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        if (cmd === 'gh' && args.includes('merge')) {
          mergeCallCount++;
          if (mergeCallCount === 1) throw new Error('non-200 OK status code: 502 Bad Gateway');
          return { stdout: '', stderr: '' };
        }
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return { stdout: 'abc123\n', stderr: '' };
        }
        if (cmd === 'git' && args[0] === 'branch' && args[1] === '-r') {
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await mergeAndCleanup('/repo', 10);

      expect(result.success).toBe(true);
      expect(mergeCallCount).toBe(2);
    }, 20000);

    it('detects merge landed on main after 502 without retrying merge', async () => {
      withDispatch(async (cmd, args) => {
        if (args.includes('--show-current')) return { stdout: 'task/10-feature\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        if (cmd === 'gh' && args.includes('merge')) {
          throw new Error('non-200 OK status code: 502 Bad Gateway');
        }
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return { stdout: 'abc123\n', stderr: '' };
        }
        if (cmd === 'git' && args[0] === 'branch' && args[1] === '-r') {
          return { stdout: '  origin/main\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await mergeAndCleanup('/repo', 10);

      expect(result.success).toBe(true);
    }, 20000);

    it('returns error when non-502 merge fails without retrying', async () => {
      let mergeCallCount = 0;
      withDispatch(async (cmd, args) => {
        if (args.includes('--show-current')) return { stdout: 'task/10-feature\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'main\n', stderr: '' };
        if (cmd === 'gh' && args.includes('merge')) {
          mergeCallCount++;
          throw new Error('PR is not mergeable');
        }
        return { stdout: '', stderr: '' };
      });

      const result = await mergeAndCleanup('/repo', 10);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not mergeable');
      expect(mergeCallCount).toBe(1);
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
