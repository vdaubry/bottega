// Stopping — and resuming — orchestration, in one place.
//
// Two callers block an epic and they must behave identically: the orchestrator
// itself (`block_epic`, when it decides it is stuck) and the event bridge (when
// a runaway counter trips). Both set the same flag, announce it on the same
// channel and send the same push, because from the user's side there is no
// difference — the epic stopped and it needs them.

import { epicsDb, epicAgentRunsDb } from '../../../database/epics.js';
import { broadcastEpicUpdated } from '../epicEvents.js';
import { resetBridgeCounters } from './bridge.js';
import type { EpicAgentRunRow, EpicRow } from '@shared/types/db';
import type { BroadcastToEpicSubscribersFn } from '@shared/websocket/messages';

export function blockOrchestration(
  epicId: number,
  reason: string,
  options: {
    broadcastToEpicSubscribersFn?: BroadcastToEpicSubscribersFn | undefined;
    userId?: number | null | undefined;
  } = {},
): EpicRow | null {
  const updated = epicsDb.setOrchestrationBlocked(epicId, true, reason);
  if (!updated) return null;

  broadcastEpicUpdated(options.broadcastToEpicSubscribersFn, updated);

  // Loaded on demand: `notifications` reaches the transcript store through
  // `taskService`, and this module is in the MCP tool catalog's import graph.
  const notifyUserId = options.userId ?? updated.user_id;
  if (notifyUserId) {
    void import('../../notifications.js')
      .then(({ sendBannerNotification }) =>
        sendBannerNotification(
          notifyUserId,
          'Epic orchestration paused',
          `${updated.name}: ${reason.slice(0, 160)}`,
          { type: 'epic_blocked', projectId: String(updated.project_id) },
        ),
      )
      .catch(() => {
        /* push is best-effort; the flag is what matters */
      });
  }

  console.log(`[EpicOrchestrator] Epic ${epicId} blocked: ${reason}`);
  return updated;
}

/**
 * The QA fix twin of `blockOrchestration`: durable, per-RUN, never the epic's
 * orchestration flags. Marks the run `blocked` — the exact state a user Stop
 * produces, so the resume path already exists: the user sends a message into
 * the conversation, `beginConversationTurn` flips it back to running, and the
 * bridge counters reset on the resumed turn. Why not merely drop the in-memory
 * state: that would reset the counters too, handing a genuinely looping agent
 * a fresh budget on the very next event — a slow runaway. The blocked row is
 * the durable brake.
 */
export function blockQaFixSupervision(
  epicId: number,
  runId: number,
  reason: string,
  options: {
    broadcastToEpicSubscribersFn?: BroadcastToEpicSubscribersFn | undefined;
  } = {},
): EpicAgentRunRow | null {
  const run = epicAgentRunsDb.updateStatus(runId, 'blocked');
  if (!run) return null;

  options.broadcastToEpicSubscribersFn?.(epicId, {
    type: 'agent-run-updated',
    agentRun: {
      id: run.id,
      status: 'blocked',
      agent_type: run.agent_type,
      conversation_id: run.conversation_id,
    },
  });

  const epic = epicsDb.getWithProject(epicId);
  if (epic?.user_id) {
    void import('../../notifications.js')
      .then(({ sendBannerNotification }) =>
        sendBannerNotification(
          epic.user_id!,
          'Epic QA fix paused',
          `${epic.name}: ${reason.slice(0, 160)}`,
          { type: 'epic_qa', projectId: String(epic.project_id) },
        ),
      )
      .catch(() => {
        /* push is best-effort; the blocked run is what matters */
      });
  }

  console.log(`[EpicQaFix] Epic ${epicId}: fix run ${runId} blocked: ${reason}`);
  return run;
}

/**
 * The inverse, kept next to its counterpart: clear the block because the
 * orchestrator is acting again. Called by the orchestrator's action tools —
 * a user who steers a blocked orchestrator into starting a ticket agent has,
 * through it, resumed orchestration. Without this the started run is a
 * stranded one: the bridge drops every wake while the epic is blocked, so
 * the run's failure would never come back to the orchestrator (exactly how
 * epic 4's restarted PR agent failed unheard). Mirrors the resume endpoint:
 * flag off, bridge counters reset, same broadcast. No-op when the epic is
 * gone, not orchestrated, or not blocked.
 */
export function resumeOrchestration(
  epicId: number,
  options: {
    broadcastToEpicSubscribersFn?: BroadcastToEpicSubscribersFn | undefined;
  } = {},
): EpicRow | null {
  const epic = epicsDb.getById(epicId);
  if (!epic?.orchestration_active || !epic.orchestration_blocked) return null;

  const updated = epicsDb.setOrchestrationBlocked(epicId, false);
  if (!updated) return null;

  resetBridgeCounters(epicId);
  broadcastEpicUpdated(options.broadcastToEpicSubscribersFn, updated);
  console.log(`[EpicOrchestrator] Epic ${epicId} unblocked — the orchestrator is acting again`);
  return updated;
}
