import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  handleStreamingStarted,
  handleStreamingComplete,
  composeAsync
} from './streamingLifecycle.js';
import { activeStreamingSessions } from './sessionState.js';

beforeEach(() => {
  activeStreamingSessions.clear();
  vi.clearAllMocks();
});

describe('handleStreamingStarted', () => {
  it('registers the session in activeStreamingSessions and broadcasts streaming-started', () => {
    const broadcastFn = vi.fn();
    handleStreamingStarted({
      conversationId: 42,
      taskId: 7,
      claudeSessionId: 'sess-1',
      broadcastFn
    } as never);

    expect(activeStreamingSessions.get('sess-1')).toEqual({ taskId: 7, conversationId: 42 });
    expect(broadcastFn).toHaveBeenCalledWith(42, {
      type: 'streaming-started',
      conversationId: 42,
      claudeSessionId: 'sess-1',
      taskId: 7
    });
  });

  it('omits taskId from the broadcast when not present', () => {
    const broadcastFn = vi.fn();
    handleStreamingStarted({ conversationId: 42, claudeSessionId: 'sess-1', broadcastFn } as never);

    expect(broadcastFn).toHaveBeenCalledWith(42, {
      type: 'streaming-started',
      conversationId: 42,
      claudeSessionId: 'sess-1'
    });
  });

  it('is safe with no broadcastFn', () => {
    expect(() =>
      handleStreamingStarted({ conversationId: 1, claudeSessionId: 'sess', broadcastFn: null as never } as never)
    ).not.toThrow();
    expect(activeStreamingSessions.has('sess')).toBe(true);
  });

  it('dual-emits on the task channel when broadcastToTaskSubscribersFn is present', () => {
    const broadcastFn = vi.fn();
    const broadcastToTaskSubscribersFn = vi.fn();
    handleStreamingStarted({
      conversationId: 42,
      taskId: 7,
      claudeSessionId: 'sess-1',
      broadcastFn,
      broadcastToTaskSubscribersFn,
    } as never);

    expect(broadcastFn).toHaveBeenCalledOnce();
    expect(broadcastToTaskSubscribersFn).toHaveBeenCalledWith(7, {
      type: 'streaming-started',
      conversationId: 42,
      claudeSessionId: 'sess-1',
    });
  });

  it('does not call broadcastToTaskSubscribersFn when taskId is missing', () => {
    const broadcastFn = vi.fn();
    const broadcastToTaskSubscribersFn = vi.fn();
    handleStreamingStarted({
      conversationId: 42,
      claudeSessionId: 'sess-1',
      broadcastFn,
      broadcastToTaskSubscribersFn,
    } as never);

    expect(broadcastToTaskSubscribersFn).not.toHaveBeenCalled();
  });
});

describe('handleStreamingComplete', () => {
  it('removes the session and broadcasts streaming-ended', async () => {
    activeStreamingSessions.set('sess-1', { taskId: 7, conversationId: 42 });
    const broadcastFn = vi.fn();

    await handleStreamingComplete(
      { conversationId: 42, taskId: 7, claudeSessionId: 'sess-1', broadcastFn } as never,
    );

    expect(activeStreamingSessions.has('sess-1')).toBe(false);
    expect(broadcastFn).toHaveBeenCalledWith(42, {
      type: 'streaming-ended',
      conversationId: 42,
      taskId: 7
    });
  });

  it('still removes the session when broadcastFn is missing', async () => {
    activeStreamingSessions.set('sess-1', { taskId: 7, conversationId: 42 });
    await handleStreamingComplete({ conversationId: 42, claudeSessionId: 'sess-1' } as never);
    expect(activeStreamingSessions.has('sess-1')).toBe(false);
  });

  it('dual-emits streaming-ended on the task channel when present', async () => {
    activeStreamingSessions.set('sess-1', { taskId: 7, conversationId: 42 });
    const broadcastFn = vi.fn();
    const broadcastToTaskSubscribersFn = vi.fn();

    await handleStreamingComplete(
      {
        conversationId: 42,
        taskId: 7,
        claudeSessionId: 'sess-1',
        broadcastFn,
        broadcastToTaskSubscribersFn,
      } as never,
    );

    expect(broadcastToTaskSubscribersFn).toHaveBeenCalledWith(7, {
      type: 'streaming-ended',
      conversationId: 42,
    });
  });
});

describe('composeAsync', () => {
  it('awaits handlers in order, passing the same argument', async () => {
    const order: string[] = [];
    const a = vi.fn(async (arg: string) => { order.push(`a:${arg}`); });
    const b = vi.fn(async (arg: string) => { order.push(`b:${arg}`); });

    const composed = composeAsync(a, b);
    await composed('X');

    expect(a).toHaveBeenCalledWith('X');
    expect(b).toHaveBeenCalledWith('X');
    expect(order).toEqual(['a:X', 'b:X']);
  });

  it('skips falsy handlers', async () => {
    const a = vi.fn();
    const composed = composeAsync(a, null, undefined);
    await composed(true);
    expect(a).toHaveBeenCalledOnce();
  });

  it('continues running subsequent handlers when one throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = vi.fn().mockRejectedValue(new Error('boom'));
    const b = vi.fn();
    const c = vi.fn();

    await composeAsync(a, b, c)(true);

    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    expect(c).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
