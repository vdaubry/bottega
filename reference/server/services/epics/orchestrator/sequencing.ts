// Moving from one ticket to the next.
//
// The orchestrator supervises exactly one ticket per run + conversation, so
// something outside it has to notice "that ticket merged" and open the next
// one. That is this module, and it runs where `handleAgentChaining` runs — in
// the turn-end hook, one second later, re-reading everything from the database
// rather than trusting what the turn believed.
//
// It is deliberately dumb: it never decides that work is finished (the PR
// reviewer does that by merging), it only reacts to the state that decision
// left behind. The one other hop it owns is the hand-off to that reviewer when
// a ticket's pull-request agent ends (`schedulePrReview`) — same shape, same
// settle delay, same fresh re-reads.

import { epicsDb, epicTicketsDb } from '../../../database/epics.js';
import { broadcastEpicUpdated } from '../epicEvents.js';
import { blockOrchestration } from './blocking.js';

import {
  currentOrchestratorRun,
  getBridgeBroadcasters,
  notifyOrchestrator,
} from './bridge.js';
import type { EpicTicketWithTask } from '@shared/types/db';

const epicAgentRunner = () => import('../epicAgentRunner.js');
/** Also lazy: `notifications` reaches the transcript store through `taskService`. */
const notifications = () => import('../../notifications.js');
/** The task domain's facade — the one surface the epic layer acts through. */
const taskApi = () => import('../../tasks/index.js');
const epicBranch = () => import('../epicBranch.js');

/** Same 1s settle as the task chaining: let the ending turn's writes land. */
const HOP_DELAY_MS = 1000;

/** The ticket the orchestrator should be on: the first that has not merged. */
export function nextTicket(epicId: number): EpicTicketWithTask | null {
  return epicTicketsDb.listTickets(epicId).find((t) => t.status !== 'completed') ?? null;
}

/**
 * Decide whether a new orchestrator run is due, after a delay. Fire-and-forget:
 * every failure path logs and stops rather than throwing into a hook.
 */
export function scheduleNextTicket(epicId: number, delayMs: number = HOP_DELAY_MS): void {
  setTimeout(() => {
    void advance(epicId).catch((err: unknown) => {
      console.error(`[EpicOrchestrator] Sequencing failed for epic ${epicId}:`, err);
    });
  }, delayMs);
}

/**
 * Start the next ticket's orchestrator run, or finish the epic.
 *
 * Exported for the boot reconciliation and the orchestrator endpoints, which
 * need the same decision without waiting for a turn to end.
 */
export async function advance(epicId: number): Promise<void> {
  const epic = epicsDb.getById(epicId);
  if (!epic?.orchestration_active || epic.orchestration_blocked) return;

  // Race guard: an epic run already streaming means the orchestrator is mid-turn
  // (or the previous hop already fired). One at a time, as everywhere else.
  const { getRunningAgentForEpic, startEpicAgentRun } = await epicAgentRunner();
  if (getRunningAgentForEpic(epicId)) return;

  const broadcasters = getBridgeBroadcasters();
  const ticket = nextTicket(epicId);

  if (!ticket) {
    await finishOrchestration(epicId);
    return;
  }

  // The current conversation is already on this ticket — it is simply idle
  // between events, which is the normal resting state. Nothing to start.
  const run = currentOrchestratorRun(epicId);
  if (run?.ticket_task_id === ticket.id) return;

  // A ticket's worktree is set up in the background after it is created, and
  // no agent may start before it is ready. Still setting up: wait — the task
  // event subscriber re-advances when the setup ends. Failed: only a human can
  // retry it, so pause the epic and say why.
  const { taskFlags } = await taskApi();
  const flags = taskFlags(ticket.id);
  if (flags?.worktreeState === 'provisioning') {
    console.log(
      `[EpicOrchestrator] Epic ${epicId}: ticket ${ticket.id}'s worktree is still being set up; ` +
        'waiting for it',
    );
    return;
  }
  if (flags?.worktreeState === 'failed') {
    blockOrchestration(
      epicId,
      `The worktree setup of ticket ${ticket.id} failed. Retry the setup from the ticket's ` +
        'page (or delete the ticket), then resume the orchestration.',
      {
        broadcastToEpicSubscribersFn: broadcasters.broadcastToEpicSubscribersFn,
        userId: epic.user_id,
      },
    );
    return;
  }

  console.log(
    `[EpicOrchestrator] Epic ${epicId}: starting orchestrator on ticket ${ticket.id} ` +
      `(#${ticket.position ?? '?'})`,
  );
  await startEpicAgentRun(epicId, 'epic-orchestrator', {
    ticketTaskId: ticket.id,
    broadcastFn: broadcasters.broadcastFn,
    broadcastToTaskSubscribersFn: broadcasters.broadcastToTaskSubscribersFn,
    broadcastToEpicSubscribersFn: broadcasters.broadcastToEpicSubscribersFn,
    userId: epic.user_id ?? undefined,
  });
}

