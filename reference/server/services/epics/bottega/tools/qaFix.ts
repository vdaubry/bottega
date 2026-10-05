// The QA fix agent's own verbs — deliberately three.
//
// The mission's supervision (planification, questions, plan approval,
// resume) is the shared catalog in `ticketSupervision.ts`; the re-test
// recording is the executor's `record_qa_results`. What only this agent needs
// is: bringing its ONE fix ticket into existence (`create_fix_ticket` — the
// stories `create_task` tool refuses once work has started, and a fix ticket
// is created precisely then), adopting a previous run's unmerged fix ticket
// instead of duplicating it, and merging the fix pull request it reviewed
// itself (`merge_task`, the PR reviewer's guard-set with a re-test closing).
//
// The ticket_task_id stamp on the run row is load-bearing: it is what routes
// the ticket's events to this conversation (`supervisedEpicOf`) and what
// rebuilds `ctx.ticketTaskId` on every later turn (`bottegaInjection`).

import { z } from 'zod';
import { definePortableTool as tool } from '../../../conversation/portableTool.js';
import { epicAgentRunsDb, epicTicketsDb } from '../../../../database/epics.js';
import { ok, okJson, fail, errText } from '../toolResult.js';
import { mergeTicket, OUTCOME_SUMMARY_MAX } from './prReview.js';
import type { BottegaMcpContext } from '../mcpServer.js';

/** Lazy — the task facade reaches startConversation (the catalog's importer). */
const taskApi = () => import('../../../tasks/index.js');
/** Lazy for the same cycle: the ticket service reaches the task facade. */
const ticketService = () => import('../../ticketService.js');

const QA_FIX_MERGE_CLOSING =
  'Now re-test: `git pull --ff-only` in the delivery worktree, start the dev server per your ' +
  'Testing Configuration, re-run the previously-failed scenarios with the browser tools, record ' +
  'what you observe with record_qa_results, then notify_user and end your turn.';

export function buildQaFixTools(ctx: BottegaMcpContext & { projectId: number }) {
  const { epicId } = ctx;

  /** This conversation's own run row, read fresh — the stamp lives on it. */
  function ownRun() {
    const run = epicAgentRunsDb.getByConversationId(ctx.conversationId);
    if (!run || run.agent_type !== 'epic-qa-fix') return null;
    return run;
  }

  const createFixTicket = tool(
    'create_fix_ticket',
    "Create THIS mission's one fix ticket on the epic — a real ticket, forked from the epic's " +
      'feature branch with its pull request landing back into it. The description is the brief ' +
      'planification will read: one section per failed scenario (id, steps, expected, what was ' +
      'observed), grounded in the specification. One ticket per mission — never a second.',
    {
      title: z.string().trim().min(1).max(200),
      description: z
        .string()
        .trim()
        .min(1)
        .max(50_000)
        .describe('The full brief for the fix, covering every failed scenario.'),
    },
    async ({ title, description }) => {
      try {
        const run = ownRun();
        if (!run) return fail('This conversation has no QA fix run — it cannot create a ticket.');
        const existingId = run.ticket_task_id ?? ctx.ticketTaskId;
        if (existingId != null) {
          return fail(
            `This mission already supervises ticket #${existingId} — one fix ticket per run. ` +
              'Use get_task_progress to see where it stands.',
          );
        }

        if (ctx.userId == null) {
          return fail('This conversation has no acting user — it cannot create a ticket.');
        }
        const { createEpicTicket } = await ticketService();
        const result = await createEpicTicket(epicId, { title, description }, ctx.userId);
        if (!result.success || !result.task) {
          return fail(`Could not create the fix ticket: ${result.error ?? 'unknown error'}.`);
        }

        epicAgentRunsDb.setTicketTask(run.id, result.task.id);
        return okJson({
          taskId: result.task.id,
          position: result.task.position ?? null,
          baseBranch: result.baseBranch ?? null,
          warning: result.warning ?? null,
          next:
            `Ticket #${result.task.id} created; its description is the brief planification will ` +
            `read. Now start_planification(${result.task.id}) and END YOUR TURN.`,
        });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const adoptFixTicket = tool(
    'adopt_fix_ticket',
    'Adopt an UNMERGED fix ticket a previous mission created, instead of duplicating it — from ' +
      'then on its events wake this conversation. Use get_epic_state first to find it; then ' +
      'get_task_progress to see which step it is at, and resume from there.',
    {
      taskId: z.number().int().positive(),
    },
    async ({ taskId }) => {
      try {
        const run = ownRun();
        if (!run) return fail('This conversation has no QA fix run — it cannot adopt a ticket.');
        const existingId = run.ticket_task_id ?? ctx.ticketTaskId;
        if (existingId != null) {
          return fail(
            `This mission already supervises ticket #${existingId} — it cannot adopt another.`,
          );
        }
        const { taskFlags } = await taskApi();
        const flags = taskFlags(taskId);
        if (!flags) return fail(`Task ${taskId} does not exist.`);
        if (epicTicketsDb.epicOf(taskId) !== epicId) {
          return fail(`Task ${taskId} does not belong to this epic.`);
        }
        if (flags.status === 'completed') {
          return fail(
            `Task ${taskId} is already merged — there is nothing to adopt. If its fixes did not ` +
              'hold, re-test and record what you observe.',
          );
        }

        epicAgentRunsDb.setTicketTask(run.id, taskId);
        return ok(
          `Ticket #${taskId} adopted — its events now wake this conversation. Check ` +
            'get_task_progress to see where it stands, and resume from that step.',
        );
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const mergeTask = tool(
    'merge_task',
    "Merge the fix ticket's pull request into the epic's feature branch and close the ticket. " +
      'Only after you have read the whole diff, fixed what you found, and CI is green. The ' +
      'outcome summary is the durable record of what this fix delivered.',
    {
      taskId: z.number().int().positive(),
      outcomeSummary: z
        .string()
        .trim()
        .min(1)
        .max(OUTCOME_SUMMARY_MAX)
        .describe(
          'What this fix delivered: which failed scenarios it addresses, what changed and why, ' +
            `anything deferred. Under ${OUTCOME_SUMMARY_MAX} characters.`,
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
        const supervisedId = ownRun()?.ticket_task_id ?? ctx.ticketTaskId;
        if (supervisedId != null && taskId !== supervisedId) {
          return fail(
            `This mission supervises ticket #${supervisedId} only; it cannot merge task ${taskId}.`,
          );
        }
        if (task.status === 'completed') {
          return fail(`Task ${taskId} is already merged and completed.`);
        }
        const result = await mergeTicket(epicId, task, outcomeSummary, () => QA_FIX_MERGE_CLOSING);
        return result.ok ? ok(result.text) : fail(result.text);
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  return [createFixTicket, adoptFixTicket, mergeTask];
}
