// OpenCode `Event` → `UnifiedMessage[]` mapper.
//
// This is the only place in the codebase that imports the OpenCode SDK's
// event types. Every consumer above sees `UnifiedMessage` from
// `@shared/providers/types`.
//
// Reference for shapes:
// - node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts (Event union @ ~L602)
// - tmp/opencode/packages/sdk/js/src/gen/types.gen.ts (upstream)
//
// Unlike Codex (where every `item.completed` carries the final text), the
// OpenCode wire interleaves many `message.part.updated` events per
// assistant turn. The mapper keeps per-`messageID` state so it can
// coalesce text and reasoning parts into one final `assistant` /
// `assistant_thinking` per turn, flushed when the parent
// `message.updated` arrives with `finish`. Tool parts are emitted
// immediately (lifecycle: pending/running → tool_use only; completed/
// error → tool_use + tool_result). Per D8 there is no thinking-delta
// streaming and no AskUserQuestion in OpenCode.

import type {
  Event,
  EventMessagePartUpdated,
  EventMessageUpdated,
  EventSessionError,
  EventSessionIdle,
  AssistantMessage,
  Part,
  TextPart,
  ReasoningPart,
  ToolPart,
  FilePart,
  StepFinishPart,
  Message,
} from '@opencode-ai/sdk';
import type {
  UnifiedAssistantMessage,
  UnifiedAssistantThinkingMessage,
  UnifiedMessage,
  UnifiedResultMessage,
  UnifiedSystemMessage,
  UnifiedToolResultMessage,
  UnifiedToolUseMessage,
} from '@shared/providers/types';

interface MessageState {
  /** Accumulated text from TextParts (in part-order). */
  textByPart: Map<string, string>;
  textPartOrder: string[];
  /** Accumulated reasoning from ReasoningParts (in part-order). */
  reasoningByPart: Map<string, string>;
  reasoningPartOrder: string[];
  /** True iff the parent AssistantMessage has finished (so we can flush coalesced). */
  finished: boolean;
  /** Final AssistantMessage carried for usage at flush time. */
  final?: AssistantMessage;
  /** Tracks which tool parts have already emitted their tool_use. */
  toolsWithUseEmitted: Set<string>;
}

export interface OpenCodeEventMapper {
  /**
   * Translate one OpenCode SSE event into 0+ UnifiedMessages. The
   * mapper carries internal state for per-messageID text accumulation,
   * so callers MUST use one mapper per conversation (per session_id).
   */
  map(event: Event): UnifiedMessage[];
}

/**
 * Create a stateful mapper bound to one `providerSessionId`. Each
 * conversation needs its own instance — text accumulation is per
 * messageID, but two parallel streams should not share buffers.
 */
