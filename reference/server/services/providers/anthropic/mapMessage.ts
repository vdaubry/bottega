// SDK `SDKMessage` → `UnifiedMessage` mapper.
//
// This is the only place in the codebase that knows Claude SDK shapes.
// Every consumer above it sees `UnifiedMessage`. When the SDK adds a new
// message variant, the catch-all branch produces a `system`/`unknown`
// unified message so the rest of the app keeps streaming; add the new
// variant explicitly when its shape is understood.

import type { SDKMessage } from '@shared/sdk/transcript';
import type {
  UnifiedMessage,
  UnifiedAssistantMessage,
  UnifiedUserMessage,
  UnifiedToolUseMessage,
  UnifiedToolResultMessage,
  UnifiedAssistantThinkingMessage,
  UnifiedResultMessage,
  UnifiedSystemMessage,
  UnifiedStreamDeltaMessage,
} from '@shared/providers/types';

type AnyRecord = Record<string, unknown>;

function getId(raw: AnyRecord, prefix: string): string {
  const messageId = (raw.message as AnyRecord | undefined)?.id;
  if (typeof messageId === 'string') return messageId;
  if (typeof raw.uuid === 'string') return raw.uuid as string;
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text?: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as AnyRecord).type === 'text',
    )
    .map((block) => block.text ?? '')
    .join('');
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

function emitToolBlocks(
  raw: AnyRecord,
  providerSessionId: string | null,
  parentId: string,
): Array<UnifiedToolUseMessage | UnifiedAssistantThinkingMessage> {
  const out: Array<UnifiedToolUseMessage | UnifiedAssistantThinkingMessage> = [];
  const content = (raw.message as AnyRecord | undefined)?.content;
  if (!Array.isArray(content)) return out;

  for (const block of content as ContentBlock[]) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      out.push({
        type: 'tool_use',
        id: `${parentId}:tool:${block.id}`,
        provider: 'anthropic',
        providerSessionId,
        raw: block,
        toolName: block.name,
        toolUseId: block.id,
        toolInput: block.input,
      });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      out.push({
        type: 'assistant_thinking',
        id: `${parentId}:thinking`,
        provider: 'anthropic',
        providerSessionId,
        raw: block,
        text: block.thinking,
      });
    }
  }

  return out;
}

function tryMapAssistant(raw: AnyRecord, providerSessionId: string | null): UnifiedMessage[] {
  const id = getId(raw, 'asst');
  const message = (raw.message as AnyRecord | undefined) ?? {};
  const text = extractAssistantText(message.content);
  const parentToolUseId = (raw.parent_tool_use_id ?? null) as string | null;
  const usage = message.usage as { input_tokens?: number; output_tokens?: number } | undefined;

  const assistant: UnifiedAssistantMessage = {
    type: 'assistant',
    id,
    provider: 'anthropic',
    providerSessionId,
    raw,
    text,
    isSubAgent: parentToolUseId !== null,
    ...(usage ? { usage } : {}),
    ...(typeof message.model === 'string' ? { model: message.model } : {}),
  };

  return [assistant, ...emitToolBlocks(raw, providerSessionId, id)];
}

function mapUserContent(raw: AnyRecord, providerSessionId: string | null): UnifiedMessage[] {
  const id = getId(raw, 'user');
  const message = (raw.message as AnyRecord | undefined) ?? {};
  const content = message.content;

  // Tool-result blocks arrive as user-typed entries; surface them as
  // tool_result so downstream consumers can pair them with their tool_use.
  if (Array.isArray(content)) {
    const out: UnifiedMessage[] = [];
    let hasNonToolResult = false;
    for (const block of content as ContentBlock[]) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const toolResult: UnifiedToolResultMessage = {
          type: 'tool_result',
          id: `${id}:result:${block.tool_use_id}`,
          provider: 'anthropic',
          providerSessionId,
          raw: block,
          toolUseId: block.tool_use_id,
          content: block.content,
          ...(typeof block.is_error === 'boolean' ? { isError: block.is_error } : {}),
        };
        out.push(toolResult);
      } else {
        hasNonToolResult = true;
      }
    }
    if (!hasNonToolResult && out.length > 0) {
      return out;
    }
  }

  const user: UnifiedUserMessage = {
    type: 'user',
    id,
    provider: 'anthropic',
    providerSessionId,
    raw,
    content,
  };
  return [user];
}

function tryMapResult(raw: AnyRecord, providerSessionId: string | null): UnifiedResultMessage {
  const usage = raw.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    type: 'result',
    id: getId(raw, 'result'),
    provider: 'anthropic',
    providerSessionId,
    raw,
    isError: raw.is_error === true,
    ...(usage ? { usage } : {}),
    ...(raw.modelUsage !== undefined ? { modelUsage: raw.modelUsage } : {}),
    ...(Array.isArray(raw.errors) ? { errors: raw.errors } : {}),
  };
}

function tryMapSystem(raw: AnyRecord, providerSessionId: string | null): UnifiedSystemMessage {
  return {
    type: 'system',
    id: getId(raw, 'sys'),
    provider: 'anthropic',
    providerSessionId,
    raw,
    ...(typeof raw.subtype === 'string' ? { subtype: raw.subtype } : {}),
  };
}

function tryMapStreamEvent(raw: AnyRecord, providerSessionId: string | null): UnifiedStreamDeltaMessage {
  return {
    type: 'stream_delta',
    id: getId(raw, 'delta'),
    provider: 'anthropic',
    providerSessionId,
    raw,
    delta: raw.event,
  };
}

/**
 * Map a single Claude `SDKMessage` to one or more `UnifiedMessage`s.
 *
 * Splitting on the SDK's `type`:
 *  - `'assistant'`     → `assistant` (+ tool_use / assistant_thinking children).
 *  - `'user'`          → `user`, or one or more `tool_result` when the user
 *                        content is purely tool results.
 *  - `'result'`        → `result`.
 *  - `'system'`        → `system`. `subtype: 'mirror_error'` is preserved.
 *  - `'stream_event'`  → `stream_delta`.
 *  - anything else     → `system` with `subtype: 'unknown'`.
 *
 * Caller can extract the session id from `raw.session_id`. We thread it in
 * explicitly via `providerSessionId` so each unified message carries it.
 */
export function mapMessage(
  sdkMessage: SDKMessage,
  providerSessionId: string | null,
): UnifiedMessage[] {
  const raw = sdkMessage as unknown as AnyRecord;
  const type = raw.type;

  switch (type) {
    case 'assistant':
      return tryMapAssistant(raw, providerSessionId);
    case 'user':
      return mapUserContent(raw, providerSessionId);
    case 'result':
      return [tryMapResult(raw, providerSessionId)];
    case 'system':
      return [tryMapSystem(raw, providerSessionId)];
    case 'stream_event':
      return [tryMapStreamEvent(raw, providerSessionId)];
    default: {
      const fallback: UnifiedSystemMessage = {
        type: 'system',
        id: getId(raw, 'unknown'),
        provider: 'anthropic',
        providerSessionId,
        raw,
        subtype: 'unknown',
      };
      return [fallback];
    }
  }
}
