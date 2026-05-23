// Shared WebSocket message contract between the React frontend and the
// Node/Express backend. Single source of truth — every WS message that flows
// between the two halves of the app is enumerated here as a discriminated
// union keyed on `type`.
//
// Wire format is flat: WebSocketContext serialises `sendMessage(type, data)`
// as `JSON.stringify({ type, ...data })`. Each union variant therefore lists
// the entire on-wire payload (the discriminant `type` plus the rest as
// sibling fields, not nested under `data`). The `data` field that does
// appear on `claude-response` / `claude-status` / `context-usage` is part of
// those messages' payloads and is unrelated to the wrapper.
//
// The frontend `WebSocketContext.tsx` consumes these unions to give
// `sendMessage`/`subscribe` typed overloads. The backend (`server/index.js`
// + WS-aware service modules) imports them via JSDoc `@typedef` from this
// file and stays as `.js` for now — TypeScript runs as a checker only
// (`tsc --noEmit`), there is no compile step.

// ---- Domain primitives ----

export type ConversationId = number;
export type TaskId = number;
export type AgentRunId = number;
export type ClaudeSessionId = string;

export type AgentType =
  | 'planification'
  | 'implementation'
  | 'review'
  | 'refinement'
  | 'pr'
  | 'yolo';

export type AgentRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked';

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions';

export interface ConversationSummary {
  id: ConversationId;
  task_id: TaskId;
  claude_conversation_id: ClaudeSessionId | null;
  created_at: string;
  name?: string;
}

export interface AgentRunSummary {
  id: AgentRunId;
  status: AgentRunStatus;
  agent_type: AgentType;
  conversation_id: ConversationId | null;
}

export interface ClaudeStatusPayload {
  tokens: number;
  text: string;
  can_interrupt: boolean;
}

export interface ClaudeCommandOptions {
  projectPath?: string | undefined;
  cwd?: string | undefined;
  sessionId?: ClaudeSessionId | null | undefined;
  resume?: boolean | ClaudeSessionId | undefined;
  permissionMode?: PermissionMode | undefined;
  conversationId?: ConversationId | undefined;
  images?: Array<{ data: string; mimeType: string }> | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  disallowedTools?: string[] | undefined;
}

// ---- Client → Server messages ----

export type ClientToServerMessage =
  | {
      type: 'claude-command';
      command: string;
      options: ClaudeCommandOptions;
    }
  | {
      type: 'abort-session';
      sessionId: ClaudeSessionId;
      provider?: string;
    }
  | {
      type: 'ask-user-question-answer';
      conversationId: ConversationId;
      toolUseId: string;
      answers: Record<string, string>;
    }
  | {
      type: 'check-session-status';
      sessionId: ClaudeSessionId;
    }
  | {
      type: 'get-active-sessions';
    }
  | {
      type: 'subscribe-task';
      taskId: TaskId;
    }
  | {
      type: 'unsubscribe-task';
      taskId: TaskId;
    }
  | {
      type: 'subscribe-conversation';
      conversationId: ConversationId;
    }
  | {
      type: 'unsubscribe-conversation';
      conversationId: ConversationId;
    };

// ---- Server → Client messages ----
//
// SDK transcript payloads narrow off the discriminated union re-exported
// from `shared/sdk/transcript.ts`. Bumping the SDK version surfaces
// added/removed `SDKMessage` variants as compile errors at every consumer.

import type { SDKMessage } from '../sdk/transcript.js';
import type { Provider } from '../providers/types.js';

