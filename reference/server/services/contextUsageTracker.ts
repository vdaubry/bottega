/**
 * Context-usage stream tracker.
 *
 * One instance per streaming session. The conversation adapter creates a
 * tracker, then forwards SDK iterator messages to it via the `onAssistant`
 * and `onResult` hooks. The tracker owns:
 *   - the in-flight `getContextUsage()` promise captured mid-stream,
 *   - building a baseline snapshot from `result.modelUsage`,
 *   - persistence to `conversations.context_usage_json`,
 *   - the `context-usage` WebSocket broadcast.
 *
 * The hybrid baseline+breakdown design is required because bottega spawns a
 * one-shot SDK subprocess per turn, so the control-channel `getContextUsage()`
 * call frequently loses the race against subprocess teardown. The baseline
 * (from `result.modelUsage`) always works; the breakdown (categories, MCP
 * tools, system prompt sections, …) is folded in when the live call wins.
 */

import { conversationsDb } from '../database/db.js';
import type {
  BroadcastFn,
  ConversationId,
} from '@shared/websocket/messages';

interface QueryInstance {
  getContextUsage?: () => Promise<unknown>;
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

  return {
    onAssistant(queryInstance, parentToolUseId, masterModel) {
      // Sub-agents (spawned via the Task tool) emit assistant messages with
      // a non-null `parent_tool_use_id`. Their context window is independent
      // of the master and would clobber the popup's totals/model if we let
      // their breakdown be captured here. Skip them so `pendingContextUsage`
      // always reflects the master agent's most recent state.
      if (parentToolUseId != null) return;
      if (masterModel) observedMasterModel = masterModel;
      pendingContextUsage = captureContextUsage(queryInstance);
    },

    async onResult(resultMessage) {
      const baseline = buildBaselineFromResult(resultMessage, observedMasterModel);
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

  const totalTokens =
    (modelData.inputTokens || 0) +
    (modelData.cacheReadInputTokens || 0) +
    (modelData.cacheCreationInputTokens || 0);
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
