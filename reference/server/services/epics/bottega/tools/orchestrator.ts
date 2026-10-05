// The orchestrator's tools — how a drop-in replacement for the human drives a
// ticket from planification to the pull request.
//
// The supervision verbs themselves (start planification, answer questions,
// approve the plan, resume a ticket, ...) are shared with the QA fix agent and
// live in `ticketSupervision.ts`. What stays here is what only orchestration
// owns: resuming a blocked epic before every act, the PR-review hand-off, the
// epic's final pull request, and `block_epic`.
//
// The pull request itself is NOT reviewed or merged here. When the PR agent
// ends, the server hands the pull request to the `epic-pr-review` agent — a
// fresh conversation in the ticket's worktree that reviews against the whole
// specification, fixes what it finds, and merges (`tools/prReview.ts`). The
// orchestrator keeps one verb for that stage, `start_pr_review`, for the
// retry path after a review that ended without merging.

import { z } from 'zod';
import { definePortableTool as tool } from '../../../conversation/portableTool.js';
import { epicTicketsDb } from '../../../../database/epics.js';
import { createEpicCompletionPR } from '../../epicBranch.js';
import { resumeOrchestration } from '../../orchestrator/blocking.js';
import { ok, fail, errText } from '../toolResult.js';
import { buildBlockEpicTool } from './blockEpic.js';
import {
  buildTicketSupervisionTools,
  type TicketSupervisionContext,
} from './ticketSupervision.js';

export { FEEDBACK_MAX } from './ticketSupervision.js';

/** Lazy for the load-time cycle: the sequencer reaches the agent runners. */
const sequencing = () => import('../../orchestrator/sequencing.js');
/** Lazy for the same cycle — see `ticketSupervision.ts`. */
const taskApi = () => import('../../../tasks/index.js');

export type OrchestratorToolContext = TicketSupervisionContext;

export function buildOrchestratorTools(ctx: OrchestratorToolContext) {
  const { epicId } = ctx;

  /**
   * Acting on a ticket while the epic is blocked resumes orchestration.
   * Every tool that starts or steers a ticket agent calls this right before
   * it acts: a run started under a blocked epic would be a stranded one —
   * the bridge drops every wake while the block is set, so the run's own
   * failure could never come back to this conversation. Returns a sentence
   * for the tool result when the block was actually lifted, '' otherwise.
   */
  function resumeIfBlocked(): string {
    const resumed = resumeOrchestration(epicId, {
      broadcastToEpicSubscribersFn: ctx.broadcastToEpicSubscribersFn,
    });
    return resumed ? ' Orchestration was paused; your action has resumed it.' : '';
  }

  const startPrReview = tool(
    'start_pr_review',
    "Start the PR reviewer on a ticket's open pull request: a fresh conversation in the " +
      "ticket's worktree that reviews the pull request against the whole specification, fixes " +
      'what it finds itself, gets CI green and merges. The server starts it on its own when the ' +
      'pull-request agent ends — call this only to retry after a review ended without merging, ' +
      'or after a restart left a pull request unreviewed. END YOUR TURN afterwards.',
    {
      taskId: z.number().int().positive(),
    },
    async ({ taskId }) => {
      try {
        const { taskFlags } = await taskApi();
        if (!taskFlags(taskId)) return fail(`Task ${taskId} does not exist.`);
        if (epicTicketsDb.epicOf(taskId) !== epicId) {
          return fail(
            `Task ${taskId} does not belong to this epic. Use get_epic_state to see the tickets you may act on.`,
          );
        }

        // Before the guards inside startPrReview: a blocked epic would refuse
        // with 'orchestration is paused', and the orchestrator acting IS the
        // resumption.
        const resumedNote = resumeIfBlocked();
        const { startPrReview: start } = await sequencing();
        const result = await start(epicId, taskId);
        if (!result.started) {
          return fail(
            `Could not start a PR review of task ${taskId}: ${result.reason}.` +
              (result.noPullRequest
                ? " There is nothing to review until the pull request exists: restart the ticket's " +
                  "pull-request agent with resume_ticket(agentType: 'pr')."
                : ' Check get_task_progress and wait to be woken.'),
          );
        }
        return ok(
          `PR review of task ${taskId} started (run ${result.runId}, conversation ` +
            `${result.conversationId}).${resumedNote} End your turn — the next ticket starts on ` +
            'its own once it merges, and you will be woken only if it ends without merging.',
        );
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const openEpicPr = tool(
    'open_epic_pr',
    "Open the epic's final pull request, from its feature branch into the repository's default " +
      'branch. Only once every ticket is merged. A human merges this one — you open it and tell ' +
      'them.',
    {
      title: z.string().trim().min(1).max(200).optional(),
      body: z.string().max(50_000).optional(),
    },
    async ({ title, body }) => {
      try {
        const unfinished = epicTicketsDb.listTickets(epicId).filter((t) => t.status !== 'completed');
        if (unfinished.length > 0) {
          return fail(
            `${unfinished.length} ticket(s) of this epic are not merged yet ` +
              `(${unfinished.map((t) => `#${t.id}`).join(', ')}). Finish them first.`,
          );
        }
        const result = await createEpicCompletionPR(epicId, { title, body });
        if (!result.success) {
          return fail(
            `Could not open the epic pull request: ${result.error ?? 'unknown error'}. Tell the ` +
              'user — they can open it from the epic page.',
          );
        }
        return ok(
          `Epic pull request opened: ${result.url}. Tell the user it is waiting for their review ` +
            'and merge.',
        );
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const blockEpic = buildBlockEpicTool(
    ctx,
    'Stop orchestrating and hand the epic back to the user. Use this when you are stuck in a way ' +
      'no retry fixes: repeated failures, a decision only a person can make, a ticket whose brief ' +
      'turned out to be wrong. Say plainly what you tried and what you need.',
  );

  // `notify_user` stays last, as it always has — splice the orchestrator-only
  // verbs in front of it.
  const supervision = buildTicketSupervisionTools(ctx, {
    beforeAct: resumeIfBlocked,
    prResumeSuffix: ' — when the pull request is open the server starts the PR reviewer itself',
  });
  const notifyUser = supervision.pop()!;
  return [...supervision, startPrReview, openEpicPr, blockEpic, notifyUser];
}
