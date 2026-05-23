// Codex transcript mirror.
//
// Persists each `UnifiedMessage` emitted by `CodexProvider` into the
// same `messages` SQLite table the Anthropic path writes to via
// `sqliteSessionStore`. The frontend's existing
// `/api/conversations/:id/messages` reader fetches off that table — by
// mirroring Codex events into it, reloaded Codex conversations show
// their history exactly the same way Claude conversations do.
//
// We DELIBERATELY DON'T read from `~/.codex/sessions/*.jsonl` (D4):
// SQLite is the single source of truth, and the SDK's session JSONL
// files stay as private scratch (mirroring claudecodeui's pattern is
// rejected by the plan — they're single-tenant).

import { sqliteSessionStore } from '../../sqliteSessionStore.js';
import { resolveProjectKey } from '../../conversationContentStore.js';
import type { UnifiedMessage } from '@shared/providers/types';

interface MirrorContext {
  /** cwd / worktree path used when the Codex turn started — the SDK
   *  derives `projectKey` from this. */
  projectFolderPath: string;
  /** Codex thread id; equals the conversation's `provider_session_id`. */
  providerSessionId: string;
}

/**
 * Convert a `UnifiedMessage` into the on-disk entry shape that the
 * conversation reader consumes. Matches the structure
 * `conversationContentStore.getSessionMessages` expects (Claude's
 * SDKMessage on-the-wire shape: `{ type, uuid, message: { id, content,
 * usage? }, parent_tool_use_id?, ... }`). This lets the frontend
 * reload Codex conversations without any provider-specific reader.
 */
function unifiedToTranscriptEntry(unified: UnifiedMessage): {
  uuid: string;
  type: string;
  timestamp: string;
  [key: string]: unknown;
} | null {
  const timestamp = new Date().toISOString();

  switch (unified.type) {
    case 'user':
      return {
        uuid: unified.id,
        type: 'user',
        timestamp,
        message: { role: 'user', content: unified.content },
      };
    case 'assistant':
      return {
        uuid: unified.id,
        type: 'assistant',
        timestamp,
        parent_tool_use_id: unified.isSubAgent ? '__codex_subagent__' : null,
        message: {
          id: unified.id,
          role: 'assistant',
          model: unified.model ?? null,
          ...(unified.usage ? { usage: unified.usage } : {}),
          content: [{ type: 'text', text: unified.text }],
        },
      };
    case 'tool_use':
      return {
        uuid: `${unified.id}:tool_use`,
        type: 'assistant',
        timestamp,
        message: {
          id: unified.id,
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: unified.toolUseId,
              name: unified.toolName,
              input: unified.toolInput,
            },
          ],
        },
      };
    case 'tool_result':
      return {
        uuid: `${unified.id}:tool_result`,
        type: 'user',
        timestamp,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: unified.toolUseId,
              content: unified.content,
              ...(unified.isError ? { is_error: true } : {}),
            },
          ],
        },
      };
    case 'assistant_thinking':
      return {
        uuid: `${unified.id}:thinking`,
        type: 'assistant',
        timestamp,
        message: {
          id: unified.id,
          role: 'assistant',
          content: [{ type: 'thinking', thinking: unified.text }],
        },
      };
    case 'result':
      return {
        uuid: unified.id,
        type: 'result',
        timestamp,
        is_error: unified.isError,
        ...(unified.usage ? { usage: unified.usage } : {}),
        ...(unified.errors ? { errors: unified.errors } : {}),
      };
    case 'system':
      return {
        uuid: unified.id,
        type: 'system',
        timestamp,
        subtype: unified.subtype ?? 'codex',
      };
    case 'stream_delta':
      return null;
  }
}

/**
 * Append a single `UnifiedMessage` to the `messages` table under the
 * Codex thread id. Idempotent on `uuid` (sqliteSessionStore's `append`
 * upserts on `(project_key, session_id, subpath, uuid)`).
 */
export async function mirrorCodexEvent(
  ctx: MirrorContext,
  unified: UnifiedMessage,
): Promise<void> {
  const entry = unifiedToTranscriptEntry(unified);
  if (!entry) return;
  await sqliteSessionStore.append(
    {
      projectKey: resolveProjectKey(ctx.projectFolderPath),
      sessionId: ctx.providerSessionId,
      subpath: '',
      provider: 'openai',
    },
    [entry],
  );
}
