// Request/response shapes for the conversation endpoints:
//  - /api/tasks/:taskId/conversations  (list, create-with-message)
//  - /api/conversations/:id*           (get, delete, patch, claude-id, context-usage, messages)

import type { ConversationRow } from '../types/db';
import type { Provider } from '../providers/types';
import type {
  SDKMessage,
  SDKControlGetContextUsageResponse,
} from '../sdk/transcript';
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
  // Provider-specific model id (e.g. 'opus', 'gpt-5.5', 'opencode/kimi-k2.6').
  model: string;
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

// ---- Type-level smoke checks ---------------------------------------------

expectType<CreateConversationResponse>({} as ConversationRow);
expectType<GetConversationResponse['metadata']>(null);
