// Epic-domain bootstrap. The server entrypoint calls these two functions and
// otherwise knows nothing about orchestration internals — the bridge, the
// sequencer and the TaskEvents subscription are all wired here, inside the
// epic layer.

import { epicsDb, epicAgentRunsDb } from '../../database/epics.js';
import {
  currentQaFixRun,
  notifySupervisor,
  setBridgeBroadcasters,
  type BridgeBroadcasters,
} from './orchestrator/bridge.js';
import { wakeOrchestrator } from './orchestrator/sequencing.js';
import { taskFlags } from '../tasks/index.js';
import { registerEpicTaskEventSubscriber } from './taskEventSubscriber.js';
import { registerEpicOwnerAdapter } from './adapter.js';
import { registerEpicServeTargetResolver } from './serveTarget.js';

let subscribed = false;

/**
 * Wire the epic layer up: give the bridge its broadcasters (it starts
 * conversation turns from places that have no request to read `app.locals`
 * off), register the conversation owner adapter and the switch-server serve
 * resolver, and subscribe to the task domain's events. Idempotent.
 */
export function initEpics(broadcasters: BridgeBroadcasters): void {
  setBridgeBroadcasters(broadcasters);
  registerEpicOwnerAdapter();
  registerEpicServeTargetResolver();
  if (!subscribed) {
    registerEpicTaskEventSubscriber();
    subscribed = true;
  }
}

/**
 * Boot self-healing: epics under orchestration resume across restarts. This
 * matters operationally — the service redeploys on every merge to main, so
 * pausing on restart would pause active epics constantly. Each one gets a
 * snapshot wake ("you were interrupted, re-read the state") rather than a
 * replay of events the in-memory queue just lost. Blocked epics are left
 * alone: they are waiting for a human, and a restart is not one.
 */
export function resumeOrchestrationAfterRestart(): void {
  for (const epic of epicsDb.listOrchestrating()) {
    console.log(`[RECOVERY] Resuming orchestration of epic ${epic.id} (${epic.name})`);
    wakeOrchestrator(epic.id, 'server-restarted');
  }

  // The same self-healing for in-flight QA fix missions: without it a redeploy
  // mid-planification strands the mission silently — the run in flight was
  // swept to failed, so no task event will ever fire for it again. A mission
  // is in flight when its ticket is not merged yet (or was never created —
  // its own first turn was the one swept). Blocked runs wait for a human.
  for (const epicId of epicAgentRunsDb.listEpicIdsWithAgentType('epic-qa-fix')) {
    const epic = epicsDb.getById(epicId);
    if (!epic || epic.orchestration_active) continue;
    const run = currentQaFixRun(epicId);
    if (!run?.conversation_id || run.status === 'blocked') continue;
    const ticket = run.ticket_task_id != null ? taskFlags(run.ticket_task_id) : null;
    const inFlight =
      run.ticket_task_id == null
        ? run.status === 'failed'
        : ticket != null && ticket.status !== 'completed';
    if (!inFlight) continue;
    console.log(`[RECOVERY] Waking the QA fix mission of epic ${epicId} (${epic.name})`);
    notifySupervisor(epicId, {
      type: 'server-restarted',
      taskId: run.ticket_task_id,
      payload:
        'The server restarted while your mission was in flight, so any run that was streaming ' +
        'was marked failed and no events reached you. Re-read the state with get_epic_state ' +
        'and get_task_progress, then pick up where the mission actually is.',
    });
  }
}
