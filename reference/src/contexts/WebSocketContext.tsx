/*
 * WebSocketContext.tsx - Shared WebSocket Provider
 *
 * Manages a single WebSocket connection at the App level that can be
 * shared across components. Supports message subscription by type.
 *
 * Features:
 * - Exponential backoff reconnection with jitter
 * - Connection state tracking (connecting, connected, reconnecting, failed)
 * - Manual reconnect capability
 * - Disconnect notification callbacks
 * - Typed pub/sub via the discriminated unions in shared/websocket/messages
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from 'react';
import type {
  ServerToClientMessage,
  ServerMessageType,
  ServerMessageOf,
  ClientMessageType,
  ClientMessageOf,
} from '../../shared/websocket/messages';

const BASE_DELAY = 1000; // 1 second
const MAX_DELAY = 30000; // 30 seconds
const MAX_ATTEMPTS = 10;

type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed';

type Subscriber<T extends ServerMessageType = ServerMessageType> = (
  message: ServerMessageOf<T>,
) => void;

type SubscribersMap = Map<ServerMessageType, Set<Subscriber>>;

type DisconnectCallback = () => void;

export interface WebSocketContextValue {
  ws: WebSocket | null;
  isConnected: boolean;
  connectionState: ConnectionState;
  sendMessage: <T extends ClientMessageType>(
    type: T,
    data: Omit<ClientMessageOf<T>, 'type'>,
  ) => boolean;
  subscribe: <T extends ServerMessageType>(
    type: T,
    callback: (message: ServerMessageOf<T>) => void,
  ) => void;
  unsubscribe: <T extends ServerMessageType>(
    type: T,
    callback: (message: ServerMessageOf<T>) => void,
  ) => void;
  manualReconnect: () => void;
  onDisconnect: (callback: DisconnectCallback) => () => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

function calculateBackoff(attempt: number): number {
  const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), MAX_DELAY);
  const jitter = delay * 0.1 * (Math.random() - 0.5) * 2;
  return Math.floor(delay + jitter);
}

interface ConnectOptions {
  resetAttempts?: boolean;
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('disconnected');

  const subscribersRef = useRef<SubscribersMap>(new Map());
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const onDisconnectCallbacksRef = useRef<Set<DisconnectCallback>>(new Set());
  const shouldReconnectRef = useRef(true);
  const logPrefix = '[WebSocket]';

  const logDebug = useCallback(
    (msg: string, extra: Record<string, unknown> = {}) => {
      const parts: string[] = [logPrefix, msg];
      const keys = Object.keys(extra);
      if (keys.length) {
        parts.push(JSON.stringify(extra));
      }
      console.log(parts.join(' '));
    },
    [],
  );

  const onDisconnect = useCallback((callback: DisconnectCallback) => {
    onDisconnectCallbacksRef.current.add(callback);
    return () => {
      onDisconnectCallbacksRef.current.delete(callback);
    };
  }, []);

  const notifyDisconnect = useCallback(() => {
    onDisconnectCallbacksRef.current.forEach((cb) => {
      try {
        cb();
      } catch (e) {
        console.error('[WebSocket] Error in disconnect callback:', e);
      }
    });
  }, []);

  const connect = useCallback(
    (options: ConnectOptions = {}) => {
      const { resetAttempts = false } = options;

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (resetAttempts) {
        reconnectAttemptRef.current = 0;
      }

      shouldReconnectRef.current = true;

      setConnectionState(
        reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connecting',
      );
      logDebug('connect start', { attempt: reconnectAttemptRef.current + 1 });

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

      let wsUrl = `${protocol}//${window.location.host}/ws`;
      const token = localStorage.getItem('auth-token');
      if (token) {
        wsUrl += `?token=${encodeURIComponent(token)}`;
      }

      const socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        logDebug('connected');
        reconnectAttemptRef.current = 0;
        setConnectionState('connected');
        setIsConnected(true);
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      };

      socket.onmessage = (event: MessageEvent) => {
        try {
          const message = JSON.parse(event.data) as ServerToClientMessage;
          const callbacks = subscribersRef.current.get(message.type);
          callbacks?.forEach((cb) => cb(message));
        } catch (e) {
          console.error('[WebSocket] Failed to parse message:', e);
        }
      };

      socket.onclose = () => {
        if (wsRef.current !== socket) {
          logDebug('stale socket close ignored');
          return;
        }

        logDebug('disconnected');
        setIsConnected(false);

        notifyDisconnect();

        if (!shouldReconnectRef.current) {
          setConnectionState('disconnected');
          return;
        }

        if (reconnectAttemptRef.current >= MAX_ATTEMPTS) {
          console.log('[WebSocket] Max reconnection attempts reached');
          setConnectionState('failed');
          return;
        }

        const delay = calculateBackoff(reconnectAttemptRef.current);
        reconnectAttemptRef.current++;

        logDebug('scheduling reconnect', {
          delay,
          attempt: reconnectAttemptRef.current,
          max: MAX_ATTEMPTS,
        });
        setConnectionState('reconnecting');

        reconnectTimeoutRef.current = setTimeout(() => connect(), delay);
      };

      socket.onerror = (error) => {
        if (wsRef.current !== socket) {
          logDebug('stale socket error ignored');
          return;
        }

        console.error(`${logPrefix} Error:`, error);
        notifyDisconnect();
      };

      setWs(socket);
      wsRef.current = socket;
    },
    [logDebug, notifyDisconnect],
  );

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      shouldReconnectRef.current = false;
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  const manualReconnect = useCallback(() => {
    logDebug('manual reconnect requested');

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    shouldReconnectRef.current = false;
    setIsConnected(false);

    if (
      wsRef.current?.readyState !== WebSocket.CLOSED &&
      wsRef.current?.readyState !== WebSocket.CLOSING
    ) {
      wsRef.current?.close();
    }

    connect({ resetAttempts: true });
  }, [connect, logDebug]);

  const sendMessage = useCallback(
    <T extends ClientMessageType>(
      type: T,
      data: Omit<ClientMessageOf<T>, 'type'>,
    ): boolean => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type, ...data }));
        return true;
      }
      console.warn(
        '[WebSocket] Cannot send, not connected. ReadyState:',
        wsRef.current?.readyState,
      );
      setIsConnected(false);
      return false;
    },
    [],
  );

  const subscribe = useCallback(
    <T extends ServerMessageType>(
      type: T,
      callback: (message: ServerMessageOf<T>) => void,
    ): void => {
      let bucket = subscribersRef.current.get(type);
      if (!bucket) {
        bucket = new Set();
        subscribersRef.current.set(type, bucket);
      }
      bucket.add(callback as Subscriber);
    },
    [],
  );

  const unsubscribe = useCallback(
    <T extends ServerMessageType>(
      type: T,
      callback: (message: ServerMessageOf<T>) => void,
    ): void => {
      subscribersRef.current.get(type)?.delete(callback as Subscriber);
    },
    [],
  );

  const value: WebSocketContextValue = {
    ws,
    isConnected,
    connectionState,
    sendMessage,
    subscribe,
    unsubscribe,
    manualReconnect,
    onDisconnect,
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

export const useWebSocket = (): WebSocketContextValue => {
  const ctx = useContext(WebSocketContext);
  if (!ctx) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return ctx;
};
