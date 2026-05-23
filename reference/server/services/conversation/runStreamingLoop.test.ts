import { describe, it, expect, vi, beforeEach } from 'vitest';

import { runStreamingLoop } from './runStreamingLoop.js';

function asyncIterableOf(messages: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
    }
  };
}

// runStreamingLoop's typed signature expects ThinkingAccumulator and
// ContextUsageTracker; tests stub only the methods the loop reads, then
// cast at the call site via `as never` (see each invocation).
let thinkingAcc: Record<string, unknown>;
let contextUsageTracker: Record<string, unknown>;
let broadcastFn: ReturnType<typeof vi.fn>;

beforeEach(() => {
  thinkingAcc = {
    handleStreamEvent: vi.fn(),
    patchAssistantMessage: vi.fn()
  };
  contextUsageTracker = {
    onAssistant: vi.fn(),
    onResult: vi.fn().mockResolvedValue(undefined)
  };
  broadcastFn = vi.fn();
});

describe('runStreamingLoop', () => {
  it('forwards stream_event entries to the thinking accumulator without broadcasting', async () => {
    const event = { type: 'message_start', message: { id: 'msg-1' } };
    const queryInstance = asyncIterableOf([
      { type: 'stream_event', event }
    ]);

    await runStreamingLoop({
      queryInstance: queryInstance as never,
      conversationId: 1,
      broadcastFn: broadcastFn as never,
      thinkingAcc: thinkingAcc as never,
      contextUsageTracker: contextUsageTracker as never,
      initialSessionId: 'sess'
    });

    expect(thinkingAcc.handleStreamEvent).toHaveBeenCalledWith(event);
    expect(broadcastFn).not.toHaveBeenCalled();
  });

  it('skips system mirror_error messages without broadcasting', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const queryInstance = asyncIterableOf([
      { type: 'system', subtype: 'mirror_error', session_id: 'sess' }
    ]);

    await runStreamingLoop({
      queryInstance: queryInstance as never,
      conversationId: 1,
      broadcastFn: broadcastFn as never,
      thinkingAcc: thinkingAcc as never,
      contextUsageTracker: contextUsageTracker as never,
      initialSessionId: 'sess'
    });

    expect(broadcastFn).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('patches assistant messages and notifies the context usage tracker', async () => {
    const assistant = {
      type: 'assistant',
      session_id: 'sess',
      message: { id: 'msg-1', content: [], usage: { input_tokens: 10, output_tokens: 5 } }
    };
    const queryInstance = asyncIterableOf([assistant]);

    await runStreamingLoop({
      queryInstance: queryInstance as never,
      conversationId: 1,
      broadcastFn: broadcastFn as never,
      thinkingAcc: thinkingAcc as never,
      contextUsageTracker: contextUsageTracker as never,
      initialSessionId: 'sess'
    });

    expect(thinkingAcc.patchAssistantMessage).toHaveBeenCalledWith(assistant);
    expect(contextUsageTracker.onAssistant).toHaveBeenCalledWith(queryInstance, null, null);
    // Dual-emit (Phase 5): legacy claude-response + provider-tagged ai-response.
    expect(broadcastFn).toHaveBeenCalledWith(1, { type: 'claude-response', data: assistant });
    expect(broadcastFn).toHaveBeenCalledWith(1, {
      type: 'ai-response',
      data: assistant,
      provider: 'anthropic',
    });
  });

  it('forwards parent_tool_use_id and master model to the context usage tracker', async () => {
    // Resolved (versioned) Claude model IDs surfaced by the SDK on each
    // assistant event. Bumping these for a new model rev only requires
    // touching this one place.
    const MASTER_MODEL = 'claude-opus-4-7';
    const SUB_AGENT_MODEL = 'claude-sonnet-4-6';
    const masterAssistant = {
      type: 'assistant',
      session_id: 'sess',
      parent_tool_use_id: null,
      message: { id: 'm', content: [], model: MASTER_MODEL, usage: { input_tokens: 1, output_tokens: 1 } },
    };
    const subAssistant = {
      type: 'assistant',
      session_id: 'sess',
      parent_tool_use_id: 'tool-use-abc',
      message: { id: 'm2', content: [], model: SUB_AGENT_MODEL, usage: { input_tokens: 1, output_tokens: 1 } },
    };
    const queryInstance = asyncIterableOf([masterAssistant, subAssistant]);

    await runStreamingLoop({
      queryInstance: queryInstance as never,
      conversationId: 1,
      broadcastFn: broadcastFn as never,
      thinkingAcc: thinkingAcc as never,
      contextUsageTracker: contextUsageTracker as never,
      initialSessionId: 'sess',
    });

    expect(contextUsageTracker.onAssistant).toHaveBeenNthCalledWith(1, queryInstance, null, MASTER_MODEL);
    expect(contextUsageTracker.onAssistant).toHaveBeenNthCalledWith(2, queryInstance, 'tool-use-abc', SUB_AGENT_MODEL);
  });

  it('captures the first session_id and fires onSessionId exactly once', async () => {
    const onSessionId = vi.fn();
    const queryInstance = asyncIterableOf([
      { type: 'system', subtype: 'init', session_id: 'sess-X' },
      { type: 'assistant', session_id: 'sess-X', message: { id: 'm', content: [] } },
      { type: 'assistant', session_id: 'sess-X', message: { id: 'm2', content: [] } }
    ]);

    const result = await runStreamingLoop({
      queryInstance: queryInstance as never,
      conversationId: 1,
      broadcastFn: broadcastFn as never,
      thinkingAcc: thinkingAcc as never,
      contextUsageTracker: contextUsageTracker as never,
      initialSessionId: null,
      onSessionId
    });

    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(onSessionId).toHaveBeenCalledWith('sess-X');
    expect(result.claudeSessionId).toBe('sess-X');
  });

  it('does not call onSessionId for resume (initialSessionId already set)', async () => {
    const onSessionId = vi.fn();
    const queryInstance = asyncIterableOf([
      { type: 'system', subtype: 'init', session_id: 'sess' }
    ]);

    await runStreamingLoop({
      queryInstance: queryInstance as never,
      conversationId: 1,
      broadcastFn: broadcastFn as never,
      thinkingAcc: thinkingAcc as never,
      contextUsageTracker: contextUsageTracker as never,
      initialSessionId: 'sess',
      onSessionId
    });

    expect(onSessionId).not.toHaveBeenCalled();
  });

  it('broadcasts session-created exactly once after the first session_id is known', async () => {
    const queryInstance = asyncIterableOf([
      { type: 'system', subtype: 'init', session_id: 'sess' },
      { type: 'assistant', session_id: 'sess', message: { id: 'a', content: [] } }
    ]);

    await runStreamingLoop({
      queryInstance: queryInstance as never,
      conversationId: 1,
      broadcastFn: broadcastFn as never,
      thinkingAcc: thinkingAcc as never,
      contextUsageTracker: contextUsageTracker as never,
      initialSessionId: 'sess'
    });

    const sessionCreatedCalls = broadcastFn.mock.calls.filter(
      ([, msg]) => msg.type === 'session-created'
    );
    expect(sessionCreatedCalls).toHaveLength(1);
    expect(sessionCreatedCalls[0]![1]).toEqual({ type: 'session-created', sessionId: 'sess' });
  });

  it('emits claude-status only when broadcastClaudeStatus is true and tokens > 0', async () => {
    const assistantWithTokens = {
      type: 'assistant',
      session_id: 'sess',
      message: { id: 'a', content: [], usage: { input_tokens: 10, output_tokens: 5 } }
    };

    await runStreamingLoop({
      queryInstance: asyncIterableOf([assistantWithTokens]) as never,
      conversationId: 1,
      broadcastFn: broadcastFn as never,
      thinkingAcc: thinkingAcc as never,
      contextUsageTracker: contextUsageTracker as never,
      initialSessionId: 'sess',
      broadcastClaudeStatus: true
    });

    const statusCalls = broadcastFn.mock.calls.filter(([, m]) => m.type === 'claude-status');
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]![1].data.tokens).toBe(15);
  });

  it('does not emit claude-status when broadcastClaudeStatus is false', async () => {
    const assistantWithTokens = {
      type: 'assistant',
      session_id: 'sess',
      message: { id: 'a', content: [], usage: { input_tokens: 10, output_tokens: 5 } }
    };

    await runStreamingLoop({
      queryInstance: asyncIterableOf([assistantWithTokens]) as never,
      conversationId: 1,
      broadcastFn: broadcastFn as never,
      thinkingAcc: thinkingAcc as never,
      contextUsageTracker: contextUsageTracker as never,
      initialSessionId: 'sess',
      broadcastClaudeStatus: false
    });

    const statusCalls = broadcastFn.mock.calls.filter(([, m]) => m.type === 'claude-status');
    expect(statusCalls).toHaveLength(0);
  });

  it('forwards result messages to contextUsageTracker.onResult', async () => {
    const resultMsg = { type: 'result', session_id: 'sess', modelUsage: {} };
    await runStreamingLoop({
      queryInstance: asyncIterableOf([resultMsg]) as never,
      conversationId: 1,
      broadcastFn: broadcastFn as never,
      thinkingAcc: thinkingAcc as never,
      contextUsageTracker: contextUsageTracker as never,
      initialSessionId: 'sess'
    });

    expect(contextUsageTracker.onResult).toHaveBeenCalledWith(resultMsg);
  });

  it('propagates errors thrown by the iterator', async () => {
    const queryInstance = {
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new Error('iterator boom');
      }
    };

    await expect(
      runStreamingLoop({
        queryInstance: queryInstance as never,
        conversationId: 1,
        broadcastFn: broadcastFn as never,
        thinkingAcc: thinkingAcc as never,
        contextUsageTracker: contextUsageTracker as never,
        initialSessionId: 'sess'
      })
    ).rejects.toThrow('iterator boom');
  });

  it('fires onResult exactly once when the SDK emits its result message', async () => {
    const onResult = vi.fn();
    const queryInstance = asyncIterableOf([
      { type: 'assistant', session_id: 'sess', message: { id: 'a', content: [] } },
      { type: 'result', session_id: 'sess', modelUsage: {} }
    ]);

    await runStreamingLoop({
      queryInstance: queryInstance as never,
      conversationId: 1,
      broadcastFn: broadcastFn as never,
      thinkingAcc: thinkingAcc as never,
      contextUsageTracker: contextUsageTracker as never,
      initialSessionId: 'sess',
      onResult
    });

    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('does not fire onResult when no result message is observed', async () => {
    const onResult = vi.fn();
    const queryInstance = asyncIterableOf([
      { type: 'assistant', session_id: 'sess', message: { id: 'a', content: [] } }
    ]);

    await runStreamingLoop({
      queryInstance: queryInstance as never,
      conversationId: 1,
      broadcastFn: broadcastFn as never,
      thinkingAcc: thinkingAcc as never,
      contextUsageTracker: contextUsageTracker as never,
      initialSessionId: 'sess',
      onResult
    });

    expect(onResult).not.toHaveBeenCalled();
  });

  it('swallows iterator errors thrown after result and returns cleanly', async () => {
    // Models the real-world case: SDK emits `result`, our `onResult` callback
    // aborts the AbortController, then the SDK iterator throws
    // "Claude Code process exited with code 143". The loop should treat the
    // turn as cleanly ended so the caller's success-path lifecycle still runs.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const queryInstance = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', session_id: 'sess', modelUsage: {} };
        throw new Error('Claude Code process exited with code 143');
      }
    };

    const result = await runStreamingLoop({
      queryInstance: queryInstance as never,
      conversationId: 1,
      broadcastFn: broadcastFn as never,
      thinkingAcc: thinkingAcc as never,
      contextUsageTracker: contextUsageTracker as never,
      initialSessionId: 'sess',
      onResult: vi.fn()
    });

    expect(result.claudeSessionId).toBe('sess');
    logSpy.mockRestore();
  });

  it('still propagates iterator errors thrown before result', async () => {
    // Errors before result are real failures and must surface so the caller
    // routes through composeOnComplete(true) (agent run -> failed).
    const queryInstance = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'assistant', session_id: 'sess', message: { id: 'a', content: [] } };
        throw new Error('Claude Code process exited with code 1');
      }
    };

    await expect(
      runStreamingLoop({
        queryInstance: queryInstance as never,
        conversationId: 1,
        broadcastFn: broadcastFn as never,
        thinkingAcc: thinkingAcc as never,
        contextUsageTracker: contextUsageTracker as never,
        initialSessionId: 'sess',
        onResult: vi.fn()
      })
    ).rejects.toThrow('Claude Code process exited with code 1');
  });

  describe('in-band 401 detection', () => {
    // On claude-agent-sdk ≥ 0.3.x the CLI may deliver an auth failure as data
    // (synthetic assistant + SDKResultError) instead of throwing it. The loop
    // must surface this as `authError: true` so the caller can run the same
    // subprocess-recycle retry as the thrown-error path, and must suppress the
    // claude-response broadcast of the synthetic message so the UI doesn't
    // flash "Failed to authenticate" before the transparent retry succeeds.

    it('flags authError on a synthetic assistant with message.error="authentication_failed"', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onResult = vi.fn();
      const queryInstance = asyncIterableOf([
        {
          type: 'assistant',
          session_id: 'sess',
          message: {
            id: 'm-synth',
            model: '<synthetic>',
            content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401' }],
            error: 'authentication_failed',
          },
        },
      ]);

      const result = await runStreamingLoop({
        queryInstance: queryInstance as never,
        conversationId: 1,
        broadcastFn: broadcastFn as never,
        thinkingAcc: thinkingAcc as never,
        contextUsageTracker: contextUsageTracker as never,
        initialSessionId: 'sess',
        onResult,
      });

      expect(result.authError).toBe(true);
      // The synthetic message must NOT be broadcast — otherwise the UI flashes
      // "Failed to authenticate" before the retry recovers.
      expect(broadcastFn).not.toHaveBeenCalledWith(
        1,
        expect.objectContaining({ type: 'claude-response' }),
      );
      // The thinking patcher / context tracker should not have processed it.
      expect(thinkingAcc.patchAssistantMessage).not.toHaveBeenCalled();
      expect(contextUsageTracker.onAssistant).not.toHaveBeenCalled();
      // onResult must fire so the caller aborts the dead subprocess.
      expect(onResult).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('flags authError on a SDKResultError with a 401 entry in errors[]', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onResult = vi.fn();
      const queryInstance = asyncIterableOf([
        {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: 'sess',
          is_error: true,
          errors: ['Failed to authenticate. API Error: 401 Invalid authentication credentials'],
          modelUsage: {},
        },
      ]);

      const result = await runStreamingLoop({
        queryInstance: queryInstance as never,
        conversationId: 1,
        broadcastFn: broadcastFn as never,
        thinkingAcc: thinkingAcc as never,
        contextUsageTracker: contextUsageTracker as never,
        initialSessionId: 'sess',
        onResult,
      });

      expect(result.authError).toBe(true);
      // The result must NOT be broadcast or fed to the usage tracker — that
      // would record a "completed turn" for an auth failure.
      expect(broadcastFn).not.toHaveBeenCalledWith(
        1,
        expect.objectContaining({ type: 'claude-response' }),
      );
      expect(contextUsageTracker.onResult).not.toHaveBeenCalled();
      expect(onResult).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('does not flag authError for an ordinary assistant message', async () => {
      const queryInstance = asyncIterableOf([
        { type: 'assistant', session_id: 'sess', message: { id: 'm', content: [] } },
        { type: 'result', session_id: 'sess', is_error: false, modelUsage: {} },
      ]);

      const result = await runStreamingLoop({
        queryInstance: queryInstance as never,
        conversationId: 1,
        broadcastFn: broadcastFn as never,
        thinkingAcc: thinkingAcc as never,
        contextUsageTracker: contextUsageTracker as never,
        initialSessionId: 'sess',
        onResult: vi.fn(),
      });

      expect(result.authError).toBe(false);
    });

    it('does not flag authError for a non-auth SDKResultError', async () => {
      const queryInstance = asyncIterableOf([
        {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: 'sess',
          is_error: true,
          errors: ['Some other backend failure'],
          modelUsage: {},
        },
      ]);

      const result = await runStreamingLoop({
        queryInstance: queryInstance as never,
        conversationId: 1,
        broadcastFn: broadcastFn as never,
        thinkingAcc: thinkingAcc as never,
        contextUsageTracker: contextUsageTracker as never,
        initialSessionId: 'sess',
        onResult: vi.fn(),
      });

      expect(result.authError).toBe(false);
    });
  });
});
