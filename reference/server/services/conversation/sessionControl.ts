// Session control: abort and read-only queries against the in-memory session
// state. Pure delegation to sessionState.js — no SDK or DB awareness.

import {
  activeSessions,
  activeStreamingSessions,
} from './sessionState.js';
import { cleanupTempFiles } from './media.js';
import { hasProjectAccess } from '../projectService.js';
import { getProvider } from '../providers/registry.js';
import { conversationsDb, tasksDb, agentRunsDb } from '../../database/db.js';
import type { Provider } from '@shared/providers/types';

/**
 * Abort an active session — the user clicked Stop.
 *
 * This is the *only* runtime path that marks an agent run as `'failed'`
 * (the other writer is the server-restart orphan recovery in `server/index.ts`).
 * We write the DB row synchronously *before* the abort lands, so the
 * streaming loop's completion handler will see `status='failed'` when it
 * eventually runs and skip the chain. Everything downstream — chaining,
 * notifications — derives from the DB status, not from a separate
 * in-memory flag. That keeps "what failed" deterministic instead of
 * derived from an `isError` boolean threaded through the streaming loop.
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

    // Mark the linked agent run 'failed' BEFORE the abort fires. The
    // streaming loop's completion handler reads the row to decide whether
    // to chain — a 'failed' row stops the loop, a 'running' row (no agent
    // run linked, e.g. a manual chat) is the no-op case.
    const linkedAgentRun = agentRunsDb.getByConversationId(session.conversationId);
    if (linkedAgentRun && linkedAgentRun.status === 'running') {
      agentRunsDb.updateStatus(linkedAgentRun.id, 'failed');
      console.log(
        `[ConversationAdapter] Marked agent run ${linkedAgentRun.id} (${linkedAgentRun.agent_type}) failed on user abort`,
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
      const providerName = (conversation?.provider as Provider | undefined) ?? 'anthropic';
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
    activeStreamingSessions.delete(sessionId);
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
      if (conv?.task_id) {
        const task = tasksDb.getById(conv.task_id);
        if (task) projectId = task.project_id;
      }
    }
    if (projectId === null) continue;
    if (!hasProjectAccess(projectId, userId)) continue;
    sessions.push({
      sessionId,
      taskId: data.taskId,
      conversationId: data.conversationId,
    });
  }
  return sessions;
}
