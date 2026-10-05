/**
 * Epic feature-branch lifecycle.
 *
 * An epic develops on one long-lived integration branch, `epic/{id}-{slug}`:
 * its tickets fork off it, their PRs target it, and the epic finishes with a
 * single PR from it into the repo's default branch. Nothing else about the
 * ticket machinery changes — a ticket worktree, its agents and its prompts
 * behave exactly as they do for a standalone task, they just point at a
 * different base.
 *
 * What a task branches from / merges into is a TASK property since
 * architecture-v2 step 3 (`tasks.base_branch`, resolved by the task layer's
 * `resolveBaseBranch`); this module only manages the epic's own branch, its
 * final pull request, and the delivery worktree that branch is landed from.
 */

import fs from 'fs';
import { epicsDb, epicTicketsDb } from '../../database/epics.js';
import { runCommand } from '../shell.js';
import {
  cleanupFailedWorktreeAdd,
  getDefaultBranch,
  getEpicWorktreePath,
  getWorktreesDir,
} from '../worktree.js';
import { describeUnsavedWork, getWorktreeSafety } from '../worktreeSafety.js';
import { assertValidBranchName } from '../validators.js';
import type { EpicRow } from '../../../shared/types/db.js';
import type { EpicWithProject } from '../../database/epics.js';

/**
 * `epic/{id}-{slug}`. The id makes it unique per repo (two epics may share a
 * name) and the slug is stamped at creation, so renaming an epic never moves
 * its branch. `parseTaskIdFromBranch` anchors on `^task/`, so an epic branch
 * can never be mistaken for a ticket branch by the GitHub webhook.
 */
export function buildEpicBranchName(epic: Pick<EpicRow, 'id' | 'slug'>): string {
  return assertValidBranchName(`epic/${epic.id}-${epic.slug}`, 'epic branch');
}

export interface EnsureEpicBranchResult {
  branch: string;
  /** The branch did not exist locally before this call. */
  created: boolean;
  /** The branch exists on origin (false = local-only; PRs against it will fail). */
  pushed: boolean;
  /** Non-fatal problem the caller should surface to the user. */
  warning?: string;
}

