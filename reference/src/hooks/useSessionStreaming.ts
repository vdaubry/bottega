/*
 * useSessionStreaming.ts - Hook for session streaming and abort functionality
 *
 * Extracts streaming logic from ChatInterface for reuse across components.
 * Handles message streaming, status updates, and session abort.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  ClaudeSessionId,
  ClaudeStatusPayload,
  ServerMessageOf,
} from '@shared/websocket/messages';
import type { WebSocketContextValue } from '../contexts/WebSocketContext';

export type StreamingDisplayMessage =
  | { type: 'assistant'; content: string; timestamp: string }
  | { type: 'thinking'; content: string; timestamp: string }
  | {
      type: 'tool';
      isToolUse: true;
      toolName: string;
      toolId: string;
      toolInput: string;
      timestamp: string;
    };

export interface SessionLike {
  id: ClaudeSessionId;
  __provider?: string;
}

type WsHooks = Pick<
  WebSocketContextValue,
  'sendMessage' | 'subscribe' | 'unsubscribe' | 'onDisconnect'
>;

export interface UseSessionStreamingOptions extends WsHooks {
  selectedSession: SessionLike | null | undefined;
  selectedProject?: unknown;
  onMessagesRefresh?: () => Promise<void> | void;
  onTokenBudgetUpdate?: (usage: unknown) => void;
  // Called when the server rejects a send because a turn is already in
  // flight for this conversation (`conversation-busy`). The hook reconciles
  // its own streaming state; this surfaces the message to the user (toast).
  onBusy?: (message: string) => void;
}

export interface UseSessionStreamingResult {
  streamingMessages: StreamingDisplayMessage[];
  setStreamingMessages: React.Dispatch<
    React.SetStateAction<StreamingDisplayMessage[]>
  >;
  isStreaming: boolean;
  setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  isSending: boolean;
  setIsSending: React.Dispatch<React.SetStateAction<boolean>>;
  claudeStatus: ClaudeStatusPayload | null;
  handleAbortSession: () => void;
}

interface SdkBlockText {
  type: 'text';
  text: string;
}
interface SdkBlockThinking {
  type: 'thinking';
  thinking: string;
}
interface SdkBlockToolUse {
  type: 'tool_use';
  name: string;
  id: string;
  input: unknown;
}
type SdkContentBlock = SdkBlockText | SdkBlockThinking | SdkBlockToolUse;

interface SdkAssistantMessage {
  type: 'assistant';
  message?: { content?: SdkContentBlock[] | string };
  session_id?: ClaudeSessionId;
}
interface SdkUserMessage {
  type: 'user';
  message?: { content?: unknown };
  session_id?: ClaudeSessionId;
}

function isAssistantMessage(value: unknown): value is SdkAssistantMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'assistant'
  );
}

function isUserMessage(value: unknown): value is SdkUserMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'user'
  );
}

function getSessionId(value: unknown): ClaudeSessionId | undefined {
  if (typeof value === 'object' && value !== null) {
    const sid = (value as { session_id?: unknown }).session_id;
    if (typeof sid === 'string') return sid;
  }
  return undefined;
}

// Transform streaming SDK message to display format
function transformStreamingMessage(
  sdkMessage: unknown,
): StreamingDisplayMessage[] {
  const timestamp = new Date().toISOString();

  // Handle assistant messages with content array
  if (isAssistantMessage(sdkMessage) && sdkMessage.message?.content) {
    const content = sdkMessage.message.content;
    const messages: StreamingDisplayMessage[] = [];

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          messages.push({ type: 'assistant', content: block.text, timestamp });
        } else if (block.type === 'thinking') {
          messages.push({
            type: 'thinking',
            content: block.thinking,
            timestamp,
          });
        } else if (block.type === 'tool_use') {
          messages.push({
            type: 'tool',
            isToolUse: true,
            toolName: block.name,
            toolId: block.id,
            toolInput: JSON.stringify(block.input, null, 2),
            timestamp,
          });
        }
      }
    } else if (typeof content === 'string') {
      messages.push({ type: 'assistant', content, timestamp });
    }

    return messages;
  }

  // Tool results come as user messages — handled by tool_use display, skip here.
  if (isUserMessage(sdkMessage)) {
    return [];
  }

  return [];
}

export function useSessionStreaming({
  selectedSession,
  sendMessage,
  subscribe,
  unsubscribe,
  onMessagesRefresh,
  onDisconnect,
  onBusy,
}: UseSessionStreamingOptions): UseSessionStreamingResult {
  const [streamingMessages, setStreamingMessages] = useState<
    StreamingDisplayMessage[]
  >([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatusPayload | null>(
    null,
  );

  const onMessagesRefreshRef = useRef(onMessagesRefresh);
  const onBusyRef = useRef(onBusy);
  const selectedSessionIdRef = useRef<ClaudeSessionId | undefined>(
    selectedSession?.id,
  );

  useEffect(() => {
    onMessagesRefreshRef.current = onMessagesRefresh;
  }, [onMessagesRefresh]);

  useEffect(() => {
    onBusyRef.current = onBusy;
  }, [onBusy]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSession?.id;
  }, [selectedSession?.id]);

  // Handle incoming claude-response messages
  const handleClaudeResponse = useCallback((data: unknown) => {
    const currentSessionId = selectedSessionIdRef.current;
    const messageSessionId = getSessionId(data);

    // Tightened session filtering (modal-first flow guarantees we have real session ID):
    // Accept messages when:
    // 1. Message has no session ID (broadcast messages - SDK often omits session_id)
    // 2. The message's session ID matches our session ID
    const shouldAccept =
      !messageSessionId || messageSessionId === currentSessionId;

    if (!shouldAccept) {
      console.log(
        '[useSessionStreaming] Ignoring message for different session:',
        messageSessionId,
      );
      return;
    }

    setIsStreaming(true);

    const transformed = transformStreamingMessage(data);
    if (transformed.length > 0) {
      setStreamingMessages((prev) => [...prev, ...transformed]);
    }
  }, []);

  const handleClaudeComplete = useCallback(async () => {
    setIsStreaming(false);
    setIsSending(false);
    setClaudeStatus(null);

    if (onMessagesRefreshRef.current) {
      await onMessagesRefreshRef.current();
    }
    setStreamingMessages([]);
  }, []);

  const handleClaudeError = useCallback((error: unknown) => {
    console.error('[useSessionStreaming] Claude error:', error);
    setIsStreaming(false);
    setIsSending(false);
    setClaudeStatus(null);
    setStreamingMessages([]);
  }, []);

  // The server rejected this send: a turn is already in flight for the
  // conversation (one conversation = one process). Unlike claude-error we do
  // NOT tear down streaming — a turn IS running. Revert the optimistic echo,
  // flip the composer into the streaming state (covers the case where it was
  // wrongly enabled, e.g. the client missed `streaming-started` across a
  // reconnect), and surface the reason via the onBusy callback.
  const handleConversationBusy = useCallback(
    (msg: ServerMessageOf<'conversation-busy'>) => {
      console.warn('[useSessionStreaming] conversation busy:', msg.error);
      setStreamingMessages([]);
      setIsSending(false);
      setIsStreaming(true);
      onBusyRef.current?.(msg.error);
    },
    [],
  );

  const handleAbortSession = useCallback(() => {
    if (selectedSession?.id) {
      sendMessage('abort-session', {
        sessionId: selectedSession.id,
        provider: selectedSession.__provider || 'claude',
      });
    }
  }, [selectedSession?.id, selectedSession?.__provider, sendMessage]);

  const handleSessionAborted = useCallback(() => {
    setIsStreaming(false);
    setIsSending(false);
    setClaudeStatus(null);
    setStreamingMessages((prev) => [
      ...prev,
      {
        type: 'assistant',
        content: 'Session interrupted by user.',
        timestamp: new Date().toISOString(),
      },
    ]);
  }, []);

  const handleClaudeStatusMsg = useCallback(
    (msg: ServerMessageOf<'claude-status'>) => {
      if (msg.data) {
        setClaudeStatus({
          text: msg.data.text || 'Working...',
          tokens: msg.data.tokens || 0,
          can_interrupt: msg.data.can_interrupt !== false,
        });
      }
    },
    [],
  );

  // Subscribe to WebSocket messages
  useEffect(() => {
    if (!selectedSession) return;

    // Server dual-emits `claude-response` (legacy) and `ai-response`
    // (Codex-aware) for the same SDK payload. Both carry the same
    // identifier (`uuid` from the session store, or the Anthropic
    // `message.id`). Dedup by id — whichever event arrives first wins, the
    // second is dropped. Phase 14 cleanup removes the legacy emit; this
    // hook keeps only ai-response then.
    const seenResponseIds = new Set<string>();
    const aiResponseId = (data: { uuid?: unknown; message?: { id?: unknown } }): string | null => {
      if (typeof data.uuid === 'string') return data.uuid;
      const msgId = data.message?.id;
      return typeof msgId === 'string' ? msgId : null;
    };

    const handleDualEmitResponse = (data: unknown) => {
      const id = aiResponseId(data as never);
      if (id) {
        if (seenResponseIds.has(id)) return;
        seenResponseIds.add(id);
      }
      handleClaudeResponse(data);
    };

    const handleAiResponse = (msg: ServerMessageOf<'ai-response'>) =>
      handleDualEmitResponse(msg.data);
    const handleResponse = (msg: ServerMessageOf<'claude-response'>) =>
      handleDualEmitResponse(msg.data);
    const handleComplete = () => handleClaudeComplete();
    const handleError = (msg: ServerMessageOf<'claude-error'>) =>
      handleClaudeError(msg.error);
    const handleBusy = (msg: ServerMessageOf<'conversation-busy'>) =>
      handleConversationBusy(msg);
    const handleAborted = () => handleSessionAborted();
    const handleStatus = (msg: ServerMessageOf<'claude-status'>) =>
      handleClaudeStatusMsg(msg);
    // streaming-ended/streaming-started reflect SDK turn lifecycle; mirror them
    // into the chat-level isStreaming for the "Claude is responding..." UI.
    const handleStreamingEnded = () => setIsStreaming(false);
    const handleStreamingStarted = () => setIsStreaming(true);
    // AskUserQuestion parks the SDK turn on canUseTool — the server emits
    // awaiting-user-answer with the questions/toolId. Hide the streaming
    // indicator so the user sees the panel is theirs to act on. When they
    // submit, the server emits streaming-started again as the SDK resumes.
    const handleAwaitingUserAnswer = () => {
      setIsStreaming(false);
      setIsSending(false);
      setClaudeStatus(null);
    };

    subscribe('claude-response', handleResponse);
    subscribe('ai-response', handleAiResponse);
    subscribe('claude-complete', handleComplete);
    subscribe('claude-error', handleError);
    subscribe('conversation-busy', handleBusy);
    subscribe('session-aborted', handleAborted);
    subscribe('claude-status', handleStatus);
    subscribe('streaming-ended', handleStreamingEnded);
    subscribe('streaming-started', handleStreamingStarted);
    subscribe('awaiting-user-answer', handleAwaitingUserAnswer);

    return () => {
      unsubscribe('claude-response', handleResponse);
      unsubscribe('ai-response', handleAiResponse);
      unsubscribe('claude-complete', handleComplete);
      unsubscribe('claude-error', handleError);
      unsubscribe('conversation-busy', handleBusy);
      unsubscribe('session-aborted', handleAborted);
      unsubscribe('claude-status', handleStatus);
      unsubscribe('streaming-ended', handleStreamingEnded);
      unsubscribe('streaming-started', handleStreamingStarted);
      unsubscribe('awaiting-user-answer', handleAwaitingUserAnswer);
    };
  }, [
    selectedSession?.id,
    subscribe,
    unsubscribe,
    handleClaudeResponse,
    handleClaudeComplete,
    handleClaudeError,
    handleConversationBusy,
    handleSessionAborted,
    handleClaudeStatusMsg,
  ]);

  // Escape key to stop generation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (isSending || isStreaming)) {
        handleAbortSession();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSending, isStreaming, handleAbortSession]);

  // Clear streaming state immediately on WebSocket disconnect
  // This prevents "stuck thinking" state when connection is lost
  useEffect(() => {
    if (!onDisconnect) return;

    const cleanup = onDisconnect(() => {
      console.log(
        '[useSessionStreaming] Connection lost, clearing streaming state',
      );
      setIsStreaming(false);
      setIsSending(false);
      setClaudeStatus(null);
      setStreamingMessages([]);
    });

    return cleanup;
  }, [onDisconnect]);

  return {
    streamingMessages,
    setStreamingMessages,
    isStreaming,
    setIsStreaming,
    isSending,
    setIsSending,
    claudeStatus,
    handleAbortSession,
  };
}
