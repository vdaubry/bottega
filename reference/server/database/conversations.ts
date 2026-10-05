// CONVERSATION RUNTIME (infrastructure): the owner-less `conversations` table
// and its two ownership link tables. The base row carries no foreign key to
// either domain — `owner_kind` is a dispatch tag, and the owner id lives in
// `task_conversations` / `epic_conversations`, each of which references THIS
// table (the domains point at the infrastructure, never the reverse).
//
// The query layer derives `task_id` / `epic_id` onto every returned row via
// LEFT JOINs, so ConversationRow keeps the shape every consumer (routes, WS
// dispatch, injection, frontend) already reads — exactly one of the two is
// non-null, matching owner_kind.
//
// Deleting a conversation removes the base row (links cascade). Deleting an
// owner cascades the LINK only: the owning domain's delete service removes
// the base rows itself (explicit-delete semantics, architecture-v2 step 5).

import { db, lastInsertId } from './connection.js';
import { tasksDb } from './tasks.js';
import type { ConversationRow, Provider } from '../../shared/types/db.js';

export interface CreatedConversation {
  id: number;
  // Exactly one of task_id / epic_id is set, mirroring owner_kind.
  task_id: number | null;
  epic_id: number | null;
  claude_conversation_id: string | null;
  provider: Provider;
  provider_session_id: string | null;
  model: string;
  effort: string | null;
}

const SELECT_WITH_OWNER = `
  SELECT c.*, tc.task_id AS task_id, ec.epic_id AS epic_id
  FROM conversations c
  LEFT JOIN task_conversations tc ON tc.conversation_id = c.id
  LEFT JOIN epic_conversations ec ON ec.conversation_id = c.id`;

const conversationsDb = {
  // Every conversation is stamped with the exact (provider, model, effort) it
  // runs. `model` is required so resume is deterministic; `effort` is null when
  // the provider has none (OpenCode) or the caller didn't pick one (manual).
  create: (
    taskId: number,
    provider: Provider,
    model: string,
    effort: string | null,
  ): CreatedConversation => {
    // The backstop for "no conversation before the worktree is ready": every
    // task conversation — REST, agent runs, every provider, Explore — is born
    // here. Entry points check earlier, before their own side effects; this
    // makes forgetting to check impossible.
    tasksDb.assertWorktreeReady(taskId);
    const insert = db.transaction((): number => {
      const result = db
        .prepare(
          `INSERT INTO conversations (owner_kind, provider, model, effort) VALUES ('task', ?, ?, ?)`,
        )
        .run(provider, model, effort);
      const id = lastInsertId(result.lastInsertRowid);
      db.prepare('INSERT INTO task_conversations (conversation_id, task_id) VALUES (?, ?)').run(
        id,
        taskId,
      );
      return id;
    });
    return {
      id: insert(),
      task_id: taskId,
      epic_id: null,
      claude_conversation_id: null,
      provider,
      provider_session_id: null,
      model,
      effort,
    };
  },

  // Epic-scoped counterpart of `create`. Epic conversations back the stages of
  // the epic pipeline; everything downstream is conversation-keyed and behaves
  // exactly as it does for a task conversation.
  createForEpic: (
    epicId: number,
    provider: Provider,
    model: string,
    effort: string | null,
  ): CreatedConversation => {
    const insert = db.transaction((): number => {
      const result = db
        .prepare(
          `INSERT INTO conversations (owner_kind, provider, model, effort) VALUES ('epic', ?, ?, ?)`,
        )
        .run(provider, model, effort);
      const id = lastInsertId(result.lastInsertRowid);
      db.prepare('INSERT INTO epic_conversations (conversation_id, epic_id) VALUES (?, ?)').run(
        id,
        epicId,
      );
      return id;
    });
    return {
      id: insert(),
      task_id: null,
      epic_id: epicId,
      claude_conversation_id: null,
      provider,
      provider_session_id: null,
      model,
      effort,
    };
  },

  getByTask: (taskId: number): ConversationRow[] => {
    return db
      .prepare(`${SELECT_WITH_OWNER} WHERE tc.task_id = ? ORDER BY c.created_at DESC`)
      .all(taskId) as ConversationRow[];
  },

  getByEpic: (epicId: number): ConversationRow[] => {
    return db
      .prepare(`${SELECT_WITH_OWNER} WHERE ec.epic_id = ? ORDER BY c.created_at DESC`)
      .all(epicId) as ConversationRow[];
  },

  getById: (id: number): ConversationRow | undefined => {
    return db
      .prepare(`${SELECT_WITH_OWNER} WHERE c.id = ?`)
      .get(id) as ConversationRow | undefined;
  },

  findByClaudeSessionId: (sessionId: string): ConversationRow | undefined => {
    return db
      .prepare(`${SELECT_WITH_OWNER} WHERE c.claude_conversation_id = ? LIMIT 1`)
      .get(sessionId) as ConversationRow | undefined;
  },

  updateClaudeId: (id: number, claudeConversationId: string | null): boolean => {
    const result = db
      .prepare('UPDATE conversations SET claude_conversation_id = ? WHERE id = ?')
      .run(claudeConversationId, id);
    return result.changes > 0;
  },

  // Provider-agnostic session id (Claude session id / Codex thread id).
  // Anthropic rows duplicate it from claude_conversation_id; Codex rows
  // are the only ones that depend on this column at runtime.
  updateProviderSessionId: (id: number, providerSessionId: string | null): boolean => {
    const result = db
      .prepare('UPDATE conversations SET provider_session_id = ? WHERE id = ?')
      .run(providerSessionId, id);
    return result.changes > 0;
  },

  // Re-stamp the (model, effort) a conversation runs on. Used on resume when
  // the resuming user's per-user agent settings override the original model
  // within the same provider, so the row stays authoritative for later turns.
  updateModelEffort: (id: number, model: string | null, effort: string | null): boolean => {
    const result = db
      .prepare('UPDATE conversations SET model = ?, effort = ? WHERE id = ?')
      .run(model, effort, id);
    return result.changes > 0;
  },

  updateSessionPath: (id: number, sessionPath: string | null): boolean => {
    const result = db
      .prepare('UPDATE conversations SET session_path = ? WHERE id = ?')
      .run(sessionPath, id);
    return result.changes > 0;
  },

  updateName: (id: number, name: string | null): boolean => {
    const result = db
      .prepare('UPDATE conversations SET name = ? WHERE id = ?')
      .run(name, id);
    return result.changes > 0;
  },

  updateContextUsage: (id: number, snapshot: unknown): boolean => {
    const json = snapshot == null ? null : JSON.stringify(snapshot);
    const result = db
      .prepare('UPDATE conversations SET context_usage_json = ? WHERE id = ?')
      .run(json, id);
    return result.changes > 0;
  },

  getContextUsage: (id: number): unknown => {
    const row = db
      .prepare('SELECT context_usage_json FROM conversations WHERE id = ?')
      .get(id) as Pick<ConversationRow, 'context_usage_json'> | undefined;
    if (!row || !row.context_usage_json) return null;
    try {
      return JSON.parse(row.context_usage_json);
    } catch {
      return null;
    }
  },

  delete: (id: number): boolean => {
    const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return result.changes > 0;
  },

  // Flag a conversation as Explore-initiated: resume reads this off the row to
  // re-inject the in-process code-atlas MCP server (same source-of-truth rule
  // as provider/model/effort).
  setAtlasEnabled: (id: number): boolean => {
    const result = db
      .prepare('UPDATE conversations SET atlas_enabled = 1 WHERE id = ?')
      .run(id);
    return result.changes > 0;
  },
};

export { conversationsDb };