export type ServerToClientMessage =
  // ---- Streaming pipeline ----
  //
  // Two parallel variants for one release: `claude-response` carries the
  // raw Claude SDK message (legacy clients); `ai-response` carries the
  // same payload alongside a `provider` tag so cross-provider clients can
  // route per backend. The server dual-emits during Phases 5-13; after
  // Phase 13 ships the cleanup PR drops `claude-response`.
  | {
      type: 'claude-response';
      data: SDKMessage;
    }
  | {
      type: 'ai-response';
      data: SDKMessage;
      provider: Provider;
    }
  | {
      type: 'claude-status';
      data: ClaudeStatusPayload;
    }
  | {
      type: 'claude-complete';
      sessionId: ClaudeSessionId | null;
      exitCode: number;
      isNewSession: boolean;
    }
  | {
      type: 'claude-error';
      error: string;
    }
  | {
      // Rejection of a `claude-command` because a turn is already in flight
      // for this conversation (one conversation = one process). Sent only to
      // the socket that issued the command — never broadcast. Distinct from
      // `claude-error` because the client must NOT tear down streaming state
      // (a turn is genuinely running); instead it surfaces the error and
      // flips the composer into the streaming state. See dispatch.ts.
      type: 'conversation-busy';
      conversationId: ConversationId;
      error: string;
    }
  | {
      type: 'session-created';
      sessionId: ClaudeSessionId;
    }
  | {
      type: 'streaming-started';
      conversationId: ConversationId;
      claudeSessionId?: ClaudeSessionId;
      taskId?: TaskId;
    }
  | {
      type: 'streaming-ended';
      conversationId: ConversationId;
      taskId?: TaskId;
    }
  // ---- Conversation lifecycle ----
  | {
      type: 'conversation-created';
      conversationId: ConversationId;
      claudeSessionId: ClaudeSessionId;
    }
  | {
      type: 'conversation-added';
      conversation: ConversationSummary;
      taskId: TaskId;
    }
  | {
      type: 'conversation-name-updated';
      conversationId: ConversationId;
      taskId: TaskId;
      name: string;
    }
  // ---- Agent runs (task-scoped) ----
  | {
      type: 'agent-run-updated';
      agentRun: AgentRunSummary;
      taskId: TaskId;
    }
  | {
      type: 'task-blocked';
      taskId: TaskId;
      reason: string;
    }
  // ---- Context usage ----
  //
  // `data` is intentionally `unknown` here. The server emits a hybrid shape
  // (baseline-from-`result.modelUsage` ∪ live-`getContextUsage()` breakdown
  // when the control-channel race wins) that doesn't strictly match the SDK
  // type. Consumers narrow per-field.
  | {
      type: 'context-usage';
      data: unknown;
    }
  // ---- AskUserQuestion ----
  | {
      type: 'awaiting-user-answer';
      conversationId: ConversationId;
      toolUseId: string | null;
      questions: unknown[];
    }
  | {
      type: 'ask-user-question-error';
      conversationId: ConversationId | undefined;
      error: string;
    }
  | {
      type: 'ask-user-question-resolved';
      conversationId: ConversationId;
      kind: string;
    }
  // ---- Subscription acks ----
  | {
      type: 'task-subscribed';
      taskId: TaskId;
      success: true;
    }
  | {
      type: 'task-unsubscribed';
      taskId: TaskId;
      success: true;
    }
  | {
      type: 'conversation-subscribed';
      conversationId: ConversationId;
      success: true;
    }
  | {
      type: 'conversation-unsubscribed';
      conversationId: ConversationId;
      success: true;
    }
  // ---- Session status ----
  | {
      type: 'session-status';
      sessionId: ClaudeSessionId;
      isProcessing: boolean;
    }
  | {
      type: 'active-sessions';
      sessions: { claude: ClaudeSessionId[] };
    }
  | {
      type: 'session-aborted';
      sessionId: ClaudeSessionId;
      success: boolean;
    }
  // ---- Generic error ----
  | {
      type: 'error';
      error: string;
    };

// ---- Helper extractors ----

export type ServerMessageType = ServerToClientMessage['type'];
export type ClientMessageType = ClientToServerMessage['type'];

export type ServerMessageOf<T extends ServerMessageType> = Extract<
  ServerToClientMessage,
  { type: T }
>;
export type ClientMessageOf<T extends ClientMessageType> = Extract<
  ClientToServerMessage,
  { type: T }
>;

// Distributive Omit — preserves the discriminated-union shape when stripping
// a key. Plain `Omit<U, K>` collapses unions to their shared keys.
type DistributiveOmit<U, K extends PropertyKey> = U extends unknown
  ? Omit<U, K>
  : never;

// What `broadcastToTaskSubscribers(taskId, message)` accepts: any
// server-to-client message, with the `taskId` discriminant stripped (the
// helper splices it in itself). Used by genuinely task-scoped messages
// (`agent-run-updated`, `task-blocked`, `conversation-added`,
// `conversation-name-updated`) AND by the task-channel half of dual-emit
// events (`streaming-started`, `streaming-ended`) whose payload carries
// `taskId` as optional.
export type TaskScopedBroadcastPayload = DistributiveOmit<
  ServerToClientMessage,
  'taskId'
>;

// Convenience alias for the curried per-conversation broadcast helper that
// the conversation lifecycle passes around as `broadcastFn`.
export type BroadcastFn = (
  conversationId: ConversationId,
  message: ServerToClientMessage,
) => void;

export type BroadcastToTaskSubscribersFn = (
  taskId: TaskId,
  message: TaskScopedBroadcastPayload,
) => void;

// Fans a message out to every WebSocket that has subscribed to this
// conversation id. The channel key is the function argument — the message
// payload does NOT need to carry `conversationId` (most streaming payloads
// like `claude-response`/`claude-status` don't), so the message type is the
// full server-to-client union.
export type BroadcastToConversationSubscribersFn = (
  conversationId: ConversationId,
  message: ServerToClientMessage,
) => void;
