// Boundary types for the conversation lifecycle.

import type {
  BroadcastFn,
  BroadcastToTaskSubscribersFn,
  PermissionMode,
} from '@shared/websocket/messages';
import type { Provider } from '@shared/providers/types';

export type { BroadcastFn, BroadcastToTaskSubscribersFn, PermissionMode, Provider };

export interface ConversationImage {
  data: string;
  mimeType: string;
}

export interface VideoConfig {
  tempDir?: string | undefined;
  taskId?: number | undefined;
  recordingDestPath?: string | undefined;
  worktreePath?: string | undefined;
}

export interface AskUserQuestionToolResult {
  tool_use_id: string;
  content: unknown;
}

export interface ConversationOptions {
  broadcastFn?: BroadcastFn | undefined;
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
  userId?: number | undefined;
  permissionMode?: PermissionMode | undefined;
  customSystemPrompt?: string | undefined;
  conversationId?: number | undefined;
  images?: ConversationImage[] | undefined;
  /**
   * Provider to stamp on the new conversation row. The runtime path still
   * dispatches to Claude regardless of this value — full provider-aware
   * dispatch lands once the orchestrator goes through the provider
   * registry. Today this is purely a DB stamp + diagnostic.
   */
  provider?: Provider | undefined;
  /**
   * Model to run this turn on. Required in practice for `startConversation`
   * (the caller resolves it from the chosen settings); omitted on the WS
   * resume path, where `sendMessage` reads the stored model off the
   * conversation row. Never reaches a provider as undefined.
   */
  model?: string | undefined;
  effort?: string | null | undefined;
  disallowedTools?: string[] | undefined;
  askUserQuestionToolResult?: AskUserQuestionToolResult | undefined;
  videoConfig?: VideoConfig | null | undefined;
  /**
   * Internal: set when this call is the automatic single retry after a 401
   * subprocess-auth failure (see `retryOn401.ts`). External callers must not
   * set this — it exists only to prevent the retry from retrying itself.
   */
  isAuthRetry?: boolean | undefined;
}

export interface StreamingContext {
  conversationId: number;
  taskId?: number | null | undefined;
  claudeSessionId: string | null;
  userId?: number | undefined;
  broadcastFn?: BroadcastFn | undefined;
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
  isNewSession: boolean;
  broadcastClaudeStatus?: boolean | undefined;
  videoConfig?: VideoConfig | null | undefined;
}

export interface LifecycleHooks {
  onSessionId?: ((sessionId: string) => void | Promise<void>) | undefined;
  onAssistant?: ((query: unknown) => void) | undefined;
  onResult?: ((result: unknown) => Promise<void>) | undefined;
  onComplete?: ((err: Error | null) => Promise<void>) | undefined;
}
