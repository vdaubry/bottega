// TaskEvents — the task domain's outbound event stream.
//
// Rule 3 of the v2 architecture (docs/epics/architecture-v2.md): the task
// layer publishes domain events to nobody in particular. The epic layer
// subscribes at boot (`initEpics`); a task never knows whether anyone is
// listening. This module is the only coupling surface pointing UP from the
// task domain — it exports an emitter and payload types, and imports nothing.
//
// Emission is synchronous and ordered: `emitTaskEvent` calls every subscriber
// in registration order before it returns. That property is load-bearing for
// `run-ended`, which fires where `notifyOrchestratorOfTurnEnd` used to sit —
// after the run's terminal status write, BEFORE any chaining decision — so a
// subscriber always observes the turn end before the next agent starts.
//
// Subscriber errors are caught and logged; a listener can never fail a turn.

import type {
  AgentRunDriver,
  AgentRunStatus,
  AgentType,
  TaskWorktreeState,
} from '@shared/types/db';

export interface TaskRunEndedEvent {
  taskId: number;
  runId: number;
  /** The run's agent type as stored on the row. */
  agentType: AgentType;
  /** Who drove the run — 'human' or 'automation'. */
  driver: AgentRunDriver;
  /**
   * Terminal status of the run as this turn ends: 'completed' when the loop
   * exited normally, or the pre-written status ('failed' on user-Stop /
   * provider error) otherwise. Never 'running'.
   */
  status: AgentRunStatus;
  conversationId: number | null;
}

export interface TaskQuestionParkedEvent {
  taskId: number;
  conversationId: number;
  /** The AskUserQuestion payload, verbatim. */
  questions: unknown[];
}

export interface TaskWorkflowBlockedEvent {
  taskId: number;
  /**
   * 'agent-requested' is the agent's own call — `scripts/block-workflow.ts`,
   * run from inside its turn. That write happens in a separate process, so
   * the server only learns of it when the turn ends and the chain re-reads
   * the row; the task adapter publishes it from there. The other two are
   * conditions the server itself detected.
   */
  reason: 'agent-requested' | 'max-iterations' | 'base-sync-conflict';
  /** Human-readable detail (the agent's reason, the git error for a sync conflict). */
  detail?: string;
}

export interface TaskChainStartFailedEvent {
  taskId: number;
  /** The agent type the chain tried and failed to start. */
  nextAgentType: AgentType;
  error: string;
}

export interface TaskMergedEvent {
  taskId: number;
}

export interface TaskDeletedEvent {
  taskId: number;
}

/**
 * The task's worktree setup moved: started ('provisioning', on a retry),
 * finished ('ready'), or failed ('failed', with the reason). Creation itself
 * emits nothing — the new row already says 'provisioning'.
 */
export interface TaskWorktreeStateChangedEvent {
  taskId: number;
  state: TaskWorktreeState;
  error: string | null;
}

export interface TaskEventMap {
  'run-ended': TaskRunEndedEvent;
  'question-parked': TaskQuestionParkedEvent;
  'workflow-blocked': TaskWorkflowBlockedEvent;
  'chain-start-failed': TaskChainStartFailedEvent;
  'task-merged': TaskMergedEvent;
  'task-deleted': TaskDeletedEvent;
  'worktree-state-changed': TaskWorktreeStateChangedEvent;
}

export type TaskEventName = keyof TaskEventMap;

type Listener<E extends TaskEventName> = (event: TaskEventMap[E]) => void;

const listeners = new Map<TaskEventName, Array<Listener<TaskEventName>>>();

/** Subscribe. Returns an unsubscribe function. */
export function onTaskEvent<E extends TaskEventName>(
  name: E,
  listener: Listener<E>,
): () => void {
  const list = listeners.get(name) ?? [];
  list.push(listener as Listener<TaskEventName>);
  listeners.set(name, list);
  return () => {
    const current = listeners.get(name);
    if (!current) return;
    const index = current.indexOf(listener as Listener<TaskEventName>);
    if (index !== -1) current.splice(index, 1);
  };
}

/**
 * Emit to every subscriber, synchronously, in registration order. A throwing
 * subscriber is logged and skipped — emission never propagates errors back
 * into the task layer.
 */
export function emitTaskEvent<E extends TaskEventName>(
  name: E,
  event: TaskEventMap[E],
): void {
  const list = listeners.get(name);
  if (!list || list.length === 0) return;
  // Copy: a subscriber unsubscribing (itself or another) mid-emit must not
  // shift the iteration.
  for (const listener of [...list]) {
    try {
      listener(event);
    } catch (err) {
      console.error(`[TaskEvents] '${name}' subscriber failed:`, err);
    }
  }
}

/** Test seam: drop every subscriber. */
export function _resetTaskEventListeners(): void {
  listeners.clear();
}