async function localBranchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await runCommand('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repoPath,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * `null` = the repo has no usable origin (no remote, or it is unreachable);
 * `true`/`false` = origin answered and does / does not have the branch.
 */
async function remoteBranchExists(repoPath: string, branch: string): Promise<boolean | null> {
  try {
    const { stdout } = await runCommand('git', ['ls-remote', '--heads', 'origin', branch], {
      cwd: repoPath,
    });
    return stdout.trim().length > 0;
  } catch {
    return null;
  }
}

async function pushBranch(repoPath: string, branch: string): Promise<string | null> {
  try {
    await runCommand('git', ['push', '-u', 'origin', branch], { cwd: repoPath, timeout: 120_000 });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Two tickets created back to back would otherwise both find `feature_branch`
// NULL and both try to create the branch. Callers await the same promise.
const inFlight = new Map<number, Promise<EnsureEpicBranchResult>>();

/**
 * Make sure the epic's feature branch exists (locally and, when the repo has a
 * remote, on origin) and is recorded on the epic row. Idempotent: safe to call
 * before every ticket creation, which is exactly what happens.
 *
 * Failure modes degrade rather than block — a ticket must still be creatable
 * on a repo with no origin, or when the push is rejected. The returned
 * `warning` says what is off; the PR step fails loudly later if it matters.
 */
export async function ensureEpicFeatureBranch(
  repoPath: string,
  epicId: number,
): Promise<EnsureEpicBranchResult> {
  const pending = inFlight.get(epicId);
  if (pending) return pending;

  const run = (async (): Promise<EnsureEpicBranchResult> => {
    const epic = epicsDb.getById(epicId);
    if (!epic) {
      throw new Error(`Epic ${epicId} not found`);
    }
    const branch = buildEpicBranchName(epic);

    // --- Already recorded: verify it is still there ------------------------
    if (epic.feature_branch) {
      const recorded = assertValidBranchName(epic.feature_branch, 'epic branch');
      const onRemote = await remoteBranchExists(repoPath, recorded);
      if (onRemote === true) {
        return { branch: recorded, created: false, pushed: true };
      }

      const local = await localBranchExists(repoPath, recorded);
      if (local) {
        if (onRemote === null) {
          return {
            branch: recorded,
            created: false,
            pushed: false,
            warning: `Could not reach origin to verify branch ${recorded}; it exists locally only.`,
          };
        }
        // Deleted on origin (or never landed): re-push it.
        const pushError = await pushBranch(repoPath, recorded);
        return pushError
          ? {
              branch: recorded,
              created: false,
              pushed: false,
              warning: `Branch ${recorded} could not be pushed to origin: ${pushError}`,
            }
          : { branch: recorded, created: false, pushed: true };
      }
      // Gone from both sides — fall through and recreate it off the default
      // branch, loudly: the epic's merged work is not in the new branch.
      const recreated = await createBranch(repoPath, recorded);
      return {
        ...recreated,
        warning:
          `Branch ${recorded} no longer exists locally or on origin and was recreated from ` +
          `the default branch. Any work previously merged into it is not included.`,
      };
    }

    // --- First ticket of the epic ------------------------------------------
    // A same-named branch can only be this epic's (the id makes it unique), so
    // an existing one is reused rather than treated as a conflict.
    const result = await createBranch(repoPath, branch);
    epicsDb.setFeatureBranch(epicId, result.branch);
    return result;
  })();

  inFlight.set(epicId, run);
  try {
    return await run;
  } finally {
    inFlight.delete(epicId);
  }
}

/**
 * Create (or adopt) the branch locally off the repo's default branch and push
 * it. Prefers `origin/{default}` so the epic starts from what origin has.
 */
async function createBranch(
  repoPath: string,
  branch: string,
): Promise<EnsureEpicBranchResult> {
  const defaultBranch = assertValidBranchName(await getDefaultBranch(repoPath), 'default branch');

  try {
    await runCommand('git', ['fetch', 'origin', defaultBranch], { cwd: repoPath });
  } catch {
    /* remoteless or unreachable — fall back to the local default ref */
  }

  let created = false;
  if (!(await localBranchExists(repoPath, branch))) {
    try {
      await runCommand('git', ['branch', branch, `origin/${defaultBranch}`], { cwd: repoPath });
    } catch {
      await runCommand('git', ['branch', branch, defaultBranch], { cwd: repoPath });
    }
    created = true;
  }

  const remote = await remoteBranchExists(repoPath, branch);
  if (remote === null) {
    return {
      branch,
      created,
      pushed: false,
      warning: `This repository has no reachable origin; branch ${branch} exists locally only.`,
    };
  }
  if (remote) {
    return { branch, created, pushed: true };
  }

  const pushError = await pushBranch(repoPath, branch);
  return pushError
    ? {
        branch,
        created,
        pushed: false,
        warning: `Branch ${branch} could not be pushed to origin: ${pushError}`,
      }
    : { branch, created, pushed: true };
}

export interface EpicCompletionPRResult {
  success: boolean;
  url?: string;
  error?: string;
}

function readExistingPrUrl(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const first: unknown = parsed[0];
    if (typeof first !== 'object' || first === null) return null;
    const url = (first as Record<string, unknown>).url;
    return typeof url === 'string' && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/**
 * Open the epic's final PR: feature branch -> repo default. Runs in the
 * project's main checkout (framing has no worktree; the delivery worktree below
 * is the branch itself, and this call must not depend on it existing).
 *
 * The epic's status is deliberately NOT flipped here — merging that PR is a
 * separate, human act, and `PATCH /api/epics/:id` marks the epic completed.
 */
export async function createEpicCompletionPR(
  epicId: number,
  options: { title?: string | undefined; body?: string | undefined } = {},
): Promise<EpicCompletionPRResult> {
  const epic = epicsDb.getWithProject(epicId);
  if (!epic) {
    return { success: false, error: `Epic ${epicId} not found` };
  }
  if (!epic.feature_branch) {
    return {
      success: false,
      error: 'This epic has no feature branch yet — create its first ticket to open one.',
    };
  }
  const unfinished = epicTicketsDb.listTickets(epicId).filter((task) => task.status !== 'completed');
  if (unfinished.length > 0) {
    return {
      success: false,
      error: `${unfinished.length} ticket(s) are not merged yet: ${unfinished
        .map((task) => `#${task.id}`)
        .join(', ')}`,
    };
  }

  const repoPath = epic.repo_folder_path;
  const feature = assertValidBranchName(epic.feature_branch, 'epic branch');

  try {
    const defaultBranch = assertValidBranchName(
      await getDefaultBranch(repoPath),
      'default branch',
    );

    try {
      await runCommand('git', ['fetch', 'origin'], { cwd: repoPath });
    } catch {
      /* checked below by ls-remote */
    }

    const onRemote = await remoteBranchExists(repoPath, feature);
    if (onRemote !== true) {
      return {
        success: false,
        error: `Branch ${feature} is not on origin, so no pull request can be opened for it.`,
      };
    }

    // Both the orchestrator and the UI backstop may reach this service. Return
    // the existing open PR instead of making the second caller fail with
    // "already exists".
    const existingUrl = await findOpenPrUrl(repoPath, feature, defaultBranch);
    if (existingUrl) return { success: true, url: existingUrl };

    const { stdout } = await runCommand(
      'git',
      ['rev-list', '--count', `origin/${defaultBranch}..origin/${feature}`],
      { cwd: repoPath },
    );
    if ((parseInt(stdout.trim(), 10) || 0) === 0) {
      return { success: false, error: 'No changes to create a PR' };
    }

    const title = options.title?.trim() || `Epic: ${epic.name}`;
    const body = options.body?.trim() || `Delivers epic #${epic.id} — ${epic.name}.`;

    const { stdout: prOutput } = await runCommand(
      'gh',
      [
        'pr',
        'create',
        '--head',
        feature,
        '--base',
        defaultBranch,
        '--title',
        title,
        '--body',
        body,
      ],
      { cwd: repoPath },
    );

    return { success: true, url: prOutput.trim() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The open pull request from `head` into `base`, or null. Throws if `gh` does. */
async function findOpenPrUrl(
  repoPath: string,
  head: string,
  base: string,
): Promise<string | null> {
  const { stdout } = await runCommand(
    'gh',
    ['pr', 'list', '--head', head, '--base', base, '--state', 'open', '--json', 'url', '--limit', '1'],
    { cwd: repoPath },
  );
  return readExistingPrUrl(stdout);
}

/**
 * The epic's final pull request, or null when there is none (or when the repo
 * has no `gh`, no origin, or no feature branch yet).
 *
 * Read-only and best-effort on purpose: this answers "what should the delivery
 * agent be told it is working on", and a lookup failure must degrade to "not
 * opened yet" rather than stop a conversation from starting. Opening one stays
 * `createEpicCompletionPR`, behind the user's button.
 */
export async function findEpicCompletionPR(epic: EpicWithProject): Promise<string | null> {
  if (!epic.feature_branch) return null;
  try {
    const feature = assertValidBranchName(epic.feature_branch, 'epic branch');
    const defaultBranch = assertValidBranchName(
      await getDefaultBranch(epic.repo_folder_path),
      'default branch',
    );
    return await findOpenPrUrl(epic.repo_folder_path, feature, defaultBranch);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The delivery worktree
// ---------------------------------------------------------------------------

/**
 * Where the epic's feature branch is checked out for the delivery agent.
 *
 * Every OTHER epic conversation runs in the project's MAIN checkout, and every
 * git operation this module performs there is deliberately HEAD-preserving
 * (`fetch`, `ls-remote`, `rev-list`, `gh pr create`). The delivery agent cannot
 * follow that rule: merging `origin/{default}` into the feature branch and
 * resolving the conflicts means having the branch checked out somewhere. Doing
 * it in the main checkout would move the HEAD of the working copy the user —
 * and, on a self-hosting box, the running service — is using.
 *
 * So delivery gets its own worktree, `{repo}-worktrees/epic-{id}`, holding the
 * feature branch. It is created on demand, reused by every delivery run of the
 * epic, and removed only when the epic is deleted, so a conversation reopened
 * weeks later still resumes into a directory that exists.
 *
 * It is provisioned exactly like a ticket worktree — by the project's own
 * `post-checkout` hook, which git runs inside `git worktree add` — because it
 * is also what "switch server" serves when you preview the epic: a tree the
 * app cannot boot from would be useless there (see docs/web-server/switch-server.md).
 *
 * Serialized per epic like `ensureEpicFeatureBranch`: a webhook comment landing
 * while the user clicks "New conversation" would otherwise race two
 * `git worktree add` calls onto the same path.
 */
const deliveryInFlight = new Map<number, Promise<string>>();

export async function ensureEpicDeliveryWorktree(epic: EpicWithProject): Promise<string> {
  const existing = deliveryInFlight.get(epic.id);
  if (existing) return existing;

  const promise = createDeliveryWorktree(epic).finally(() => {
    deliveryInFlight.delete(epic.id);
  });
  deliveryInFlight.set(epic.id, promise);
  return promise;
}

async function createDeliveryWorktree(epic: EpicWithProject): Promise<string> {
  if (!epic.feature_branch) {
    throw new Error(
      `Epic ${epic.id} has no feature branch yet — create its first ticket to open one.`,
    );
  }
  const repoPath = epic.repo_folder_path;
  const branch = assertValidBranchName(epic.feature_branch, 'epic branch');
  const worktreePath = getEpicWorktreePath(repoPath, epic.id);

  // Already there: the common case for every run after the first.
  try {
    await fs.promises.access(worktreePath);
    return worktreePath;
  } catch {
    /* create it below */
  }

  await fs.promises.mkdir(getWorktreesDir(repoPath), { recursive: true });

  // Best-effort: a remoteless repo still gets a worktree off its local branch.
  try {
    await runCommand('git', ['fetch', 'origin', branch], { cwd: repoPath, timeout: 120_000 });
  } catch {
    /* the checkout below decides whether anything is missing */
  }

  // The branch normally exists locally (the main checkout created it). If only
  // origin has it — a fresh clone, or a branch created on another machine —
  // check out a local ref tracking it.
  const startPoint = (await localBranchExists(repoPath, branch))
    ? [branch]
    : ['-b', branch, `origin/${branch}`];

  // The project's post-checkout hook runs inside this command — the same
  // provisioning a ticket worktree gets, and it may do a real dependency
  // install, so the 30 s runCommand default is far too tight. A failed or
  // timed-out hook leaves the worktree on disk, where the "already there"
  // check above would mistake it for a good one on the next attempt — sweep
  // it before rethrowing. The feature branch itself is never deleted: it
  // outlives any worktree.
  try {
    await runCommand('git', ['worktree', 'add', worktreePath, ...startPoint], {
      cwd: repoPath,
      timeout: 10 * 60_000,
    });
  } catch (error) {
    await cleanupFailedWorktreeAdd(repoPath, worktreePath, null);
    throw error;
  }

  console.log(`[EpicBranch] Created delivery worktree for epic ${epic.id} at ${worktreePath}`);
  return worktreePath;
}

/**
 * Remove the delivery worktree, if there is one. Called when the epic is
 * deleted. Refuses a worktree holding uncommitted work unless forced — the
 * same guard every ticket worktree removal runs — and deliberately does NOT
 * delete the branch: `epic/{id}-{slug}` is what the final pull request merges,
 * and it outlives both the worktree and the epic row.
 */
export async function removeEpicDeliveryWorktree(
  repoPath: string,
  epicId: number,
  options: { force?: boolean | undefined } = {},
): Promise<{ removed: boolean; error?: string }> {
  const worktreePath = getEpicWorktreePath(repoPath, epicId);
  try {
    await fs.promises.access(worktreePath);
  } catch {
    return { removed: false };
  }

  try {
    if (!options.force) {
      const safety = await getWorktreeSafety(worktreePath);
      if (!safety.clean) {
        return {
          removed: false,
          error: `The delivery worktree of epic ${epicId} has ${describeUnsavedWork(safety)}`,
        };
      }
    }
    await runCommand('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: repoPath });
    return { removed: true };
  } catch (error) {
    return { removed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

