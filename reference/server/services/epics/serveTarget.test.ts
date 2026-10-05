import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../database/epics.js', () => ({
  epicsDb: { getWithProject: vi.fn(), getById: vi.fn() },
}));

vi.mock('./epicBranch.js', () => ({
  ensureEpicDeliveryWorktree: vi.fn(),
}));

vi.mock('../webServerManager.js', () => ({
  registerEpicServeResolver: vi.fn(),
}));

import { epicServeResolver, registerEpicServeTargetResolver } from './serveTarget.js';
import { epicsDb } from '../../database/epics.js';
import { ensureEpicDeliveryWorktree } from './epicBranch.js';
import { registerEpicServeResolver } from '../webServerManager.js';

const EPIC = {
  id: 8,
  project_id: 3,
  name: 'Nimbus Pricing',
  feature_branch: 'epic/8-nimbus-pricing',
  repo_folder_path: '/repos/nimbus',
};

describe('epicServeResolver.resolveEpicServeTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(epicsDb.getWithProject).mockReturnValue(EPIC as never);
    vi.mocked(ensureEpicDeliveryWorktree).mockResolvedValue('/repos/nimbus-worktrees/epic-8');
  });

  // The feature branch is the only place every merged ticket exists together —
  // each ticket's own worktree is deleted when it merges.
  it('serves the epic delivery worktree, and names the epic', async () => {
    const result = await epicServeResolver.resolveEpicServeTarget(8, 3);

    expect(result).toEqual({
      worktreePath: '/repos/nimbus-worktrees/epic-8',
      name: 'Nimbus Pricing',
    });
    expect(ensureEpicDeliveryWorktree).toHaveBeenCalledWith(EPIC);
  });

  // "Talk to the delivery agent before you may preview the epic" would be a
  // nonsense precondition, so the first switch creates the worktree.
  it('creates the worktree on the first switch, before any delivery run', async () => {
    await epicServeResolver.resolveEpicServeTarget(8, 3);

    expect(ensureEpicDeliveryWorktree).toHaveBeenCalledTimes(1);
  });

  it('refuses an epic that does not exist', async () => {
    vi.mocked(epicsDb.getWithProject).mockReturnValue(undefined);

    await expect(epicServeResolver.resolveEpicServeTarget(8, 3)).rejects.toThrow('Epic not found');
    expect(ensureEpicDeliveryWorktree).not.toHaveBeenCalled();
  });

  // The switch is authorized by project membership; this is what stops a
  // member of project A pointing A's symlink at project B's worktree.
  it('refuses an epic belonging to another project', async () => {
    await expect(epicServeResolver.resolveEpicServeTarget(8, 999)).rejects.toThrow(
      /does not belong to this project/,
    );
    expect(ensureEpicDeliveryWorktree).not.toHaveBeenCalled();
  });

  it('refuses an epic with no feature branch to check out', async () => {
    vi.mocked(epicsDb.getWithProject).mockReturnValue({
      ...EPIC,
      feature_branch: null,
    } as never);

    await expect(epicServeResolver.resolveEpicServeTarget(8, 3)).rejects.toThrow(
      /no feature branch yet/,
    );
    expect(ensureEpicDeliveryWorktree).not.toHaveBeenCalled();
  });
});

describe('epicServeResolver.epicName', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the name without creating anything', () => {
    vi.mocked(epicsDb.getById).mockReturnValue({ id: 8, name: 'Nimbus Pricing' } as never);

    expect(epicServeResolver.epicName(8)).toBe('Nimbus Pricing');
    expect(ensureEpicDeliveryWorktree).not.toHaveBeenCalled();
  });

  it('answers null for an epic that has been deleted', () => {
    vi.mocked(epicsDb.getById).mockReturnValue(undefined);

    expect(epicServeResolver.epicName(8)).toBeNull();
  });
});

describe('registerEpicServeTargetResolver', () => {
  it('wires the epic domain into the switch-server service', () => {
    registerEpicServeTargetResolver();

    expect(registerEpicServeResolver).toHaveBeenCalledWith(epicServeResolver);
  });
});
