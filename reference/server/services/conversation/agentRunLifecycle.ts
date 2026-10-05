// Agent-run completion dispatch. The runtime knows one thing about agent
// runs: a conversation's owner domain handles them. Everything
// domain-specific — status writes, chaining, sequencing, notifications —
// lives in the owner adapters (`services/tasks/adapter.ts`,
// `services/epics/adapter.ts`); this module just routes.

import { conversationsDb } from '../../database/conversations.js';
import { getOwnerAdapter, ownerAdapterFor } from './ownerAdapters.js';
import type { StreamingContext } from './types.js';

/** Run owner-domain concurrency checks before any provider work is created. */
export function assertAgentRunTurnCanStart(conversationId: number): void {
  const conversation = conversationsDb.getById(conversationId);
  if (!conversation) return;
  ownerAdapterFor(conversation).assertTurnCanStart(conversationId);
}

/**
 * Tell the owner that a provider turn has successfully registered its active
 * session. Epic runs use this to represent every wake/resume as `running` and
 * to release a user interruption; task behavior is unchanged.
 */
export async function handleAgentRunTurnStarted(ctx: StreamingContext): Promise<void> {
  if (ctx.epicId != null) {
    await getOwnerAdapter('epic').onTurnStarted(ctx);
    return;
  }
  if (ctx.taskId != null) {
    await getOwnerAdapter('task').onTurnStarted(ctx);
  }
}

/**
 * Pre-mark a still-running agent run as 'failed' the instant a provider
 * surfaces a terminal `result` event with `isError: true` — e.g. an OpenAI
 * "You've hit your usage limit" `turn.failed`, or an OpenCode SSE stream that
 * closed before `session.idle`.
 *
 * Non-Anthropic providers report model/usage errors as in-band stream
 * events, not thrown exceptions, so the streaming loop ends *normally*.
 * Without this, the completion handler sees status='running' → marks
 * 'completed' → auto-chains to the next agent → which hits the same limit →
 * runaway loop until the iteration cap trips. Writing 'failed' here makes
 * the "status === 'failed' → no chain" branch fire instead. User Stop is a
 * separate owner-adapter operation and never reaches this path.
 *
 * Best-effort and idempotent: no-ops when there's no linked agent run (a
 * manual chat) or the run isn't 'running'. Never throws — it runs inside the
 * provider's own error-handling path. Dispatched by the conversation's
 * owner, so it covers epic runs as well as task runs.
 */
export function failLinkedAgentRunIfRunning(conversationId: number): void {
  try {
    const conversation = conversationsDb.getById(conversationId);
    if (!conversation) return;
    const failed = ownerAdapterFor(conversation).failLinkedRunIfRunning(conversationId);
    if (failed) {
      console.log(
        `[ConversationAdapter] Marked agent run ${failed.id} (${failed.agent_type}) failed on terminal provider error (conversation ${conversationId})`,
      );
    }
  } catch (err) {
    // Best-effort: never throw out of an error-handling path.
    console.warn(
      '[ConversationAdapter] failed to pre-mark agent run as failed on terminal error:',
      err,
    );
  }
}

/**
 * Build an `onComplete` handler for a streaming session: the owner domain's
 * turn-end hook.
 *
 * **There is intentionally no `isError` parameter.** Failure is determined
 * by what's already in the DB, set deterministically *before* this handler
 * runs by the orphan-recovery sweep on server restart or by
 * `failLinkedAgentRunIfRunning` on a terminal in-band provider error. A
 * thrown SDK error that leaves the
 * row 'running' still lands here as "status was still 'running' → mark
 * 'completed' → chain"; on the Anthropic path the next agent reads the
 * synthetic error left in the transcript and decides whether to retry.
 *
 * No-op if the conversation has neither a task nor an epic in its context.
 */
export function buildAgentRunCompletionHandler(
  ctx: StreamingContext,
): () => Promise<void> {
  return async function onAgentRunComplete(): Promise<void> {
    if (ctx.epicId != null) {
      await getOwnerAdapter('epic').onTurnEnded(ctx);
      return;
    }
    if (ctx.taskId != null) {
      await getOwnerAdapter('task').onTurnEnded(ctx);
    }
  };
}
