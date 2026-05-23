/**
 * ChatInterface.tsx - Chat Component for Task-Driven Workflow
 *
 * Architecture:
 * - Load messages via REST API when conversation selected
 * - Display messages (user, assistant, tool calls)
 * - Send messages via WebSocket
 * - Messages linked to task's conversation
 */

import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  type FormEvent,
} from 'react';
import ClaudeStatus from './ClaudeStatus';
import MessageInput from './MessageInput';
import MessageComponent, { type DisplayMessage } from './MessageComponent';
import CommandMenu from './CommandMenu';
import ContextDetailModal, {
  type ContextUsageData,
} from './ContextDetailModal';
import { api } from '../utils/api';
import { useWebSocket } from '../contexts/WebSocketContext';
import { useClaudeAuth } from '../contexts/ClaudeAuthContext';
import { useToast } from '../contexts/ToastContext';
import { useSlashCommands, type SlashCommand } from '../hooks/useSlashCommands';
import { useSessionStreaming } from '../hooks/useSessionStreaming';
import { useConversationSubscription } from '../hooks/useConversationSubscription';
import AskUserQuestionPanel from './AskUserQuestion/AskUserQuestionPanel';
import {
  indexAskWidgets,
  getAskWidgetState,
  type AskWidgetState,
} from './AskUserQuestion/derivedState';
import type { Question } from './AskUserQuestion/answerUtils';
import type {
  ClaudeSessionId,
  PermissionMode,
  ServerMessageOf,
} from '@shared/websocket/messages';
import type { Provider } from '@shared/providers/types';

// ---- Local types ----

interface SelectedProjectShape {
  id?: number;
  name?: string;
  repo_folder_path?: string;
  path?: string;
}

interface SelectedTaskShape {
  id?: number;
}

interface ActiveConversationShape {
  id?: number;
  claude_conversation_id?: ClaudeSessionId | null;
  /** Which LLM backend runs this conversation. Defaults to 'anthropic'
   *  for legacy rows that pre-date the column. */
  provider?: Provider;
  __initialMessage?: string;
  __permissionMode?: PermissionMode;
}

export interface ChatInterfaceProps {
  selectedProject: SelectedProjectShape | null;
  selectedTask: SelectedTaskShape | null;
  activeConversation: ActiveConversationShape | null;
  onShowSettings?: () => void;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
}

interface AskUserQuestionPanelState {
  toolId: string;
  questions: Question[];
}

interface RawSdkBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface RawSdkMessage {
  type?: string;
  message?: { content?: RawSdkBlock[] | string } | string;
  timestamp?: string;
}

// ---- Helpers ----

function convertSessionMessages(
  rawMessages: RawSdkMessage[],
): DisplayMessage[] {
  const converted: DisplayMessage[] = [];
  const toolResults = new Map<string, RawSdkBlock>();

  // First pass: collect tool results
  for (const msg of rawMessages) {
    if (msg.type === 'user' && typeof msg.message === 'object' && msg.message?.content) {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolResults.set(block.tool_use_id, block);
          }
        }
      }
    }
  }

  // Second pass: build message list
  for (const msg of rawMessages) {
    const timestamp = msg.timestamp ?? new Date().toISOString();

    if (msg.type === 'user') {
      const content = typeof msg.message === 'object' ? msg.message?.content : undefined;
      if (typeof content === 'string') {
        if (!content.startsWith('<task-notification>')) {
          converted.push({ type: 'user', content, timestamp });
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block.type === 'text' &&
            block.text &&
            !block.text.startsWith('<task-notification>')
          ) {
            converted.push({ type: 'user', content: block.text, timestamp });
          }
        }
      }
    } else if (msg.type === 'assistant') {
      const content = typeof msg.message === 'object' ? msg.message?.content : undefined;
      if (typeof content === 'string') {
        converted.push({ type: 'assistant', content, timestamp });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            converted.push({
              type: 'assistant',
              content: block.text,
              timestamp,
            });
          } else if (block.type === 'thinking' && block.thinking) {
            converted.push({
              type: 'thinking',
              content: block.thinking,
              timestamp,
            });
          } else if (block.type === 'tool_use' && block.id && block.name) {
            const toolResult = toolResults.get(block.id);
            converted.push({
              type: 'tool',
              isToolUse: true,
              toolName: block.name,
              toolId: block.id,
              toolInput: JSON.stringify(block.input, null, 2),
              toolResult: toolResult?.content,
              timestamp,
            });
          }
        }
      }
    }
  }

  return converted;
}

