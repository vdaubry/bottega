// Session control: abort and read-only queries against the in-memory session
// state. Pure delegation to sessionState.js — no SDK or DB awareness.

import {
  activeSessions,
  activeStreamingSessions,
} from './sessionState.js';
import { cleanupTempFiles } from './media.js';
import { hasProjectAccess } from '../projectService.js';
import { getProvider } from '../providers/registry.js';
import { conversationsDb } from '../../database/conversations.js';
import { ownerAdapterFor } from './ownerAdapters.js';

/**
 * Abort an active session — the user clicked Stop.
 *
 * The owner records the user's intent before the abort lands. Tasks retain
 * their terminal `failed` Stop behavior; epic runs become `blocked`, which
 * makes their completion hook inert until a message resumes the same run.
 *
 * Returns false if the session id is unknown.
 */
export async function abortSession(sessionId: string): Promise<boolean> {
  const session = activeSessions.get(sessionId);
  if (!session) {
    console.log(`[ConversationAdapter] Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`[ConversationAdapter] Aborting session: ${sessionId}`);

    // Persist the explicit interruption BEFORE the abort fires. Completion
    // behavior is owner-specific and derives from this durable run state.
    try {
      const abortedConversation = conversationsDb.getById(session.conversationId);
      const interruptedRun = abortedConversation
        ? await ownerAdapterFor(abortedConversation).interruptLinkedRun(session.conversationId)
        : null;
      if (interruptedRun) {
        console.log(
          `[ConversationAdapter] Interrupted agent run ${interruptedRun.id} ` +
            `(${interruptedRun.agent_type}) on user abort`,
        );
      }
    } catch (interruptError) {
      // Best-effort, like the provider abort below: a missing row or adapter
      // must not block the local abort.
      console.warn(
        `[ConversationAdapter] failed to persist the interruption of ${sessionId}:`,
        interruptError,
      );
    }

    // Kill the subprocess via the SDK's AbortController. More reliable than
    // interrupt(), which is cooperative and can hang if the subprocess is
    // mid tool execution or API call.
    //
    // For Anthropic/Codex the running work IS this local subprocess, so
    // flipping the controller stops it. For OpenCode the turn runs
    // out-of-process inside the per-user `opencode serve`; the controller
    // only gates Bottega's client-side SSE subscription, so aborting it
    // stops Bottega from *listening* but leaves the model running tools
    // and editing the task worktree. We therefore also dispatch to the
    // conversation's provider so its `abortTurn()` can issue the
    // server-side `session.abort()`. `abortTurn` is idempotent for
    // Anthropic/Codex (re-aborting the same controller is a no-op) and is
    // reached only here on user-Stop — normal completion flips the
    // controller in the provider's own `finally` but never calls
    // `abortTurn`, so a completed turn never triggers a spurious
    // server-side abort.
    if (session.abortController) {
      session.abortController.abort();
    }

    try {
      const conversation = conversationsDb.getById(session.conversationId);
      const providerName = conversation?.provider ?? 'anthropic';
      // `sessionId` is the activeSessions key, which equals the provider
      // session id for every provider (claude session id / codex thread id /
      // opencode session id). Hand it straight to abortTurn.
      getProvider(providerName).abortTurn(sessionId);
    } catch (providerAbortError) {
      // Best-effort: an unknown provider, or a turn the provider already
      // cleared, must not block the local cleanup below.
      console.warn(
        `[ConversationAdapter] provider.abortTurn failed for session ${sessionId}:`,
        providerAbortError,
      );
    }

    session.status = 'aborted';
    await cleanupTempFiles(session.tempImagePaths, session.tempDir);
    activeSessions.delete(sessionId);
    // Keep the conversation-busy entry until the aborted streaming loop runs
    // its normal completion lifecycle. Releasing it here would let a resume
    // start before the old completion hook has observed the durable blocked
    // run, allowing that stale hook to complete the newly resumed turn.
    // `handleStreamingComplete` owns this deletion.
    return true;
  } catch (error) {
    console.error(`[ConversationAdapter] Error aborting session ${sessionId}:`, error);
    return false;
  }
}

export function isSessionActive(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  return !!session && session.status === 'active';
}

export function getActiveSessions(): string[] {
  return Array.from(activeSessions.keys());
}

export interface ActiveStreamingDescriptor {
  sessionId: string;
  taskId?: number | null | undefined;
  epicId?: number | null | undefined;
  conversationId: number;
}

export function getActiveStreamingByConversation(
  conversationId: number,
): ActiveStreamingDescriptor | null {
  for (const [sessionId, data] of activeStreamingSessions.entries()) {
    if (data.conversationId === conversationId) {
      return { sessionId, ...data };
    }
  }
  return null;
}

/**
 * Find the conversation id of an in-flight Explore artifact generation for a
 * task, or null. A generation is an `atlas_enabled` conversation that is
 * currently streaming (held in `activeStreamingSessions`). The
 * generate-artifact route uses this to stay idempotent: a task has at most one
 * ongoing generation, so re-opening the Explore view (a fresh mount) — or
 * double-clicking Generate — while the ~5-min plan turn is still running binds
 * to the running generation instead of spawning a duplicate. The in-memory map
 * is the right source: it empties on `streaming-ended`, so a finished or
 * server-restart-orphaned generation correctly reads as "none ongoing".
 */
export function getOngoingAtlasGenerationConversationId(taskId: number): number | null {
  for (const data of activeStreamingSessions.values()) {
    if (data.taskId !== taskId) continue;
    const conversation = conversationsDb.getById(data.conversationId);
    if (conversation?.atlas_enabled) return data.conversationId;
  }
  return null;
}

/**
 * Reconcile liveness when a task is marked `completed`. Deletes every
 * `activeStreamingSessions` entry for the task and returns the
 * {sessionId, conversationId} pairs that were removed so the caller can
 * re-emit a task-channel `streaming-ended` for each (the frontend drops the
 * task from `liveTaskIds` on that event).
 *
 * The realistic trigger is a *leaked* session — a lost `streaming-ended` that
 * only a server restart would otherwise clear. We deliberately touch only the
 * in-memory map here: no abort controller is flipped and no `task_agent_runs`
 * row is mutated, so a genuinely in-flight turn keeps running and its eventual
 * `handleStreamingComplete` re-broadcasts `streaming-ended` idempotently.
 *
 * Deleting from a `Map` while iterating its `.entries()` is safe — the
 * iterator tolerates deletion of the current entry.
 */
export function clearStreamingSessionsForTask(
  taskId: number,
): Array<{ sessionId: string; conversationId: number }> {
  const cleared: Array<{ sessionId: string; conversationId: number }> = [];
  for (const [sessionId, data] of activeStreamingSessions.entries()) {
    if (data.taskId === taskId) {
      cleared.push({ sessionId, conversationId: data.conversationId });
      activeStreamingSessions.delete(sessionId);
    }
  }
  return cleared;
}

/**
 * Returns array of {sessionId, taskId, conversationId} for every active
 * streaming session that `userId` has access to. Used by the dashboard live
 * indicator. Admins (per `hasProjectAccess`) get every session.
 *
 * Resolves the owning project preferentially from the in-memory
 * `activeSessions` (cheap, fresh) and falls back to a DB join
 * (`conversationsDb.findByClaudeSessionId` → `tasksDb.getById`) for sessions
 * that landed in `activeStreamingSessions` before `ActiveSession` was
 * populated, or for entries where the ownership metadata is missing.
 */
export function getAllActiveStreamingSessions(
  userId: number | undefined,
): ActiveStreamingDescriptor[] {
  const sessions: ActiveStreamingDescriptor[] = [];
  for (const [sessionId, data] of activeStreamingSessions.entries()) {
    let projectId: number | null = null;
    const active = activeSessions.get(sessionId);
    if (active && active.projectId !== null) {
      projectId = active.projectId;
    } else {
      const conv = conversationsDb.findByClaudeSessionId(sessionId);
      if (conv) {
        projectId = ownerAdapterFor(conv).resolveOwner(conv)?.projectId ?? null;
      }
    }
    if (projectId === null) continue;
    if (!hasProjectAccess(projectId, userId)) continue;
    sessions.push({
      sessionId,
      taskId: data.taskId,
      epicId: data.epicId,
      conversationId: data.conversationId,
    });
  }
  return sessions;
}
