import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./worktree.js', () => ({
  hasUncommittedChanges: vi.fn(),
  commitAllChanges: vi.fn(),
  createPullRequest: vi.fn(),
  getPullRequestStatus: vi.fn(),
  getWorktreeStatus: vi.fn(),
  getWorktreePath: vi.fn((repo: string, taskId: number) => `${repo}-worktrees/task-${taskId}`),
}));

// Only the git-touching probe is faked; describeUnsavedWork / MAX_LISTED_FILES
// stay real so the summary strings under test are the ones users see.
vi.mock('./worktreeSafety.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./worktreeSafety.js')>()),
  getWorktreeSafety: vi.fn(),
}));

vi.mock('./tasks/baseBranch.js', () => ({
  resolveBaseBranch: vi.fn(),
}));

vi.mock('../database/db.js', () => ({
  tasksDb: { getById: vi.fn(), getWithProject: vi.fn() },
}));

import {
  createOrUpdatePR,
  getCIStatusWithDetails,
  shouldRunPrAgent,
  getTaskPublishState,
} from './prService.js';
import {
  hasUncommittedChanges,
  commitAllChanges,
  createPullRequest,
  getPullRequestStatus,
  getWorktreeStatus,
} from './worktree.js';
import { getWorktreeSafety } from './worktreeSafety.js';
import { resolveBaseBranch } from './tasks/baseBranch.js';
import { tasksDb } from '../database/db.js';

