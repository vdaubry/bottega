import path from 'path';
import fs from 'fs';
import { CommandGroupError, runCommand, runCommandGroup } from './shell.js';
import { assertValidBranchName } from './validators.js';
import { assertWorktreeSafeToDestroy, getWorktreeSafety } from './worktreeSafety.js';

/**
 * Derive the worktree path for a task based on convention
 */
export function getWorktreePath(repoPath: string, taskId: number): string {
  return path.join(`${repoPath}-worktrees`, `task-${taskId}`);
}

/**
 * Derive the worktree path for an EPIC's delivery worktree — where the epic's
 * feature branch is checked out so the delivery agent can merge, resolve
 * conflicts and push without ever moving the main checkout's HEAD.
 *
 * Same `{repo}-worktrees/` directory as the tickets, a different prefix: an
 * epic id and a task id are independent sequences, so `task-7` and `epic-7`
 * must not collide. Its lifecycle lives in `epics/epicBranch.ts` — this is
 * only the naming convention, kept beside `getWorktreePath` so the two can
 * never drift apart.
 */
export function getEpicWorktreePath(repoPath: string, epicId: number): string {
  return path.join(`${repoPath}-worktrees`, `epic-${epicId}`);
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

export function sanitizeTitle(title: string | null | undefined): string {
  return (title || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

/**
 * Who makes a new worktree a RUNNABLE checkout, as opposed to just a git tree.
 *
 * - **`hook`** — the project ships a `post-checkout` hook. Git runs it *inside*
 *   `git worktree add`, with the new worktree as the working directory and the
 *   null SHA as `$1` (that is how a hook tells "fresh worktree" from "branch
 *   switch"). Bottega does nothing at all, and because the hook is synchronous
 *   the worktree is fully provisioned the moment the command returns.
 * - **`none`** — no hook. The worktree is a bare checkout: git-tracked files
 *   only. That is correct for a repo that needs nothing else to run, and a
 *   visible settings warning for one that does — Bottega deliberately
 *   provisions nothing itself (docs/agents/worktree-provisioning.md).
 *
 * Detection goes through `git rev-parse --git-path`, so it honours
 * `core.hooksPath` — which is how a project makes the hook *committed* and
 * therefore genuinely part of the repo (`.githooks/post-checkout` +
 * `git config core.hooksPath .githooks`) rather than per-clone local state.
 *
 * It must run with `cwd` = the repo root: git resolves a RELATIVE `core.hooksPath`
 * against the invocation's working directory, so asking from inside a worktree
 * returns that worktree's path instead of the project's.
 */
export type WorktreeProvisioning = 'hook' | 'none';

export async function worktreeProvisioningMode(
  repoPath: string,
): Promise<WorktreeProvisioning> {
  let hookPath: string;
  try {
    const { stdout } = await runCommand(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/post-checkout'],
      { cwd: repoPath },
    );
    hookPath = stdout.trim();
  } catch {
    // `--path-format` needs git >= 2.31; fall back to the relative form.
    try {
      const { stdout } = await runCommand(
        'git',
        ['rev-parse', '--git-path', 'hooks/post-checkout'],
        { cwd: repoPath },
      );
      hookPath = path.resolve(repoPath, stdout.trim());
    } catch {
      return 'none';
    }
  }
  if (!hookPath) return 'none';

  // Executable, like every git hook — a non-`+x` file is not run by git either.
  try {
    await fs.promises.access(hookPath, fs.constants.X_OK);
    return 'hook';
  } catch {
    return 'none';
  }
}

/**
 * Best-effort sweep after a failed `git worktree add`. `post-checkout` runs
 * *after* the checkout, so when the hook fails (or times out) the worktree and
 * the freshly-created branch are already on disk — git does not undo them.
 * Every step tolerates "was never created": a failure before the checkout
 * simply finds nothing to remove.
 *
 * Exported for the epic delivery worktree (`epics/epicBranch.ts`), which runs
 * the same `git worktree add` and inherits the same failure mode — it passes
 * `branch: null` because the epic's feature branch outlives any worktree.
 */
export async function cleanupFailedWorktreeAdd(
  repoPath: string,
  worktreePath: string,
  branch: string | null,
): Promise<void> {
  try {
    await runCommand('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: repoPath,
      timeout: 60_000,
    });
  } catch {
    // Not registered (the add died early) or the removal itself failed. The
    // directory would shadow a future `git worktree add` at the same path, so
    // clear both it and any stale registration.
    await fs.promises.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    await runCommand('git', ['worktree', 'prune'], { cwd: repoPath }).catch(() => {});
  }
  if (branch) {
    try {
      await runCommand('git', ['branch', '-D', branch], { cwd: repoPath });
    } catch {
      /* never created */
    }
  }
}

export interface CreateWorktreeResult {
  success: boolean;
  worktreePath?: string;
  branch?: string;
  error?: string;
  /** The last lines git and the project's hook printed, on failure. */
  output?: string;
  /** The add was cancelled through `options.signal` (the task was deleted). */
  aborted?: boolean;
}

/** How long `git worktree add` — the project's hook included — may run. */
export const WORKTREE_ADD_TIMEOUT_MS = 10 * 60_000;

const OUTPUT_TAIL_LINES = 40;

function outputTail(stdout: string, stderr: string): string {
  // Git runs hooks with stdout redirected to stderr, so stderr carries both
  // git's own messages and everything the hook printed.
  const lines = [stderr, stdout]
    .join('\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines.slice(-OUTPUT_TAIL_LINES).join('\n');
}

/**
 * Create a worktree for a task.
 *
 * Provisioning — env files, dependencies, runtime directories — is the
 * project's own job: git runs the repo's `post-checkout` hook synchronously
 * *inside* `git worktree add`, so the tree is runnable the moment the command
 * returns, and a failing hook fails the command. Bottega adds nothing on top
 * (docs/agents/worktree-provisioning.md).
 *
 * `baseBranch` is where the task branch forks from. Omitted (the default, and
 * every non-epic ticket) it resolves to the repo's default branch and the
 * *local* ref is used verbatim — byte-for-byte the pre-epic behaviour. Passed
 * explicitly (epic tickets fork off their epic's feature branch) the branch is
 * fetched first and the remote-tracking ref is preferred, so a ticket starts
 * from what origin has rather than from a stale local copy.
 */
export async function createWorktree(
  repoPath: string,
  taskId: number,
  title: string | null | undefined,
  baseBranch?: string | null,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<CreateWorktreeResult> {
  const sanitizedTitle = sanitizeTitle(title);
  const branch = `task/${taskId}-${sanitizedTitle}`;
  const worktreesDir = getWorktreesDir(repoPath);
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    await fs.promises.mkdir(worktreesDir, { recursive: true });

    const base = assertValidBranchName(
      baseBranch ?? (await getDefaultBranch(repoPath)),
      baseBranch ? 'base branch' : 'default branch',
    );

    let startPoint = base;
    if (baseBranch) {
      try {
        await runCommand('git', ['fetch', 'origin', base], { cwd: repoPath });
        startPoint = `origin/${base}`;
      } catch {
        // Remoteless repo, or the feature branch never made it to origin
        // (push failed when the epic branch was created). The local ref is
        // still correct — degrade to it instead of failing ticket creation.
      }
    }

    // The project's post-checkout hook runs inside this command and may do a
    // real dependency install — the 30 s runCommand default is a hang guard,
    // not an install budget. Same ceiling as worktree removal. A process
    // group, so a timeout or a cancel also stops whatever the hook started
    // (a hung build otherwise outlives `git` forever).
    await runCommandGroup(
      'git',
      ['worktree', 'add', '-b', assertValidBranchName(branch), worktreePath, startPoint],
      { cwd: repoPath, timeout: WORKTREE_ADD_TIMEOUT_MS, signal: options.signal },
    );

    return { success: true, worktreePath, branch };
  } catch (error) {
    await cleanupFailedWorktreeAdd(repoPath, worktreePath, branch);
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof CommandGroupError) {
      // Said plainly: the user sees this on the task, with the output below it.
      const reason = error.timedOut
        ? `The project's setup did not finish within ${WORKTREE_ADD_TIMEOUT_MS / 60_000} minutes, so it was stopped`
        : error.aborted
          ? 'The worktree setup was cancelled'
          : `The project's setup failed (git worktree add exited with code ${error.exitCode})`;
      return {
        success: false,
        error: reason,
        output: outputTail(error.stdout, error.stderr),
        aborted: error.aborted,
      };
    }
    return { success: false, error: message };
  }
}

export interface RemoveWorktreeResult {
  success: boolean;
  error?: string;
}

/**
 * Remove a worktree and its branch.
 *
 * **Throws `UnsavedWorktreeWorkError` when the worktree holds uncommitted or
 * unpushed work and `force` is not set.** That throw — rather than a
 * `{success:false}` return — is deliberate: it carries the structured safety
 * report every caller needs to offer the user a choice, and it cannot be
 * mistaken for an ordinary git failure. Callers that mean "discard it" pass
 * `{ force: true }`.
 */
export async function removeWorktree(
  repoPath: string,
  taskId: number,
  options: { force?: boolean | undefined } = {},
): Promise<RemoveWorktreeResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  await assertWorktreeSafeToDestroy(worktreePath, taskId, options);

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
  /** The branch the counts are measured against (an epic ticket's is its epic's feature branch). */
  baseBranch?: string;
  /** @deprecated Alias of `baseBranch`, kept for existing UI consumers. */
  mainBranch?: string;
  worktreePath?: string;
  /** Paths with uncommitted modifications (capped — see `MAX_LISTED_FILES`). */
  dirtyPaths?: string[];
  /** Count of uncommitted paths. Drives the "N uncommitted" badge. */
  dirtyFiles?: number;
  /** Commits the branch has that `origin/<branch>` does not. */
  unpushed?: number;
  error?: string;
}

/**
 * Get worktree status including commits ahead/behind its base branch
 * (the repo default unless the caller resolved something else).
 */
export async function getWorktreeStatus(
  repoPath: string,
  taskId: number,
  baseBranch?: string | null,
): Promise<WorktreeStatusResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    await fs.promises.access(worktreePath);

    const branch = await getBranchName(worktreePath);
    const base = assertValidBranchName(
      baseBranch ?? (await getDefaultBranch(repoPath)),
      baseBranch ? 'base branch' : 'default branch',
    );

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
        ['rev-list', '--left-right', '--count', `origin/${base}...HEAD`],
        { cwd: worktreePath },
      );
      const parts = stdout.trim().split(/\s+/);
      behind = parseInt(parts[0] ?? '0', 10) || 0;
      ahead = parseInt(parts[1] ?? '0', 10) || 0;
    } catch {
      /* ignore */
    }

    // Ahead/behind alone cannot answer "is my work on the PR?" — they measure
    // against the *base* branch, so a pushed commit and an unpushed one look
    // identical. The safety report is what the UI badge needs.
    const safety = await getWorktreeSafety(worktreePath);

    return {
      success: true,
      branch,
      ahead,
      behind,
      baseBranch: base,
      mainBranch: base,
      worktreePath,
      dirtyPaths: safety.files,
      dirtyFiles: safety.dirtyFiles,
      unpushed: safety.unpushedCommits,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Merge a worktree's base branch into the worktree branch. `baseBranch`
 * defaults to the repo's default branch — epic tickets pass their epic's
 * feature branch (see `resolveTaskBaseBranch`).
 *
 * A failed merge is always aborted before returning: this runs automatically
 * before agent runs, and handing an agent a tree full of conflict markers is
 * far worse than reporting the conflict.
 */
export async function syncWithBase(
  repoPath: string,
  taskId: number,
  baseBranch?: string | null,
): Promise<RemoveWorktreeResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    const base = assertValidBranchName(
      baseBranch ?? (await getDefaultBranch(repoPath)),
      baseBranch ? 'base branch' : 'default branch',
    );

    await runCommand('git', ['fetch', 'origin'], { cwd: worktreePath });
    await runCommand('git', ['merge', `origin/${base}`], { cwd: worktreePath });

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await runCommand('git', ['merge', '--abort'], { cwd: worktreePath });
    } catch {
      /* nothing to abort — the failure came before/outside the merge */
    }
    return { success: false, error: message };
  }
}

