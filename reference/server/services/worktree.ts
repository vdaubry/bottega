import path from 'path';
import fs from 'fs';
import { runCommand } from './shell.js';
import { assertValidBranchName } from './validators.js';

/**
 * Derive the worktree path for a task based on convention
 */
export function getWorktreePath(repoPath: string, taskId: number): string {
  return path.join(`${repoPath}-worktrees`, `task-${taskId}`);
}

/**
 * Get the project path within a worktree (for monorepos)
 */
export function getWorktreeProjectPath(
  repoPath: string,
  taskId: number,
  subprojectPath: string | null,
): string {
  const worktreePath = getWorktreePath(repoPath, taskId);
  if (subprojectPath) {
    return path.join(worktreePath, subprojectPath);
  }
  return worktreePath;
}

/**
 * Get the worktrees directory for a repository
 */
export function getWorktreesDir(repoPath: string): string {
  return `${repoPath}-worktrees`;
}

/**
 * Check if a worktree exists for a task
 */
export async function worktreeExists(repoPath: string, taskId: number): Promise<boolean> {
  const worktreePath = getWorktreePath(repoPath, taskId);
  try {
    await fs.promises.access(worktreePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path is a git repository
 */
export async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    await runCommand('git', ['rev-parse', '--git-dir'], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the default branch name (main or master).
 *
 * Previously this was a single `exec` with a shell `||` fallback. Now the
 * fallback lives in JS so we don't need a shell at all.
 */
export async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await runCommand(
      'git',
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      { cwd: repoPath },
    );
    return stdout.trim().replace('refs/remotes/origin/', '');
  } catch {
    // fall through to the abbrev-ref attempt
  }
  try {
    const { stdout } = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoPath,
    });
    return stdout.trim().replace('refs/remotes/origin/', '');
  } catch {
    return 'main';
  }
}

/**
 * Get the current branch name from a worktree
 */
