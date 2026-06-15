// OpenCode transcript mirror.
//
// Persists each `UnifiedMessage` emitted by `OpenCodeProvider` into the
// same `messages` SQLite table the Anthropic and Codex paths write to
// via `sqliteSessionStore`. The frontend's existing
// `/api/conversations/:id/messages` reader fetches off that table — so
// reloaded OpenCode conversations show their history exactly the same
// way Claude and Codex conversations do.
//
// SQLite is the single source of truth (D3); OpenCode persists its own
// copy under XDG_DATA_HOME but the runtime deliberately does not read
// it. Mirror writes are idempotent on `uuid` because
// `sqliteSessionStore.append` upserts on `(project_key, session_id,
// subpath, uuid)`.

import { sqliteSessionStore } from '../../sqliteSessionStore.js';
import { resolveProjectKey } from '../../conversationContentStore.js';
import type { UnifiedMessage } from '@shared/providers/types';

interface MirrorContext {
  /** cwd / worktree path used when the OpenCode turn started — the
   * sessionStore derives `projectKey` from this. */
  projectFolderPath: string;
  /** OpenCode session id; equals the conversation's `provider_session_id`. */
  providerSessionId: string;
}

/**
 * Convert a `UnifiedMessage` into the on-disk entry shape that the
 * conversation reader consumes. Structure matches the Claude SDKMessage
 * on-the-wire shape so the frontend reloads OpenCode conversations
 * through the same provider-neutral reader.
 *
 * Differences from `mirrorCodexEvent` (Phase 7):
 *   - `parent_tool_use_id` synthesises to `'__opencode_subagent__'`
 *     when a sub-agent block is emitted (currently never, but the field
 *     is reserved for future `AgentPart`s).
 *   - `model` on `assistant` is the canonical `'opencode/<modelID>'` or
 *     `'opencode-go/<modelID>'` string so context-usage attribution stays
 *     unambiguous.
 */
function unifiedToTranscriptEntry(
  unified: UnifiedMessage,
  providerName: 'opencode' | 'opencode-go',
): {
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
    case 'assistant': {
      // OpenCode reports `modelID` (bare, like `kimi-k2.6`); we re-prefix
      // to the canonical persisted form for unambiguous attribution.
      // Accept both `opencode/` and `opencode-go/` prefixes as already-canonical.
      const canonicalModel = unified.model
        ? unified.model.startsWith('opencode/') || unified.model.startsWith('opencode-go/')
          ? unified.model
          : `${providerName}/${unified.model}`
        : null;
      return {
        uuid: unified.id,
        type: 'assistant',
        timestamp,
        parent_tool_use_id: unified.isSubAgent ? '__opencode_subagent__' : null,
        message: {
          id: unified.id,
          role: 'assistant',
          model: canonicalModel,
          ...(unified.usage ? { usage: unified.usage } : {}),
          content: [{ type: 'text', text: unified.text }],
        },
      };
    }
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
        subtype: unified.subtype ?? 'opencode',
      };
    case 'stream_delta':
      return null;
  }
}

/**
 * Append a single `UnifiedMessage` to the `messages` table under the
 * OpenCode session id. Idempotent on `uuid` — duplicate events
 * (SSE reconnects, replay) produce a single row.
 */
export async function mirrorOpenCodeEvent(
  ctx: MirrorContext,
  unified: UnifiedMessage,
  providerName: 'opencode' | 'opencode-go',
): Promise<void> {
  const entry = unifiedToTranscriptEntry(unified, providerName);
  if (!entry) return;
  await sqliteSessionStore.append(
    {
      projectKey: resolveProjectKey(ctx.projectFolderPath),
      sessionId: ctx.providerSessionId,
      subpath: '',
      provider: providerName,
    },
    [entry],
  );
}
