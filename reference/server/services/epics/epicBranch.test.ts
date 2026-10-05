import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRunCommand, mockCleanupFailedAdd } = vi.hoisted(() => ({
  mockRunCommand: vi.fn(),
  mockCleanupFailedAdd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../shell.js', () => ({ runCommand: mockRunCommand }));

vi.mock('../../database/epics.js', () => ({
  epicsDb: {
    getById: vi.fn(),
    getWithProject: vi.fn(),
    setFeatureBranch: vi.fn(),
  },
  epicTicketsDb: {
    listTickets: vi.fn(),
  },
}));

vi.mock('../worktree.js', () => ({
  getDefaultBranch: vi.fn(),
  getEpicWorktreePath: (repo: string, epicId: number) => `${repo}-worktrees/epic-${epicId}`,
  getWorktreesDir: (repo: string) => `${repo}-worktrees`,
  cleanupFailedWorktreeAdd: mockCleanupFailedAdd,
}));

const { mockAccess, mockMkdir, mockGetWorktreeSafety } = vi.hoisted(() => ({
  mockAccess: vi.fn(),
  mockMkdir: vi.fn(),
  mockGetWorktreeSafety: vi.fn(),
}));

vi.mock('fs', () => ({
  default: { promises: { access: mockAccess, mkdir: mockMkdir } },
  promises: { access: mockAccess, mkdir: mockMkdir },
}));

vi.mock('../worktreeSafety.js', () => ({
  getWorktreeSafety: mockGetWorktreeSafety,
  describeUnsavedWork: () => '2 uncommitted files',
}));

import {
  buildEpicBranchName,
  createEpicCompletionPR,
  ensureEpicFeatureBranch,
  ensureEpicDeliveryWorktree,
  removeEpicDeliveryWorktree,
  findEpicCompletionPR,
} from './epicBranch.js';
import { epicsDb, epicTicketsDb } from '../../database/epics.js';
import { getDefaultBranch } from '../worktree.js';
import type { EpicWithProject } from '../../database/epics.js';

type RunArgs = readonly string[];
type RunHandler = (cmd: string, args: RunArgs) => Promise<{ stdout: string; stderr: string }>;

function withDispatch(handler: RunHandler): void {
  mockRunCommand.mockImplementation((cmd: string, args: RunArgs) => handler(cmd, args));
}

/** Convenience: the git calls made, as `git fetch origin main`-style strings. */
function calls(): string[] {
  return mockRunCommand.mock.calls.map((c) => [c[0], ...(c[1] as string[])].join(' '));
}

const epic = { id: 8, project_id: 3, name: 'Nimbus Pricing', slug: 'nimbus-pricing' };

describe('epicBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDefaultBranch).mockResolvedValue('main');
    vi.mocked(epicsDb.getById).mockReturnValue({ ...epic, feature_branch: null } as never);
    vi.mocked(epicTicketsDb.listTickets).mockReturnValue([{ id: 41, status: 'completed' }] as never);
  });

  describe('buildEpicBranchName', () => {
    it('is `epic/{id}-{slug}` — id-unique, rename-proof', () => {
      expect(buildEpicBranchName({ id: 8, slug: 'nimbus-pricing' })).toBe('epic/8-nimbus-pricing');
    });

    it('rejects a slug that could be read as a flag', () => {
      expect(() => buildEpicBranchName({ id: 8, slug: '--upload-pack=evil' })).toThrow(/Invalid/);
    });
  });

  describe('ensureEpicFeatureBranch — first ticket of the epic', () => {
    it('creates the branch off origin/{default} and pushes it', async () => {
      let branchQueried = false;
      withDispatch(async (cmd, args) => {
        if (args[0] === 'rev-parse') throw new Error('not found'); // no local branch
        if (args[0] === 'ls-remote') {
          // Absent before the push, present after.
          const out = branchQueried ? '  sha\trefs/heads/epic/8-nimbus-pricing\n' : '';
          branchQueried = true;
          return { stdout: out, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await ensureEpicFeatureBranch('/repo', 8);

      expect(result).toEqual({ branch: 'epic/8-nimbus-pricing', created: true, pushed: true });
      expect(calls()).toContain('git fetch origin main');
      expect(calls()).toContain('git branch epic/8-nimbus-pricing origin/main');
      expect(calls()).toContain('git push -u origin epic/8-nimbus-pricing');
      expect(epicsDb.setFeatureBranch).toHaveBeenCalledWith(8, 'epic/8-nimbus-pricing');
    });

    it('falls back to the local default ref when origin/{default} is unusable', async () => {
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'rev-parse') throw new Error('not found');
        if (args[0] === 'branch' && args[2] === 'origin/main') throw new Error('unknown revision');
        if (args[0] === 'ls-remote') return { stdout: '', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      await ensureEpicFeatureBranch('/repo', 8);

      expect(calls()).toContain('git branch epic/8-nimbus-pricing main');
    });

    it('adopts a pre-existing same-named branch instead of failing', async () => {
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'rev-parse') return { stdout: 'sha\n', stderr: '' }; // already local
        if (args[0] === 'ls-remote') return { stdout: 'sha\trefs/heads/x\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await ensureEpicFeatureBranch('/repo', 8);

      expect(result).toEqual({ branch: 'epic/8-nimbus-pricing', created: false, pushed: true });
      expect(calls().some((c) => c.startsWith('git branch epic/'))).toBe(false);
    });

    it('records the branch with a warning when the push is rejected', async () => {
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'rev-parse') throw new Error('not found');
        if (args[0] === 'ls-remote') return { stdout: '', stderr: '' };
        if (args[0] === 'push') throw new Error('permission denied');
        return { stdout: '', stderr: '' };
      });

      const result = await ensureEpicFeatureBranch('/repo', 8);

      expect(result.pushed).toBe(false);
      expect(result.warning).toContain('permission denied');
      // Still recorded: the next ticket re-pushes rather than re-creating.
      expect(epicsDb.setFeatureBranch).toHaveBeenCalledWith(8, 'epic/8-nimbus-pricing');
    });

    it('degrades to a local-only branch on a repo with no origin', async () => {
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'rev-parse') throw new Error('not found');
        if (args[0] === 'ls-remote') throw new Error("'origin' does not appear to be a git repository");
        if (args[0] === 'fetch') throw new Error('no origin');
        return { stdout: '', stderr: '' };
      });

      const result = await ensureEpicFeatureBranch('/repo', 8);

      expect(result.pushed).toBe(false);
      expect(result.warning).toContain('no reachable origin');
      expect(calls().some((c) => c.startsWith('git push'))).toBe(false);
    });

    it('serializes concurrent calls so two tickets never race the creation', async () => {
      let branchCreations = 0;
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'rev-parse') throw new Error('not found');
        if (args[0] === 'branch') {
          branchCreations++;
          return { stdout: '', stderr: '' };
        }
        if (args[0] === 'ls-remote') return { stdout: '', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const [a, b] = await Promise.all([
        ensureEpicFeatureBranch('/repo', 8),
        ensureEpicFeatureBranch('/repo', 8),
      ]);

      expect(a).toEqual(b);
      expect(branchCreations).toBe(1);
      expect(epicsDb.setFeatureBranch).toHaveBeenCalledTimes(1);
    });

    it('throws for an unknown epic', async () => {
      vi.mocked(epicsDb.getById).mockReturnValue(undefined);

      await expect(ensureEpicFeatureBranch('/repo', 8)).rejects.toThrow('Epic 8 not found');
    });
  });

  describe('ensureEpicFeatureBranch — branch already recorded', () => {
    beforeEach(() => {
      vi.mocked(epicsDb.getById).mockReturnValue({
        ...epic,
        feature_branch: 'epic/8-nimbus-pricing',
      } as never);
    });

    it('is a no-op when the branch is still on origin', async () => {
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'ls-remote') return { stdout: 'sha\trefs/heads/x\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await ensureEpicFeatureBranch('/repo', 8);

      expect(result).toEqual({ branch: 'epic/8-nimbus-pricing', created: false, pushed: true });
      expect(calls()).toEqual(['git ls-remote --heads origin epic/8-nimbus-pricing']);
      expect(epicsDb.setFeatureBranch).not.toHaveBeenCalled();
    });

    it('re-pushes a branch that was deleted on origin', async () => {
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'ls-remote') return { stdout: '', stderr: '' };
        if (args[0] === 'rev-parse') return { stdout: 'sha\n', stderr: '' }; // still local
        return { stdout: '', stderr: '' };
      });

      const result = await ensureEpicFeatureBranch('/repo', 8);

      expect(result.pushed).toBe(true);
      expect(calls()).toContain('git push -u origin epic/8-nimbus-pricing');
    });

    it('keeps the local branch with a warning when origin is unreachable', async () => {
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'ls-remote') throw new Error('network down');
        if (args[0] === 'rev-parse') return { stdout: 'sha\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await ensureEpicFeatureBranch('/repo', 8);

      expect(result.pushed).toBe(false);
      expect(result.warning).toContain('Could not reach origin');
      expect(calls().some((c) => c.startsWith('git push'))).toBe(false);
    });

    it('recreates loudly when the branch is gone from both sides', async () => {
      let seenRevParse = 0;
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'ls-remote') return { stdout: '', stderr: '' };
        if (args[0] === 'rev-parse') {
          seenRevParse++;
          throw new Error('not found');
        }
        return { stdout: '', stderr: '' };
      });

      const result = await ensureEpicFeatureBranch('/repo', 8);

      expect(seenRevParse).toBeGreaterThan(0);
      expect(calls()).toContain('git branch epic/8-nimbus-pricing origin/main');
      expect(result.warning).toContain('was recreated');
      expect(result.warning).toContain('not included');
    });
  });

  describe('createEpicCompletionPR', () => {
    beforeEach(() => {
      vi.mocked(epicsDb.getWithProject).mockReturnValue({
        ...epic,
        feature_branch: 'epic/8-nimbus-pricing',
        repo_folder_path: '/repo',
      } as never);
    });

    it('opens feature -> default from the main checkout', async () => {
      withDispatch(async (cmd, args) => {
        if (args[0] === 'ls-remote') return { stdout: 'sha\trefs/heads/x\n', stderr: '' };
        if (args[0] === 'rev-list') return { stdout: '7\n', stderr: '' };
        if (cmd === 'gh' && args[1] === 'list') return { stdout: '[]', stderr: '' };
        if (cmd === 'gh') return { stdout: 'https://github.com/o/r/pull/42\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await createEpicCompletionPR(8, { title: 'Ship pricing' });

      expect(result).toEqual({ success: true, url: 'https://github.com/o/r/pull/42' });
      const ghCall = mockRunCommand.mock.calls.find(
        (c) => c[0] === 'gh' && (c[1] as string[])[1] === 'create',
      )!;
      expect(ghCall[1]).toEqual([
        'pr',
        'create',
        '--head',
        'epic/8-nimbus-pricing',
        '--base',
        'main',
        '--title',
        'Ship pricing',
        '--body',
        'Delivers epic #8 — Nimbus Pricing.',
      ]);
      expect(ghCall[2]).toMatchObject({ cwd: '/repo' });
    });

    it('defaults the title to the epic name', async () => {
      withDispatch(async (cmd, args) => {
        if (args[0] === 'ls-remote') return { stdout: 'sha\trefs/heads/x\n', stderr: '' };
        if (args[0] === 'rev-list') return { stdout: '1\n', stderr: '' };
        if (cmd === 'gh' && args[1] === 'list') return { stdout: '[]', stderr: '' };
        if (cmd === 'gh') return { stdout: 'url\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      await createEpicCompletionPR(8);

      const ghCall = mockRunCommand.mock.calls.find(
        (c) => c[0] === 'gh' && (c[1] as string[])[1] === 'create',
      )!;
      expect(ghCall[1]).toContain('Epic: Nimbus Pricing');
    });

    it('returns an existing open pull request instead of creating a duplicate', async () => {
      withDispatch(async (cmd, args) => {
        if (args[0] === 'ls-remote') return { stdout: 'sha\trefs/heads/x\n', stderr: '' };
        if (cmd === 'gh' && args[1] === 'list') {
          return { stdout: '[{"url":"https://github.com/o/r/pull/41"}]', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      await expect(createEpicCompletionPR(8)).resolves.toEqual({
        success: true,
        url: 'https://github.com/o/r/pull/41',
      });
      expect(calls().some((call) => call.startsWith('gh pr create'))).toBe(false);
    });

    it('refuses while any epic ticket is still unmerged', async () => {
      vi.mocked(epicTicketsDb.listTickets).mockReturnValue([
        { id: 41, status: 'completed' },
        { id: 42, status: 'in_review' },
      ] as never);

      const result = await createEpicCompletionPR(8);

      expect(result.success).toBe(false);
      expect(result.error).toContain('#42');
      expect(mockRunCommand).not.toHaveBeenCalled();
    });

    it('refuses when the feature branch has no commits beyond the default', async () => {
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'ls-remote') return { stdout: 'sha\trefs/heads/x\n', stderr: '' };
        if (args[0] === 'rev-list') return { stdout: '0\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await createEpicCompletionPR(8);

      expect(result).toEqual({ success: false, error: 'No changes to create a PR' });
      expect(calls().some((call) => call.startsWith('gh pr create'))).toBe(false);
    });

    it('refuses when the branch is not on origin', async () => {
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'ls-remote') return { stdout: '', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await createEpicCompletionPR(8);

      expect(result.success).toBe(false);
      expect(result.error).toContain('is not on origin');
    });

    it('refuses when the epic has no feature branch yet', async () => {
      vi.mocked(epicsDb.getWithProject).mockReturnValue({
        ...epic,
        feature_branch: null,
        repo_folder_path: '/repo',
      } as never);

      const result = await createEpicCompletionPR(8);

      expect(result.success).toBe(false);
      expect(result.error).toContain('no feature branch yet');
    });

    it('reports a missing epic instead of throwing', async () => {
      vi.mocked(epicsDb.getWithProject).mockReturnValue(undefined);

      await expect(createEpicCompletionPR(8)).resolves.toEqual({
        success: false,
        error: 'Epic 8 not found',
      });
    });
  });
});


// ---------------------------------------------------------------------------
// The delivery worktree
// ---------------------------------------------------------------------------

const DELIVERY_EPIC = {
  id: 8,
  project_id: 3,
  name: 'Nimbus Pricing',
  slug: 'nimbus-pricing',
  feature_branch: 'epic/8-nimbus-pricing',
  repo_folder_path: '/repos/nimbus',
} as EpicWithProject;

describe('ensureEpicDeliveryWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    withDispatch(() => Promise.resolve({ stdout: '', stderr: '' }));
  });

  it('reuses an existing worktree without touching git', async () => {
    mockAccess.mockResolvedValue(undefined);

    const path = await ensureEpicDeliveryWorktree(DELIVERY_EPIC);

    expect(path).toBe('/repos/nimbus-worktrees/epic-8');
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('checks the local feature branch out into its own worktree', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));
    withDispatch((cmd, args) => {
      if (args[0] === 'rev-parse') return Promise.resolve({ stdout: '', stderr: '' });
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const path = await ensureEpicDeliveryWorktree(DELIVERY_EPIC);

    expect(path).toBe('/repos/nimbus-worktrees/epic-8');
    expect(calls()).toContain(
      'git worktree add /repos/nimbus-worktrees/epic-8 epic/8-nimbus-pricing',
    );
    // The project's post-checkout hook runs inside the add and may do a real
    // dependency install — far more than the 30 s runCommand default allows.
    const add = mockRunCommand.mock.calls.find((c) => (c[1] as string[])[1] === 'add')!;
    expect(add[2]).toEqual({ cwd: '/repos/nimbus', timeout: 600_000 });
  });

  // A failed or timed-out post-checkout hook leaves the worktree on disk,
  // where the "already there" check would mistake it for a good one on the
  // next attempt.
  it('sweeps a half-created worktree when the add fails, then rethrows', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));
    withDispatch((_cmd, args) => {
      if (args[1] === 'add') return Promise.reject(new Error('post-checkout hook failed'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(ensureEpicDeliveryWorktree(DELIVERY_EPIC)).rejects.toThrow(
      /post-checkout hook failed/,
    );
    // branch: null — the epic's feature branch outlives any worktree.
    expect(mockCleanupFailedAdd).toHaveBeenCalledWith(
      '/repos/nimbus',
      '/repos/nimbus-worktrees/epic-8',
      null,
    );
  });

  // A fresh clone, or a branch created on another machine: only origin has it.
  it('creates a tracking branch when only origin has the branch', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));
    withDispatch((cmd, args) => {
      if (args[0] === 'rev-parse') return Promise.reject(new Error('unknown revision'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await ensureEpicDeliveryWorktree(DELIVERY_EPIC);

    expect(calls()).toContain(
      'git worktree add /repos/nimbus-worktrees/epic-8 -b epic/8-nimbus-pricing origin/epic/8-nimbus-pricing',
    );
  });

  it('refuses an epic that has no feature branch yet', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    await expect(
      ensureEpicDeliveryWorktree({ ...DELIVERY_EPIC, feature_branch: null }),
    ).rejects.toThrow(/no feature branch yet/);
  });

  // A webhook comment landing while the user clicks "New conversation" would
  // otherwise race two `git worktree add` calls onto the same path.
  it('serializes concurrent callers onto one creation', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    const [a, b] = await Promise.all([
      ensureEpicDeliveryWorktree(DELIVERY_EPIC),
      ensureEpicDeliveryWorktree(DELIVERY_EPIC),
    ]);

    expect(a).toBe(b);
    expect(calls().filter((c) => c.includes('worktree add'))).toHaveLength(1);
  });
});

describe('removeEpicDeliveryWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withDispatch(() => Promise.resolve({ stdout: '', stderr: '' }));
    mockGetWorktreeSafety.mockResolvedValue({ clean: true, dirtyFiles: 0, unpushedCommits: 0 });
  });

  it('does nothing when there is no worktree', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    expect(await removeEpicDeliveryWorktree('/repos/nimbus', 8)).toEqual({ removed: false });
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  // The branch is what the final pull request merges: it outlives the
  // worktree, the epic row, and this call. `removeWorktree` deletes a ticket's
  // branch; this one must not.
  it('removes the worktree and never the branch', async () => {
    mockAccess.mockResolvedValue(undefined);

    expect(await removeEpicDeliveryWorktree('/repos/nimbus', 8)).toEqual({ removed: true });
    expect(calls()).toEqual([
      'git worktree remove /repos/nimbus-worktrees/epic-8 --force',
    ]);
  });

  it('refuses to destroy unsaved work unless forced', async () => {
    mockAccess.mockResolvedValue(undefined);
    mockGetWorktreeSafety.mockResolvedValue({ clean: false, dirtyFiles: 2, unpushedCommits: 0 });

    const result = await removeEpicDeliveryWorktree('/repos/nimbus', 8);

    expect(result.removed).toBe(false);
    expect(result.error).toMatch(/2 uncommitted files/);
    expect(mockRunCommand).not.toHaveBeenCalled();

    expect(await removeEpicDeliveryWorktree('/repos/nimbus', 8, { force: true })).toEqual({
      removed: true,
    });
  });
});

describe('findEpicCompletionPR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDefaultBranch).mockResolvedValue('main');
  });

  it('returns the open pull request for the feature branch', async () => {
    withDispatch(() =>
      Promise.resolve({ stdout: '[{"url":"https://github.com/acme/x/pull/148"}]', stderr: '' }),
    );

    expect(await findEpicCompletionPR(DELIVERY_EPIC)).toBe('https://github.com/acme/x/pull/148');
  });

  it('returns null when there is none', async () => {
    withDispatch(() => Promise.resolve({ stdout: '[]', stderr: '' }));

    expect(await findEpicCompletionPR(DELIVERY_EPIC)).toBeNull();
  });

  // Best-effort: this only decides what the delivery agent is TOLD it is
  // working on, so a repo with no `gh` must not stop a conversation starting.
  it('degrades to null when gh or the remote is unavailable', async () => {
    withDispatch(() => Promise.reject(new Error('gh: command not found')));

    expect(await findEpicCompletionPR(DELIVERY_EPIC)).toBeNull();
  });

  it('returns null for an epic with no feature branch', async () => {
    expect(
      await findEpicCompletionPR({ ...DELIVERY_EPIC, feature_branch: null }),
    ).toBeNull();
    expect(mockRunCommand).not.toHaveBeenCalled();
  });
});