// ---- Component ----

function ChatInterface({
  selectedProject,
  activeConversation,
  showThinking,
}: ChatInterfaceProps) {
  const [sessionMessages, setSessionMessages] = useState<RawSdkMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [input, setInput] = useState('');

  const initialPermissionMode = activeConversation?.__permissionMode;

  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    initialPermissionMode || 'bypassPermissions',
  );

  useEffect(() => {
    if (initialPermissionMode) {
      setPermissionMode(initialPermissionMode);
    } else {
      setPermissionMode('bypassPermissions');
    }
  }, [activeConversation?.id, initialPermissionMode]);

  // Context usage snapshot — drives both the gauge above the input and the
  // detail popup. We keep `unknown` here because the wire payload comes from
  // the SDK's getContextUsage() and we forward it verbatim to the modal.
  const [contextUsage, setContextUsage] = useState<ContextUsageData | null>(
    null,
  );
  const [showContextModal, setShowContextModal] = useState(false);

  const [openAskPanel, setOpenAskPanel] =
    useState<AskUserQuestionPanelState | null>(null);

  const projectPath =
    selectedProject?.repo_folder_path || selectedProject?.path;
  const {
    slashCommands,
    showCommandMenu,
    commandQuery: _commandQuery,
    filteredCommands,
    selectedCommandIndex,
    handleSlashDetected,
    handleCommandSelect: hookCommandSelect,
    handleCloseCommandMenu,
    handleToggleCommandMenu,
  } = useSlashCommands(projectPath);

  const inputTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const { isConnected, sendMessage, subscribe, unsubscribe, onDisconnect } =
    useWebSocket();
  const { requireClaudeAuth } = useClaudeAuth() as {
    requireClaudeAuth: () => boolean;
  };
  const { toast } = useToast();

  // Subscribe this WebSocket to conversation-channel messages
  // (claude-response, claude-status, claude-complete, claude-error,
  // session-created, context-usage, conversation-name-updated,
  // awaiting-user-answer). The hook handles subscribe/unsubscribe lifecycle
  // and reconnect resubscription.
  useConversationSubscription(activeConversation?.id ?? null);

  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const userScrollIntentRef = useRef(false);
  const userScrollIntentTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const isProgrammaticScrollRef = useRef(false);
  const reconnectCooldownRef = useRef(false);

  const wasConnectedRef = useRef(false);
  const isRefreshingRef = useRef(false);

  const claudeSessionId = activeConversation?.claude_conversation_id ?? null;

  const conversationId = activeConversation?.id;
  const refreshSessionMessages = useCallback(async () => {
    if (!conversationId) {
      setSessionMessages([]);
      return;
    }

    try {
      const response = await (api.conversations.getMessages)(conversationId, 1000, 0);
      if (response.ok) {
        const data = await response.json();
        const msgs = Array.isArray(data) ? data : data.messages;
        setSessionMessages(msgs || []);
      } else {
        console.error('Failed to load messages');
        setSessionMessages([]);
      }
    } catch (error) {
      console.error('Error loading messages:', error);
      setSessionMessages([]);
    }
  }, [conversationId]);

  const handleStreamingComplete = useCallback(async () => {
    await refreshSessionMessages();
  }, [refreshSessionMessages]);

  const sessionForStreaming = useMemo(() => {
    if (!claudeSessionId) return null;
    return {
      id: claudeSessionId,
      __provider: 'claude',
    };
  }, [claudeSessionId]);

  const {
    streamingMessages,
    setStreamingMessages,
    isStreaming,
    setIsStreaming,
    isSending,
    setIsSending,
    claudeStatus,
    handleAbortSession,
  } = useSessionStreaming({
    selectedSession: sessionForStreaming,
    selectedProject,
    sendMessage,
    subscribe,
    unsubscribe,
    onMessagesRefresh: handleStreamingComplete,
    onDisconnect,
    // The server rejects a send when a turn is already in flight for this
    // conversation (one conversation = one process). Surface why.
    onBusy: (message: string) => toast.error(message),
  });

  // Display initial message from NewConversationModal immediately
  useEffect(() => {
    if (activeConversation?.__initialMessage && sessionMessages.length === 0) {
      setStreamingMessages([
        {
          type: 'user' as never,
          content: activeConversation.__initialMessage,
          timestamp: new Date().toISOString(),
        },
      ]);
    }
  }, [
    activeConversation?.__initialMessage,
    activeConversation?.id,
    sessionMessages.length,
    setStreamingMessages,
  ]);

  const handleContextUsage = useCallback(
    (message: ServerMessageOf<'context-usage'>) => {
      // `data` is intentionally `unknown` on the WS message — see
      // shared/websocket/messages.ts for the hybrid baseline+breakdown
      // shape rationale. Narrow structurally to the modal's expected shape.
      setContextUsage(message.data as ContextUsageData);
    },
    [],
  );

  // Reset + hydrate cached snapshot whenever the active conversation changes,
  // so the gauge has a value even before the next turn streams.
  useEffect(() => {
    if (!conversationId) {
      setContextUsage(null);
      return undefined;
    }
    let cancelled = false;
    setContextUsage(null);
    api.conversations
      .getContextUsage(conversationId)
      .then(async (res: Response) => {
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as ContextUsageData;
          setContextUsage(data);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const handleModeChange = useCallback(
    (newMode: PermissionMode) => {
      setPermissionMode(newMode);
      if (activeConversation?.id) {
        localStorage.setItem(
          `permissionMode-conv-${activeConversation.id}`,
          newMode,
        );
      }
    },
    [activeConversation?.id],
  );

  const handleCommandSelect = useCallback(
    (command: SlashCommand, index: number, isHover: boolean) => {
      hookCommandSelect(command, index, isHover, input, setInput);
    },
    [hookCommandSelect, input, setInput],
  );

  const handleOpenAskUserPanel = useCallback(
    (toolId: string, questions: Question[]) => {
      setOpenAskPanel({ toolId, questions });
    },
    [],
  );

  const handleDismissAskUserPanel = useCallback(() => {
    setOpenAskPanel(null);
  }, []);

  // Subscribe to context-usage updates. (Conversation-level subscription
  // acks are handled by useConversationSubscription itself.)
  useEffect(() => {
    if (!activeConversation) return;

    const handleContextUsageMsg = (msg: ServerMessageOf<'context-usage'>) =>
      handleContextUsage(msg);

    subscribe('context-usage', handleContextUsageMsg);

    return () => {
      unsubscribe('context-usage', handleContextUsageMsg);
    };
  }, [activeConversation, subscribe, unsubscribe, handleContextUsage]);

  const sendUserCommand = useCallback(
    (messageText: string) => {
      setIsSending(true);
      setStreamingMessages([
        {
          type: 'user' as never,
          content: messageText,
          timestamp: new Date().toISOString(),
        },
      ]);
      sendMessage('claude-command', {
        command: messageText,
        options: {
          projectPath: projectPath,
          cwd: projectPath,
          sessionId: claudeSessionId,
          resume: true,
          permissionMode: permissionMode,
          conversationId: activeConversation?.id,
        },
      });
    },
    [
      sendMessage,
      permissionMode,
      projectPath,
      claudeSessionId,
      activeConversation,
      setIsSending,
      setStreamingMessages,
    ],
  );

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (
        !input.trim() ||
        isSending ||
        isStreaming ||
        !selectedProject ||
        !isConnected
      )
        return;

      if (!claudeSessionId) {
        console.error(
          '[ChatInterface] Cannot send message: no claude session ID',
        );
        return;
      }

      if (!requireClaudeAuth()) {
        return;
      }

      const messageText = input.trim();
      setInput('');
      sendUserCommand(messageText);
    },
    [
      input,
      isSending,
      isStreaming,
      selectedProject,
      claudeSessionId,
      isConnected,
      requireClaudeAuth,
      sendUserCommand,
    ],
  );

  const displayMessages = useMemo<DisplayMessage[]>(() => {
    const historyMessages = convertSessionMessages(sessionMessages);
    if (streamingMessages.length > 0) {
      return [
        ...historyMessages,
        ...(streamingMessages as unknown as DisplayMessage[]),
      ];
    }
    return historyMessages;
  }, [sessionMessages, streamingMessages]);

  const askWidgetStatesRef = useRef<Map<string, AskWidgetState>>(new Map());
  const askWidgetStatesSignatureRef = useRef('');
  const askWidgetStates = useMemo(() => {
    const idx = indexAskWidgets(displayMessages);
    const next = new Map<string, AskWidgetState>();
    let signature = '';
    for (const [toolId, entry] of idx) {
      const state = getAskWidgetState(
        toolId,
        entry.questions,
        displayMessages,
        idx,
      );
      next.set(toolId, state);
      signature += `${toolId}|${state.isAnswered ? 1 : 0}|${
        state.isDuplicate ? 1 : 0
      }|${state.answers ? JSON.stringify(state.answers) : ''}\n`;
    }
    if (signature === askWidgetStatesSignatureRef.current) {
      return askWidgetStatesRef.current;
    }
    askWidgetStatesSignatureRef.current = signature;
    askWidgetStatesRef.current = next;
    return next;
  }, [displayMessages]);

  const handleAskUserSubmit = useCallback(
    (_formatted: unknown, structured: Record<string, string> | null) => {
      if (!openAskPanel || !isConnected || !claudeSessionId) return;
      if (!requireClaudeAuth()) return;
      if (
        structured &&
        Object.keys(structured).length > 0 &&
        activeConversation?.id
      ) {
        setIsSending(true);
        sendMessage('ask-user-question-answer', {
          conversationId: activeConversation.id,
          toolUseId: openAskPanel.toolId,
          answers: structured,
        });
      }
      setOpenAskPanel(null);
    },
    [
      openAskPanel,
      isConnected,
      claudeSessionId,
      requireClaudeAuth,
      sendMessage,
      activeConversation,
      setIsSending,
    ],
  );

  // Reset modal when conversation changes
  useEffect(() => {
    setOpenAskPanel(null);
  }, [activeConversation?.id]);

  // Load messages when conversation changes.
  // For NEW conversations: skip loading - use __initialMessage + WS streaming.
  // For RESUMED conversations: load history from JSONL via REST API.
  useEffect(() => {
    async function loadMessages() {
      if (!activeConversation) {
        setSessionMessages([]);
        return;
      }

      if (activeConversation.__initialMessage) {
        setSessionMessages([]);
        return;
      }

      setIsLoading(true);
      try {
        if (!activeConversation.id) {
          setSessionMessages([]);
          return;
        }
        const response = await (api.conversations.getMessages)(activeConversation.id, 1000, 0);
        if (response.ok) {
          const data = await response.json();
          const msgs = Array.isArray(data) ? data : data.messages;
          setSessionMessages(msgs || []);
        } else {
          console.error('Failed to load messages');
          setSessionMessages([]);
        }
      } catch (error) {
        console.error('Error loading messages:', error);
        setSessionMessages([]);
      } finally {
        setIsLoading(false);
      }
    }

    void loadMessages();
  }, [activeConversation?.id]);

  // Load permission mode when conversation changes
  useEffect(() => {
    if (initialPermissionMode) return;

    if (activeConversation?.id) {
      const savedMode = localStorage.getItem(
        `permissionMode-conv-${activeConversation.id}`,
      ) as PermissionMode | null;
      setPermissionMode(savedMode || 'bypassPermissions');
    } else {
      setPermissionMode('bypassPermissions');
    }
  }, [activeConversation?.id, initialPermissionMode]);

  // Clear streaming UI state when switching to a different conversation —
  // the previous conversation's in-flight events do not belong to this view.
  // (Subscription lifecycle is handled by `useConversationSubscription`
  // above; this effect only owns the per-view UI reset.)
  const lastConversationIdRef = useRef<number | null>(null);
  useEffect(() => {
    const newId = activeConversation?.id ?? null;
    const isConversationChange = lastConversationIdRef.current !== newId;
    lastConversationIdRef.current = newId;
    if (isConversationChange && !activeConversation?.__initialMessage) {
      setStreamingMessages([]);
      setIsStreaming(false);
    }
  }, [activeConversation?.id, setStreamingMessages, setIsStreaming]);

  // Cooldown after WebSocket reconnection to ignore scroll events
  useEffect(() => {
    if (isConnected) {
      reconnectCooldownRef.current = true;
      const timeout = setTimeout(() => {
        reconnectCooldownRef.current = false;
      }, 500);
      return () => clearTimeout(timeout);
    }
  }, [isConnected]);

  // State sync on reconnect. `useConversationSubscription` already
  // resubscribes this client when the WS comes back; here we only need to
  // sync `isStreaming` / `isSending` (`check-session-status`) and backfill
  // any messages that streamed while disconnected (REST).
  useEffect(() => {
    const wasConnected = wasConnectedRef.current;
    wasConnectedRef.current = isConnected;

    if (isConnected && !wasConnected && claudeSessionId) {
      console.log('[ChatInterface] Reconnected, syncing state...');

      sendMessage('check-session-status', { sessionId: claudeSessionId });

      if (!isRefreshingRef.current) {
        isRefreshingRef.current = true;
        void refreshSessionMessages().finally(() => {
          isRefreshingRef.current = false;
        });
      }
    }
  }, [isConnected, claudeSessionId, sendMessage, refreshSessionMessages]);

  // session-status response sync
  useEffect(() => {
    const handleSessionStatus = (msg: ServerMessageOf<'session-status'>) => {
      if (msg.sessionId === claudeSessionId) {
        if (!msg.isProcessing && (isSending || isStreaming)) {
          console.log(
            '[ChatInterface] Syncing: Server finished, clearing UI state',
          );
          setIsSending(false);
          setIsStreaming(false);
          if (!isRefreshingRef.current) {
            isRefreshingRef.current = true;
            void refreshSessionMessages().finally(() => {
              isRefreshingRef.current = false;
            });
          }
        } else if (msg.isProcessing && !isStreaming) {
          // Inverse sync: the server still has a turn in flight but this
          // client thinks it's idle (e.g. it missed `streaming-started`
          // across a reconnect). Light the streaming state so the composer
          // disables — otherwise the user can fire a message into a live
          // turn, which the backend now rejects as `conversation-busy`.
          console.log(
            '[ChatInterface] Syncing: Server still processing, marking streaming',
          );
          setIsStreaming(true);
        }
      }
    };

    subscribe('session-status', handleSessionStatus);
    return () => unsubscribe('session-status', handleSessionStatus);
  }, [
    claudeSessionId,
    isSending,
    isStreaming,
    subscribe,
    unsubscribe,
    refreshSessionMessages,
    setIsSending,
    setIsStreaming,
  ]);

  const markProgrammaticScroll = useCallback(() => {
    isProgrammaticScrollRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false;
      });
    });
  }, []);

  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const scrollPos = container.scrollTop;
    const atBottom = scrollPos >= -50;

    setIsAtBottom(atBottom);
    if (atBottom) {
      setHasNewMessages(false);
      setIsScrolling(false);
      return;
    }

    if (isProgrammaticScrollRef.current) return;
    if (!userScrollIntentRef.current) return;
    if (isStreaming) return;
    if (reconnectCooldownRef.current) return;

    const COLLAPSE_THRESHOLD = -200;
    if (scrollPos < COLLAPSE_THRESHOLD) {
      setIsScrolling(true);

      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }

      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);
      }, 150);
    }
  }, [isStreaming]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => {
        container.removeEventListener('scroll', handleScroll);
        if (scrollTimeoutRef.current) {
          clearTimeout(scrollTimeoutRef.current);
        }
      };
    }
  }, [handleScroll]);

  // Listen for user scroll-intent signals (touch, wheel, mouse)
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleUserScrollIntent = () => {
      userScrollIntentRef.current = true;
      if (userScrollIntentTimeoutRef.current) {
        clearTimeout(userScrollIntentTimeoutRef.current);
      }
      userScrollIntentTimeoutRef.current = setTimeout(() => {
        userScrollIntentRef.current = false;
      }, 200);
    };

    container.addEventListener('touchstart', handleUserScrollIntent, {
      passive: true,
    });
    container.addEventListener('touchmove', handleUserScrollIntent, {
      passive: true,
    });
    container.addEventListener('wheel', handleUserScrollIntent, {
      passive: true,
    });
    container.addEventListener('mousedown', handleUserScrollIntent, {
      passive: true,
    });

    return () => {
      container.removeEventListener('touchstart', handleUserScrollIntent);
      container.removeEventListener('touchmove', handleUserScrollIntent);
      container.removeEventListener('wheel', handleUserScrollIntent);
      container.removeEventListener('mousedown', handleUserScrollIntent);
      if (userScrollIntentTimeoutRef.current) {
        clearTimeout(userScrollIntentTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (streamingMessages.length > 0 && !isAtBottom) {
      setHasNewMessages(true);
    }
  }, [streamingMessages.length, isAtBottom]);

  const scrollToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (container) {
      markProgrammaticScroll();
      container.scrollTop = 0;
    }
    setHasNewMessages(false);
  }, [markProgrammaticScroll]);

  useEffect(() => {
    if (isAtBottom && messagesContainerRef.current) {
      markProgrammaticScroll();
      messagesContainerRef.current.scrollTop = 0;
    }
  }, [displayMessages.length, isAtBottom, markProgrammaticScroll]);

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <div className="w-8 h-8 mx-auto mb-3">
            <div className="w-full h-full rounded-full border-4 border-muted border-t-primary animate-spin" />
          </div>
          <p>Loading messages...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col relative">
      <div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto p-4 space-y-4 flex flex-col-reverse"
      >
        <div className="space-y-4">
          {displayMessages.length === 0 && !isStreaming ? (
            <div className="text-center py-12 text-muted-foreground">
              <p className="text-lg mb-2">Start a conversation</p>
              <p className="text-sm">
                Type a message below to begin chatting with Claude about this
                task.
              </p>
            </div>
          ) : (
            displayMessages.map((message, index) => {
              const prevMessage =
                index > 0 ? displayMessages[index - 1] : null;
              const isGrouped =
                !!prevMessage && prevMessage.type === message.type;

              if (message.type === 'thinking' && !showThinking) {
                return null;
              }

              const askWidgetState =
                message.type === 'tool' &&
                message.toolName === 'AskUserQuestion' &&
                message.toolId
                  ? askWidgetStates.get(message.toolId)
                  : undefined;
              return (
                <MessageComponent
                  key={index}
                  message={message}
                  isGrouped={isGrouped}
                  askWidgetState={askWidgetState}
                  onOpenAskUserPanel={handleOpenAskUserPanel}
                />
              );
            })
          )}
        </div>
      </div>

      {hasNewMessages && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 px-4 py-2 bg-primary text-primary-foreground rounded-full shadow-lg flex items-center gap-2 hover:bg-primary/90 transition-colors z-10"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 14l-7 7m0 0l-7-7m7 7V3"
            />
          </svg>
          New messages
        </button>
      )}

      <ClaudeStatus
        status={claudeStatus}
        isLoading={isSending || isStreaming}
        onAbort={handleAbortSession}
        provider={
          activeConversation?.provider === 'openai'
            ? 'codex'
            : activeConversation?.provider === 'opencode'
              ? 'opencode'
              : 'claude'
        }
      />

      {openAskPanel && (
        <AskUserQuestionPanel
          questions={openAskPanel.questions}
          onSubmit={handleAskUserSubmit}
          onDismiss={handleDismissAskUserPanel}
        />
      )}

      <MessageInput
        input={input}
        setInput={setInput}
        handleSubmit={handleSubmit}
        isConnected={isConnected}
        isSending={isSending}
        isStreaming={isStreaming}
        selectedProject={selectedProject}
        permissionMode={permissionMode}
        onModeChange={handleModeChange}
        contextUsage={contextUsage}
        onContextClick={() => setShowContextModal(true)}
        slashCommands={slashCommands}
        showCommandMenu={showCommandMenu}
        onToggleCommandMenu={handleToggleCommandMenu}
        isUserScrolledUp={!isAtBottom}
        onScrollToBottom={scrollToBottom}
        onSlashDetected={handleSlashDetected}
        textareaRef={inputTextareaRef}
        selectedCommandIndex={selectedCommandIndex}
        filteredCommands={filteredCommands}
        onCommandSelect={handleCommandSelect}
        onCloseCommandMenu={handleCloseCommandMenu}
        isScrolling={isScrolling}
      />

      <CommandMenu
        commands={filteredCommands}
        selectedIndex={selectedCommandIndex}
        onSelect={handleCommandSelect}
        onClose={handleCloseCommandMenu}
        position={{
          top: inputTextareaRef.current
            ? Math.max(
                16,
                inputTextareaRef.current.getBoundingClientRect().top - 316,
              )
            : 0,
          left: inputTextareaRef.current
            ? inputTextareaRef.current.getBoundingClientRect().left
            : 16,
          bottom: inputTextareaRef.current
            ? window.innerHeight -
              inputTextareaRef.current.getBoundingClientRect().top +
              8
            : 90,
        }}
        isOpen={showCommandMenu && filteredCommands.length > 0}
      />

      <ContextDetailModal
        isOpen={showContextModal}
        onClose={() => setShowContextModal(false)}
        contextUsage={contextUsage}
      />
    </div>
  );
}

export default ChatInterface;
