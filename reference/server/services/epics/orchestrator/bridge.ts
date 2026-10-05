// The event bridge — how a dormant supervising agent is woken.
//
// Two agents supervise ticket work through this bridge: the ORCHESTRATOR
// (implementation stage, one conversation per ticket, while
// `orchestration_active`) and the QA FIX agent (one conversation supervising
// the single fix ticket it created). Neither holds a process between events:
// each wake is one conversation turn that ends with the SDK subprocess
// exiting. So "tell the supervisor that something happened" means *resuming
// its conversation with a message*, which is exactly the follow-up-chat path a
// human uses. Events are rendered as `[bottega-event]` blocks so the model can
// parse them reliably without us inventing a second protocol.
//
// Everything here is per-epic and in memory:
//
//  - a FIFO queue, because events land while the orchestrator is mid-turn (its
//    own tool call started the run that just failed). Queued events are batched
//    into ONE message when its turn ends — a second concurrent resume on the
//    same conversation would fork the session.
//  - counters, so a model that answers the same question forever, or ping-pongs
//    with the planification agent, stops instead of burning tokens until
//    someone notices.
//
// The queue is memory-only by design: a restart drops it, and the boot
// reconciliation's `server-restarted` snapshot supersedes anything lost — the
// orchestrator re-reads state from the database rather than replaying history.

import { epicsDb, epicAgentRunsDb, epicTicketsDb } from '../../../database/epics.js';
import { activeSessions } from '../../conversation/sessionState.js';
import { taskFlags } from '../../tasks/index.js';
import { blockOrchestration, blockQaFixSupervision } from './blocking.js';
import type { EpicAgentRunRow, EpicRow } from '@shared/types/db';
import type {
  BroadcastFn,
  BroadcastToEpicSubscribersFn,
  BroadcastToTaskSubscribersFn,
} from '@shared/websocket/messages';

/** Loaded on demand — `startConversation` imports this module's callers. */
const conversationAdapter = () => import('../../conversation/startConversation.js');
const sequencing = () => import('./sequencing.js');

export type BridgeEventType =
  | 'planification-turn-ended'
  | 'pr-turn-ended'
  | 'pr-review-ended'
  | 'agent-run-failed'
  | 'question-pending'
  | 'task-blocked'
  | 'chain-start-failed'
  | 'sync-failed'
  | 'worktree-setup-ended'
  | 'server-restarted';

export interface BridgeEvent {
  type: BridgeEventType;
  taskId?: number | null | undefined;
  agentType?: string | null | undefined;
  runId?: number | null | undefined;
  status?: string | null | undefined;
  /** Questions JSON, a git error, a block reason — whatever the type carries. */
  payload?: string | null | undefined;
}

/**
 * How many times one ticket's orchestrator may be woken before we assume it is
 * looping. Generous: a normal ticket is a handful of wakes.
 */
export const MAX_WAKES = 40;

/** Per-event-type caps. A breach means the ticket is going in circles. */
export const EVENT_CAPS: Partial<Record<BridgeEventType, number>> = {
  'question-pending': 8,
  'planification-turn-ended': 6,
  'pr-turn-ended': 6,
  // The prompt allows one retry; the cap is the backstop behind it.
  'pr-review-ended': 3,
};

interface EpicBridgeState {
  queue: BridgeEvent[];
  /** A resume is in flight; anything arriving now must queue behind it. */
  sending: boolean;
  /** Conversation the counters below belong to — a new ticket resets them. */
  conversationId: number | null;
  wakes: number;
  perType: Map<BridgeEventType, number>;
}

const states = new Map<number, EpicBridgeState>();

function stateFor(epicId: number): EpicBridgeState {
  let state = states.get(epicId);
  if (!state) {
    state = { queue: [], sending: false, conversationId: null, wakes: 0, perType: new Map() };
    states.set(epicId, state);
  }
  return state;
}

/**
 * Broadcasters for the wake-up turns the bridge starts on its own — from a
 * completion hook, an AskUserQuestion park site or the boot reconciliation,
 * none of which is inside a request. `server/index.ts` registers the same
 * closures it puts on `app.locals`; without them the turns still run, they just
 * do not stream to open pages.
 */
export interface BridgeBroadcasters {
  broadcastFn?: BroadcastFn | undefined;
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
  broadcastToEpicSubscribersFn?: BroadcastToEpicSubscribersFn | undefined;
}

