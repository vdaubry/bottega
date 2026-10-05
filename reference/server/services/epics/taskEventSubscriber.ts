// The epic layer's ear on the task domain.
//
// v2 rule 3: the task layer publishes TaskEvents to nobody in particular; this
// module subscribes at boot (`initEpics`) and translates each event into what
// the supervision machinery already understands — a bridge wake, or a
// sequencing hop. The task layer does not know this file exists.
//
// Every handler starts with the same membership gate: is this task supervised
// — a ticket of an actively orchestrated epic, or the one fix ticket a QA fix
// run has stamped? That question (`supervisedEpicOf`) is epic-side knowledge
// and lives in the bridge; an unsupervised task produces no reaction at all.
// The two supervisor kinds differ in exactly two events: a completed `pr` run
// hands the pull request to the PR reviewer under orchestration but wakes the
// QA fix agent to review it itself, and a merge advances the ticket sequence
// under orchestration but means nothing extra to a fix mission (its own
// `merge_task` call already returned in-turn).

import { epicsDb } from '../../database/epics.js';
import { onTaskEvent } from '../tasks/events.js';
import { supervisedEpicOf, notifySupervisor } from './orchestrator/bridge.js';
import { scheduleNextTicket, schedulePrReview } from './orchestrator/sequencing.js';
import type {
  TaskChainStartFailedEvent,
  TaskQuestionParkedEvent,
  TaskRunEndedEvent,
  TaskWorkflowBlockedEvent,
  TaskWorktreeStateChangedEvent,
} from '../tasks/events.js';

function onRunEnded(event: TaskRunEndedEvent): void {
  const supervised = supervisedEpicOf(event.taskId);
  if (!supervised) return;
  const { epicId, kind } = supervised;

  const base = {
    taskId: event.taskId,
    agentType: event.agentType,
    runId: event.runId,
    status: event.status,
  };

  // Planification ended (any turn — the supervisor reviews or re-asks).
  if (event.agentType === 'planification') {
    notifySupervisor(epicId, { ...base, type: 'planification-turn-ended' });
    return;
  }

  // The PR agent ended: completed → under orchestration the pull request is
  // handed to the PR reviewer (no wake — the orchestrator is deliberately
  // kept out of the review), while the QA fix agent IS the reviewer and is
  // woken to do that job itself; failed (a user abort, a provider error) →
  // the supervisor's call to make.
  if (event.agentType === 'pr') {
    if (event.status === 'failed') {
      notifySupervisor(epicId, {
        ...base,
        type: 'pr-turn-ended',
        payload:
          kind === 'orchestrator'
            ? 'The pull-request agent run failed. If the ticket has an open pull request, ' +
              'start_pr_review — the reviewer finishes what the PR agent did not. If it has ' +
              "none, resume_ticket(agentType: 'pr') restarts the pull-request agent: the " +
              "worktree still holds the ticket's work and the fresh agent commits, pushes and " +
              'opens the pull request. Restart up to twice; block_epic only once both restarts ' +
              'have failed too.'
            : 'The pull-request agent run failed. If the ticket already has an open pull ' +
              "request, review it yourself in the ticket's worktree and merge with merge_task " +
              "once CI is green. If it has none, resume_ticket(agentType: 'pr') restarts the " +
              "pull-request agent: the worktree still holds the ticket's work and the fresh " +
              'agent commits, pushes and opens the pull request. Restart up to twice, then ' +
              'notify_user and stop.',
      });
      return;
    }
    if (event.status === 'completed') {
      if (kind === 'orchestrator') {
        schedulePrReview(epicId, event.taskId, {
          id: event.runId,
          agent_type: event.agentType,
          status: event.status,
        });
      } else {
        notifySupervisor(epicId, {
          ...base,
          type: 'pr-turn-ended',
          payload:
            "The pull-request agent finished and the ticket's pull request is open. Review it " +
            'yourself: get_task_progress for the worktree path and the PR URL, read the whole ' +
            'diff in that worktree, fix what you find, get CI green, then merge_task.',
        });
      }
    }
    return;
  }

  // Successful implementation/review/refinement hops stay silent: the chain
  // handles those itself, and narrating them would wake the supervisor
  // dozens of times per ticket for nothing. Failures are its business.
  if (event.status === 'failed') {
    notifySupervisor(epicId, { ...base, type: 'agent-run-failed' });
  }
}

function onQuestionParked(event: TaskQuestionParkedEvent): void {
  const supervised = supervisedEpicOf(event.taskId);
  if (!supervised) return;
  notifySupervisor(supervised.epicId, {
    type: 'question-pending',
    taskId: event.taskId,
    payload: `The agent is waiting for an answer:\n\n${JSON.stringify(event.questions, null, 2)}`,
  });
}

