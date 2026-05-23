import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SDKMessage } from '@shared/sdk/transcript';

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@anthropic-ai/claude-agent-sdk');
  return {
    ...actual,
    query: vi.fn(),
  };
});

vi.mock('../../sqliteSessionStore.js', () => ({
  sqliteSessionStore: {
    load: vi.fn(),
  },
}));

vi.mock('../../../database/db.js', () => ({
  agentRunsDb: {
    getByConversationId: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { sqliteSessionStore } from '../../sqliteSessionStore.js';
import { activeSessions } from '../../conversation/sessionState.js';
import { agentRunsDb } from '../../../database/db.js';
import { AnthropicProvider } from './index.js';

describe('AnthropicProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeSessions.clear();
  });

  it("name is 'anthropic'", () => {
    const p = new AnthropicProvider();
    expect(p.name).toBe('anthropic');
  });

  it('exposes the static capabilities matrix', () => {
    const p = new AnthropicProvider();
    const caps = p.getCapabilities();
    expect(caps.supportsAskUserQuestion).toBe(true);
    expect(caps.supportsThinkingDelta).toBe(true);
    expect(caps.supportsMcpServers).toBe(true);
  });

  it('startTurn streams mapped UnifiedMessages and resolves providerSessionId$ on first session_id', async () => {
    async function* fakeSdkStream(): AsyncGenerator<SDKMessage> {
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        parent_tool_use_id: null,
        message: { id: 'msg_1', content: [{ type: 'text', text: 'hi' }] },
      } as unknown as SDKMessage;
      yield {
        type: 'result',
        session_id: 'sess-1',
        is_error: false,
      } as unknown as SDKMessage;
    }
    vi.mocked(query).mockReturnValue(fakeSdkStream() as never);

    const p = new AnthropicProvider();
    const run = await p.startTurn({ cwd: '/x', prompt: 'hi', model: 'opus', effort: null });

    // providerSessionId$ resolves the first time an event with session_id
    // flows through the iterator — i.e. as the consumer iterates events,
    // not before. Race the two: assert the sid resolves to the first
    // session id we see.
    const collected = [];
    for await (const m of run.events) {
      collected.push(m);
    }
    const sid = await run.providerSessionId$;
    expect(sid).toBe('sess-1');

    // assistant + result = 2 (no tool_use children)
    expect(collected).toHaveLength(2);
    expect(collected[0]!.type).toBe('assistant');
    expect(collected[1]!.type).toBe('result');
  });

  it('sendTurnMessage forwards to startTurn with resumeSessionId', async () => {
    async function* fakeSdkStream(): AsyncGenerator<SDKMessage> {
      yield { type: 'system', session_id: 's', subtype: 'init' } as unknown as SDKMessage;
    }
    vi.mocked(query).mockReturnValue(fakeSdkStream() as never);

    const p = new AnthropicProvider();
    const run = await p.sendTurnMessage({ cwd: '/x', prompt: 'msg', model: 'opus', effort: null, resumeSessionId: 'old' });
    expect(run).toBeDefined();

    // Confirm the SDK was asked to resume.
    const sdkOptions = vi.mocked(query).mock.calls[0]![0].options as { resume?: string };
    expect(sdkOptions.resume).toBe('old');
  });

  it("abortTurn marks the linked agent run 'failed' and triggers its abort controller", () => {
    const ac = new AbortController();
    activeSessions.set('sess-active', {
      instance: {},
      abortController: ac,
      startTime: 1,
      status: 'active',
      tempImagePaths: [],
      tempDir: null,
      conversationId: 1,
      taskId: 1,
      projectId: 1,
      userId: 1,
    });
    vi.mocked(agentRunsDb.getByConversationId).mockReturnValue({
      id: 42,
      task_id: 1,
      agent_type: 'review',
      status: 'running',
      conversation_id: 1,
      provider: 'anthropic',
      created_at: '',
      completed_at: null,
    });
    const p = new AnthropicProvider();
    expect(p.abortTurn('sess-active')).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    expect(agentRunsDb.updateStatus).toHaveBeenCalledWith(42, 'failed');
  });

  it('abortTurn returns false when the session is unknown', () => {
    const p = new AnthropicProvider();
    expect(p.abortTurn('nope')).toBe(false);
  });

  it('loadTranscript delegates through to the session store mapper', async () => {
    vi.mocked(sqliteSessionStore.load).mockResolvedValueOnce([
      { type: 'system', session_id: 's', subtype: 'init' },
    ]);
    const p = new AnthropicProvider();
    const out = await p.loadTranscript({
      providerSessionId: 's',
      projectFolderPath: '/x',
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('system');
  });
});