let broadcasters: BridgeBroadcasters = {};

export function setBridgeBroadcasters(next: BridgeBroadcasters): void {
  broadcasters = next;
}

export function getBridgeBroadcasters(): BridgeBroadcasters {
  return broadcasters;
}

/** Test seam: forget every epic's queue and counters. */
export function _resetBridgeState(): void {
  states.clear();
}

/** Forget one epic's counters — called when the user resumes a blocked epic. */
export function resetBridgeCounters(epicId: number): void {
  states.delete(epicId);
}

/**
 * Is this task being driven by an orchestrator right now? Every hook in the
 * codebase asks this exact question before doing anything epic-specific, and it
 * must stay cheap: two indexed row reads, no filesystem, no await.
 */
export function isOrchestratedTask(taskId: number): number | null {
  const epicId = epicTicketsDb.epicOf(taskId);
  if (epicId == null) return null;
  const epic = epicsDb.getById(epicId);
  if (!epic?.orchestration_active) return null;
  return epic.id;
}

/** The orchestrator run currently driving this epic, newest first. */
export function currentOrchestratorRun(epicId: number): EpicAgentRunRow | null {
  return (
    epicAgentRunsDb
      .getByEpic(epicId)
      .filter((r) => r.agent_type === 'epic-orchestrator' && r.conversation_id != null)
      .sort((a, b) => b.id - a.id)[0] ?? null
  );
}

/**
 * The newest QA fix run with a conversation, any status — the dormant model
 * cycles running→completed per turn, so status is NOT an activity signal.
 */
export function currentQaFixRun(epicId: number): EpicAgentRunRow | null {
  return (
    epicAgentRunsDb
      .getByEpic(epicId)
      .filter((r) => r.agent_type === 'epic-qa-fix' && r.conversation_id != null)
      .sort((a, b) => b.id - a.id)[0] ?? null
  );
}

export interface EpicSupervisor {
  kind: 'orchestrator' | 'qa-fix';
  epic: EpicRow;
  /** `conversation_id` is non-null by construction. */
  run: EpicAgentRunRow;
  /**
   * Orchestrator: the epic's `orchestration_blocked` flag. QA fix: the run
   * itself is `blocked` (a user Stop, or a runaway-counter breach) — the fix
   * mission never touches the epic's orchestration flags.
   */
  blocked: boolean;
}

/**
 * Who supervises this epic's ticket events. Orchestration wins outright: while
 * `orchestration_active` the QA fix run is never consulted, so two supervisors
 * can never drive the same epic at once.
 */
export function resolveSupervisor(epicId: number): EpicSupervisor | null {
  const epic = epicsDb.getById(epicId);
  if (!epic) return null;

  if (epic.orchestration_active) {
    const run = currentOrchestratorRun(epicId);
    if (!run?.conversation_id) return null;
    return { kind: 'orchestrator', epic, run, blocked: !!epic.orchestration_blocked };
  }

  const run = currentQaFixRun(epicId);
  if (!run?.conversation_id) return null;
  return { kind: 'qa-fix', epic, run, blocked: run.status === 'blocked' };
}

/**
 * The membership gate, per ticket. Orchestrator: any ticket of an actively
 * orchestrated epic (`isOrchestratedTask` semantics, unchanged). QA fix: ONLY
 * the ticket the newest fix run has stamped in `ticket_task_id` — strict
 * match, so a human driving another task of the epic never wakes the fix
 * agent.
 */
export function supervisedEpicOf(
  taskId: number,
): { epicId: number; kind: 'orchestrator' | 'qa-fix' } | null {
  const orchestratedEpicId = isOrchestratedTask(taskId);
  if (orchestratedEpicId != null) return { epicId: orchestratedEpicId, kind: 'orchestrator' };

  const epicId = epicTicketsDb.epicOf(taskId);
  if (epicId == null) return null;
  const run = currentQaFixRun(epicId);
  if (run?.ticket_task_id !== taskId) return null;
  return { epicId, kind: 'qa-fix' };
}

/** True while a turn is streaming on this conversation. */
function isConversationStreaming(conversationId: number): boolean {
  for (const session of activeSessions.values()) {
    if (session.conversationId === conversationId && session.status === 'active') return true;
  }
  return false;
}