function onWorkflowBlocked(event: TaskWorkflowBlockedEvent): void {
  const supervised = supervisedEpicOf(event.taskId);
  if (!supervised) return;
  const { epicId } = supervised;
  if (event.reason === 'base-sync-conflict') {
    notifySupervisor(epicId, {
      type: 'sync-failed',
      taskId: event.taskId,
      payload: event.detail ?? 'Syncing the ticket worktree with its base branch failed.',
    });
    return;
  }

  // An agent's own block is a claim, not a verdict — the prompt's procedure
  // applies, so the wake points at it instead of reading like a dead end.
  const closing =
    event.reason === 'agent-requested'
      ? '\n\nThe ticket is stopped. Verify this claim, fix what you can, resume_ticket.'
      : '\n\nThe ticket will not move again on its own.';

  notifySupervisor(epicId, {
    type: 'task-blocked',
    taskId: event.taskId,
    payload:
      (event.detail ?? 'The ticket hit its iteration cap and was blocked.') + closing,
  });
}

function onChainStartFailed(event: TaskChainStartFailedEvent): void {
  const supervised = supervisedEpicOf(event.taskId);
  if (!supervised) return;
  notifySupervisor(supervised.epicId, {
    type: 'chain-start-failed',
    taskId: event.taskId,
    agentType: event.nextAgentType,
    payload: `Starting the ${event.nextAgentType} agent threw: ${event.error}`,
  });
}

function onTaskMerged(event: TaskRunEndedEvent | { taskId: number }): void {
  // A merged ticket moves an ORCHESTRATED epic forward immediately — whether
  // the PR reviewer merged it or a human clicked the Merge button. `advance()`
  // re-reads everything and no-ops while a reviewer turn is still streaming,
  // so the extra hop is always safe. A merged fix ticket needs no reaction:
  // the fix agent's own merge_task call returned inside its turn, and it
  // continues to the re-test from there.
  const supervised = supervisedEpicOf(event.taskId);
  if (supervised?.kind !== 'orchestrator') return;
  scheduleNextTicket(supervised.epicId);
}

function onTaskDeleted(): void {
  // The task row is gone by the time this fires, so membership cannot be
  // looked up — re-evaluate every epic under orchestration instead (rarely
  // more than one). `advance()` starts the next remaining ticket, or finishes
  // an epic whose last ticket was just removed; for an epic the deletion did
  // not concern it is a guarded no-op. A deleted fix ticket simply quiesces
  // its mission's routing.
  for (const epic of epicsDb.listOrchestrating()) {
    scheduleNextTicket(epic.id);
  }
}

function onWorktreeStateChanged(event: TaskWorktreeStateChangedEvent): void {
  if (event.state === 'provisioning') return;
  // A supervising agent that tried to start this ticket was told to end its
  // turn and wait: wake it with the outcome.
  const supervised = supervisedEpicOf(event.taskId);
  if (supervised) {
    notifySupervisor(supervised.epicId, {
      type: 'worktree-setup-ended',
      taskId: event.taskId,
      status: event.state,
      payload:
        event.state === 'ready'
          ? "The ticket's worktree is set up. Start the agent you were waiting to start."
          : "The ticket's worktree setup failed, so no agent can run on it until a human " +
            `retries the setup from its task page:\n\n${event.error ?? '(no detail)'}`,
    });
    return;
  }
  // Otherwise the sequencer may be waiting on this ticket before it starts the
  // orchestrator on it. `advance()` re-reads everything: a ready worktree
  // starts the ticket, a failed one pauses the epic, anything else no-ops.
  for (const epic of epicsDb.listOrchestrating()) {
    scheduleNextTicket(epic.id);
  }
}

/**
 * Subscribe the epic layer to the task domain's events. Called once from
 * `initEpics()`. Returns an unsubscribe function (used by tests).
 */
export function registerEpicTaskEventSubscriber(): () => void {
  const offs = [
    onTaskEvent('run-ended', onRunEnded),
    onTaskEvent('question-parked', onQuestionParked),
    onTaskEvent('workflow-blocked', onWorkflowBlocked),
    onTaskEvent('chain-start-failed', onChainStartFailed),
    onTaskEvent('task-merged', onTaskMerged),
    onTaskEvent('task-deleted', onTaskDeleted),
    onTaskEvent('worktree-state-changed', onWorktreeStateChanged),
  ];
  return () => {
    for (const off of offs) off();
  };
}