export function createOpenCodeEventMapper(
  providerSessionId: string,
  providerName: 'opencode' | 'opencode-go',
): OpenCodeEventMapper {
  const messages = new Map<string, MessageState>();

  function stateFor(messageID: string): MessageState {
    let s = messages.get(messageID);
    if (!s) {
      s = {
        textByPart: new Map(),
        textPartOrder: [],
        reasoningByPart: new Map(),
        reasoningPartOrder: [],
        finished: false,
        toolsWithUseEmitted: new Set(),
      };
      messages.set(messageID, s);
    }
    return s;
  }

  function concatOrdered(order: string[], map: Map<string, string>): string {
    return order.map((id) => map.get(id) ?? '').join('');
  }

  function flushAssistant(
    messageID: string,
    raw: unknown,
  ): UnifiedMessage[] {
    const s = messages.get(messageID);
    if (!s) return [];
    const out: UnifiedMessage[] = [];
    const text = concatOrdered(s.textPartOrder, s.textByPart);
    if (text.length > 0) {
      const usage = s.final
        ? {
            input_tokens: s.final.tokens?.input,
            output_tokens: s.final.tokens?.output,
          }
        : undefined;
      const assistant: UnifiedAssistantMessage = {
        type: 'assistant',
        id: messageID,
        provider: providerName,
        providerSessionId,
        raw,
        text,
        isSubAgent: false,
        ...(usage ? { usage } : {}),
        ...(s.final?.modelID ? { model: s.final.modelID } : {}),
      };
      out.push(assistant);
    }
    const reasoning = concatOrdered(s.reasoningPartOrder, s.reasoningByPart);
    if (reasoning.length > 0) {
      const thinking: UnifiedAssistantThinkingMessage = {
        type: 'assistant_thinking',
        id: `${messageID}:thinking`,
        provider: providerName,
        providerSessionId,
        raw,
        text: reasoning,
      };
      out.push(thinking);
    }
    return out;
  }

  function mapTextPart(
    part: TextPart,
    raw: unknown,
  ): UnifiedMessage[] {
    const s = stateFor(part.messageID);
    if (!s.textByPart.has(part.id)) s.textPartOrder.push(part.id);
    s.textByPart.set(part.id, part.text);
    void raw;
    return [];
  }

  function mapReasoningPart(
    part: ReasoningPart,
    raw: unknown,
  ): UnifiedMessage[] {
    const s = stateFor(part.messageID);
    if (!s.reasoningByPart.has(part.id)) s.reasoningPartOrder.push(part.id);
    s.reasoningByPart.set(part.id, part.text);
    void raw;
    return [];
  }

  function mapToolPart(part: ToolPart, raw: unknown): UnifiedMessage[] {
    const messageState = stateFor(part.messageID);
    const toolUseId = part.callID;
    const toolName = part.tool;
    const state = part.state;
    const messages: UnifiedMessage[] = [];

    // Emit tool_use only if we haven't already emitted it for this part.
    if (!messageState.toolsWithUseEmitted.has(part.id)) {
      const toolUse: UnifiedToolUseMessage = {
        type: 'tool_use',
        id: `${part.id}:use`,
        provider: providerName,
        providerSessionId,
        raw,
        toolName,
        toolUseId,
        toolInput: 'input' in state ? state.input : {},
      };
      messages.push(toolUse);
      // Mark that we've emitted the tool_use for this part.
      messageState.toolsWithUseEmitted.add(part.id);
    }

    if (state.status === 'pending' || state.status === 'running') {
      return messages;
    }
    if (state.status === 'completed') {
      const result: UnifiedToolResultMessage = {
        type: 'tool_result',
        id: `${part.id}:result`,
        provider: providerName,
        providerSessionId,
        raw,
        toolUseId,
        content: state.output,
      };
      messages.push(result);
      return messages;
    }
    // status === 'error'
    const errResult: UnifiedToolResultMessage = {
      type: 'tool_result',
      id: `${part.id}:result`,
      provider: providerName,
      providerSessionId,
      raw,
      toolUseId,
      content: state.error,
      isError: true,
    };
    messages.push(errResult);
    return messages;
  }

  function mapFilePart(part: FilePart, raw: unknown): UnifiedMessage[] {
    const result: UnifiedToolResultMessage = {
      type: 'tool_result',
      id: `${part.id}:file`,
      provider: providerName,
      providerSessionId,
      raw,
      toolUseId: part.id,
      content: {
        kind: 'file',
        mime: part.mime,
        filename: part.filename ?? null,
        url: part.url,
      },
    };
    return [result];
  }

  function mapStepFinishPart(part: StepFinishPart, raw: unknown): UnifiedMessage[] {
    const result: UnifiedResultMessage = {
      type: 'result',
      id: `${part.id}:step-finish`,
      provider: providerName,
      providerSessionId,
      raw,
      isError: false,
      usage: {
        input_tokens: part.tokens.input,
        output_tokens: part.tokens.output,
      },
    };
    return [result];
  }

  function mapPart(event: EventMessagePartUpdated): UnifiedMessage[] {
    const part = event.properties.part as Part;
    switch (part.type) {
      case 'text':
        return mapTextPart(part, event);
      case 'reasoning':
        return mapReasoningPart(part, event);
      case 'tool':
        return mapToolPart(part, event);
      case 'file':
        return mapFilePart(part, event);
      case 'step-finish':
        return mapStepFinishPart(part, event);
      case 'step-start':
      case 'snapshot':
      case 'patch':
      case 'agent':
      case 'retry':
      case 'compaction':
      case 'subtask':
        return [];
      default:
        return [];
    }
  }

  function mapMessageUpdated(event: EventMessageUpdated): UnifiedMessage[] {
    const info = event.properties.info as Message;
    if (info.role === 'user') {
      // The synthetic user message is emitted by the orchestrator; do not echo.
      return [];
    }
    const assistant = info;
    const s = stateFor(assistant.id);
    s.final = assistant;
    // Only flush when the message has finished (carries `finish` field).
    if (!assistant.finish) return [];
    if (s.finished) return [];
    s.finished = true;
    const events = flushAssistant(assistant.id, event);
    if (assistant.error) {
      const err: UnifiedResultMessage = {
        type: 'result',
        id: `${assistant.id}:error`,
        provider: providerName,
        providerSessionId,
        raw: event,
        isError: true,
        errors: [assistant.error],
      };
      events.push(err);
    }
    return events;
  }

  function mapSessionIdle(event: EventSessionIdle): UnifiedMessage[] {
    const result: UnifiedResultMessage = {
      type: 'result',
      id: `session-idle:${event.properties.sessionID}:${Math.random()}`,
      provider: providerName,
      providerSessionId,
      raw: event,
      isError: false,
    };
    return [result];
  }

  function mapSessionError(event: EventSessionError): UnifiedMessage[] {
    const errObj = event.properties.error;
    const errors = errObj ? [errObj] : undefined;
    const result: UnifiedResultMessage = {
      type: 'result',
      id: `session-error:${event.properties.sessionID ?? 'unknown'}:${Math.random()}`,
      provider: providerName,
      providerSessionId,
      raw: event,
      isError: true,
      ...(errors ? { errors } : {}),
    };
    return [result];
  }

  function map(event: Event): UnifiedMessage[] {
    switch (event.type) {
      case 'message.part.updated':
        return mapPart(event);
      case 'message.updated':
        return mapMessageUpdated(event);
      case 'session.idle':
        return mapSessionIdle(event);
      case 'session.error':
        return mapSessionError(event);
      // Everything else (server-instance, lsp, file watch, pty, tui, …) is
      // either Bottega-irrelevant or covered elsewhere. Return [] so the
      // mapper is forward-compatible to new event types.
      default:
        return [];
    }
  }

  return { map };
}

/**
 * Convenience entry point for non-streaming callers (or tests). Wraps a
 * fresh mapper per call. Most consumers should keep one mapper alive
 * across a turn instead, so per-messageID buffers persist.
 */
export function mapOpenCodeEvent(
  event: Event,
  providerSessionId: string,
  providerName: 'opencode' | 'opencode-go' = 'opencode',
): UnifiedMessage[] {
  return createOpenCodeEventMapper(providerSessionId, providerName).map(event);
}

/**
 * Emit a "system" envelope for unmapped or noise events. Useful when a
 * consumer wants to forward every wire event to the frontend for forensics.
 * Not used by the streaming loop today (the loop drops empty arrays).
 */
export function asUnifiedSystem(
  event: Event,
  providerSessionId: string,
  providerName: 'opencode' | 'opencode-go' = 'opencode',
): UnifiedSystemMessage {
  return {
    type: 'system',
    id: `opencode_event:${event.type}:${Math.random()}`,
    provider: providerName,
    providerSessionId,
    raw: event,
    subtype: event.type,
  };
}
