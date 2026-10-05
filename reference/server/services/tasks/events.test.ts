import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  emitTaskEvent,
  onTaskEvent,
  _resetTaskEventListeners,
} from './events.js';

beforeEach(() => {
  _resetTaskEventListeners();
});

describe('TaskEvents', () => {
  it('delivers synchronously, in registration order', () => {
    const order: string[] = [];
    onTaskEvent('task-merged', () => order.push('first'));
    onTaskEvent('task-merged', () => order.push('second'));

    emitTaskEvent('task-merged', { taskId: 1 });
    order.push('after-emit');

    expect(order).toEqual(['first', 'second', 'after-emit']);
  });

  it('passes the payload through verbatim', () => {
    const seen = vi.fn();
    onTaskEvent('run-ended', seen);

    emitTaskEvent('run-ended', {
      taskId: 7,
      runId: 3,
      agentType: 'planification',
      driver: 'automation',
      status: 'completed',
      conversationId: 100,
    });

    expect(seen).toHaveBeenCalledWith({
      taskId: 7,
      runId: 3,
      agentType: 'planification',
      driver: 'automation',
      status: 'completed',
      conversationId: 100,
    });
  });

  it('a throwing subscriber never fails the emitter, and later subscribers still run', () => {
    const after = vi.fn();
    onTaskEvent('task-deleted', () => {
      throw new Error('boom');
    });
    onTaskEvent('task-deleted', after);

    expect(() => emitTaskEvent('task-deleted', { taskId: 1 })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe removes exactly that listener', () => {
    const kept = vi.fn();
    const dropped = vi.fn();
    const off = onTaskEvent('question-parked', dropped);
    onTaskEvent('question-parked', kept);

    off();
    emitTaskEvent('question-parked', { taskId: 1, conversationId: 2, questions: [] });

    expect(dropped).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('emitting with no subscribers is a no-op', () => {
    expect(() =>
      emitTaskEvent('workflow-blocked', { taskId: 1, reason: 'max-iterations' }),
    ).not.toThrow();
  });
});
