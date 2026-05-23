import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../sqliteSessionStore.js', () => ({
  sqliteSessionStore: {
    load: vi.fn(),
  },
}));

import { sqliteSessionStore } from '../../sqliteSessionStore.js';
import { loadAnthropicTranscript } from './sessionStore.js';

describe('loadAnthropicTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the SDK-derived projectKey (alphanumeric + `-`) when reading from sqliteSessionStore', async () => {
    vi.mocked(sqliteSessionStore.load).mockResolvedValueOnce([]);
    await loadAnthropicTranscript({
      providerSessionId: 'sess-1',
      projectFolderPath: '/home/ubuntu/misc/hello_world',
    });
    expect(sqliteSessionStore.load).toHaveBeenCalledWith({
      projectKey: '-home-ubuntu-misc-hello-world',
      sessionId: 'sess-1',
    });
  });

  it('returns [] when the store has no entries for that session', async () => {
    vi.mocked(sqliteSessionStore.load).mockResolvedValueOnce(null);
    const out = await loadAnthropicTranscript({
      providerSessionId: 'sess-empty',
      projectFolderPath: '/x',
    });
    expect(out).toEqual([]);
  });

  it('maps each SDK entry into one-or-more UnifiedMessage rows', async () => {
    vi.mocked(sqliteSessionStore.load).mockResolvedValueOnce([
      {
        type: 'assistant',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        message: {
          id: 'msg_1',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      },
      {
        type: 'result',
        session_id: 'sess-1',
        is_error: false,
      },
    ]);

    const out = await loadAnthropicTranscript({
      providerSessionId: 'sess-1',
      projectFolderPath: '/x',
    });

    // 1 assistant + 1 tool_use child + 1 result = 3
    expect(out).toHaveLength(3);
    expect(out[0]!.type).toBe('assistant');
    expect(out[1]!.type).toBe('tool_use');
    expect(out[2]!.type).toBe('result');
    expect(out[0]!.providerSessionId).toBe('sess-1');
  });
});
