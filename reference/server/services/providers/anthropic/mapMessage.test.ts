import { describe, it, expect } from 'vitest';

import { mapMessage } from './mapMessage.js';
import type { SDKMessage } from '@shared/sdk/transcript';
import type {
  UnifiedAssistantMessage,
  UnifiedAssistantThinkingMessage,
  UnifiedResultMessage,
  UnifiedStreamDeltaMessage,
  UnifiedSystemMessage,
  UnifiedToolResultMessage,
  UnifiedToolUseMessage,
  UnifiedUserMessage,
} from '@shared/providers/types';

const SID = 'session-abc-123';

function asSdk(raw: unknown): SDKMessage {
  return raw as unknown as SDKMessage;
}

describe('AnthropicProvider mapMessage', () => {
  it('maps an assistant text message into a single UnifiedAssistantMessage', () => {
    const sdk = asSdk({
      type: 'assistant',
      uuid: 'u1',
      session_id: SID,
      parent_tool_use_id: null,
      message: {
        id: 'msg_1',
        model: 'claude-opus-4-7',
        usage: { input_tokens: 10, output_tokens: 20 },
        content: [{ type: 'text', text: 'hello world' }],
      },
    });
    const out = mapMessage(sdk, SID);
    expect(out).toHaveLength(1);
    const first = out[0] as UnifiedAssistantMessage;
    expect(first.type).toBe('assistant');
    expect(first.id).toBe('msg_1');
    expect(first.provider).toBe('anthropic');
    expect(first.providerSessionId).toBe(SID);
    expect(first.text).toBe('hello world');
    expect(first.isSubAgent).toBe(false);
    expect(first.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect(first.model).toBe('claude-opus-4-7');
  });

  it('marks isSubAgent when parent_tool_use_id is set', () => {
    const sdk = asSdk({
      type: 'assistant',
      uuid: 'u1',
      session_id: SID,
      parent_tool_use_id: 'tool_parent_1',
      message: { id: 'msg_sub', content: [{ type: 'text', text: 'sub' }] },
    });
    const out = mapMessage(sdk, SID);
    expect((out[0] as UnifiedAssistantMessage).isSubAgent).toBe(true);
  });

  it('splits assistant tool_use and thinking blocks into child UnifiedMessages', () => {
    const sdk = asSdk({
      type: 'assistant',
      uuid: 'u1',
      session_id: SID,
      parent_tool_use_id: null,
      message: {
        id: 'msg_2',
        content: [
          { type: 'text', text: 'before tool ' },
          { type: 'thinking', thinking: 'pondering' },
          { type: 'tool_use', id: 'tool_xyz', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: 'after tool' },
        ],
      },
    });
    const out = mapMessage(sdk, SID);
    expect(out).toHaveLength(3);
    expect(out[0]!.type).toBe('assistant');
    expect((out[0] as UnifiedAssistantMessage).text).toBe('before tool after tool');

    const thinking = out.find((m) => m.type === 'assistant_thinking') as UnifiedAssistantThinkingMessage | undefined;
    expect(thinking).toBeDefined();
    expect(thinking!.text).toBe('pondering');

    const toolUse = out.find((m) => m.type === 'tool_use') as UnifiedToolUseMessage | undefined;
    expect(toolUse).toBeDefined();
    expect(toolUse!.toolName).toBe('Bash');
    expect(toolUse!.toolUseId).toBe('tool_xyz');
    expect(toolUse!.toolInput).toEqual({ command: 'ls' });
  });

  it('maps a user text message into a UnifiedUserMessage', () => {
    const sdk = asSdk({
      type: 'user',
      uuid: 'u2',
      session_id: SID,
      message: { role: 'user', content: 'hi there' },
    });
    const out = mapMessage(sdk, SID);
    expect(out).toHaveLength(1);
    const user = out[0] as UnifiedUserMessage;
    expect(user.type).toBe('user');
    expect(user.content).toBe('hi there');
  });

  it('maps user content that is entirely tool_results into UnifiedToolResultMessages', () => {
    const sdk = asSdk({
      type: 'user',
      uuid: 'u3',
      session_id: SID,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok', is_error: false },
          { type: 'tool_result', tool_use_id: 'tu_2', content: 'bad', is_error: true },
        ],
      },
    });
    const out = mapMessage(sdk, SID);
    expect(out).toHaveLength(2);
    const first = out[0] as UnifiedToolResultMessage;
    const second = out[1] as UnifiedToolResultMessage;
    expect(first.type).toBe('tool_result');
    expect(first.toolUseId).toBe('tu_1');
    expect(first.content).toBe('ok');
    expect(first.isError).toBe(false);
    expect(second.toolUseId).toBe('tu_2');
    expect(second.isError).toBe(true);
  });

  it('falls back to UnifiedUserMessage when content mixes tool_result with non-tool blocks', () => {
    const sdk = asSdk({
      type: 'user',
      uuid: 'u4',
      session_id: SID,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
          { type: 'text', text: 'follow-up' },
        ],
      },
    });
    const out = mapMessage(sdk, SID);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('user');
  });

  it('maps a successful result message with usage', () => {
    const sdk = asSdk({
      type: 'result',
      uuid: 'r1',
      session_id: SID,
      is_error: false,
      usage: { input_tokens: 100, output_tokens: 50 },
      modelUsage: { 'claude-opus': { tokens: 150 } },
    });
    const out = mapMessage(sdk, SID);
    expect(out).toHaveLength(1);
    const r = out[0] as UnifiedResultMessage;
    expect(r.type).toBe('result');
    expect(r.isError).toBe(false);
    expect(r.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(r.modelUsage).toEqual({ 'claude-opus': { tokens: 150 } });
  });

  it('preserves errors[] on an error result', () => {
    const sdk = asSdk({
      type: 'result',
      uuid: 'r2',
      session_id: SID,
      is_error: true,
      errors: [{ message: '401 Invalid authentication credentials' }],
    });
    const out = mapMessage(sdk, SID);
    const r = out[0] as UnifiedResultMessage;
    expect(r.isError).toBe(true);
    expect(r.errors).toHaveLength(1);
  });

  it("preserves subtype: 'mirror_error' on system messages", () => {
    const sdk = asSdk({
      type: 'system',
      uuid: 's1',
      session_id: SID,
      subtype: 'mirror_error',
    });
    const out = mapMessage(sdk, SID);
    const s = out[0] as UnifiedSystemMessage;
    expect(s.type).toBe('system');
    expect(s.subtype).toBe('mirror_error');
  });

  it('maps stream_event into stream_delta with unwrapped event', () => {
    const sdk = asSdk({
      type: 'stream_event',
      uuid: 'd1',
      session_id: SID,
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '...' } },
    });
    const out = mapMessage(sdk, SID);
    const d = out[0] as UnifiedStreamDeltaMessage;
    expect(d.type).toBe('stream_delta');
    expect(d.delta).toEqual({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '...' } });
  });

  it("falls back to system/subtype='unknown' for unrecognised SDK types", () => {
    const sdk = asSdk({ type: 'totally_new_variant', uuid: 'x1', session_id: SID });
    const out = mapMessage(sdk, SID);
    const s = out[0] as UnifiedSystemMessage;
    expect(s.type).toBe('system');
    expect(s.subtype).toBe('unknown');
  });

  it('stamps the providerSessionId argument through to every emitted message', () => {
    const sdk = asSdk({
      type: 'assistant',
      uuid: 'u1',
      session_id: SID,
      parent_tool_use_id: null,
      message: { id: 'msg_x', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
    });
    const out = mapMessage(sdk, 'override-sid');
    for (const m of out) {
      expect(m.providerSessionId).toBe('override-sid');
    }
  });

  it('keeps the original sdk message accessible via raw', () => {
    const sdk = asSdk({
      type: 'system',
      uuid: 's1',
      session_id: SID,
      subtype: 'init',
      anything: 1,
    });
    const out = mapMessage(sdk, SID);
    expect(out[0]!.raw).toBe(sdk);
  });
});
