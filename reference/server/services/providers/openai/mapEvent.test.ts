import { describe, it, expect } from 'vitest';

import { mapEvent } from './mapEvent.js';
import type { ThreadEvent } from '@openai/codex-sdk';

const SID = 'thread-abc-1';

function ev(raw: unknown): ThreadEvent {
  return raw as unknown as ThreadEvent;
}

describe('CodexProvider mapEvent', () => {
  it("maps thread.started to a system/'thread_started' UnifiedMessage", () => {
    const out = mapEvent(ev({ type: 'thread.started', thread_id: 'tid-1' }), null);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('system');
    expect((out[0] as { subtype?: string }).subtype).toBe('thread_started');
    expect(out[0]!.provider).toBe('openai');
    // providerSessionId can be filled in from the thread_id when it wasn't known yet.
    expect(out[0]!.providerSessionId).toBe('tid-1');
  });

  it("skips item.started and item.updated (only item.completed is yielded)", () => {
    const started = mapEvent(ev({ type: 'item.started', item: { type: 'agent_message', id: 'x', text: '' } }), SID);
    const updated = mapEvent(ev({ type: 'item.updated', item: { type: 'agent_message', id: 'x', text: '' } }), SID);
    expect(started).toEqual([]);
    expect(updated).toEqual([]);
  });

  it('maps item.completed agent_message into a UnifiedAssistantMessage', () => {
    const out = mapEvent(
      ev({ type: 'item.completed', item: { type: 'agent_message', id: 'i1', text: 'hi' } }),
      SID,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('assistant');
    expect((out[0] as { text?: string }).text).toBe('hi');
  });

  it('maps item.completed reasoning into UnifiedAssistantThinking', () => {
    const out = mapEvent(
      ev({ type: 'item.completed', item: { type: 'reasoning', id: 'r1', text: 'thinking...' } }),
      SID,
    );
    expect(out[0]!.type).toBe('assistant_thinking');
    expect((out[0] as { text?: string }).text).toBe('thinking...');
  });

  it('maps command_execution completed into tool_use + tool_result with Bash toolName', () => {
    const out = mapEvent(
      ev({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd1',
          command: 'ls -la',
          aggregated_output: 'output...',
          exit_code: 0,
          status: 'completed',
        },
      }),
      SID,
    );
    expect(out).toHaveLength(2);
    const use = out[0] as { toolName?: string; toolUseId?: string; toolInput?: unknown };
    const result = out[1] as { toolUseId?: string; content?: unknown; isError?: boolean };
    expect(use.toolName).toBe('Bash');
    expect(use.toolUseId).toBe('cmd1');
    expect(use.toolInput).toEqual({ command: 'ls -la' });
    expect(result.toolUseId).toBe('cmd1');
    expect(result.content).toBe('output...');
    expect(result.isError).toBeUndefined();
  });

  it('marks command_execution failed with isError=true', () => {
    const out = mapEvent(
      ev({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd2',
          command: 'false',
          aggregated_output: 'fail',
          exit_code: 1,
          status: 'failed',
        },
      }),
      SID,
    );
    expect((out[1] as { isError?: boolean }).isError).toBe(true);
  });

  it("emits only the tool_use (no result) when command_execution is in_progress", () => {
    const out = mapEvent(
      ev({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd3',
          command: 'long',
          aggregated_output: '',
          status: 'in_progress',
        },
      }),
      SID,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('tool_use');
  });

  it('maps file_change to a FileChanges tool_use', () => {
    const out = mapEvent(
      ev({
        type: 'item.completed',
        item: {
          type: 'file_change',
          id: 'fc1',
          changes: [{ path: 'foo.ts', kind: 'add' }],
          status: 'completed',
        },
      }),
      SID,
    );
    expect(out[0]!.type).toBe('tool_use');
    expect((out[0] as { toolName?: string }).toolName).toBe('FileChanges');
  });

  it('maps web_search to a WebSearch tool_use', () => {
    const out = mapEvent(
      ev({ type: 'item.completed', item: { type: 'web_search', id: 'ws1', query: 'react' } }),
      SID,
    );
    expect((out[0] as { toolName?: string }).toolName).toBe('WebSearch');
    expect((out[0] as { toolInput?: { query?: string } }).toolInput).toEqual({ query: 'react' });
  });

  it('maps todo_list to a TodoList tool_use', () => {
    const out = mapEvent(
      ev({
        type: 'item.completed',
        item: { type: 'todo_list', id: 'td1', items: [{ task: 'a', done: false }] },
      }),
      SID,
    );
    expect((out[0] as { toolName?: string }).toolName).toBe('TodoList');
  });

  it('maps mcp_tool_call into a tool_use named after the underlying tool', () => {
    const out = mapEvent(
      ev({
        type: 'item.completed',
        item: { type: 'mcp_tool_call', id: 'mcp1', tool: 'search_files', arguments: { q: 'foo' } },
      }),
      SID,
    );
    expect((out[0] as { toolName?: string }).toolName).toBe('search_files');
  });

  it("maps item.completed error to a system/'item_error' message", () => {
    const out = mapEvent(
      ev({ type: 'item.completed', item: { type: 'error', id: 'e1', message: 'boom' } }),
      SID,
    );
    expect(out[0]!.type).toBe('system');
    expect((out[0] as { subtype?: string }).subtype).toBe('item_error');
  });

  it('maps turn.completed into a UnifiedResultMessage carrying usage', () => {
    const out = mapEvent(
      ev({
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 10,
          output_tokens: 20,
          reasoning_output_tokens: 5,
        },
      }),
      SID,
    );
    expect(out[0]!.type).toBe('result');
    const r = out[0] as { isError: boolean; usage?: { input_tokens: number; output_tokens: number } };
    expect(r.isError).toBe(false);
    expect(r.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
  });

  it('maps turn.failed into an error result with the error payload preserved', () => {
    const out = mapEvent(
      ev({ type: 'turn.failed', error: { message: 'bad' } }),
      SID,
    );
    const r = out[0] as { isError: boolean; errors?: unknown[] };
    expect(r.isError).toBe(true);
    expect(r.errors).toEqual([{ message: 'bad' }]);
  });

  it('maps top-level error into an error result', () => {
    const out = mapEvent(ev({ type: 'error', message: 'fatal' }), SID);
    const r = out[0] as { isError: boolean; errors?: unknown[] };
    expect(r.isError).toBe(true);
    expect(r.errors).toEqual([{ message: 'fatal' }]);
  });

  it('falls back to system/unknown for unrecognised event types', () => {
    const out = mapEvent(ev({ type: 'completely.unknown.event' }), SID);
    expect(out[0]!.type).toBe('system');
    expect((out[0] as { subtype?: string }).subtype).toBe('unknown');
  });
});