export interface CreatePRResult {
  success: boolean;
  url?: string;
  error?: string;
}

/**
 * Create a pull request for a task's worktree branch.
 *
 * `baseBranch` becomes `gh pr create --base`. Callers (prService) always
 * resolve and pass it, so an epic ticket's PR targets the epic's feature
 * branch and a plain ticket's PR targets the repo default explicitly rather
 * than relying on gh's own default.
 */
export async function createPullRequest(
  repoPath: string,
  taskId: number,
  title: string,
  body: string,
  baseBranch?: string | null,
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
      [
        'pr',
        'create',
        '--title',
        title,
        '--body',
        body,
        ...(baseBranch ? ['--base', assertValidBranchName(baseBranch, 'base branch')] : []),
      ],
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
  headBranch?: string;
  baseBranch?: string;
  mergeCommitSha?: string | null;
  mergedAt?: string | null;
  ciStatus?: CIStatus;
  error?: string;
}

interface GitHubPullRequestData {
  url: string;
  state: string;
  mergeable: string;
  headRefName: string;
  baseRefName: string;
  mergeCommit: { oid: string } | null;
  mergedAt: string | null;
}

const PR_STATUS_FIELDS =
  'url,state,mergeable,headRefName,baseRefName,mergeCommit,mergedAt';

