import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import useAtlasEvents, { type AtlasEventHandlers } from './useAtlasEvents';
import type { ServerMessageOf } from '@shared/websocket/messages';

const mockSendMessage = vi.fn();
const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();

vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({
    isConnected: true,
    sendMessage: mockSendMessage,
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
  }),
}));

function findHandler<T>(eventType: string): T {
  const call = mockSubscribe.mock.calls.find((c) => c[0] === eventType);
  if (!call) throw new Error(`No subscription registered for event: ${eventType}`);
  return call[1] as T;
}

function makeHandlers(overrides: Partial<AtlasEventHandlers> = {}): AtlasEventHandlers {
  return {
    onOpenFile: vi.fn(),
    onHighlight: vi.fn(),
    onRenderArtifact: vi.fn().mockResolvedValue('{"ok":true}'),
    onSubscribed: vi.fn(),
    ...overrides,
  };
}

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('useAtlasEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to the atlas channel and notifies onSubscribed', () => {
    const handlers = makeHandlers();
    renderHook(() => useAtlasEvents(7, handlers));

    expect(mockSendMessage).toHaveBeenCalledWith('subscribe-atlas', { taskId: 7 });
    expect(handlers.onSubscribed).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useAtlasEvents(7, makeHandlers()));
    unmount();
    expect(mockSendMessage).toHaveBeenCalledWith('unsubscribe-atlas', { taskId: 7 });
    expect(mockUnsubscribe).toHaveBeenCalledTimes(3);
  });

  it('does nothing without a taskId', () => {
    renderHook(() => useAtlasEvents(null, makeHandlers()));
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('applies atlas-open-file and acks success', () => {
    const handlers = makeHandlers();
    renderHook(() => useAtlasEvents(7, handlers));
    const handler = findHandler<(msg: ServerMessageOf<'atlas-open-file'>) => void>(
      'atlas-open-file',
    );

    handler({ type: 'atlas-open-file', taskId: 7, requestId: 'r1', path: 'a.ts', content: 'x', line: 2 });

    expect(handlers.onOpenFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'a.ts', line: 2 }),
    );
    expect(mockSendMessage).toHaveBeenCalledWith('atlas-ack', { taskId: 7, requestId: 'r1' });
  });

  it('acks with an error when the handler throws', () => {
    const handlers = makeHandlers({
      onHighlight: vi.fn(() => {
        throw new Error('cannot apply');
      }),
    });
    renderHook(() => useAtlasEvents(7, handlers));
    const handler = findHandler<(msg: ServerMessageOf<'atlas-highlight'>) => void>(
      'atlas-highlight',
    );

    handler({
      type: 'atlas-highlight',
      taskId: 7,
      requestId: 'r2',
      path: 'a.ts',
      content: 'x',
      ranges: [{ start: 1, end: 2 }],
      color: 'green',
    });

    expect(mockSendMessage).toHaveBeenCalledWith('atlas-ack', {
      taskId: 7,
      requestId: 'r2',
      error: 'cannot apply',
    });
  });

  it('ignores events for other tasks', () => {
    const handlers = makeHandlers();
    renderHook(() => useAtlasEvents(7, handlers));
    const handler = findHandler<(msg: ServerMessageOf<'atlas-open-file'>) => void>(
      'atlas-open-file',
    );

    handler({ type: 'atlas-open-file', taskId: 8, requestId: 'r3', path: 'a.ts', content: 'x' });

    expect(handlers.onOpenFile).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalledWith(
      'atlas-ack',
      expect.objectContaining({ requestId: 'r3' }),
    );
  });

  it('acks atlas-render-artifact with the ack detail', async () => {
    const handlers = makeHandlers();
    renderHook(() => useAtlasEvents(7, handlers));
    const handler = findHandler<(msg: ServerMessageOf<'atlas-render-artifact'>) => void>(
      'atlas-render-artifact',
    );

    handler({
      type: 'atlas-render-artifact',
      taskId: 7,
      requestId: 'r4',
      kind: 'flowchart',
      html: '<!doctype html><html></html>',
    });
    await flushMicrotasks();

    expect(mockSendMessage).toHaveBeenCalledWith('atlas-ack', {
      taskId: 7,
      requestId: 'r4',
      detail: '{"ok":true}',
    });
  });

  it('acks atlas-render-artifact errors', async () => {
    const handlers = makeHandlers({
      onRenderArtifact: vi.fn().mockRejectedValue(new Error('iframe failed to mount')),
    });
    renderHook(() => useAtlasEvents(7, handlers));
    const handler = findHandler<(msg: ServerMessageOf<'atlas-render-artifact'>) => void>(
      'atlas-render-artifact',
    );

    handler({
      type: 'atlas-render-artifact',
      taskId: 7,
      requestId: 'r5',
      kind: 'plan',
      html: '<!doctype html><html></html>',
    });
    await flushMicrotasks();

    expect(mockSendMessage).toHaveBeenCalledWith('atlas-ack', {
      taskId: 7,
      requestId: 'r5',
      error: 'iframe failed to mount',
    });
  });
});
