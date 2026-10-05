/**
 * Context-usage stream tracker.
 *
 * One instance per streaming session. The conversation adapter creates a
 * tracker, then forwards SDK iterator messages to it via the `onAssistant`
 * and `onResult` hooks. The tracker owns:
 *   - the in-flight `getContextUsage()` promise captured mid-stream,
 *   - the latest master assistant message's per-request usage,
 *   - building a baseline snapshot from that usage (+ `result.modelUsage` for
 *     the model name and context-window size),
 *   - persistence to `conversations.context_usage_json`,
 *   - the `context-usage` WebSocket broadcast.
 *
 * The hybrid baseline+breakdown design is required because bottega spawns a
 * one-shot SDK subprocess per turn, so the control-channel `getContextUsage()`
 * call frequently loses the race against subprocess teardown. The baseline
 * always works; the breakdown (categories, MCP tools, system prompt sections,
 * …) is folded in when the live call wins.
 *
 * Baseline total: the context-window total comes from the *latest master
 * assistant message's per-request `usage`* (point-in-time occupancy), using the
 * same formula `conversationContentStore.getSessionTokenUsage()` has run
 * accurately for months — `input + cache_read + cache_creation` of the most
 * recent non-sidechain message. It is NOT summed from `result.modelUsage`,
 * which is a turn-wide cumulative aggregate that over-counts agentic turns into
 * the millions. See `buildBaselineFromResult`.
 */

import { conversationsDb } from '../database/conversations.js';
import type {
  BroadcastFn,
  ConversationId,
} from '@shared/websocket/messages';

interface QueryInstance {
  getContextUsage?: () => Promise<unknown>;
}

/**
 * Per-request usage as it appears on a single `assistant` message. Unlike
 * `result.modelUsage` (a turn-wide cumulative aggregate), these fields describe
 * the prompt of *one* API request, so summing them gives that request's
 * point-in-time context-window occupancy.
 */
interface MessageUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ResultMessage {
  type?: string;
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      contextWindow?: number;
    }
  >;
}

interface ContextUsageBaseline {
  model: string;
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  categories: unknown[];
  memoryFiles: unknown[];
  mcpTools: unknown[];
  systemTools: unknown[];
  systemPromptSections: unknown[];
  deferredBuiltinTools: unknown[];
}

interface ContextUsageBreakdown {
  totalTokens: number;
  [key: string]: unknown;
}

export interface CreateContextUsageTrackerOptions {
  conversationId: ConversationId;
  broadcastFn?: BroadcastFn | undefined;
}

export interface ContextUsageTracker {
  onAssistant(
    queryInstance: QueryInstance | null | undefined,
    parentToolUseId: string | null | undefined,
    masterModel?: string | null,
    masterUsage?: MessageUsage | null,
  ): void;
  onResult(resultMessage: ResultMessage | null | undefined): Promise<void>;
}

