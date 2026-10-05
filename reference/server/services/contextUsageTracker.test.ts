import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../database/conversations.js', () => ({
  conversationsDb: {
    updateContextUsage: vi.fn()
  }
}));

import { createContextUsageTracker } from './contextUsageTracker.js';
import { conversationsDb } from '../database/conversations.js';

// Resolved (versioned) Claude model IDs — what the SDK reports back in
// `result.modelUsage` and `assistant.message.model`. Defined in one place
// per file so a future model rev (e.g. Opus 4.8) only needs one update.
const MASTER_MODEL = 'claude-opus-4-7';
const SUB_AGENT_MODEL = 'claude-sonnet-4-6';

const baselineResult = {
  type: 'result',
  modelUsage: {
    [MASTER_MODEL]: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
      contextWindow: 200000
    }
  }
};

describe('contextUsageTracker', () => {
  // BroadcastFn shape from contextUsageTracker; vi.fn() is structurally compatible
  // but TS can't prove it without a cast at call sites. Keep loose.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let broadcastFn: any;

  beforeEach(() => {
    vi.clearAllMocks();
    broadcastFn = vi.fn();
  });

  it('uses the live breakdown when getContextUsage resolves before result', async () => {
    const breakdown = {
      totalTokens: 19141,
      maxTokens: 200000,
      percentage: 9.57,
      model: MASTER_MODEL,
      categories: [{ name: 'System prompt', tokens: 6000, color: '#3498db' }]
    };
    const queryInstance = { getContextUsage: vi.fn().mockResolvedValue(breakdown) };
    const tracker = createContextUsageTracker({ conversationId: 7, broadcastFn });

    tracker.onAssistant(queryInstance, null, MASTER_MODEL);
    await tracker.onResult(baselineResult);

    expect(queryInstance.getContextUsage).toHaveBeenCalled();
    expect(conversationsDb.updateContextUsage).toHaveBeenCalledWith(7, expect.objectContaining({
      totalTokens: 19141,
      categories: [{ name: 'System prompt', tokens: 6000, color: '#3498db' }]
    }));
    expect(broadcastFn).toHaveBeenCalledWith(7, {
      type: 'context-usage',
      data: expect.objectContaining({ totalTokens: 19141 })
    });
  });

  it('falls back to the latest master per-request usage (not the modelUsage aggregate) when getContextUsage rejects', async () => {
    const queryInstance = { getContextUsage: vi.fn().mockRejectedValue(new Error('Query closed')) };
    const tracker = createContextUsageTracker({ conversationId: 7, broadcastFn });

    // The master assistant message carries the point-in-time per-request usage.
    tracker.onAssistant(queryInstance, null, MASTER_MODEL, {
      input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 100,
    });
    await tracker.onResult(baselineResult);

    expect(broadcastFn).toHaveBeenCalledTimes(1);
    expect(broadcastFn.mock.calls[0][1].data).toEqual(expect.objectContaining({
      model: MASTER_MODEL,
      totalTokens: 1300, // input + cache_read + cache_creation of the last request
      maxTokens: 200000,
      categories: []
    }));
  });

  it('reports 0 (never the cumulative modelUsage sum) when no master assistant usage was observed', async () => {
    const tracker = createContextUsageTracker({ conversationId: 7, broadcastFn });

    // No onAssistant call → no per-request usage. getSessionTokenUsage reports
    // 0 in this degenerate case; we match it rather than summing the aggregate.
    await tracker.onResult(baselineResult);

    expect(broadcastFn).toHaveBeenCalledTimes(1);
    expect(broadcastFn.mock.calls[0][1].data.totalTokens).toBe(0);
  });

  it('does not broadcast or persist if neither baseline nor breakdown is available', async () => {
    const tracker = createContextUsageTracker({ conversationId: 7, broadcastFn });

    await tracker.onResult({ type: 'result' }); // no modelUsage

    expect(broadcastFn).not.toHaveBeenCalled();
    expect(conversationsDb.updateContextUsage).not.toHaveBeenCalled();
  });

  it('skips persistence when conversationId is falsy but still broadcasts', async () => {
    const tracker = createContextUsageTracker({ conversationId: null as never, broadcastFn });

    await tracker.onResult(baselineResult);

    expect(conversationsDb.updateContextUsage).not.toHaveBeenCalled();
    expect(broadcastFn).toHaveBeenCalled();
  });

  it('keeps the latest breakdown across multiple assistant messages', async () => {
    const breakdownA = { totalTokens: 100, maxTokens: 200000, model: 'a' };
    const breakdownB = { totalTokens: 999, maxTokens: 200000, model: 'b' };
    const getContextUsage = vi.fn()
      .mockResolvedValueOnce(breakdownA)
      .mockResolvedValueOnce(breakdownB);
    const queryInstance = { getContextUsage };
    const tracker = createContextUsageTracker({ conversationId: 7, broadcastFn });

    tracker.onAssistant(queryInstance, null, MASTER_MODEL);
    tracker.onAssistant(queryInstance, null, MASTER_MODEL); // second assistant overwrites
    await tracker.onResult(baselineResult);

    expect(broadcastFn.mock.calls[0][1].data.totalTokens).toBe(999);
  });

  it('ignores sub-agent assistant events (parent_tool_use_id set)', async () => {
    // Master fires first with a small breakdown, then a sub-agent fires with
    // a much larger one. The sub-agent breakdown must NOT win.
    const masterBreakdown = { totalTokens: 100, maxTokens: 200000, model: MASTER_MODEL };
    const subAgentBreakdown = { totalTokens: 9999, maxTokens: 200000, model: SUB_AGENT_MODEL };
    const getContextUsage = vi.fn()
      .mockResolvedValueOnce(masterBreakdown)
      .mockResolvedValueOnce(subAgentBreakdown);
    const queryInstance = { getContextUsage };
    const tracker = createContextUsageTracker({ conversationId: 7, broadcastFn });

    tracker.onAssistant(queryInstance, null, MASTER_MODEL); // master
    tracker.onAssistant(queryInstance, 'tool-use-abc', SUB_AGENT_MODEL); // sub-agent
    await tracker.onResult(baselineResult);

    // Sub-agent's getContextUsage was never called.
    expect(getContextUsage).toHaveBeenCalledTimes(1);
    expect(broadcastFn.mock.calls[0][1].data.totalTokens).toBe(100);
    // Model is pinned to the observed master, not the sub-agent.
    expect(broadcastFn.mock.calls[0][1].data.model).toBe(MASTER_MODEL);
  });

  it('builds the baseline from the latest master per-request usage, not the cumulative modelUsage aggregate', async () => {
    // Regression for the "2.7M against a 1M window" bug. An agentic turn makes
    // many tool-use round-trips, so result.modelUsage accumulates cache reads
    // far beyond the real window (and folds the same-model sub-agent in too).
    // The point-in-time usage on the last master assistant message is the true
    // occupancy and must be preferred.
    const result = {
      type: 'result',
      modelUsage: {
        [MASTER_MODEL]: {
          inputTokens: 20,
          cacheReadInputTokens: 2_700_000, // summed across every round-trip
          cacheCreationInputTokens: 24_000,
          contextWindow: 1_000_000,
        },
      },
    };
    // getContextUsage rejects → the baseline path is exercised (the buggy one).
    const queryInstance = { getContextUsage: vi.fn().mockRejectedValue(new Error('Query closed')) };
    const tracker = createContextUsageTracker({ conversationId: 7, broadcastFn });

    // The last master API request actually held 196_530 tokens.
    tracker.onAssistant(queryInstance, null, MASTER_MODEL, {
      input_tokens: 2,
      cache_read_input_tokens: 196_182,
      cache_creation_input_tokens: 346,
    });
    await tracker.onResult(result);

    const data = broadcastFn.mock.calls[0][1].data;
    expect(data.totalTokens).toBe(196_530); // NOT 2_724_020 from the aggregate
    expect(data.maxTokens).toBe(1_000_000);
    expect(data.percentage).toBeCloseTo(19.653, 2); // well under 100%
  });

  it('tracks the latest master per-request usage and ignores sub-agent usage', async () => {
    const queryInstance = { getContextUsage: vi.fn().mockRejectedValue(new Error()) };
    const tracker = createContextUsageTracker({ conversationId: 7, broadcastFn });

    // Early master request (smaller prompt).
    tracker.onAssistant(queryInstance, null, MASTER_MODEL, {
      input_tokens: 2, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 1_000,
    });
    // A sub-agent request (parent_tool_use_id set) — must not influence the master.
    tracker.onAssistant(queryInstance, 'tool-use-abc', SUB_AGENT_MODEL, {
      input_tokens: 2, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 0,
    });
    // Later master request — the real end-of-turn window.
    tracker.onAssistant(queryInstance, null, MASTER_MODEL, {
      input_tokens: 2, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 2_000,
    });
    await tracker.onResult(baselineResult);

    // 2 + 120_000 + 2_000 — latest master request; the sub-agent's 900K is ignored.
    expect(broadcastFn.mock.calls[0][1].data.totalTokens).toBe(122_002);
  });

  it('keys into result.modelUsage by the observed master model for the model name and context window', async () => {
    // Two-model result: sub-agent entry is first, master entry is second. The
    // model name + context window are picked by the observed master key; the
    // total comes from the master's per-request usage.
    const result = {
      type: 'result',
      modelUsage: {
        [SUB_AGENT_MODEL]: {
          inputTokens: 5000,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 400000,
        },
        [MASTER_MODEL]: {
          inputTokens: 200,
          cacheReadInputTokens: 50,
          cacheCreationInputTokens: 50,
          contextWindow: 200000,
        },
      },
    };
    const tracker = createContextUsageTracker({ conversationId: 7, broadcastFn });
    // Master assistant event (no breakdown — getContextUsage rejects)
    tracker.onAssistant(
      { getContextUsage: vi.fn().mockRejectedValue(new Error()) },
      null,
      MASTER_MODEL,
      { input_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 50 },
    );
    await tracker.onResult(result);

    expect(broadcastFn.mock.calls[0][1].data.model).toBe(MASTER_MODEL);
    expect(broadcastFn.mock.calls[0][1].data.maxTokens).toBe(200000); // master's window, not sub-agent's
    // 200 + 50 + 50 = the master request's point-in-time usage.
    expect(broadcastFn.mock.calls[0][1].data.totalTokens).toBe(300);
  });
});
