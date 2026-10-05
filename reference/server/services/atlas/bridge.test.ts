import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initAtlasBridge,
  sendAtlasEvent,
  resolveAtlasAck,
  getAtlasSubscriberCount,
  ATLAS_ACK_TIMEOUT_MS,
  __resetAtlasBridgeForTesting,
  __getPendingAckCountForTesting,
  type AtlasBridgeDeps,
  type AtlasUiCommand,
} from './bridge.js';

const OPEN_FILE: AtlasUiCommand = {
  type: 'atlas-open-file',
  path: 'src/index.ts',
  content: 'hello',
};

describe('atlas bridge', () => {
  let broadcast: ReturnType<typeof vi.fn>;
  let subscriberCount: number;

  beforeEach(() => {
    vi.useFakeTimers();
    broadcast = vi.fn();
    subscriberCount = 1;
    initAtlasBridge({
      broadcast: broadcast as unknown as AtlasBridgeDeps['broadcast'],
      getSubscriberCount: () => subscriberCount,
    });
  });

  afterEach(() => {
    __resetAtlasBridgeForTesting();
    vi.useRealTimers();
  });

  function broadcastRequestId(): string {
    const call = broadcast.mock.calls.at(-1);
    if (!call) throw new Error('broadcast was not called');
    return (call[1] as { requestId: string }).requestId;
  }

  it('rejects when not initialized', async () => {
    __resetAtlasBridgeForTesting();
    await expect(sendAtlasEvent(7, OPEN_FILE)).rejects.toThrow('not initialized');
  });

  it('rejects when no Explore view is subscribed (without broadcasting)', async () => {
    subscriberCount = 0;
    await expect(sendAtlasEvent(7, OPEN_FILE)).rejects.toThrow(
      'No Explore view is open for this task',
    );
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts the command with taskId-channel routing and a requestId', async () => {
    const done = sendAtlasEvent(7, OPEN_FILE);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0]![0]).toBe(7);
    expect(broadcast.mock.calls[0]![1]).toMatchObject({
      type: 'atlas-open-file',
      path: 'src/index.ts',
      requestId: expect.any(String),
    });
    resolveAtlasAck(broadcastRequestId(), { taskId: 7 });
    await expect(done).resolves.toBeUndefined();
  });

  it('resolves with the ack detail (diagram render summary)', async () => {
    const done = sendAtlasEvent(7, OPEN_FILE);
    resolveAtlasAck(broadcastRequestId(), { taskId: 7, detail: '{"nodeCount":4}' });
    await expect(done).resolves.toBe('{"nodeCount":4}');
  });

  it('rejects with the client-reported error', async () => {
    const done = sendAtlasEvent(7, OPEN_FILE);
    resolveAtlasAck(broadcastRequestId(), { taskId: 7, error: 'Parse error on line 2' });
    await expect(done).rejects.toThrow('Parse error on line 2');
  });

  it('times out with a clear error when no ack arrives', async () => {
    const done = sendAtlasEvent(7, OPEN_FILE);
    const assertion = expect(done).rejects.toThrow(
      `UI did not acknowledge atlas-open-file within ${ATLAS_ACK_TIMEOUT_MS}ms`,
    );
    vi.advanceTimersByTime(ATLAS_ACK_TIMEOUT_MS + 1);
    await assertion;
    expect(__getPendingAckCountForTesting()).toBe(0);
  });

  it('honors a custom timeout', async () => {
    const done = sendAtlasEvent(7, OPEN_FILE, 15000);
    const assertion = expect(done).rejects.toThrow('within 15000ms');
    vi.advanceTimersByTime(5001);
    expect(__getPendingAckCountForTesting()).toBe(1); // still pending past the default
    vi.advanceTimersByTime(10000);
    await assertion;
  });

  it('drops acks whose taskId does not match the pending command', async () => {
    const done = sendAtlasEvent(7, OPEN_FILE);
    const requestId = broadcastRequestId();

    resolveAtlasAck(requestId, { taskId: 8 }); // spoofed/foreign ack
    expect(__getPendingAckCountForTesting()).toBe(1); // still pending

    resolveAtlasAck(requestId, { taskId: 7 });
    await expect(done).resolves.toBeUndefined();
  });

  it('first ack wins; later acks are dropped', async () => {
    const done = sendAtlasEvent(7, OPEN_FILE);
    const requestId = broadcastRequestId();

    resolveAtlasAck(requestId, { taskId: 7, detail: 'first' });
    resolveAtlasAck(requestId, { taskId: 7, error: 'second tab failed' });

    await expect(done).resolves.toBe('first');
  });

  it('ignores acks for unknown request ids', () => {
    expect(() => resolveAtlasAck('nope', { taskId: 7 })).not.toThrow();
  });

  it('exposes the injected subscriber count (0 when uninitialized)', () => {
    subscriberCount = 3;
    expect(getAtlasSubscriberCount(7)).toBe(3);
    __resetAtlasBridgeForTesting();
    expect(getAtlasSubscriberCount(7)).toBe(0);
  });
});
