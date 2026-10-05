// Request/response shapes for the conversation endpoints:
//  - /api/tasks/:taskId/conversations  (list, create-with-message)
//  - /api/conversations/:id*           (get, delete, patch, claude-id, context-usage, messages)

import type { ConversationRow } from '../types/db';
import type { Provider } from '../providers/types';
import type {
  SDKMessage,
  SDKControlGetContextUsageResponse,
} from '../sdk/transcript';
import type { PostMessageBody } from '../schemas/conversations';
import { expectType } from './_common';

// ---- Conversation list / get ---------------------------------------------

export type ListConversationsResponse = ConversationRow[];

// `GET /api/conversations/:id` — row + decorated `metadata` (token usage)
// when the conversation has a Claude session. `metadata: null` otherwise.
export interface ConversationTokenUsage {
  tokens: number;
  contextWindow: number;
  // Per-entry timestamp metadata may be present when the SDK has reported
  // usage; keep the snapshot loose (the route hands the underlying
  // `getSessionTokenUsage` result through verbatim).
  [key: string]: unknown;
}

export interface GetConversationResponse extends ConversationRow {
  metadata: { tokenUsage: ConversationTokenUsage } | null;
}

// ---- Create conversation -------------------------------------------------
//
// `POST /api/tasks/:taskId/conversations` is shared via `conversationHandlers.js`
// — when called WITHOUT `message`, it pre-creates a row and returns the
// `ConversationRow` (status 201). When called WITH `message`, it starts a
// Claude session and returns the row decorated with the live
// `claude_conversation_id`.

export interface CreateConversationRequest {
  // Empty/omitted = pre-create only (no LLM session).
  message?: string | undefined;
  // Custom cwd override; defaults to the project's repo_folder_path.
  projectPath?: string | undefined;
  // Defaults to 'bypassPermissions' server-side.
  permissionMode?: string | undefined;
  // Which backend runs the conversation. Always explicit — stamped on the row.
  provider: Provider;
  // Provider-specific model id (e.g. 'opus', 'gpt-6.1-sol', 'opencode/kimi-k2.7-code').
  model: string;
  // Explore-initiated conversation — attaches the in-process code-atlas MCP
  // server. Anthropic-only (zod-refined server-side).
  atlas?: boolean | undefined;
}

export type CreateConversationResponse = ConversationRow;

// ---- Update conversation -------------------------------------------------

export interface UpdateConversationRequest {
  // Pass `null` or `''` to clear the name back to NULL.
  name: string | null;
}

export type UpdateConversationResponse = ConversationRow;

export interface UpdateClaudeIdRequest {
  claudeConversationId: string;
}

export interface UpdateClaudeIdResponse {
  success: true;
}

export interface DeleteConversationResponse {
  success: true;
}

// ---- Context usage -------------------------------------------------------
//
// The persisted snapshot is the SDK's `query.getContextUsage()` response
// verbatim. Re-exported through `shared/sdk/transcript.ts` so callers
// don't have to depend on the SDK package directly.

export type GetContextUsageResponse = SDKControlGetContextUsageResponse;

// ---- Messages ------------------------------------------------------------
//
// The messages endpoint is polymorphic on the `limit` query parameter:
//   - `?limit=N` (any number) → paginated envelope.
//   - no `?limit`             → bare array (server treats `limit = null`).
//
// Both shapes are returned as JSON. Consumers should pass `limit` to make
// the response shape predictable.

export interface GetConversationMessagesQuery {
  limit?: number;
  offset?: number;
}

export interface PaginatedMessagesResponse {
  messages: SDKMessage[];
  total: number;
  hasMore: boolean;
  // Echoed when paginated; absent in the empty-no-claude-id branch.
  offset?: number;
  limit?: number;
}

export type GetConversationMessagesResponse =
  | PaginatedMessagesResponse
  | SDKMessage[];

// ---- Nested conversation detail (task-scoped) ----------------------------
//
// `GET /api/tasks/:taskId/conversations/:conversationId` — the conversation row
// plus its paginated message history. Mirrors the shape returned by
// `conversationContentStore.getSessionMessages` (always the paginated envelope
// here, never the bare-array form the legacy `?limit`-omitted route returns).

export interface GetTaskConversationResponse {
  conversation: ConversationRow;
  messages: SDKMessage[];
  total: number;
  hasMore: boolean;
}

// ---- Post message (task-scoped resume) -----------------------------------
//
// `POST /api/tasks/:taskId/conversations/:conversationId/messages` — bridges to
// the WS `claude-command` resume path. Asynchronous: the turn is fired
// fire-and-forget and the assistant's reply streams over WebSocket + persists
// to SQLite, so the caller polls the detail endpoint from `messages_before`.

// Request body — re-export of the zod-inferred type (the schema is the
// authoritative contract).
export type PostMessageRequest = PostMessageBody;

export interface PostMessageResponse {
  status: 'accepted';
  task_id: number;
  conversation_id: number;
  // The message count at accept time — the offset a poller reads new
  // messages from on the detail endpoint.
  messages_before: number;
}

// Returned `409` when a turn is already streaming for this conversation
// (mirrors the WS `conversation-busy` rejection).
export interface ConversationBusyResponse {
  error: string;
  code: 'CONVERSATION_BUSY';
  conversation_id: number;
}

// ---- Type-level smoke checks ---------------------------------------------

expectType<CreateConversationResponse>({} as ConversationRow);
expectType<GetConversationResponse['metadata']>(null);
