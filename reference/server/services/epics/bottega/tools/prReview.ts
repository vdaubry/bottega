// The pull-request reviewer's tools — deliberately two.
//
// The reviewer does its work with the ordinary task-agent surface (Bash, the
// editors, `gh`) inside the ticket's worktree; what it needs from Bottega is
// the one act a shell must not perform — landing the ticket — and the one
// exit it has when CI will not go green. `merge_task` is the task facade's
// `mergeTask` (the same service the human Merge button's route calls) behind
// the reviewer's live guards, plus the outcome note that is the epic's memory
// across tickets. `block_epic` is shared with the orchestrator.
//
// The reviewer is bound to ONE ticket (the run row's `ticket_task_id`), and
// `merge_task` refuses any other id: a reviewer that could merge a sibling
// ticket's pull request would be a second, unsupervised orchestrator.

import { z } from 'zod';
import { definePortableTool as tool } from '../../../conversation/portableTool.js';
import { epicTicketsDb } from '../../../../database/epics.js';
import { writeEpicTaskOutcome } from '../../epicArchive.js';
import { ok, fail, errText } from '../toolResult.js';
import {
  isUnsavedWorktreeWorkError,
  describeUnsavedWork,
} from '../../../worktreeSafety.js';
import { buildBlockEpicTool } from './blockEpic.js';
import type { TaskWithProject } from '../../../tasks/index.js';
import type { BroadcastToEpicSubscribersFn } from '@shared/websocket/messages';

/** Lazy — the task facade reaches startConversation (the catalog's importer). */
const taskApi = () => import('../../../tasks/index.js');

export const OUTCOME_SUMMARY_MAX = 4000;

export interface PrReviewToolContext {
  epicId: number;
  /** The ticket this conversation reviews; null on a manual epic chat. */
  ticketTaskId?: number | null | undefined;
  userId?: number | undefined;
  broadcastToEpicSubscribersFn?: BroadcastToEpicSubscribersFn | undefined;
}

/**
 * Land one ticket: re-check the pull request live, merge it through the task
 * facade's `mergeTask` (the Merge button's service — merge, cleanup, status
 * flip, notifications), and record the outcome note. Returns the tool-result
 * text, or throws.
 *
 * Exported so the guards are testable without the SDK `tool()` wrapper.
 */
