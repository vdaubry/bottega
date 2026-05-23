/**
 * Conversation content storage abstraction.
 *
 * All transcript reads route through SqliteSessionStore. The SDK still writes
 * its own JSONL copies under CLAUDE_CONFIG_DIR for its private resume path,
 * but our app never reads those files — the only place left in this codebase
 * that knows JSONL exists is `scripts/data-migrations/import-jsonl-to-sqlite.js`.
 *
 * `userId` is accepted in signatures for backward compatibility with callers
 * but is no longer load-bearing: SQLite is shared across all users of a
 * project, which is the whole point of the move (any project member can read
 * any conversation in that project).
 */

import { sqliteSessionStore, SqliteSessionStore } from './sqliteSessionStore.js';
import type { ThinkingAccumulator } from './conversation/thinkingPatcher.js';

interface TranscriptEntry {
  uuid?: string;
  type?: string;
  timestamp?: string | number;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  message?: {
    id?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  [key: string]: unknown;
}

interface ConversationLike {
  claude_conversation_id?: string | null;
  session_path?: string | null;
}

export interface PaginatedMessagesResult {
  messages: TranscriptEntry[];
  total: number;
  hasMore: boolean;
  offset?: number;
  limit?: number | null;
}

export interface TokenUsage {
  tokens: number;
  contextUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  contextWindow: number;
}

/**
 * Compute the canonical projectKey for a filesystem path. Mirrors the SDK's
 * default `projectKey` derivation (sanitized cwd) so the keys we read with
 * match the keys the SDK wrote with.
 *
 * The SDK replaces every non-alphanumeric character with `-` (see f1() in
 * @anthropic-ai/claude-agent-sdk: `path.replace(/[^a-zA-Z0-9]/g, '-')`),
 * which collapses underscores, hyphens-of-other-codepoints, and any other
 * separator to `-`. Earlier versions of this helper only replaced `/` and
 * `.`, so paths containing `_` (e.g. `/home/ubuntu/misc/hello_world`) were
 * keyed differently on read vs write — messages appeared to vanish.
 */
export function resolveProjectKey(projectFolderPath: string | null | undefined): string {
  if (!projectFolderPath) return '';
  return projectFolderPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Remove every message row and summary belonging to a conversation. Called
 * from delete routes so the messages table doesn't keep orphaned rows after a
 * task / conversation is gone. Prefers the conversation's `session_path` (the
 * cwd we passed the SDK at session start, which may be a worktree path); falls
 * back to the project's repo folder when older rows have a null session_path.
 */
export async function purgeConversationMessages(
  conversation: ConversationLike | null | undefined,
  fallbackRepoPath: string | null | undefined,
  store: SqliteSessionStore = sqliteSessionStore,
): Promise<void> {
  if (!conversation?.claude_conversation_id) return;
  const pathForKey = conversation.session_path || fallbackRepoPath;
  if (!pathForKey) return;
  await store.purgeSession({
    projectKey: resolveProjectKey(pathForKey),
    sessionId: conversation.claude_conversation_id,
  });
}

function isTaskNotification(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user') return false;
  const content = entry.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content) &&
          (content[0] as { type?: string; text?: string })?.type === 'text'
        ? ((content[0] as { type?: string; text?: string }).text ?? '')
        : '';
  return typeof text === 'string' && text.startsWith('<task-notification>');
}

function emptyMessagesResult(
  limit: number | null,
): TranscriptEntry[] | PaginatedMessagesResult {
  return limit === null ? [] : { messages: [], total: 0, hasMore: false };
}

export interface GetConversationContentOptions {
  claudeSessionId: string;
  projectFolderPath: string;
  limit?: number | null;
  offset?: number;
}

export interface PatchThinkingOptions {
  claudeSessionId: string;
  projectFolderPath: string;
  accumulator: ThinkingAccumulator | null | undefined;
}

export class ConversationContentStore {
  store: SqliteSessionStore;

  constructor({ store = sqliteSessionStore }: { store?: SqliteSessionStore } = {}) {
    this.store = store;
  }

  async loadEntries(
    claudeSessionId: string | null | undefined,
    projectFolderPath: string | null | undefined,
  ): Promise<TranscriptEntry[] | null> {
    if (!claudeSessionId || !projectFolderPath) return null;
    const projectKey = resolveProjectKey(projectFolderPath);
    return this.store.load({ projectKey, sessionId: claudeSessionId });
  }

  paginateEntries(
    entries: TranscriptEntry[],
    limit: number | null,
    offset: number,
  ): TranscriptEntry[] | PaginatedMessagesResult {
    const sortedMessages = entries
      .slice()
      .sort(
        (a, b) =>
          new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
      );
    const total = sortedMessages.length;

    if (limit === null) {
      return sortedMessages;
    }

    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = sortedMessages.slice(startIndex, endIndex);

    return {
      messages: paginatedMessages,
      total,
      hasMore: startIndex > 0,
      offset,
      limit,
    };
  }

