/**
 * The orchestration stage, read from the outside — in one place.
 *
 * The Implementation section derives what it says and what it offers from
 * here, so its chip, its progress bar and its button can never disagree about
 * whether the epic is running, paused or done.
 *
 * The gates mirror the server's `/orchestrator/{start,pause,resume}` routes
 * (`server/routes/epics.ts`), which stay authoritative: this only decides what
 * to offer, and a request the server refuses surfaces its 409 on the page.
 *
 * The final pull request is deliberately NOT here. Orchestration ends when the
 * last ticket merges; opening, discussing and landing the epic's own pull
 * request is the Delivery section's job, and folding "Open final PR" into this
 * state machine made the epic's last action look like an orchestration step
 * (see `docs/epics/delivery.md`).
 */

import type { EpicRow, TaskRow } from '@shared/types/db';

export type OrchestrationAction = 'start' | 'pause' | 'resume';

/**
 * What the orchestration is doing. Deliberately not the latest orchestrator
 * run's status: the orchestrator is dormant between events — it wakes, takes
 * one decision, and its subprocess exits — so its last run reads `completed`
 * for most of an active orchestration. The epic row's flags and the ticket
 * rows are what actually say where the stage is.
 */
export type OrchestrationStatus = 'not_started' | 'running' | 'paused' | 'completed';

function everyTicketMerged(tickets: TaskRow[]): boolean {
  return tickets.length > 0 && tickets.every((t) => t.status === 'completed');
}

export function orchestrationStatus(epic: EpicRow, tickets: TaskRow[]): OrchestrationStatus {
  // A block keeps `orchestration_active` set (the epic is still under
  // orchestration, just waiting on a human), so it is checked first.
  if (epic.orchestration_blocked) return 'paused';
  if (epic.orchestration_active) return 'running';
  if (everyTicketMerged(tickets)) return 'completed';
  return 'not_started';
}

export interface OrchestrationPrimaryAction {
  action: OrchestrationAction;
  label: string;
  /** The label while the request is in flight. */
  pendingLabel: string;
  /** Why the action cannot be taken yet, or null when it can. */
  disabledReason: string | null;
}

/**
 * The one action the stage offers next, and whether it can be taken — or null
 * when the stage is over and offers none.
 */
export function primaryOrchestrationAction(
  epic: EpicRow,
  tickets: TaskRow[],
): OrchestrationPrimaryAction | null {
  switch (orchestrationStatus(epic, tickets)) {
    case 'completed':
      // Every ticket merged. Nothing left to start, pause or resume — what
      // happens next lives in the Delivery section.
      return null;
    case 'paused':
      return { action: 'resume', label: 'Resume', pendingLabel: 'Resuming…', disabledReason: null };
    case 'running':
      return { action: 'pause', label: 'Pause', pendingLabel: 'Pausing…', disabledReason: null };
    case 'not_started':
      return {
        action: 'start',
        label: 'Start orchestration',
        pendingLabel: 'Starting…',
        // The same three refusals as the route, in the same order.
        disabledReason: !epic.stories_complete
          ? 'Create and approve the epic tickets first.'
          : !epic.review_complete
            ? 'Finish the specification review first — or mark it complete to skip it.'
            : tickets.length === 0
              ? 'This epic has no tickets.'
              : null,
      };
  }
}
