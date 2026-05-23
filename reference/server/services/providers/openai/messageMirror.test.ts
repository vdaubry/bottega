import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UnifiedMessage } from '@shared/providers/types';

vi.mock('../../sqliteSessionStore.js', () => ({
  sqliteSessionStore: {
    append: vi.fn(async () => {}),
  },
}));

import { sqliteSessionStore } from '../../sqliteSessionStore.js';
import { mirrorCodexEvent } from './messageMirror.js';

const CTX = {
  projectFolderPath: '/home/ubuntu/misc/hello_world',
  providerSessionId: 'thread-abc',
};

describe('mirrorCodexEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends with provider='openai' and SDK-derived projectKey", async () => {
    const msg: UnifiedMessage = {
      type: 'assistant',
      id: 'msg-1',
      provider: 'openai',
      providerSessionId: 'thread-abc',
      raw: null,
      text: 'hi',
      isSubAgent: false,
    };
    await mirrorCodexEvent(CTX, msg);
    expect(sqliteSessionStore.append).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sqliteSessionStore.append).mock.calls[0]!;
    expect(call[0]).toMatchObject({
      projectKey: '-home-ubuntu-misc-hello-world',
      sessionId: 'thread-abc',
      subpath: '',
      provider: 'openai',
    });
    const entries = call[1] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!['type']).toBe('assistant');
    expect(entries[0]!['uuid']).toBe('msg-1');
  });

  it('skips stream_delta entries (no on-disk persistence)', async () => {
    const msg: UnifiedMessage = {
      type: 'stream_delta',
      id: 'delta-1',
      provider: 'openai',
      providerSessionId: 'thread-abc',
      raw: null,
      delta: {},
    };
    await mirrorCodexEvent(CTX, msg);
    expect(sqliteSessionStore.append).not.toHaveBeenCalled();
  });

  it('persists tool_use entries as Claude-shaped assistant + tool_use block', async () => {
    const msg: UnifiedMessage = {
      type: 'tool_use',
      id: 'cmd-1',
      provider: 'openai',
      providerSessionId: 'thread-abc',
      raw: null,
      toolName: 'Bash',
      toolUseId: 'cmd-1',
      toolInput: { command: 'ls' },
    };
    await mirrorCodexEvent(CTX, msg);
    const entries = (vi.mocked(sqliteSessionStore.append).mock.calls[0]![1]) as Array<{
      type?: string;
      message?: { content?: Array<{ type?: string; name?: string }> };
    }>;
    expect(entries[0]!.type).toBe('assistant');
    const blocks = entries[0]!.message?.content;
    expect(blocks?.[0]?.type).toBe('tool_use');
    expect(blocks?.[0]?.name).toBe('Bash');
  });
});