export type PrReviewStart =
  | { started: true; runId: number; conversationId: number }
  | {
      started: false;
      reason: string;
      /** True when the ticket has no open pull request at all — nothing to review. */
      noPullRequest?: boolean;
    };

/**
 * Start the pull-request reviewer on one ticket: a fresh `epic-pr-review` run
 * and conversation, in the ticket's worktree, that reviews the open pull
 * request against the specification, fixes what it finds, gets CI green and
 * merges. Two callers: the PR agent's turn-end hook (the normal path, through
 * `schedulePrReview`) and the orchestrator's `start_pr_review` tool (the retry
 * path after a review that ended without merging).
 *
 * Every guard re-reads live state — the same rule as `advance`. A `started:
 * false` answer is a refusal to explain, never an error: the caller decides
 * whether the orchestrator needs to hear about it.
 */
export async function startPrReview(epicId: number, taskId: number): Promise<PrReviewStart> {
  const epic = epicsDb.getById(epicId);
  if (!epic?.orchestration_active) {
    return { started: false, reason: 'the epic is not being orchestrated' };
  }
  if (epic.orchestration_blocked) {
    return { started: false, reason: 'orchestration is paused' };
  }
  const { taskFlags, taskProgress, getRunningAgentForTask } = await taskApi();
  const flags = taskFlags(taskId);
  if (!flags || epicTicketsDb.epicOf(taskId) !== epicId) {
    return { started: false, reason: `task ${taskId} is not a ticket of epic ${epicId}` };
  }
  if (flags.status === 'completed') {
    return { started: false, reason: `task ${taskId} is already merged` };
  }

  const {
    startEpicAgentRun,
    getActivePrReviewerForEpic,
    EpicPrReviewerConflictError,
  } = await epicAgentRunner();
  const activeReviewer = getActivePrReviewerForEpic(epicId);
  if (activeReviewer) {
    return {
      started: false,
      reason: `PR reviewer run ${activeReviewer.id} is ${activeReviewer.status}`,
    };
  }
  const runningTaskAgent = getRunningAgentForTask(taskId);
  if (runningTaskAgent) {
    return {
      started: false,
      reason:
        `a ${runningTaskAgent.agent_type} agent (run ${runningTaskAgent.id}) ` +
        'is running on this task',
    };
  }
  const progress = await taskProgress(taskId);
  if (!progress?.worktreePath) {
    return { started: false, reason: `task ${taskId} has no worktree`, noPullRequest: true };
  }
  const pr = progress.pullRequest;
  if (!pr || pr.state !== 'OPEN') {
    return {
      started: false,
      reason: pr
        ? `the pull request of task ${taskId} is ${pr.state}, not open`
        : `task ${taskId} has no pull request`,
      noPullRequest: true,
    };
  }

  const broadcasters = getBridgeBroadcasters();
  let started;
  try {
    started = await startEpicAgentRun(epicId, 'epic-pr-review', {
      ticketTaskId: taskId,
      broadcastFn: broadcasters.broadcastFn,
      broadcastToTaskSubscribersFn: broadcasters.broadcastToTaskSubscribersFn,
      broadcastToEpicSubscribersFn: broadcasters.broadcastToEpicSubscribersFn,
      userId: epic.user_id ?? undefined,
    });
  } catch (error) {
    if (error instanceof EpicPrReviewerConflictError) {
      return {
        started: false,
        reason: `PR reviewer run ${error.reviewer.id} is ${error.reviewer.status}`,
      };
    }
    throw error;
  }
  const { agentRun, conversation } = started;
  console.log(
    `[EpicOrchestrator] Epic ${epicId}: started PR review of ticket ${taskId} ` +
      `(run ${agentRun.id}, conversation ${conversation.id})`,
  );
  return { started: true, runId: agentRun.id, conversationId: conversation.id };
}

/**
 * The pull-request agent's turn ended on an orchestrated ticket: hand the pull
 * request to the reviewer, after the same settle delay as the ticket hop.
 *
 * The orchestrator is woken only when that cannot happen — the ticket has no
 * open pull request, or starting the reviewer threw — and the event says
 * which, so it can choose between `start_pr_review` and `block_epic`. A
 * refusal for any other reason (a reviewer already running, the epic paused,
 * the ticket merged meanwhile) is the normal course of events and stays
 * silent.
 */