  async getSessionMessages(
    claudeSessionId: string | null | undefined,
    projectFolderPath: string | null | undefined,
    limit: number | null = null,
    offset: number = 0,
    _options: { userId?: number } = {},
  ): Promise<TranscriptEntry[] | PaginatedMessagesResult> {
    try {
      const entries = await this.loadEntries(claudeSessionId, projectFolderPath);
      if (!entries) return emptyMessagesResult(limit);

      const filtered = entries.filter((entry) => {
        if (entry.type === 'queue-operation') return false;
        if (isTaskNotification(entry)) return false;
        return true;
      });

      return this.paginateEntries(filtered, limit, offset);
    } catch (error) {
      console.error(`Error reading messages for session ${claudeSessionId}:`, error);
      return emptyMessagesResult(limit);
    }
  }

  async getSessionTokenUsage(
    claudeSessionId: string | null | undefined,
    projectFolderPath: string | null | undefined,
    _options: { userId?: number } = {},
  ): Promise<TokenUsage> {
    try {
      const entries = await this.loadEntries(claudeSessionId, projectFolderPath);
      if (!entries) return { tokens: 0, contextWindow: 1000000 };

      const usageEntries = entries.filter(
        (entry) =>
          entry.message?.usage &&
          entry.isSidechain !== true &&
          entry.isApiErrorMessage !== true &&
          entry.timestamp,
      );

      if (usageEntries.length === 0) {
        return { tokens: 0, contextWindow: 1000000 };
      }

      usageEntries.sort(
        (a, b) =>
          new Date(b.timestamp as string | number).getTime() -
          new Date(a.timestamp as string | number).getTime(),
      );
      const usage = usageEntries[0]!.message!.usage!;
      const inputTokens = usage.input_tokens || 0;
      const cacheReadTokens = usage.cache_read_input_tokens || 0;
      const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const contextUsed = inputTokens + cacheReadTokens + cacheCreationTokens;

      return {
        tokens: contextUsed,
        contextUsed,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        contextWindow: 1000000,
      };
    } catch (error) {
      console.error(`Error extracting token usage for session ${claudeSessionId}:`, error);
      return { tokens: 0, contextWindow: 1000000 };
    }
  }

  async getLastContextTokens({
    claudeSessionId,
    projectFolderPath,
  }: {
    claudeSessionId: string;
    projectFolderPath: string;
  }): Promise<number> {
    const usage = await this.getSessionTokenUsage(claudeSessionId, projectFolderPath);
    return usage.contextUsed || usage.tokens || 0;
  }

  async getConversationContent({
    claudeSessionId,
    projectFolderPath,
    limit = null,
    offset = 0,
  }: GetConversationContentOptions): Promise<
    PaginatedMessagesResult & { rawEntries: TranscriptEntry[]; source: { type: string } | null }
  > {
    const entries = await this.loadEntries(claudeSessionId, projectFolderPath);
    if (!entries) {
      const empty = emptyMessagesResult(limit);
      const base = Array.isArray(empty)
        ? { messages: empty, total: 0, hasMore: false }
        : empty;
      return {
        ...base,
        rawEntries: [],
        source: null,
      };
    }

    const filtered = entries.filter(
      (entry) => entry.type !== 'queue-operation' && !isTaskNotification(entry),
    );
    const messagesResult = this.paginateEntries(filtered, limit, offset);

    const base = Array.isArray(messagesResult)
      ? { messages: messagesResult, total: messagesResult.length, hasMore: false }
      : messagesResult;

    return {
      ...base,
      rawEntries: entries,
      source: { type: 'sqlite' },
    };
  }

  /**
   * Patch in plaintext thinking text on assistant entries that were appended
   * with empty `thinking` blocks (the SDK strips the plaintext from final
   * assistant messages and only delivers it via stream_event partials).
   *
   * Re-appending with the same uuid upserts the entry_json — append() is
   * idempotent on uuid, so this safely overwrites the prior row.
   */
  async patchThinking({
    claudeSessionId,
    projectFolderPath,
    accumulator,
  }: PatchThinkingOptions): Promise<boolean> {
    if (!claudeSessionId || !projectFolderPath || !accumulator?.hasContent()) {
      return false;
    }

    const projectKey = resolveProjectKey(projectFolderPath);
    const key = { projectKey, sessionId: claudeSessionId };
    const entries = await this.store.load(key);
    if (!entries || entries.length === 0) return false;

    interface AssistantMessage {
      id?: string;
      content?: unknown;
      [k: string]: unknown;
    }

    const modifiedEntries: TranscriptEntry[] = [];
    for (const entry of entries) {
      if (entry.type !== 'assistant') continue;
      const message = entry.message as AssistantMessage | undefined;
      const messageId = message?.id;
      if (!messageId) continue;
      const blocks = accumulator.get(messageId);
      if (!blocks?.size) continue;
      const content = message?.content;
      if (!Array.isArray(content)) continue;

      let entryModified = false;
      const patchedContent = content.map((block: { type?: string; thinking?: string; [k: string]: unknown }, idx: number) => {
        if (block?.type === 'thinking' && !block.thinking) {
          const text = blocks.get(idx);
          if (text) {
            entryModified = true;
            return { ...block, thinking: text };
          }
        }
        return block;
      });

      if (entryModified) {
        modifiedEntries.push({
          ...entry,
          message: { ...message, content: patchedContent },
        });
      }
    }

    if (modifiedEntries.length === 0) return false;

    await this.store.append(key, modifiedEntries);
    return true;
  }
}

export const conversationContentStore = new ConversationContentStore();
