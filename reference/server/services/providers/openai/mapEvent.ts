// Codex `ThreadEvent` → `UnifiedMessage[]` mapper.
//
// This is the only place in the codebase that knows the Codex SDK
// event shape. Every consumer above sees `UnifiedMessage` from
// `@shared/providers/types`.
//
// Reference for shapes: `node_modules/@openai/codex-sdk/dist/index.d.ts`
// (captured in `docs/codex-sdk-integration.md`). The catalog of
// `ThreadEvent` variants:
//   - `thread.started` — first event, carries `thread_id`.
//   - `turn.started` / `turn.completed` / `turn.failed`.
//   - `item.started` / `item.updated` / `item.completed` — assistant
//     output. We map only `item.completed`, matching the reference impl
//     (the partial-update events double up on the final).
//   - `error` — fatal stream-level errors.
//
// Tool-name normalisation table (ported from claudecodeui's
// `codex-sessions.provider.ts:148-220`):
//   - `command_execution`  → tool_use+tool_result pair with toolName='Bash'
//   - `file_change`        → tool_use with toolName='FileChanges'
//   - `mcp_tool_call`      → tool_use with the tool's own name
//   - `web_search`         → tool_use with toolName='WebSearch'
//   - `todo_list`          → tool_use with toolName='TodoList'

import type {
  ThreadEvent,
  ThreadItem,
  AgentMessageItem,
  ReasoningItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  WebSearchItem,
  TodoListItem,
  ErrorItem,
} from '@openai/codex-sdk';
import type {
  UnifiedMessage,
  UnifiedAssistantMessage,
  UnifiedAssistantThinkingMessage,
  UnifiedResultMessage,
  UnifiedSystemMessage,
  UnifiedToolUseMessage,
  UnifiedToolResultMessage,
} from '@shared/providers/types';

function asUnifiedAssistant(
  item: AgentMessageItem,
  providerSessionId: string | null,
): UnifiedAssistantMessage {
  return {
    type: 'assistant',
    id: item.id,
    provider: 'openai',
    providerSessionId,
    raw: item,
    text: item.text,
    isSubAgent: false,
  };
}

function asUnifiedThinking(
  item: ReasoningItem,
  providerSessionId: string | null,
): UnifiedAssistantThinkingMessage {
  return {
    type: 'assistant_thinking',
    id: item.id,
    provider: 'openai',
    providerSessionId,
    raw: item,
    text: item.text,
  };
}

function asUnifiedCommandExecution(
  item: CommandExecutionItem,
  providerSessionId: string | null,
): [UnifiedToolUseMessage, UnifiedToolResultMessage | null] {
  const toolUse: UnifiedToolUseMessage = {
    type: 'tool_use',
    id: `${item.id}:use`,
    provider: 'openai',
    providerSessionId,
    raw: item,
    toolName: 'Bash',
    toolUseId: item.id,
    toolInput: { command: item.command },
  };

  if (item.status === 'in_progress') return [toolUse, null];

  const result: UnifiedToolResultMessage = {
    type: 'tool_result',
    id: `${item.id}:result`,
    provider: 'openai',
    providerSessionId,
    raw: item,
    toolUseId: item.id,
    content: item.aggregated_output,
    ...(item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0)
      ? { isError: true }
      : {}),
  };
  return [toolUse, result];
}

function asUnifiedFileChange(
  item: FileChangeItem,
  providerSessionId: string | null,
): UnifiedToolUseMessage {
  return {
    type: 'tool_use',
    id: item.id,
    provider: 'openai',
    providerSessionId,
    raw: item,
    toolName: 'FileChanges',
    toolUseId: item.id,
    toolInput: { changes: item.changes, status: item.status },
  };
}

function asUnifiedMcpToolCall(
  item: McpToolCallItem,
  providerSessionId: string | null,
): UnifiedToolUseMessage {
  const itemAny = item as unknown as { tool?: string; arguments?: unknown; status?: string };
  return {
    type: 'tool_use',
    id: item.id,
    provider: 'openai',
    providerSessionId,
    raw: item,
    toolName: typeof itemAny.tool === 'string' ? itemAny.tool : 'mcp',
    toolUseId: item.id,
    toolInput: itemAny.arguments,
  };
}

function asUnifiedWebSearch(
  item: WebSearchItem,
  providerSessionId: string | null,
): UnifiedToolUseMessage {
  return {
    type: 'tool_use',
    id: item.id,
    provider: 'openai',
    providerSessionId,
    raw: item,
    toolName: 'WebSearch',
    toolUseId: item.id,
    toolInput: { query: item.query },
  };
}

