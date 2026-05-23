import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionStreaming } from './useSessionStreaming';
import type {
  ClaudeSessionId,
  ServerToClientMessage,
  ServerMessageType,
} from '@shared/websocket/messages';
import type { WebSocketContextValue } from '../contexts/WebSocketContext';

type Handler = (msg: ServerToClientMessage) => void;

function makeWsHarness() {
  const handlers = new Map<ServerMessageType, Set<Handler>>();
  const subscribe = vi.fn((type: ServerMessageType, h: Handler) => {
    let set = handlers.get(type);
    if (!set) {
      set = new Set();
      handlers.set(type, set);
    }
    set.add(h);
  });
  const unsubscribe = vi.fn((type: ServerMessageType, h: Handler) => {
    handlers.get(type)?.delete(h);
  });
  const emit = (type: ServerMessageType, msg: ServerToClientMessage) => {
    const set = handlers.get(type);
    if (!set) return;
    for (const h of set) h(msg);
  };
  return {
    sendMessage: vi.fn(),
    // The harness stores every handler under the broad ServerToClientMessage
    // type; cast to the generic context signature the hook consumes.
    subscribe: subscribe as unknown as WebSocketContextValue['subscribe'],
    unsubscribe: unsubscribe as unknown as WebSocketContextValue['unsubscribe'],
    onDisconnect: vi.fn(() => () => {}),
    emit,
  };
}

describe('useSessionStreaming dual-emit dedup', () => {
  const sessionId = 'sess-1' as ClaudeSessionId;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a single assistant message when server dual-emits claude-response then ai-response', () => {
    const ws = makeWsHarness();
    const { result } = renderHook(() =>
      useSessionStreaming({
        selectedSession: { id: sessionId },
        sendMessage: ws.sendMessage,
        subscribe: ws.subscribe,
        unsubscribe: ws.unsubscribe,
        onDisconnect: ws.onDisconnect,
      }),
    );

    const payload = {
      type: 'assistant',
      session_id: sessionId,
      uuid: 'msg-uuid-1',
      message: {
        id: 'msg_anthropic_1',
        content: [{ type: 'text', text: 'hello' }],
      },
    };

    act(() => {
      // Server emit order: legacy claude-response first, then ai-response.
      ws.emit('claude-response', {
        type: 'claude-response',
        data: payload,
      } as unknown as ServerToClientMessage);
      ws.emit('ai-response', {
        type: 'ai-response',
        data: payload,
        provider: 'anthropic',
      } as unknown as ServerToClientMessage);
    });

    expect(result.current.streamingMessages).toHaveLength(1);
    expect(result.current.streamingMessages[0]).toMatchObject({
      type: 'assistant',
      content: 'hello',
    });
  });

  it('keeps a single assistant message when ai-response arrives first', () => {
    const ws = makeWsHarness();
    const { result } = renderHook(() =>
      useSessionStreaming({
        selectedSession: { id: sessionId },
        sendMessage: ws.sendMessage,
        subscribe: ws.subscribe,
        unsubscribe: ws.unsubscribe,
        onDisconnect: ws.onDisconnect,
      }),
    );

    const payload = {
      type: 'assistant',
      session_id: sessionId,
      uuid: 'msg-uuid-2',
      message: {
        id: 'msg_anthropic_2',
        content: [{ type: 'text', text: 'world' }],
      },
    };

    act(() => {
      ws.emit('ai-response', {
        type: 'ai-response',
        data: payload,
        provider: 'anthropic',
      } as unknown as ServerToClientMessage);
      ws.emit('claude-response', {
        type: 'claude-response',
        data: payload,
      } as unknown as ServerToClientMessage);
    });

    expect(result.current.streamingMessages).toHaveLength(1);
    expect(result.current.streamingMessages[0]).toMatchObject({
      type: 'assistant',
      content: 'world',
    });
  });

  it('falls back to message.id when uuid is absent', () => {
    const ws = makeWsHarness();
    const { result } = renderHook(() =>
      useSessionStreaming({
        selectedSession: { id: sessionId },
        sendMessage: ws.sendMessage,
        subscribe: ws.subscribe,
        unsubscribe: ws.unsubscribe,
        onDisconnect: ws.onDisconnect,
      }),
    );

    const payload = {
      type: 'assistant',
      session_id: sessionId,
      message: {
        id: 'msg_anthropic_3',
        content: [{ type: 'text', text: 'no uuid' }],
      },
    };

    act(() => {
      ws.emit('claude-response', {
        type: 'claude-response',
        data: payload,
      } as unknown as ServerToClientMessage);
      ws.emit('ai-response', {
        type: 'ai-response',
        data: payload,
        provider: 'anthropic',
      } as unknown as ServerToClientMessage);
    });

    expect(result.current.streamingMessages).toHaveLength(1);
  });
});

describe('useSessionStreaming conversation-busy', () => {
  const sessionId = 'sess-busy' as ClaudeSessionId;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reverts the optimistic echo, marks streaming, and calls onBusy', () => {
    const ws = makeWsHarness();
    const onBusy = vi.fn();
    const { result } = renderHook(() =>
      useSessionStreaming({
        selectedSession: { id: sessionId },
        sendMessage: ws.sendMessage,
        subscribe: ws.subscribe,
        unsubscribe: ws.unsubscribe,
        onDisconnect: ws.onDisconnect,
        onBusy,
      }),
    );

    // Reproduce the stale-composer state that let the send through: an
    // optimistic echo + isSending, while the client believed it was idle.
    act(() => {
      result.current.setIsSending(true);
      result.current.setStreamingMessages([
        {
          type: 'assistant',
          content: 'optimistic echo',
          timestamp: new Date().toISOString(),
        },
      ]);
    });

    act(() => {
      ws.emit('conversation-busy', {
        type: 'conversation-busy',
        conversationId: 99,
        error: 'Claude is still working on this conversation.',
      });
    });

    // Optimistic echo reverted, sending cleared, streaming flipped on (a turn
    // IS running) so the composer disables — and the reason was surfaced.
    expect(result.current.streamingMessages).toHaveLength(0);
    expect(result.current.isSending).toBe(false);
    expect(result.current.isStreaming).toBe(true);
    expect(onBusy).toHaveBeenCalledWith(
      'Claude is still working on this conversation.',
    );
  });
});