function pullRequestResult(prData: GitHubPullRequestData): PullRequestStatusResult {
  return {
    success: true,
    exists: true,
    url: prData.url,
    state: prData.state,
    mergeable: prData.mergeable,
    headBranch: prData.headRefName,
    baseBranch: prData.baseRefName,
    mergeCommitSha: prData.mergeCommit?.oid ?? null,
    mergedAt: prData.mergedAt,
  };
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
      ['pr', 'view', '--json', PR_STATUS_FIELDS],
      { cwd: worktreePath },
    );
    const prData = JSON.parse(stdout) as GitHubPullRequestData;

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

    return { ...pullRequestResult(prData), ciStatus };
  } catch {
    return { success: true, exists: false };
  }
}

/** Query a known PR from the stable project checkout, not its disposable worktree. */
export async function getPullRequestStatusByUrl(
  repoPath: string,
  prUrl: string,
): Promise<PullRequestStatusResult> {
  try {
    const { stdout } = await runCommand(
      'gh',
      ['pr', 'view', prUrl, '--json', PR_STATUS_FIELDS],
      { cwd: repoPath },
    );
    return pullRequestResult(JSON.parse(stdout) as GitHubPullRequestData);
  } catch (error) {
    return {
      success: false,
      exists: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface MergePullRequestResult extends PullRequestStatusResult {
  merged: boolean;
}

/**
 * Idempotently ask GitHub to merge one known PR.
 *
 * A non-zero/timeout response is ambiguous: GitHub may have accepted the
 * irreversible merge before the client lost its response. Always re-read the
 * PR and report success when the remote fact is MERGED.
 */
export async function mergePullRequest(
  repoPath: string,
  prUrl: string,
): Promise<MergePullRequestResult> {
  const before = await getPullRequestStatusByUrl(repoPath, prUrl);
  if (before.success && before.state === 'MERGED') return { ...before, merged: true };

  let mergeError: unknown = null;
  try {
    await runCommand('gh', ['pr', 'merge', prUrl, '--merge'], {
      cwd: repoPath,
      timeout: 5 * 60_000,
    });
  } catch (error) {
    mergeError = error;
  }

  const after = await getPullRequestStatusByUrl(repoPath, prUrl);
  if (after.success && after.state === 'MERGED') return { ...after, merged: true };

  if (mergeError) {
    const errorMessage =
      mergeError instanceof Error
        ? mergeError.message
        : typeof mergeError === 'string'
          ? mergeError
          : 'The merge command failed without a readable error message.';
    return {
      ...after,
      success: false,
      merged: false,
      error: errorMessage,
    };
  }

  // A zero exit can mean GitHub accepted auto-merge or a merge-queue request;
  // it is not proof that the PR is landed. Keep the write-ahead intent pending
  // until an authoritative read observes MERGED.
  return {
    ...after,
    success: false,
    merged: false,
    error:
      after.error ??
      `GitHub accepted the merge command for ${prUrl}, but has not confirmed the PR as MERGED.`,
  };
}

export interface CleanupMergedWorktreeResult extends RemoveWorktreeResult {
  warning?: string;
}

export interface MergeAndCleanupResult extends RemoveWorktreeResult {
  /** The irreversible remote merge happened even if later cleanup failed. */
  merged?: boolean;
  warning?: string;
}

/**
 * Retryable housekeeping after GitHub has merged the PR. No safety check here:
 * the check ran before the durable merge request was written, and once the
 * remote head has landed, a half-removed worktree must be cleanable on retry.
 */
export async function cleanupMergedWorktree(
  repoPath: string,
  taskId: number,
  branch: string,
  baseBranch?: string | null,
): Promise<CleanupMergedWorktreeResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  try {
    if (fs.existsSync(worktreePath)) {
      // Provisioned worktrees are large — a hook's dependency install easily
      // reaches gigabytes (the incident that led to this path involved
      // ~1.1 GB). The global 30s command timeout is not a meaningful cleanup
      // deadline.
      await runCommand('git', ['worktree', 'remove', worktreePath, '--force'], {
        cwd: repoPath,
        timeout: 10 * 60_000,
      });
    } else {
      await runCommand('git', ['worktree', 'prune'], { cwd: repoPath });
    }

    if (branch) {
      try {
        await runCommand('git', ['branch', '-D', assertValidBranchName(branch)], {
          cwd: repoPath,
        });
      } catch {
        /* already deleted, or checked out elsewhere */
      }
    }

    // Neither checkout refresh nor the feature-branch fetch is part of task
    // completion. New worktrees fetch their explicit base themselves; keep
    // these conveniences best-effort so network trouble cannot reopen a task.
    try {
      const mainBranch = assertValidBranchName(await getDefaultBranch(repoPath), 'default branch');
      await runCommand('git', ['checkout', mainBranch], { cwd: repoPath });
      await runCommand('git', ['pull'], { cwd: repoPath, timeout: 5 * 60_000 });
      if (baseBranch && baseBranch !== mainBranch) {
        await runCommand('git', ['fetch', 'origin', assertValidBranchName(baseBranch)], {
          cwd: repoPath,
          timeout: 5 * 60_000,
        });
      }
    } catch (error) {
      return {
        success: true,
        warning: `Worktree removed, but refreshing local branches failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Merge a pull request and clean up the worktree and branch.
 *
 * Compatibility primitive for callers below the task-domain facade. New
 * product code calls `tasks.mergeTask`, which persists a write-ahead landing
 * record before invoking these remote/local primitives. `baseBranch` is used
 * only to refresh the local feature ref after cleanup; GitHub merges into the
 * PR's own recorded base.
 */
export async function mergeAndCleanup(
  repoPath: string,
  taskId: number,
  baseBranch?: string | null,
  options: { force?: boolean | undefined } = {},
): Promise<MergeAndCleanupResult> {
  const worktreePath = getWorktreePath(repoPath, taskId);

  // Before the merge, not after: `gh pr merge` merges the branch's *remote*
  // head, so unpushed commits are already excluded from the merge — refusing
  // afterwards would leave the PR landed and the work still stranded.
  await assertWorktreeSafeToDestroy(worktreePath, taskId, options);

  const branch = await getBranchName(worktreePath);
  const pr = await getPullRequestStatus(repoPath, taskId);
  if (!pr.success || !pr.exists || !pr.url) {
    return { success: false, error: pr.error ?? 'No pull request found' };
  }

  const merge = await mergePullRequest(repoPath, pr.url);
  if (!merge.merged) return { success: false, error: merge.error ?? 'Pull request did not merge' };

  const cleanup = await cleanupMergedWorktree(
    repoPath,
    taskId,
    branch ?? pr.headBranch ?? '',
    baseBranch,
  );
  return cleanup.success
    ? { success: true, ...(cleanup.warning ? { warning: cleanup.warning } : {}) }
    : { success: false, error: cleanup.error ?? 'unknown cleanup error', merged: true };
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
