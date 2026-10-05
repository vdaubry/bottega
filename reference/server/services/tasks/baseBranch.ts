// What a task branches from and merges into — a task property, not an epic
// lookup (architecture-v2 step 3). `tasks.base_branch` is stamped at creation
// by whoever creates the task (the epic layer passes its feature branch);
// NULL means the repo's actual default branch, resolved here — `main` on some
// repos, `master` on others, never assumed.

import { getDefaultBranch } from '../worktree.js';
import { assertValidBranchName } from '../validators.js';
import type { TaskRow } from '@shared/types/db';

export async function resolveBaseBranch(
  task: Pick<TaskRow, 'base_branch'> | null | undefined,
  repoPath: string,
): Promise<string> {
  if (task?.base_branch) {
    return assertValidBranchName(task.base_branch, 'base branch');
  }
  return assertValidBranchName(await getDefaultBranch(repoPath), 'default branch');
}
