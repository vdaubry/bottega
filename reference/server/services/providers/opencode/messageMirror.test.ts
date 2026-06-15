import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UnifiedMessage } from '@shared/providers/types';

vi.mock('../../sqliteSessionStore.js', () => ({
  sqliteSessionStore: {
    append: vi.fn(async () => {}),
  },
}));

import { sqliteSessionStore } from '../../sqliteSessionStore.js';
import { mirrorOpenCodeEvent } from './messageMirror.js';

const CTX = {
  projectFolderPath: '/home/ubuntu/misc/hello_world',
  providerSessionId: 'sess_oc_42',
};

describe('mirrorOpenCodeEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends with provider='opencode' and the SDK-derived projectKey", async () => {
    const msg: UnifiedMessage = {
      type: 'assistant',
      id: 'msg-1',
      provider: 'opencode',
      providerSessionId: 'sess_oc_42',
      raw: null,
      text: 'hi',
      isSubAgent: false,
      model: 'kimi-k2.6',
    };
    await mirrorOpenCodeEvent(CTX, msg, 'opencode');
    expect(sqliteSessionStore.append).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sqliteSessionStore.append).mock.calls[0]!;
    expect(call[0]).toMatchObject({
      projectKey: '-home-ubuntu-misc-hello-world',
      sessionId: 'sess_oc_42',
      subpath: '',
      provider: 'opencode',
    });
    const entries = call[1] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!['type']).toBe('assistant');
    expect(entries[0]!['uuid']).toBe('msg-1');
    // model is reprefixed to the canonical opencode/<modelID> form
    expect(((entries[0]!['message'] as Record<string, unknown>)['model'])).toBe(
      'opencode/kimi-k2.6',
    );
  });

  it("does NOT double-prefix when model is already 'opencode/<id>'", async () => {
    const msg: UnifiedMessage = {
      type: 'assistant',
      id: 'msg-2',
      provider: 'opencode',
      providerSessionId: 'sess_oc_42',
      raw: null,
      text: 'hi',
      isSubAgent: false,
      model: 'opencode/qwen3-coder',
    };
    await mirrorOpenCodeEvent(CTX, msg, 'opencode');
    const entries = (vi.mocked(sqliteSessionStore.append).mock.calls[0]![1]) as Array<{
      message?: { model?: string };
    }>;
    expect(entries[0]!.message?.model).toBe('opencode/qwen3-coder');
  });

  it('skips stream_delta entries (no on-disk persistence)', async () => {
    const msg: UnifiedMessage = {
      type: 'stream_delta',
      id: 'delta-1',
      provider: 'opencode',
      providerSessionId: 'sess_oc_42',
      raw: null,
      delta: {},
    };
    await mirrorOpenCodeEvent(CTX, msg, 'opencode');
    expect(sqliteSessionStore.append).not.toHaveBeenCalled();
  });

  it('persists user message as Claude-shaped user with role content', async () => {
    const msg: UnifiedMessage = {
      type: 'user',
      id: 'user-1',
      provider: 'opencode',
      providerSessionId: 'sess_oc_42',
      raw: null,
      content: 'hello',
    };
    await mirrorOpenCodeEvent(CTX, msg, 'opencode');
    const entries = vi.mocked(sqliteSessionStore.append).mock.calls[0]![1] as Array<{
      type?: string;
      message?: { role?: string; content?: unknown };
    }>;
    expect(entries[0]!.type).toBe('user');
    expect(entries[0]!.message?.role).toBe('user');
    expect(entries[0]!.message?.content).toBe('hello');
  });

  it('persists tool_use entries as Claude-shaped assistant + tool_use block', async () => {
    const msg: UnifiedMessage = {
      type: 'tool_use',
      id: 'tool-1',
      provider: 'opencode',
      providerSessionId: 'sess_oc_42',
      raw: null,
      toolName: 'Bash',
      toolUseId: 'call-abc',
      toolInput: { command: 'ls' },
    };
    await mirrorOpenCodeEvent(CTX, msg, 'opencode');
    const entries = vi.mocked(sqliteSessionStore.append).mock.calls[0]![1] as Array<{
      type?: string;
      uuid?: string;
      message?: { content?: Array<{ type?: string; name?: string; id?: string; input?: unknown }> };
    }>;
    expect(entries[0]!.type).toBe('assistant');
    expect(entries[0]!.uuid).toBe('tool-1:tool_use');
    const blocks = entries[0]!.message?.content;
    expect(blocks?.[0]?.type).toBe('tool_use');
    expect(blocks?.[0]?.name).toBe('Bash');
    expect(blocks?.[0]?.id).toBe('call-abc');
  });

  it('persists tool_result with isError when failed', async () => {
    const msg: UnifiedMessage = {
      type: 'tool_result',
      id: 'tool-1',
      provider: 'opencode',
      providerSessionId: 'sess_oc_42',
      raw: null,
      toolUseId: 'call-abc',
      content: 'oops',
      isError: true,
    };
    await mirrorOpenCodeEvent(CTX, msg, 'opencode');
    const entries = vi.mocked(sqliteSessionStore.append).mock.calls[0]![1] as Array<{
      type?: string;
      uuid?: string;
      message?: { content?: Array<{ type?: string; is_error?: boolean; tool_use_id?: string }> };
    }>;
    expect(entries[0]!.type).toBe('user');
    expect(entries[0]!.uuid).toBe('tool-1:tool_result');
    const blocks = entries[0]!.message?.content;
    expect(blocks?.[0]?.type).toBe('tool_result');
    expect(blocks?.[0]?.is_error).toBe(true);
    expect(blocks?.[0]?.tool_use_id).toBe('call-abc');
  });

  it('persists assistant_thinking as thinking block on assistant', async () => {
    const msg: UnifiedMessage = {
      type: 'assistant_thinking',
      id: 'think-1',
      provider: 'opencode',
      providerSessionId: 'sess_oc_42',
      raw: null,
      text: 'pondering',
    };
    await mirrorOpenCodeEvent(CTX, msg, 'opencode');
    const entries = vi.mocked(sqliteSessionStore.append).mock.calls[0]![1] as Array<{
      uuid?: string;
      message?: { content?: Array<{ type?: string; thinking?: string }> };
    }>;
    expect(entries[0]!.uuid).toBe('think-1:thinking');
    expect(entries[0]!.message?.content?.[0]?.type).toBe('thinking');
    expect(entries[0]!.message?.content?.[0]?.thinking).toBe('pondering');
  });

  it('persists result with usage + isError fields', async () => {
    const msg: UnifiedMessage = {
      type: 'result',
      id: 'res-1',
      provider: 'opencode',
      providerSessionId: 'sess_oc_42',
      raw: null,
      isError: false,
      usage: { input_tokens: 12, output_tokens: 34 },
    };
    await mirrorOpenCodeEvent(CTX, msg, 'opencode');
    const entries = vi.mocked(sqliteSessionStore.append).mock.calls[0]![1] as Array<Record<string, unknown>>;
    expect(entries[0]!['type']).toBe('result');
    expect(entries[0]!['is_error']).toBe(false);
    expect(entries[0]!['usage']).toEqual({ input_tokens: 12, output_tokens: 34 });
  });

  it('persists system entries with subtype defaulting to opencode', async () => {
    const msg: UnifiedMessage = {
      type: 'system',
      id: 'sys-1',
      provider: 'opencode',
      providerSessionId: 'sess_oc_42',
      raw: null,
    };
    await mirrorOpenCodeEvent(CTX, msg, 'opencode');
    const entries = vi.mocked(sqliteSessionStore.append).mock.calls[0]![1] as Array<Record<string, unknown>>;
    expect(entries[0]!['type']).toBe('system');
    expect(entries[0]!['subtype']).toBe('opencode');
  });

  it('parent_tool_use_id is stamped __opencode_subagent__ when isSubAgent=true', async () => {
    const msg: UnifiedMessage = {
      type: 'assistant',
      id: 'sub-1',
      provider: 'opencode',
      providerSessionId: 'sess_oc_42',
      raw: null,
      text: 'sub',
      isSubAgent: true,
    };
    await mirrorOpenCodeEvent(CTX, msg, 'opencode');
    const entries = vi.mocked(sqliteSessionStore.append).mock.calls[0]![1] as Array<Record<string, unknown>>;
    expect(entries[0]!['parent_tool_use_id']).toBe('__opencode_subagent__');
  });

  // OpenCode Go provider tests
  it("appends with provider='opencode-go' and prefixes model correctly", async () => {
    const msg: UnifiedMessage = {
      type: 'assistant',
      id: 'msg-go-1',
      provider: 'opencode-go',
      providerSessionId: 'sess_oc_go_42',
      raw: null,
      text: 'hello from go',
      isSubAgent: false,
      model: 'deepseek-r1',
    };
    await mirrorOpenCodeEvent(CTX, msg, 'opencode-go');
    expect(sqliteSessionStore.append).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sqliteSessionStore.append).mock.calls[0]!;
    expect(call[0]).toMatchObject({
      provider: 'opencode-go',
    });
    const entries = call[1] as Array<Record<string, unknown>>;
    expect(entries[0]!['type']).toBe('assistant');
    // model is reprefixed to the canonical opencode-go/<modelID> form
    expect(((entries[0]!['message'] as Record<string, unknown>)['model'])).toBe(
      'opencode-go/deepseek-r1',
    );
  });

  it("does NOT double-prefix when model is already 'opencode-go/<id>'", async () => {
    const msg: UnifiedMessage = {
      type: 'assistant',
      id: 'msg-go-2',
      provider: 'opencode-go',
      providerSessionId: 'sess_oc_go_42',
      raw: null,
      text: 'hi',
      isSubAgent: false,
      model: 'opencode-go/qwen3-coder',
    };
    await mirrorOpenCodeEvent(CTX, msg, 'opencode-go');
    const entries = (vi.mocked(sqliteSessionStore.append).mock.calls[0]![1]) as Array<{
      message?: { model?: string };
    }>;
    expect(entries[0]!.message?.model).toBe('opencode-go/qwen3-coder');
  });

  it('opencode-go provider persists user message correctly', async () => {
    const msg: UnifiedMessage = {
      type: 'user',
      id: 'user-go-1',
      provider: 'opencode-go',
      providerSessionId: 'sess_oc_go_42',
      raw: null,
      content: 'hello go',
    };
    await mirrorOpenCodeEvent(CTX, msg, 'opencode-go');
    const entries = vi.mocked(sqliteSessionStore.append).mock.calls[0]![1] as Array<{
      type?: string;
      message?: { role?: string; content?: unknown };
    }>;
    expect(entries[0]!.type).toBe('user');
    expect(entries[0]!.message?.role).toBe('user');
    expect(entries[0]!.message?.content).toBe('hello go');
  });
});