export async function mergeTicket(
  epicId: number,
  task: TaskWithProject,
  outcomeSummary: string,
  closing?: (isLastTicket: boolean) => string,
): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  const taskId = task.id;
  const { mergeTask, taskProgress } = await taskApi();

  // Live re-check: the diff the reviewer read may be minutes old, and CI or a
  // conflicting base can have moved since.
  const progress = await taskProgress(taskId);
  const pr = progress?.pullRequest ?? null;
  if (!pr) {
    return { ok: false, text: `Task ${taskId} has no pull request to merge.` };
  }
  if (pr.state && pr.state !== 'OPEN') {
    return {
      ok: false,
      text: `The pull request of task ${taskId} is ${pr.state}, not open. Check get_task_progress if you have it; otherwise there is nothing left to merge.`,
    };
  }
  if (pr.mergeable === 'CONFLICTING') {
    return {
      ok: false,
      text:
        `The pull request of task ${taskId} conflicts with its base. Rebase the branch onto the ` +
        'feature branch, push with --force-with-lease, let CI run, then merge once it is clean.',
    };
  }
  if (pr.ci === 'failed' || pr.ci === 'pending') {
    return {
      ok: false,
      text:
        `CI on task ${taskId} is '${pr.ci}'. ` +
        (pr.ci === 'pending'
          ? 'Wait for it (`gh pr checks`, sleep 30 between polls) and merge once it has passed.'
          : 'Fix the failure, push, and merge once it is green.'),
    };
  }

  // Never force. `gh pr merge` lands the branch's *remote* head, so uncommitted
  // or unpushed work in the worktree is not in the merge — merging anyway would
  // land an incomplete ticket and delete the rest.
  // Write-ahead handoff: the next ticket can only start after the task row is
  // completed, so an outcome for an open ticket is never consumed. Persisting
  // it before the non-transactional GitHub call closes the opposite crash
  // window — PR merged + task reconciled after restart, but no cross-ticket
  // memory because the reviewer died before this file was written.
  const outcomePath = writeEpicTaskOutcome(task.project_id, epicId, taskId, outcomeSummary);

  let merged: {
    success: boolean;
    error?: string;
    cleanupPending?: boolean;
    cleanupError?: string;
    cleanupRequiresManualReview?: boolean;
    warning?: string;
  };
  try {
    merged = await mergeTask(taskId);
  } catch (mergeError) {
    if (isUnsavedWorktreeWorkError(mergeError)) {
      return {
        ok: false,
        text:
          `Task ${taskId} still has ${describeUnsavedWork(mergeError.safety)} in its worktree, ` +
          'which the pull request does not contain. Commit and push that work (or discard it if ' +
          'it is not meant to land), let CI run, then merge.',
      };
    }
    throw mergeError;
  }
  if (!merged.success) {
    return {
      ok: false,
      text:
        `Merging task ${taskId} failed: ${merged.error ?? 'unknown error'}. Try once more; if it ` +
        'fails again, block_epic and let the user look at it.',
    };
  }

  console.log(`[bottega] Epic ${epicId}: merged task ${taskId}`);

  const isLastTicket = epicTicketsDb
    .listTickets(epicId)
    .every((epicTask) => epicTask.id === taskId || epicTask.status === 'completed');
  const cleanupText = merged.cleanupRequiresManualReview
    ? `The worktree was preserved for manual review: ${merged.cleanupError ?? 'no safety checkpoint was recorded'}. `
    : merged.cleanupPending
      ? 'Worktree cleanup is running asynchronously and will be retried after a restart if ' +
        'needed; this does not block delivery. '
      : 'Its worktree has been removed — do not run anything else there. ';

  const closingText = closing
    ? closing(isLastTicket)
    : isLastTicket
      ? 'This was the final ticket: the server opens the epic pull request and notifies the ' +
        'user. End your turn.'
      : 'End your turn — the next ticket starts on its own.';

  return {
    ok: true,
    text:
      `Task ${taskId} merged into its base branch and marked completed. Outcome recorded at ` +
      `${outcomePath}. ` +
      cleanupText +
      (merged.warning ? `Cleanup warning: ${merged.warning}. ` : '') +
      closingText,
  };
}

export function buildPrReviewTools(ctx: PrReviewToolContext) {
  const { epicId } = ctx;

  const mergeTask = tool(
    'merge_task',
    "Merge the ticket's pull request into the epic's feature branch and close the ticket. Only " +
      'after you have read the whole diff, fixed what you found, and CI is green. The outcome ' +
      'summary you write is the ONLY thing later tickets will know about this one — write it ' +
      'for the orchestrator that picks up the next ticket.',
    {
      taskId: z.number().int().positive(),
      outcomeSummary: z
        .string()
        .trim()
        .min(1)
        .max(OUTCOME_SUMMARY_MAX)
        .describe(
          'What this ticket delivered: what was built, the interfaces and decisions later tickets ' +
            'must build on, what your review changed and why, anything deferred or left ' +
            `inconsistent. Under ${OUTCOME_SUMMARY_MAX} characters.`,
        ),
    },
    async ({ taskId, outcomeSummary }) => {
      try {
        const { getTask } = await taskApi();
        const task = getTask(taskId);
        if (!task) return fail(`Task ${taskId} does not exist.`);
        if (epicTicketsDb.epicOf(taskId) !== epicId) {
          return fail(`Task ${taskId} does not belong to this epic.`);
        }
        if (ctx.ticketTaskId != null && taskId !== ctx.ticketTaskId) {
          return fail(
            `This conversation reviews ticket #${ctx.ticketTaskId} only; it cannot merge task ${taskId}.`,
          );
        }
        if (task.status === 'completed') {
          return fail(`Task ${taskId} is already merged and completed. End your turn.`);
        }
        const result = await mergeTicket(epicId, task, outcomeSummary);
        return result.ok ? ok(result.text) : fail(result.text);
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const blockEpic = buildBlockEpicTool(
    ctx,
    'Stop the epic and hand it back to the user. For CI you cannot get green after the fix ' +
      'rounds, or a merge that keeps failing for a reason outside this worktree — never for a ' +
      'question about the specification. Say what fails, what you tried and what a person ' +
      'needs to look at.',
  );

  return [mergeTask, blockEpic];
}