describe('prService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: false });
    vi.mocked(getWorktreeStatus).mockResolvedValue({ success: true, ahead: 2, behind: 0 });
    vi.mocked(createPullRequest).mockResolvedValue({ success: true, url: 'https://pr/1' });
    vi.mocked(tasksDb.getById).mockReturnValue({ id: 1, epic_id: null } as never);
    vi.mocked(tasksDb.getWithProject).mockReturnValue({
      id: 1,
      repo_folder_path: '/repo',
      subproject_path: 'apps/web',
    } as never);
    vi.mocked(resolveBaseBranch).mockResolvedValue('main');
  });

  describe('createOrUpdatePR', () => {
    it('measures ahead-ness against the resolved base and targets it with --base', async () => {
      vi.mocked(tasksDb.getById).mockReturnValue({ id: 1, epic_id: 8 } as never);
      vi.mocked(resolveBaseBranch).mockResolvedValue('epic/8-nimbus');

      const result = await createOrUpdatePR('/repo', 1, 'Title', 'Body');

      expect(result).toEqual({ success: true, url: 'https://pr/1' });
      expect(resolveBaseBranch).toHaveBeenCalledWith(
        expect.objectContaining({ epic_id: 8 }),
        '/repo',
      );
      expect(getWorktreeStatus).toHaveBeenCalledWith('/repo', 1, 'epic/8-nimbus');
      expect(createPullRequest).toHaveBeenCalledWith('/repo', 1, 'Title', 'Body', 'epic/8-nimbus');
    });

    it('still resolves a base when the task row has vanished', async () => {
      vi.mocked(tasksDb.getById).mockReturnValue(undefined);

      await createOrUpdatePR('/repo', 1, 'Title', 'Body');

      expect(resolveBaseBranch).toHaveBeenCalledWith(undefined, '/repo');
      expect(createPullRequest).toHaveBeenCalledWith('/repo', 1, 'Title', 'Body', 'main');
    });

    it('commits uncommitted changes with the PR title first', async () => {
      vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: true });
      vi.mocked(commitAllChanges).mockResolvedValue({ success: true });

      await createOrUpdatePR('/repo', 1, 'Add pricing', 'Body');

      expect(commitAllChanges).toHaveBeenCalledWith('/repo', 1, 'Add pricing');
    });

    it('aborts when the commit fails', async () => {
      vi.mocked(hasUncommittedChanges).mockResolvedValue({ success: true, hasChanges: true });
      vi.mocked(commitAllChanges).mockResolvedValue({ success: false, error: 'hook rejected' });

      const result = await createOrUpdatePR('/repo', 1, 'Title', 'Body');

      expect(result.success).toBe(false);
      expect(result.error).toContain('hook rejected');
      expect(createPullRequest).not.toHaveBeenCalled();
    });

    it('refuses when there is nothing ahead of the base branch', async () => {
      vi.mocked(getWorktreeStatus).mockResolvedValue({ success: true, ahead: 0, behind: 3 });

      const result = await createOrUpdatePR('/repo', 1, 'Title', 'Body');

      expect(result).toEqual({ success: false, error: 'No changes to create a PR' });
      expect(createPullRequest).not.toHaveBeenCalled();
    });
  });

  describe('getCIStatusWithDetails', () => {
    it('returns the PR snapshot when a PR exists', async () => {
      vi.mocked(getPullRequestStatus).mockResolvedValue({
        success: true,
        exists: true,
        url: 'https://pr/1',
        mergeable: 'MERGEABLE',
        ciStatus: { status: 'passed', checks: [] },
      });

      await expect(getCIStatusWithDetails('/repo', 1)).resolves.toEqual({
        success: true,
        url: 'https://pr/1',
        mergeable: 'MERGEABLE',
        ciStatus: { status: 'passed', checks: [] },
      });
    });

    it('reports "No PR found" when there is none', async () => {
      vi.mocked(getPullRequestStatus).mockResolvedValue({ success: true, exists: false });

      await expect(getCIStatusWithDetails('/repo', 1)).resolves.toEqual({
        success: false,
        error: 'No PR found',
      });
    });
  });

  // The PR stage is the last turn that touches a worktree that gets deleted when
  // the PR merges, so "clean enough to delete" is the condition for signing it
  // off — the same question worktreeSafety answers for the destructive paths,
  // asked at the other end of the lifecycle.
  describe('getTaskPublishState', () => {
    const clean = {
      clean: true,
      files: [],
      dirtyFiles: 0,
      unpushedCommits: 0,
      branch: 'task/1-x',
    };

    it('is published on a worktree with nothing dirty and nothing unpushed', async () => {
      vi.mocked(getWorktreeSafety).mockResolvedValue(clean);

      await expect(getTaskPublishState(1)).resolves.toMatchObject({
        published: true,
        worktreePath: '/repo-worktrees/task-1',
        summary: 'no unsaved work',
      });
    });

    it('is unpublished on uncommitted files alone', async () => {
      vi.mocked(getWorktreeSafety).mockResolvedValue({
        ...clean,
        clean: false,
        files: ['src/a.ts', 'screenshot.png'],
        dirtyFiles: 2,
      });

      await expect(getTaskPublishState(1)).resolves.toMatchObject({
        published: false,
        files: ['src/a.ts', 'screenshot.png'],
        summary: '2 uncommitted files',
      });
    });

    it('is unpublished on unpushed commits alone — a clean tree is not enough', async () => {
      vi.mocked(getWorktreeSafety).mockResolvedValue({ ...clean, clean: false, unpushedCommits: 3 });

      await expect(getTaskPublishState(1)).resolves.toMatchObject({
        published: false,
        dirtyFiles: 0,
        unpushedCommits: 3,
        summary: '3 unpushed commits',
      });
    });

    it('inspects the worktree root, not the monorepo subproject path', async () => {
      vi.mocked(getWorktreeSafety).mockResolvedValue(clean);

      await getTaskPublishState(1);

      // A byproduct dropped one directory up is exactly as lost.
      expect(getWorktreeSafety).toHaveBeenCalledWith('/repo-worktrees/task-1');
    });

    it('reports published when the task row is gone — nothing left to publish', async () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      await expect(getTaskPublishState(404)).resolves.toMatchObject({
        published: true,
        worktreePath: null,
      });
      expect(getWorktreeSafety).not.toHaveBeenCalled();
    });
  });

  describe('shouldRunPrAgent', () => {
    it('is true only once the workflow completed and the PR agent has not run', () => {
      expect(shouldRunPrAgent({ workflow_complete: 1, pr_agent_complete: 0 })).toBe(true);
      expect(shouldRunPrAgent({ workflow_complete: 1, pr_agent_complete: 1 })).toBe(false);
      expect(shouldRunPrAgent({ workflow_complete: 0, pr_agent_complete: 0 })).toBe(false);
    });
  });
});