export async function getBranchName(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await runCommand('git', ['branch', '--show-current'], {
      cwd: worktreePath,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function sanitizeTitle(title: string | null | undefined): string {
  return (title || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

async function symlinkEnvFiles(
  projectPath: string,
  worktreePath: string,
  subprojectPath: string | null,
): Promise<void> {
  const envFiles = ['.env', '.env.local', '.env.development', '.env.development.local'];

  const srcBase = subprojectPath ? path.join(projectPath, subprojectPath) : projectPath;
  const destBase = subprojectPath ? path.join(worktreePath, subprojectPath) : worktreePath;

  for (const file of envFiles) {
    const srcPath = path.join(srcBase, file);
    const destPath = path.join(destBase, file);

    if (!fs.existsSync(srcPath)) {
      continue;
    }

    if (fs.existsSync(destPath)) {
      continue;
    }

    try {
      await fs.promises.symlink(srcPath, destPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Failed to symlink ${file}: ${message}`);
    }
  }
}

const DEPENDENCY_DIRS = ['node_modules', '.venv'];

function copyDependenciesInBackground(srcProjectPath: string, destProjectPath: string): void {
  for (const dir of DEPENDENCY_DIRS) {
    const srcDir = path.join(srcProjectPath, dir);

    if (!fs.existsSync(srcDir)) {
      continue;
    }

    const destDir = path.join(destProjectPath, dir);

    runCommand('cp', ['-a', srcDir, destDir], { timeout: 600_000 })
      .then(() => {
        console.log(`${dir} copied to worktree: ${destProjectPath}`);
      })
      .catch((err: Error) => {
        console.warn(`Failed to copy ${dir} to worktree: ${err.message}`);
      });
  }
}

async function createGitignoreddirs(projectPath: string): Promise<void> {
  const dirs = ['log', 'tmp', 'storage'];

  for (const dir of dirs) {
    const dirPath = path.join(projectPath, dir);
    try {
      await fs.promises.mkdir(dirPath, { recursive: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Note: Could not create ${dir} directory: ${message}`);
    }
  }
}

export interface CreateWorktreeResult {
  success: boolean;
  worktreePath?: string;
  branch?: string;
  error?: string;
}

/**
 * Create a worktree for a task
 */
export async function createWorktree(
  repoPath: string,
  taskId: number,
  title: string | null | undefined,
  subprojectPath: string | null = null,
): Promise<CreateWorktreeResult> {
  const sanitizedTitle = sanitizeTitle(title);
  const branch = `task/${taskId}-${sanitizedTitle}`;
  const worktreesDir = getWorktreesDir(repoPath);
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    await fs.promises.mkdir(worktreesDir, { recursive: true });

    const baseBranch = assertValidBranchName(await getDefaultBranch(repoPath), 'default branch');

    await runCommand(
      'git',
      ['worktree', 'add', '-b', assertValidBranchName(branch), worktreePath, baseBranch],
      { cwd: repoPath },
    );

    const projectPath = subprojectPath ? path.join(worktreePath, subprojectPath) : worktreePath;

    await symlinkEnvFiles(repoPath, worktreePath, subprojectPath);

    await createGitignoreddirs(projectPath);

    copyDependenciesInBackground(repoPath, projectPath);

    return { success: true, worktreePath, branch };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface RemoveWorktreeResult {
  success: boolean;
  error?: string;
}

/**
 * Remove a worktree and its branch
 */
export async function removeWorktree(
  repoPath: string,
  taskId: number,
): Promise<RemoveWorktreeResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    const branch = await getBranchName(worktreePath);

    await runCommand('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath });

    if (branch) {
      try {
        await runCommand('git', ['branch', '-D', assertValidBranchName(branch)], { cwd: repoPath });
      } catch {
        /* ignore */
      }
    }

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface WorktreeStatusResult {
  success: boolean;
  branch?: string | null;
  ahead?: number;
  behind?: number;
  mainBranch?: string;
  worktreePath?: string;
  error?: string;
}

/**
 * Get worktree status including commits ahead/behind main
 */
export async function getWorktreeStatus(
  repoPath: string,
  taskId: number,
): Promise<WorktreeStatusResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    await fs.promises.access(worktreePath);

    const branch = await getBranchName(worktreePath);
    const mainBranch = assertValidBranchName(await getDefaultBranch(repoPath), 'default branch');

    try {
      await runCommand('git', ['fetch', 'origin'], { cwd: worktreePath });
    } catch {
      /* ignore */
    }

    let ahead = 0;
    let behind = 0;
    try {
      const { stdout } = await runCommand(
        'git',
        ['rev-list', '--left-right', '--count', `origin/${mainBranch}...HEAD`],
        { cwd: worktreePath },
      );
      const parts = stdout.trim().split(/\s+/);
      behind = parseInt(parts[0] ?? '0', 10) || 0;
      ahead = parseInt(parts[1] ?? '0', 10) || 0;
    } catch {
      /* ignore */
    }

    return {
      success: true,
      branch,
      ahead,
      behind,
      mainBranch,
      worktreePath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Sync a worktree with the main branch (merge main into worktree branch)
 */
export async function syncWithMain(
  repoPath: string,
  taskId: number,
): Promise<RemoveWorktreeResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    const mainBranch = assertValidBranchName(await getDefaultBranch(repoPath), 'default branch');

    await runCommand('git', ['fetch', 'origin'], { cwd: worktreePath });
    await runCommand('git', ['merge', `origin/${mainBranch}`], { cwd: worktreePath });

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface CreatePRResult {
  success: boolean;
  url?: string;
  error?: string;
}

/**
 * Create a pull request for a task's worktree branch
 */
export async function createPullRequest(
  repoPath: string,
  taskId: number,
  title: string,
  body: string,
): Promise<CreatePRResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    const branch = await getBranchName(worktreePath);
    if (!branch) {
      return { success: false, error: 'Could not determine worktree branch' };
    }
    assertValidBranchName(branch);

    await runCommand('git', ['push', '-u', 'origin', branch], { cwd: worktreePath });

    // Title and body pass straight through as argv. No escaping needed —
    // shell metacharacters inside title/body are literal bytes here.
    const { stdout } = await runCommand(
      'gh',
      ['pr', 'create', '--title', title, '--body', body],
      { cwd: worktreePath },
    );

    return { success: true, url: stdout.trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface CICheck {
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | string;
  name?: string;
  state?: string;
  link?: string;
}

export interface CIStatus {
  status: 'none' | 'pending' | 'passed' | 'failed' | 'unknown';
  checks: CICheck[];
}

export interface PullRequestStatusResult {
  success: boolean;
  exists: boolean;
  url?: string;
  state?: string;
  mergeable?: string;
  ciStatus?: CIStatus;
  error?: string;
}

/**
 * Get the status of a pull request for a task's worktree branch
 */
export async function getPullRequestStatus(
  repoPath: string,
  taskId: number,
): Promise<PullRequestStatusResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    const { stdout } = await runCommand(
      'gh',
      ['pr', 'view', '--json', 'url,state,mergeable'],
      { cwd: worktreePath },
    );
    const prData = JSON.parse(stdout) as { url: string; state: string; mergeable: string };

    let ciStatus: CIStatus = { status: 'none', checks: [] };
    try {
      const { stdout: checksOutput } = await runCommand(
        'gh',
        ['pr', 'checks', '--json', 'bucket,name,state,link'],
        { cwd: worktreePath },
      );
      const checks = JSON.parse(checksOutput) as CICheck[];

      if (checks.length > 0) {
        const hasFailed = checks.some((c) => c.bucket === 'fail');
        const hasPending = checks.some((c) => c.bucket === 'pending');
        const allPassed = checks.every((c) => c.bucket === 'pass' || c.bucket === 'skipping');

        if (hasFailed) {
          ciStatus = { status: 'failed', checks };
        } else if (hasPending) {
          ciStatus = { status: 'pending', checks };
        } else if (allPassed) {
          ciStatus = { status: 'passed', checks };
        } else {
          ciStatus = { status: 'unknown', checks };
        }
      }
    } catch (checksError) {
      const code = (checksError as { code?: number }).code;
      if (code === 8) {
        ciStatus = { status: 'pending', checks: [] };
      }
    }

    return {
      success: true,
      exists: true,
      url: prData.url,
      state: prData.state,
      mergeable: prData.mergeable,
      ciStatus,
    };
  } catch {
    return { success: true, exists: false };
  }
}

/**
 * Merge a pull request and clean up the worktree and branch
 */
export async function mergeAndCleanup(
  repoPath: string,
  taskId: number,
): Promise<RemoveWorktreeResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    const branch = await getBranchName(worktreePath);
    const mainBranch = assertValidBranchName(await getDefaultBranch(repoPath), 'default branch');

    let merged = false;
    let lastMergeError: Error | null = null;
    for (let mergeAttempt = 0; mergeAttempt < 3 && !merged; mergeAttempt++) {
      try {
        await runCommand('gh', ['pr', 'merge', '--merge'], { cwd: worktreePath });
        merged = true;
      } catch (mergeError) {
        lastMergeError = mergeError instanceof Error ? mergeError : new Error(String(mergeError));
        const message = lastMergeError.message;
        const is502 = message.includes('502');
        const isMergeInProgress = message.includes('Merge already in progress');

        if (is502 || isMergeInProgress) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          try {
            await runCommand('git', ['fetch', 'origin'], { cwd: worktreePath });
            const { stdout: branchHead } = await runCommand('git', ['rev-parse', 'HEAD'], {
              cwd: worktreePath,
            });
            const { stdout: mergeCheck } = await runCommand(
              'git',
              ['branch', '-r', '--contains', branchHead.trim(), `origin/${mainBranch}`],
              { cwd: worktreePath },
            );
            if (mergeCheck.trim().length > 0) {
              merged = true;
            }
          } catch {
            /* will retry merge */
          }
        } else {
          break;
        }
      }
    }
    if (!merged) {
      throw lastMergeError ?? new Error('Failed to merge after retries');
    }

    await runCommand('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath });

    if (branch) {
      try {
        await runCommand('git', ['branch', '-D', assertValidBranchName(branch)], {
          cwd: repoPath,
        });
      } catch {
        /* ignore */
      }
    }

    await runCommand('git', ['checkout', mainBranch], { cwd: repoPath });
    await runCommand('git', ['pull'], { cwd: repoPath });

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface UncommittedChangesResult {
  success: boolean;
  hasChanges?: boolean;
  error?: string;
}

/**
 * Check if there are uncommitted changes in a worktree
 */
export async function hasUncommittedChanges(
  repoPath: string,
  taskId: number,
): Promise<UncommittedChangesResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    const { stdout } = await runCommand('git', ['status', '--porcelain'], { cwd: worktreePath });
    return { success: true, hasChanges: stdout.trim().length > 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Commit all changes in the worktree with a given message
 */
export async function commitAllChanges(
  repoPath: string,
  taskId: number,
  message: string,
): Promise<RemoveWorktreeResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    await runCommand('git', ['add', '-A'], { cwd: worktreePath });

    // The commit message passes through argv — no quoting, no escaping. Even
    // `$(rm -rf ~)` would land as a literal commit message.
    await runCommand('git', ['commit', '-m', message], { cwd: worktreePath });

    return { success: true };
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    if (errMessage.includes('nothing to commit')) {
      return { success: true };
    }
    return { success: false, error: errMessage };
  }
}

export interface PushChangesResult {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * Push changes to remote for an existing PR
 */
export async function pushChanges(
  repoPath: string,
  taskId: number,
  commitMessage: string,
): Promise<PushChangesResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    const { stdout: status } = await runCommand('git', ['status', '--porcelain'], {
      cwd: worktreePath,
    });

    if (status.trim().length > 0) {
      await runCommand('git', ['add', '-A'], { cwd: worktreePath });
      await runCommand('git', ['commit', '-m', commitMessage], { cwd: worktreePath });
    }

    const branch = await getBranchName(worktreePath);
    if (!branch) {
      return { success: false, error: 'Could not determine worktree branch' };
    }
    assertValidBranchName(branch);
    await runCommand('git', ['push', 'origin', branch], { cwd: worktreePath });

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('nothing to commit') && message.includes('Everything up-to-date')) {
      return { success: true, message: 'Already up to date' };
    }
    if (message.includes('Everything up-to-date')) {
      return { success: true, message: 'Already up to date' };
    }
    return { success: false, error: message };
  }
}