function asUnifiedTodoList(
  item: TodoListItem,
  providerSessionId: string | null,
): UnifiedToolUseMessage {
  const itemAny = item as unknown as { items?: unknown };
  return {
    type: 'tool_use',
    id: item.id,
    provider: 'openai',
    providerSessionId,
    raw: item,
    toolName: 'TodoList',
    toolUseId: item.id,
    toolInput: { items: itemAny.items },
  };
}

function asUnifiedItemError(
  item: ErrorItem,
  providerSessionId: string | null,
): UnifiedSystemMessage {
  const itemAny = item as unknown as { message?: string };
  return {
    type: 'system',
    id: item.id,
    provider: 'openai',
    providerSessionId,
    raw: item,
    subtype: 'item_error',
    ...(typeof itemAny.message === 'string' ? { text: itemAny.message } : {}),
  };
}

function mapItem(item: ThreadItem, providerSessionId: string | null): UnifiedMessage[] {
  switch (item.type) {
    case 'agent_message':
      return [asUnifiedAssistant(item, providerSessionId)];
    case 'reasoning':
      return [asUnifiedThinking(item, providerSessionId)];
    case 'command_execution': {
      const [use, result] = asUnifiedCommandExecution(item, providerSessionId);
      return result ? [use, result] : [use];
    }
    case 'file_change':
      return [asUnifiedFileChange(item, providerSessionId)];
    case 'mcp_tool_call':
      return [asUnifiedMcpToolCall(item, providerSessionId)];
    case 'web_search':
      return [asUnifiedWebSearch(item, providerSessionId)];
    case 'todo_list':
      return [asUnifiedTodoList(item, providerSessionId)];
    case 'error':
      return [asUnifiedItemError(item, providerSessionId)];
    default: {
      const fallback: UnifiedSystemMessage = {
        type: 'system',
        id: (item as unknown as { id?: string }).id ?? `unknown_${Math.random()}`,
        provider: 'openai',
        providerSessionId,
        raw: item,
        subtype: 'unknown_item',
      };
      return [fallback];
    }
  }
}

/**
 * Map a single Codex `ThreadEvent` into one or more `UnifiedMessage`s.
 *
 *  - `thread.started` and `turn.started` carry no Bottega-visible content.
 *    We surface them as `system` messages so the streaming loop sees
 *    something, but downstream consumers usually filter them out.
 *  - `item.completed` is the main payload. `item.started` /
 *    `item.updated` are intentionally **not** mapped — they double up on
 *    the final completed shape (matches the reference impl).
 *  - `turn.completed` → `UnifiedResultMessage`. The aggregated `usage`
 *    flows through the existing `ContextUsageTracker.onResult` path.
 *  - `turn.failed` / `error` → `UnifiedResultMessage` with `isError: true`.
 */
export function mapEvent(
  event: ThreadEvent,
  providerSessionId: string | null,
): UnifiedMessage[] {
  switch (event.type) {
    case 'thread.started': {
      const sys: UnifiedSystemMessage = {
        type: 'system',
        id: `thread_started:${event.thread_id}`,
        provider: 'openai',
        providerSessionId: providerSessionId ?? event.thread_id,
        raw: event,
        subtype: 'thread_started',
      };
      return [sys];
    }
    case 'turn.started': {
      const sys: UnifiedSystemMessage = {
        type: 'system',
        id: `turn_started:${Math.random()}`,
        provider: 'openai',
        providerSessionId,
        raw: event,
        subtype: 'turn_started',
      };
      return [sys];
    }
    case 'item.started':
    case 'item.updated':
      // Intentionally skipped — item.completed carries the same payload.
      return [];
    case 'item.completed':
      return mapItem(event.item, providerSessionId);
    case 'turn.completed': {
      const usage = event.usage;
      const result: UnifiedResultMessage = {
        type: 'result',
        id: `turn_completed:${Math.random()}`,
        provider: 'openai',
        providerSessionId,
        raw: event,
        isError: false,
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
      };
      return [result];
    }
    case 'turn.failed': {
      const result: UnifiedResultMessage = {
        type: 'result',
        id: `turn_failed:${Math.random()}`,
        provider: 'openai',
        providerSessionId,
        raw: event,
        isError: true,
        errors: [event.error],
      };
      return [result];
    }
    case 'error': {
      const eventAny = event as unknown as { message?: string };
      const result: UnifiedResultMessage = {
        type: 'result',
        id: `stream_error:${Math.random()}`,
        provider: 'openai',
        providerSessionId,
        raw: event,
        isError: true,
        errors: typeof eventAny.message === 'string' ? [{ message: eventAny.message }] : undefined,
      };
      return [result];
    }
    default: {
      const fallback: UnifiedSystemMessage = {
        type: 'system',
        id: `unknown_event:${Math.random()}`,
        provider: 'openai',
        providerSessionId,
        raw: event,
        subtype: 'unknown',
      };
      return [fallback];
    }
  }
}