/**
 * The ticket flags an orchestrator reasons about, read fresh at send time
 * through the task facade. Kept synchronous — this renders inside the wake
 * message assembly.
 */
function flagsLine(taskId: number | null | undefined): string | null {
  if (taskId == null) return null;
  const task = taskFlags(taskId);
  if (!task) return null;
  return (
    `flags: status=${task.status} planificationComplete=${task.planificationComplete} ` +
    `workflowComplete=${task.workflowComplete} workflowBlocked=${task.workflowBlocked} ` +
    `prAgentComplete=${task.prAgentComplete} runCount=${task.runCount}`
  );
}

function renderEvent(event: BridgeEvent): string {
  const header = [
    `[bottega-event] type=${event.type}`,
    event.taskId != null ? `task=${event.taskId}` : null,
    event.agentType ? `agent=${event.agentType}` : null,
    event.runId != null ? `run=${event.runId}` : null,
    event.status ? `status=${event.status}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const lines = [header];
  const flags = flagsLine(event.taskId);
  if (flags) lines.push(flags);
  if (event.payload?.trim()) lines.push('', event.payload.trim());
  return lines.join('\n');
}

const CLOSING =
  'Decide your next action with your tools. If there is nothing to do, say so and end your turn.';

export function renderEventMessage(events: BridgeEvent[]): string {
  return `${events.map(renderEvent).join('\n\n---\n\n')}\n\n${CLOSING}`;
}

/** Same task, same type, same run = the same news. */
function isDuplicate(queue: BridgeEvent[], event: BridgeEvent): boolean {
  return queue.some(
    (q) => q.type === event.type && q.taskId === event.taskId && q.runId === event.runId,
  );
}

/** A runaway counter tripped: stop the supervisor its own way. */
function blockSupervisor(supervisor: EpicSupervisor, reason: string): void {
  if (supervisor.kind === 'orchestrator') {
    blockOrchestration(supervisor.epic.id, reason, {
      broadcastToEpicSubscribersFn: broadcasters.broadcastToEpicSubscribersFn,
    });
    return;
  }
  blockQaFixSupervision(supervisor.epic.id, supervisor.run.id, reason, {
    broadcastToEpicSubscribersFn: broadcasters.broadcastToEpicSubscribersFn,
  });
}

/**
 * Wake the epic's supervising agent, or queue the event until it can be woken.
 *
 * Silently does nothing when the epic has no supervisor — every hook site
 * calls this unconditionally, and "not supervised" is by far the common case.
 * A blocked supervisor drops the wake with a trace: a run that ends while its
 * supervisor is blocked ends unheard, and without the log that is invisible.
 */
export function notifySupervisor(epicId: number, event: BridgeEvent): void {
  const supervisor = resolveSupervisor(epicId);
  if (!supervisor) return;
  if (supervisor.blocked) {
    console.log(
      `[EpicOrchestrator] Epic ${epicId}'s ${supervisor.kind} supervisor is blocked — ` +
        `dropping '${event.type}' wake` +
        (event.taskId != null ? ` (task ${event.taskId})` : ''),
    );
    return;
  }

  const state = stateFor(epicId);
  // A new supervising conversation starts with clean counters.
  if (state.conversationId !== supervisor.run.conversation_id) {
    state.conversationId = supervisor.run.conversation_id;
    state.wakes = 0;
    state.perType.clear();
  }

  const seen = (state.perType.get(event.type) ?? 0) + 1;
  state.perType.set(event.type, seen);
  const cap = EVENT_CAPS[event.type];
  if (cap && seen > cap) {
    state.queue.length = 0;
    blockSupervisor(
      supervisor,
      `The ${supervisor.kind === 'orchestrator' ? 'orchestrator' : 'QA fix agent'} hit ${seen} ` +
        `'${event.type}' events on this ticket (limit ${cap}) — it is going in circles. ` +
        'Look at the ticket and resume when it is unstuck.',
    );
    return;
  }

  if (!isDuplicate(state.queue, event)) state.queue.push(event);
  void flush(epicId);
}

/** Historical name — every orchestrator-side caller and test uses it. */
export const notifyOrchestrator = notifySupervisor;

/**
 * Deliver everything queued as ONE message, if the supervisor is free to
 * receive it. Re-entrant by design: it returns immediately while a resume is in
 * flight or a turn is streaming, and is called again from the turn-end hook.
 */
