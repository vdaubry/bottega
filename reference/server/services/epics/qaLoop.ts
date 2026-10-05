// Continuing QA execution until the book is filled.
//
// One `epic-qa-execution` turn rarely finishes a large scenario book — the
// executor records what it completed and ends when its context runs low. The
// book itself says whether QA is done (every row carries pass or fail), so the
// continuation decision is deterministic backend code, not another agent: when
// an execution turn ends, this module re-reads the CSV and, while not-run rows
// remain, starts a fresh run — blank context, `{{qaProgress}}` recomputed.
//
// It runs where the task layer's chaining runs — in the turn-end hook, one
// second later, re-reading everything fresh. Termination is layered: every row
// resulted (finished), a turn that recorded nothing new (stalled — the
// executor deliberately leaves rows it cannot execute, so respawning would
// loop forever), a continuation cap as a backstop, and the user's Stop (the
// adapter never dispatches a blocked run here; failed runs are excluded the
// same way).
//
// Guard state is memory-only, like the bridge's event queue: a restart loses
// it, the loop simply does not auto-continue, and the user's next Run QA click
// opens a fresh budget — the CSV holds everything that matters.

import { epicsDb } from '../../database/epics.js';
import { readEpicQaFile } from './epicArchive.js';
import { getBridgeBroadcasters } from './orchestrator/bridge.js';
import { QA_SCENARIOS_FILENAME, countQaProgress, parseQaScenarios } from '@shared/schemas/qa';
import type { EpicWithProject } from '../../database/epics.js';

const epicAgentRunner = () => import('./epicAgentRunner.js');
/** Lazy for the same reason as the sequencer: `notifications` reaches the transcript store. */
const notifications = () => import('../notifications.js');

/** Same 1s settle as the task chaining: let the ending turn's writes land. */
export const QA_CONTINUATION_DELAY_MS = 1000;

/**
 * Backstop only — the stall guard is the real terminator. The largest real
 * book so far (134 scenarios) needed ~3 runs; 15 covers books several times
 * that size, in the spirit of the task layer's `MAX_WORKFLOW_RUNS`.
 */
export const MAX_QA_CONTINUATIONS = 15;

interface QaLoopState {
  /** The book's not-run count when the continuation was spawned. */
  notRunAtSpawn: number;
  /** Consecutive auto-spawned runs since the user-initiated one. */
  continuations: number;
}

const states = new Map<number, QaLoopState>();

/** A user-initiated run opens a fresh continuation budget. */
export function resetQaLoopState(epicId: number): void {
  states.delete(epicId);
}

/** Test seam. */
export function _resetAllQaLoopState(): void {
  states.clear();
}

/**
 * A QA execution turn ended normally: decide, after a delay. Fire-and-forget:
 * every failure path logs and stops rather than throwing into a hook.
 */
export function onQaExecutionTurnEnded(
  epicId: number,
  delayMs: number = QA_CONTINUATION_DELAY_MS,
): void {
  setTimeout(() => {
    void decide(epicId).catch((err: unknown) => {
      states.delete(epicId);
      console.error(`[QaLoop] Continuation decision failed for epic ${epicId}:`, err);
    });
  }, delayMs);
}

async function notifyUser(epic: EpicWithProject, title: string, message: string): Promise<void> {
  if (epic.user_id == null) return;
  const { sendBannerNotification } = await notifications();
  await sendBannerNotification(epic.user_id, title, message, {
    type: 'epic_qa',
    projectId: String(epic.project_id),
  }).catch(() => {
    /* best effort */
  });
}

/**
 * The continuation decision. Exported for tests; every input is re-read fresh
 * because both the CSV and the run table may have changed during the delay.
 */
export async function decide(epicId: number): Promise<void> {
  const epic = epicsDb.getWithProject(epicId);
  if (!epic) return;

  const content = readEpicQaFile(epic.project_id, epicId, QA_SCENARIOS_FILENAME);
  const parsed = content === null ? null : parseQaScenarios(content);
  if (parsed === null || !parsed.ok) {
    // Respawning cannot repair a missing or malformed book — the next run's
    // opening message would only tell the agent to say so and stop.
    states.delete(epicId);
    console.error(
      `[QaLoop] Epic ${epicId}: scenarios.csv is ` +
        `${parsed === null ? 'missing' : 'invalid'} — not continuing`,
    );
    return;
  }

  const { total, pass, fail, notRun } = countQaProgress(parsed.rows);
  const state = states.get(epicId);

  if (notRun === 0) {
    states.delete(epicId);
    console.log(`[QaLoop] Epic ${epicId}: QA execution finished — ${pass} pass, ${fail} fail`);
    await notifyUser(
      epic,
      'Epic QA complete',
      `${epic.name}: all ${total} scenario(s) executed — ${pass} pass, ${fail} fail.`,
    );
    return;
  }

  if (state && notRun >= state.notRunAtSpawn) {
    states.delete(epicId);
    console.log(
      `[QaLoop] Epic ${epicId}: a QA run ended without recording any new result — stopping ` +
        `(${notRun} scenario(s) still not run)`,
    );
    await notifyUser(
      epic,
      'Epic QA stalled',
      `${epic.name}: a QA run ended without recording any new result — ${notRun} scenario(s) ` +
        "remain not run. Read the last run's summary, then Run QA to try again.",
    );
    return;
  }

  if ((state?.continuations ?? 0) >= MAX_QA_CONTINUATIONS) {
    states.delete(epicId);
    console.log(`[QaLoop] Epic ${epicId}: continuation cap (${MAX_QA_CONTINUATIONS}) reached`);
    await notifyUser(
      epic,
      'Epic QA paused',
      `${epic.name}: ${MAX_QA_CONTINUATIONS} QA runs in a row and ${notRun} scenario(s) still ` +
        'not run. Run QA to continue.',
    );
    return;
  }

  // Race guard: an active run (streaming, or blocked and resumable in place)
  // means the epic is busy — that run's own turn-end re-evaluates, so the
  // guard state stays untouched.
  const { getRunningAgentForEpic, startEpicAgentRun } = await epicAgentRunner();
  if (getRunningAgentForEpic(epicId)) return;
  if (!epic.feature_branch) {
    states.delete(epicId);
    console.error(`[QaLoop] Epic ${epicId}: no feature branch — not continuing`);
    return;
  }

  const continuations = (state?.continuations ?? 0) + 1;
  states.set(epicId, { notRunAtSpawn: notRun, continuations });
  console.log(
    `[QaLoop] Epic ${epicId}: ${notRun}/${total} scenario(s) not run — starting ` +
      `continuation run ${continuations}`,
  );
  const broadcasters = getBridgeBroadcasters();
  try {
    await startEpicAgentRun(epicId, 'epic-qa-execution', {
      broadcastFn: broadcasters.broadcastFn,
      broadcastToEpicSubscribersFn: broadcasters.broadcastToEpicSubscribersFn,
      userId: epic.user_id ?? undefined,
    });
  } catch (err) {
    states.delete(epicId);
    console.error(`[QaLoop] Epic ${epicId}: failed to start the continuation run:`, err);
    await notifyUser(
      epic,
      'Epic QA interrupted',
      `${epic.name}: the QA continuation run could not be started — ${notRun} scenario(s) ` +
        'still not run. Run QA to continue.',
    );
  }
}