export function createContextUsageTracker({
  conversationId,
  broadcastFn,
}: CreateContextUsageTrackerOptions): ContextUsageTracker {
  let pendingContextUsage: Promise<ContextUsageBreakdown | null> | null = null;
  // The model the master agent actually used, observed on master assistant
  // events. Used to disambiguate `result.modelUsage` when same-model master+
  // sub-agent runs aggregate into a single key, and to fall back to a
  // correct model name if the breakdown control call drops.
  let observedMasterModel: string | null = null;
  // Per-request usage from the most recent master (non-sidechain) assistant
  // message — the point-in-time context-window occupancy and the correct
  // baseline total, mirroring `getSessionTokenUsage`. `result.modelUsage` is a
  // turn-wide cumulative aggregate (see `buildBaselineFromResult`), so it
  // cannot be summed to a context size.
  let latestMasterUsage: MessageUsage | null = null;

  return {
    onAssistant(queryInstance, parentToolUseId, masterModel, masterUsage) {
      // Sub-agents (spawned via the Task tool) emit assistant messages with
      // a non-null `parent_tool_use_id`. Their context window is independent
      // of the master and would clobber the popup's totals/model if we let
      // their breakdown be captured here. Skip them so `pendingContextUsage`
      // always reflects the master agent's most recent state.
      if (parentToolUseId != null) return;
      if (masterModel) observedMasterModel = masterModel;
      if (masterUsage) latestMasterUsage = masterUsage;
      pendingContextUsage = captureContextUsage(queryInstance);
    },

    async onResult(resultMessage) {
      const baseline = buildBaselineFromResult(
        resultMessage,
        observedMasterModel,
        latestMasterUsage,
      );
      let snapshot: (ContextUsageBaseline & ContextUsageBreakdown) | ContextUsageBaseline | null =
        baseline;
      const breakdown = pendingContextUsage ? await pendingContextUsage : null;
      if (breakdown && breakdown.totalTokens >= 0) {
        snapshot = { ...(baseline ?? {}), ...breakdown } as
          | (ContextUsageBaseline & ContextUsageBreakdown);
        // The breakdown comes from `getContextUsage()` invoked on a master
        // assistant event, so it should already reflect the master. Pin the
        // model name to the observed master regardless, so a stale breakdown
        // can't surface a sub-agent's model in the popup.
        if (observedMasterModel) {
          (snapshot as ContextUsageBaseline).model = observedMasterModel;
        }
      }
      if (!snapshot) return;
      if (conversationId) {
        try {
          conversationsDb.updateContextUsage(conversationId, snapshot);
        } catch (err) {
          console.warn(
            '[ContextUsageTracker] Failed to persist snapshot:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (broadcastFn) {
        broadcastFn(conversationId, {
          type: 'context-usage',
          data: snapshot,
        });
      }
    },
  };
}

function buildBaselineFromResult(
  resultMessage: ResultMessage | null | undefined,
  observedMasterModel: string | null,
  latestMasterUsage: MessageUsage | null,
): ContextUsageBaseline | null {
  if (resultMessage?.type !== 'result' || !resultMessage.modelUsage) {
    return null;
  }
  // Prefer the model we actually observed on master assistant events. Falls
  // back to the first key of `modelUsage` only when nothing was observed
  // (e.g. a turn that never emitted a master assistant event).
  const modelKey =
    observedMasterModel && resultMessage.modelUsage[observedMasterModel]
      ? observedMasterModel
      : Object.keys(resultMessage.modelUsage)[0];
  const modelData = modelKey ? resultMessage.modelUsage[modelKey] : null;
  if (!modelData) return null;

  // Context-window occupancy is a *point-in-time* measure: the prompt size of
  // the most recent API request. This must use the exact formula that
  // `conversationContentStore.getSessionTokenUsage()` has used accurately for
  // months — `contextUsed = input + cache_read + cache_creation` taken from the
  // latest non-sidechain (master) assistant message's per-request `usage`.
  //
  // We deliberately do NOT sum `result.modelUsage` here. That field is a
  // turn-wide CUMULATIVE aggregate: every agentic tool-use round-trip re-reads
  // the full prompt from cache, so its `cacheReadInputTokens` sums those reads
  // (and on same-model master+sub-agent turns both fold into one key). Summing
  // it reports total throughput, not window occupancy, and routinely blows past
  // `contextWindow` (e.g. 2.7M against a 1M window) — the bug this replaces.
  // When no master per-request usage was observed (a degenerate turn with no
  // master assistant message), `getSessionTokenUsage` reports 0; we match that
  // rather than substituting the over-counting aggregate.
  const totalTokens = latestMasterUsage
    ? (latestMasterUsage.input_tokens || 0) +
      (latestMasterUsage.cache_read_input_tokens || 0) +
      (latestMasterUsage.cache_creation_input_tokens || 0)
    : 0;
  // Denominator stays model-aware (multi-provider): the model's real context
  // window from `result.modelUsage`, not a hard-coded 1M.
  const maxTokens = modelData.contextWindow || 0;
  const percentage = maxTokens > 0 ? (totalTokens / maxTokens) * 100 : 0;

  return {
    model: modelKey || 'unknown',
    totalTokens,
    maxTokens,
    rawMaxTokens: maxTokens,
    percentage,
    categories: [],
    memoryFiles: [],
    mcpTools: [],
    systemTools: [],
    systemPromptSections: [],
    deferredBuiltinTools: [],
  };
}

function captureContextUsage(
  queryInstance: QueryInstance | null | undefined,
): Promise<ContextUsageBreakdown | null> {
  if (!queryInstance || typeof queryInstance.getContextUsage !== 'function') {
    return Promise.resolve(null);
  }
  return queryInstance
    .getContextUsage()
    .then((v) => v as ContextUsageBreakdown | null)
    .catch(() => null);
}
