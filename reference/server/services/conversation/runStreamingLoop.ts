// Unified for-await consumer of the SDK iterator, shared by both
// `startConversation` (new session) and `sendMessage` (resume). Owns:
//   - stream_event forwarding to the thinking accumulator
//   - mirror_error filtering
//   - assistant patching + context-usage tracking
//   - claude-response broadcast
//   - session-created broadcast (fires once, on first observed session_id)
//   - claude-status token broadcast (start-only, gated by flag)
//   - first-session-id capture via the `onSessionId` hook
//
// It does NOT own: session creation, MCP wait, image/video handling, deferred
// prompts, DB writes, claude-complete/claude-error broadcasts, abortedSessions
// resolution, or onComplete dispatch. Those live at the call sites because
// they legitimately differ between start and resume (and resume can also
// recover via askUserQuestion's tool_result path).

import type { ThinkingAccumulator } from './thinkingPatcher.js';
import type { ContextUsageTracker } from '../contextUsageTracker.js';
import type { BroadcastFn } from '@shared/websocket/messages';
import { isClaudeAuthError } from './retryOn401.js';

interface SDKIteratorMessage {
  type: string;
  subtype?: string;
  event?: unknown;
  session_id?: string;
  message?: {
    id?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: string;
  };
  errors?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

/**
 * Detect an in-band auth-failure surfaced by the SDK as either:
 *  - an `assistant` message with `message.error === 'authentication_failed'`
 *    (the `SDKAssistantMessageError` enum; see the SDK's sdk.d.ts), or
 *  - a `result` message with `is_error: true` plus a 401 entry in `errors[]`
 *    (the `SDKResultError` variant).
 *
 * The CLI subprocess used to *throw* this from the iterator (matched by
 * `isClaudeAuthError`); on @anthropic-ai/claude-agent-sdk ≥ 0.3.x it
 * delivers the same condition as data instead, with the iterator returning
 * cleanly. Both representations mean the same thing: the in-process
 * credential aged out and a fresh subprocess will recover.
 */
function isInBandAuthError(msg: SDKIteratorMessage): boolean {
  if (msg.type === 'assistant' && msg.message?.error === 'authentication_failed') {
    return true;
  }
  if (msg.type === 'result' && msg.is_error === true && Array.isArray(msg.errors)) {
    return msg.errors.some((entry) => isClaudeAuthError(entry));
  }
  return false;
}

export interface RunStreamingLoopParams {
  queryInstance: AsyncIterable<SDKIteratorMessage>;
  conversationId: number;
  broadcastFn?: BroadcastFn | undefined;
  thinkingAcc: ThinkingAccumulator;
  contextUsageTracker: ContextUsageTracker;
  /** null for new sessions, the existing id for resume */
  initialSessionId?: string | null | undefined;
  /** fired once when session_id is first observed */
  onSessionId?: ((sessionId: string) => void | Promise<void>) | undefined;
  /** emit claude-status token-count broadcasts on assistant turns */
  broadcastClaudeStatus?: boolean | undefined;
  /**
   * Fires once when the SDK emits its final `result` message for the turn.
   * Callers typically use this to abort the SDK subprocess so it doesn't
   * linger waiting on a leftover background task — the SDK can keep itself
   * alive after `end_turn` when an `assistantAutoBackgrounded` Bash is still
   * running, which deadlocks this loop indefinitely. Any error thrown by the
   * iterator after `result` is then swallowed and the loop returns cleanly,
   * so the caller's success-path lifecycle (streaming-ended, agent-run
   * completed, chaining) still runs.
   */
  onResult?: (() => void) | undefined;
}

export async function runStreamingLoop({
  queryInstance,
  conversationId,
  broadcastFn,
  thinkingAcc,
  contextUsageTracker,
  initialSessionId = null,
  onSessionId,
  broadcastClaudeStatus = false,
  onResult,
}: RunStreamingLoopParams): Promise<{ claudeSessionId: string | null; authError: boolean }> {
  let claudeSessionId: string | null = initialSessionId;
  let firstSessionIdSeen = initialSessionId !== null;
  let sessionCreatedBroadcast = false;
  let resultObserved = false;
  let authError = false;

  try {
    for await (const sdkMessage of queryInstance) {
      if (sdkMessage.type === 'stream_event') {
        thinkingAcc.handleStreamEvent(sdkMessage.event as Parameters<ThinkingAccumulator['handleStreamEvent']>[0]);
        continue;
      }

      if (sdkMessage.type === 'system' && sdkMessage.subtype === 'mirror_error') {
        console.warn(
          `[ConversationAdapter] sessionStore mirror_error for ${claudeSessionId}: batch dropped after retries`,
        );
        continue;
      }

      // In-band auth failure: the SDK reports the 401 as data (synthetic
      // assistant + SDKResultError) instead of throwing. Suppress all
      // downstream side effects for this message — broadcasting it would
      // flash "Failed to authenticate" in the UI and patching/tracking
      // would record a bad turn — then fire onResult so the caller aborts
      // the dead subprocess, and signal the auth error up to the caller
      // so it can run the same retry path as the thrown-error case.
      if (!authError && isInBandAuthError(sdkMessage)) {
        authError = true;
        console.warn(
          `[ConversationAdapter] In-band auth 401 observed on conversation ${conversationId} (session ${claudeSessionId ?? 'pre-session'})`,
        );
        if (!resultObserved) {
          resultObserved = true;
          onResult?.();
        }
        continue;
      }

      if (sdkMessage.type === 'assistant') {
        thinkingAcc.patchAssistantMessage(sdkMessage);
        const parentToolUseId = (sdkMessage as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        const masterModel = (sdkMessage.message as { model?: string } | undefined)?.model ?? null;
        contextUsageTracker.onAssistant(
          queryInstance as unknown as Parameters<ContextUsageTracker['onAssistant']>[0],
          parentToolUseId,
          masterModel,
        );
      }

      if (sdkMessage.session_id && !firstSessionIdSeen) {
        firstSessionIdSeen = true;
        claudeSessionId = sdkMessage.session_id;
        if (onSessionId) {
          await onSessionId(claudeSessionId);
        }
      }

      if (broadcastFn) {
        // Dual-emit: legacy `claude-response` for current clients, new
        // `ai-response` with a provider tag for Codex-aware clients. The
        // legacy emit gets removed in Phase 14 cleanup after every UI
        // surface has migrated.
        broadcastFn(conversationId, {
          type: 'claude-response',
          data: sdkMessage as never,
        });
        broadcastFn(conversationId, {
          type: 'ai-response',
          data: sdkMessage as never,
          provider: 'anthropic',
        });

        if (claudeSessionId && !sessionCreatedBroadcast) {
          sessionCreatedBroadcast = true;
          broadcastFn(conversationId, {
            type: 'session-created',
            sessionId: claudeSessionId,
          });
        }

        if (sdkMessage.type === 'result') {
          await contextUsageTracker.onResult(sdkMessage);
        }

        if (broadcastClaudeStatus && sdkMessage.type === 'assistant' && sdkMessage.message?.usage) {
          const usage = sdkMessage.message.usage;
          const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
          if (tokens > 0) {
            broadcastFn(conversationId, {
              type: 'claude-status',
              data: {
                tokens,
                text: 'Generating...',
                can_interrupt: true,
              },
            });
          }
        }
      }

      // Fire onResult AFTER all downstream handlers for this message have
      // run, so the claude-response/contextUsageTracker calls above are not
      // racing with the caller's abort.
      if (sdkMessage.type === 'result' && !resultObserved) {
        resultObserved = true;
        onResult?.();
      }
    }
  } catch (error) {
    // After `result`, the meaningful part of the turn is done. If the
    // iterator then errors out — typically because `onResult` aborted the
    // SDK subprocess to break it out of an `assistantAutoBackgrounded`
    // wait — treat it as a clean turn end so the caller's success-path
    // lifecycle (streaming-ended, agent-run completed, chaining) still
    // runs. Errors thrown *before* `result` propagate as before.
    if (resultObserved) {
      console.log(
        `[ConversationAdapter] iterator threw after result for session ${claudeSessionId} — treating as clean turn end (${(error as Error).message ?? error})`,
      );
      return { claudeSessionId, authError };
    }
    throw error;
  }

  return { claudeSessionId, authError };
}
