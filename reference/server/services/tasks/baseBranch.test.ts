import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../worktree.js', () => ({
  getDefaultBranch: vi.fn(),
}));

import { resolveBaseBranch } from './baseBranch.js';
import { getDefaultBranch } from '../worktree.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDefaultBranch).mockResolvedValue('master');
});

describe('resolveBaseBranch', () => {
  it('returns the repo default when the task has no explicit base', async () => {
    await expect(resolveBaseBranch({ base_branch: null }, '/repo')).resolves.toBe('master');
    expect(getDefaultBranch).toHaveBeenCalledWith('/repo');
  });

  it('returns the stamped base branch without touching the repo', async () => {
    await expect(
      resolveBaseBranch({ base_branch: 'epic/8-nimbus-pricing' }, '/repo'),
    ).resolves.toBe('epic/8-nimbus-pricing');
    expect(getDefaultBranch).not.toHaveBeenCalled();
  });

  it('tolerates a missing task row (falls back to the default branch)', async () => {
    await expect(resolveBaseBranch(null, '/repo')).resolves.toBe('master');
  });

  it('rejects a stamped branch name that could be read as a flag', async () => {
    await expect(
      resolveBaseBranch({ base_branch: '--upload-pack=/x' }, '/repo'),
    ).rejects.toThrow(/base branch/);
  });
});