export function schedulePrReview(
  epicId: number,
  taskId: number,
  prRun: { id: number; agent_type: string; status: string },
  delayMs: number = HOP_DELAY_MS,
): void {
  setTimeout(() => {
    void reviewAfterPrTurn(epicId, taskId, prRun).catch((err: unknown) => {
      console.error(`[EpicOrchestrator] PR review hand-off failed for task ${taskId}:`, err);
    });
  }, delayMs);
}

async function reviewAfterPrTurn(
  epicId: number,
  taskId: number,
  prRun: { id: number; agent_type: string; status: string },
): Promise<void> {
  const wake = (payload: string): void =>
    notifyOrchestrator(epicId, {
      type: 'pr-turn-ended',
      taskId,
      agentType: prRun.agent_type,
      runId: prRun.id,
      status: prRun.status,
      payload,
    });

  let result: PrReviewStart;
  try {
    result = await startPrReview(epicId, taskId);
  } catch (err) {
    wake(
      'The pull-request agent ended, but the server could not start the PR reviewer: ' +
        `${err instanceof Error ? err.message : String(err)}. Use start_pr_review to try ` +
        'again, or block_epic.',
    );
    return;
  }

  if (result.started) return;
  if (result.noPullRequest) {
    wake(
      `The pull-request agent ended, but there is nothing to review: ${result.reason}. ` +
        "Restart it with resume_ticket(agentType: 'pr') — the ticket's worktree still holds " +
        'its work, and the agent commits, pushes and opens the pull request from there. ' +
        'Restart up to twice; block_epic only once both restarts have failed too.',
    );
    return;
  }
  console.log(
    `[EpicOrchestrator] Epic ${epicId}: not starting a PR review of task ${taskId} — ${result.reason}`,
  );
}

/**
 * Every ticket merged. Orchestration stops here — the epic's own status is NOT
 * flipped, because the epic is done when a human merges its final pull request,
 * which is deliberately the one act the orchestrator never performs.
 */
async function finishOrchestration(epicId: number): Promise<void> {
  const updated = epicsDb.setOrchestrationActive(epicId, false);
  if (!updated) return;

  broadcastEpicUpdated(getBridgeBroadcasters().broadcastToEpicSubscribersFn, updated);
  console.log(`[EpicOrchestrator] Epic ${epicId}: every ticket merged, orchestration finished`);

  // Final PR creation is a server-owned invariant, not a prompt convention.
  // The agent still has `open_epic_pr`, and the UI has a retry button, but the
  // normal completion path guarantees an attempt even when the model ends its
  // turn immediately after `merge_task`. The service is idempotent when the
  // agent already opened the PR itself.
  const { createEpicCompletionPR } = await epicBranch();
  const completionPr = await createEpicCompletionPR(epicId);

  if (updated.user_id) {
    const { sendBannerNotification } = await notifications();
    const message = completionPr.success
      ? `${updated.name}: every ticket is merged. The final pull request is ready for your review and merge: ${completionPr.url}`
      : `${updated.name}: every ticket is merged, but the final pull request could not be opened automatically (${completionPr.error ?? 'unknown error'}). Use Open final PR on the epic page to retry.`;
    await sendBannerNotification(
      updated.user_id,
      'Epic implementation complete',
      message,
      { type: 'epic_complete', projectId: String(updated.project_id) },
    ).catch(() => {
      /* best effort */
    });
  }
}

/**
 * Put an epic's orchestrator back to work after it was stopped — by the user
 * resuming it, or by the server restarting under it.
 *
 * Deliberately a *snapshot*, not a replay: the orchestrator is told only that
 * it was interrupted, and re-reads the real state with its own tools. That is
 * what makes the in-memory event queue safe to lose on restart, and it is why
 * both recovery paths share this one function.
 *
 * If there is no orchestrator conversation to wake (orchestration was started
 * but its first run never got off the ground), the sequencer starts one.
 */
export function wakeOrchestrator(
  epicId: number,
  cause: 'resumed' | 'server-restarted',
): void {
  const run = currentOrchestratorRun(epicId);
  if (!run?.conversation_id) {
    scheduleNextTicket(epicId);
    return;
  }

  notifyOrchestrator(epicId, {
    type: 'server-restarted',
    taskId: run.ticket_task_id,
    payload:
      cause === 'resumed'
        ? 'Orchestration was paused and the user has resumed it. Anything that happened while you ' +
          'were stopped is not replayed — re-read the current state with get_epic_state and ' +
          'get_task_progress, then carry on.'
        : 'The server restarted while you were waiting, so any run that was in flight was marked ' +
          'failed and no events reached you. Re-read the current state with get_epic_state and ' +
          'get_task_progress, then pick up where the ticket actually is.',
  });
}
