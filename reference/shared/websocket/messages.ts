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
export type EpicId = number;
export type ClaudeSessionId = string;

export type AgentType =
  | 'planification'
  | 'implementation'
  | 'review'
  | 'refinement'
  | 'pr'
  | 'yolo';

// The epic pipeline's agent types. Stored in the same `task_agent_runs` table
// as the task types, hence carried by the same `agent-run-updated` message —
// but kept a separate union so task-only consumers stay exhaustive.
export type EpicAgentType =
  | 'epic-architecture'
  | 'epic-specification'
  | 'epic-stories'
  | 'epic-spec-review'
  | 'epic-orchestrator'
  | 'epic-pr-review'
  | 'epic-delivery'
  | 'epic-qa-scenarios'
  | 'epic-qa-execution'
  | 'epic-qa-fix';

export type AnyAgentType = AgentType | EpicAgentType;

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

// Exactly one of `task_id` / `epic_id` is set — a conversation belongs to a
// task or to an epic (see the DB CHECK on `conversations`).
export interface ConversationSummary {
  id: ConversationId;
  task_id: TaskId | null;
  epic_id?: EpicId | null;
  claude_conversation_id: ClaudeSessionId | null;
  created_at: string;
  name?: string;
}

export interface AgentRunSummary {
  id: AgentRunId;
  status: AgentRunStatus;
  agent_type: AnyAgentType;
  conversation_id: ConversationId | null;
}

// What changes about an epic between runs: its container status and the stage
// flags. Carried by `epic-updated`, which the `mark_stage_complete` MCP tool
// emits when an agent signs a stage off (0/1 mirrors the SQLite columns).
export interface EpicSummary {
  id: EpicId;
  status: string;
  architecture_complete: 0 | 1;
  specs_complete: 0 | 1;
  stories_complete: 0 | 1;
  review_complete: 0 | 1;
  qa_complete: 0 | 1;
  // Orchestration state (Phase 7). Carried on the same message because every
  // producer of one is a producer of the other: starting, pausing, blocking and
  // finishing orchestration all change the row the epic page renders.
  orchestration_active: 0 | 1;
  orchestration_blocked: 0 | 1;
  orchestration_blocked_reason: string | null;
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
    }
  // ---- Explore (code-atlas) channel ----
  //
  // The Explore view subscribes per task to receive agent-driven UI commands
  // (atlas-open-file / atlas-highlight / atlas-render-artifact). Each command
  // carries a `requestId`; the view applies it and answers with `atlas-ack`
  // so the MCP tool result reflects what the user actually saw (mirrors the
  // CodeAtlas UiBridge ack protocol).
  | {
      type: 'subscribe-atlas';
      taskId: TaskId;
    }
  | {
      type: 'unsubscribe-atlas';
      taskId: TaskId;
    }
  | {
      // `error` set ⇒ the command failed client-side. `detail` carries a short
      // JSON ack payload (e.g. `{ ok: true }` for atlas-render-artifact).
      type: 'atlas-ack';
      taskId: TaskId;
      requestId: string;
      error?: string;
      detail?: string;
    }
  // ---- Epic channel ----
  //
  // Epic pages subscribe per epic for the same class of events the task
  // channel carries for tasks: agent-run status, conversation lifecycle,
  // streaming start/end. Epic *transcripts* still flow on the conversation
  // channel — an epic conversation is a normal conversation.
  | {
      type: 'subscribe-epic';
      epicId: EpicId;
    }
  | {
      type: 'unsubscribe-epic';
      epicId: EpicId;
    };

// ---- Server → Client messages ----
//
// SDK transcript payloads narrow off the discriminated union re-exported
// from `shared/sdk/transcript.ts`. Bumping the SDK version surfaces
// added/removed `SDKMessage` variants as compile errors at every consumer.

import type { SDKMessage } from '../sdk/transcript.js';
import type { Provider } from '../providers/types.js';
import type { TaskWorktreeState } from '../types/db.js';
import type { ArtifactKind, HighlightColor, HighlightRange } from '../types/atlas.js';

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
      epicId?: EpicId;
    }
  | {
      type: 'streaming-ended';
      conversationId: ConversationId;
      taskId?: TaskId;
      epicId?: EpicId;
    }
  // ---- Conversation lifecycle ----
  | {
      type: 'conversation-created';
      conversationId: ConversationId;
      claudeSessionId: ClaudeSessionId;
    }
  // Emitted on the owning channel: `taskId` for task conversations, `epicId`
  // for epic ones (the broadcaster splices its own key in).
  | {
      type: 'conversation-added';
      conversation: ConversationSummary;
      taskId?: TaskId;
      epicId?: EpicId;
    }
  | {
      type: 'conversation-name-updated';
      conversationId: ConversationId;
      taskId?: TaskId;
      epicId?: EpicId;
      name: string;
    }
  // ---- Agent runs (task- or epic-scoped) ----
  | {
      type: 'agent-run-updated';
      agentRun: AgentRunSummary;
      taskId?: TaskId;
      epicId?: EpicId;
    }
  | {
      type: 'task-blocked';
      taskId: TaskId;
      reason: string;
    }
  // The task's background worktree setup moved: started (a retry), finished,
  // or failed. Conversations can start only once it says 'ready'.
  | {
      type: 'task-worktree-updated';
      taskId: TaskId;
      worktreeState: TaskWorktreeState;
      worktreeError: string | null;
    }
  // ---- Epics ----
  //
  // The epic's own row changed (a stage was signed off). Emitted on the epic
  // channel by the `mark_stage_complete` MCP tool; the epic page refreshes on
  // it the way a task page refreshes on `agent-run-updated`.
  | {
      type: 'epic-updated';
      epicId: EpicId;
      epic: EpicSummary;
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
      questionId?: string;
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
  | {
      type: 'atlas-subscribed';
      taskId: TaskId;
      success: true;
    }
  | {
      type: 'atlas-unsubscribed';
      taskId: TaskId;
      success: true;
    }
  | {
      type: 'epic-subscribed';
      epicId: EpicId;
      success: true;
    }
  | {
      type: 'epic-unsubscribed';
      epicId: EpicId;
      success: true;
    }
  // ---- Explore (code-atlas) UI commands ----
  //
  // Pushed by the in-process code-atlas MCP tools to atlas subscribers of a
  // task. File content travels with the event (≤2MB, already validated by the
  // tool) so the view never re-fetches what the agent just referenced.
  | {
      type: 'atlas-open-file';
      taskId: TaskId;
      requestId: string;
      path: string;
      content: string;
      line?: number;
    }
  | {
      type: 'atlas-highlight';
      taskId: TaskId;
      requestId: string;
      path: string;
      content: string;
      ranges: HighlightRange[];
      color: HighlightColor;
    }
  | {
      // A freshly generated self-contained HTML artifact. The view assigns
      // `html` to a sandboxed iframe's srcdoc and acks once it has mounted.
      type: 'atlas-render-artifact';
      taskId: TaskId;
      requestId: string;
      kind: ArtifactKind;
      title?: string;
      html: string;
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

// What `broadcastToEpicSubscribers(epicId, message)` accepts: any
// server-to-client message with the `epicId` discriminant stripped (the helper
// splices it in itself, mirroring the task-channel broadcaster). Used by
// `agent-run-updated`, `conversation-added`, `conversation-name-updated` and
// the epic half of the dual-emitted streaming events.
export type EpicScopedBroadcastPayload = DistributiveOmit<
  ServerToClientMessage,
  'epicId'
>;

export type BroadcastToEpicSubscribersFn = (
  epicId: EpicId,
  message: EpicScopedBroadcastPayload,
) => void;