export async function flush(epicId: number): Promise<void> {
  const state = states.get(epicId);
  if (!state || state.sending || state.queue.length === 0) return;

  const supervisor = resolveSupervisor(epicId);
  if (!supervisor || supervisor.blocked) return;
  const { epic } = supervisor;

  const conversationId = supervisor.run.conversation_id!;
  if (isConversationStreaming(conversationId)) return;

  if (state.wakes >= MAX_WAKES) {
    state.queue.length = 0;
    blockSupervisor(
      supervisor,
      `The ${supervisor.kind === 'orchestrator' ? 'orchestrator' : 'QA fix agent'} was woken ` +
        `${state.wakes} times on this ticket (limit ${MAX_WAKES}) without finishing it. ` +
        'Look at where it is stuck and resume.',
    );
    return;
  }

  const events = state.queue.splice(0, state.queue.length);
  state.sending = true;
  state.wakes += 1;
  let delivered = false;
  try {
    const { sendMessage } = await conversationAdapter();
    await sendMessage(conversationId, renderEventMessage(events), {
      broadcastFn: broadcasters.broadcastFn,
      broadcastToTaskSubscribersFn: broadcasters.broadcastToTaskSubscribersFn,
      broadcastToEpicSubscribersFn: broadcasters.broadcastToEpicSubscribersFn,
      userId: epic.user_id ?? undefined,
      permissionMode: 'bypassPermissions',
    });
    console.log(
      `[EpicOrchestrator] Woke epic ${epicId} (conversation ${conversationId}) with ` +
        `${events.length} event(s): ${events.map((e) => e.type).join(', ')}`,
    );
    delivered = true;
  } catch (err) {
    // Put them back: a failed resume is a transport problem, not a decision.
    state.queue.unshift(...events);
    console.error(`[EpicOrchestrator] Failed to wake epic ${epicId}:`, err);
  } finally {
    state.sending = false;
  }

  // `sendMessage` runs the turn-completion hook before it resolves. Events
  // queued during that turn therefore see `sending=true` in the hook's flush
  // and cannot drain there. Once the outer send has fully unwound, immediately
  // drain the next batch. Do not auto-retry transport failures: their events
  // were put back above and retrying synchronously would create a hot loop.
  if (delivered && state.queue.length > 0) await flush(epicId);
}

/**
 * The orchestrator's own turn just ended: deliver anything that arrived while
 * it was thinking, then let the sequencer decide whether this ticket is done
 * and the next one should start.
 */
export async function onOrchestratorTurnEnded(epicId: number): Promise<void> {
  await flush(epicId);
  const { scheduleNextTicket } = await sequencing();
  scheduleNextTicket(epicId);
}

/**
 * A pull-request reviewer's turn just ended. It had one job — merge — so the
 * ticket's status says how it went: merged, and the sequencer hops to the
 * next ticket (or finishes the epic); not merged, and the orchestrator is
 * woken to decide between one retry and an escalation. A reviewer that
 * blocked the epic itself is covered by the bridge's blocked check — the wake
 * is dropped.
 *
 * `run.status` is read fresh: the completion hook hands over the row it read
 * before flipping it, and the orchestrator should hear 'completed' or
 * 'failed', not 'running'.
 */
export async function onPrReviewTurnEnded(
  epicId: number,
  run: {
    id: number;
    agent_type: string;
    ticket_task_id: number | null;
    conversation_id?: number | null;
  },
): Promise<void> {
  const taskId = run.ticket_task_id;

  const ticket = taskId != null ? taskFlags(taskId) : null;
  const { scheduleNextTicket } = await sequencing();

  if (ticket?.status === 'completed') {
    scheduleNextTicket(epicId);
    return;
  }

  const status = epicAgentRunsDb.getById(run.id)?.status ?? 'completed';
  notifyOrchestrator(epicId, {
    type: 'pr-review-ended',
    taskId,
    agentType: run.agent_type,
    runId: run.id,
    status,
    payload:
      'The PR reviewer ended without merging the ticket. Check get_task_progress; if the ' +
      'ticket is still open, start_pr_review once — a fresh reviewer picks up where this one ' +
      'left off — and block_epic if that one fails too.',
  });
}
