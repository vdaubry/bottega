import { describe, it, expect, vi } from 'vitest';
import type { ThreadEvent } from '@openai/codex-sdk';

import { CodexProvider } from './index.js';

function makeFakeCodex(events: ThreadEvent[]) {
  const thread = {
    id: null as string | null,
    async runStreamed(): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
      async function* gen(): AsyncGenerator<ThreadEvent> {
        for (const e of events) yield e;
      }
      return { events: gen() };
    },
  };
  const codex = {
    startThread: vi.fn(() => thread),
    resumeThread: vi.fn(() => thread),
  };
  return { codex: codex as unknown as ConstructorParameters<typeof CodexProvider>[0], thread };
}

describe('CodexProvider', () => {
  it("name is 'openai' and capabilities match the conservative v1 matrix", () => {
    const { codex } = makeFakeCodex([]);
    const p = new CodexProvider(codex);
    expect(p.name).toBe('openai');
    const caps = p.getCapabilities();
    expect(caps.supportsAskUserQuestion).toBe(false);
    expect(caps.supportsThinkingDelta).toBe(false);
    expect(caps.supportsMcpServers).toBe(false);
    expect(caps.supportsImages).toBe(false);
  });

  it('startTurn yields a synthetic user message first, then mapped SDK events', async () => {
    const { codex } = makeFakeCodex([
      { type: 'thread.started', thread_id: 'tid-1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', id: 'i1', text: 'hi' } } as never,
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 },
      },
    ] as never);

    const p = new CodexProvider(codex);
    const run = await p.startTurn({ cwd: '/x', prompt: 'hello', model: 'gpt-5.5', effort: null });
    const collected: { type: string }[] = [];
    for await (const m of run.events) collected.push(m);

    expect(collected[0]!.type).toBe('user');
    expect((collected[0] as { content?: string }).content).toBe('hello');
    expect(collected[1]!.type).toBe('system'); // thread.started
    expect(collected[2]!.type).toBe('system'); // turn.started
    expect(collected[3]!.type).toBe('assistant');
    expect(collected[4]!.type).toBe('result');
  });

  it('resolves providerSessionId$ on the thread.started event', async () => {
    const { codex } = makeFakeCodex([
      { type: 'thread.started', thread_id: 'tid-xyz' },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
      },
    ] as never);
    const p = new CodexProvider(codex);
    const run = await p.startTurn({ cwd: '/x', prompt: 'hi', model: 'gpt-5.5', effort: null });
    // Drain the events so the generator runs the thread.started branch.
    for await (const _ of run.events) {
      void _;
    }
    const id = await run.providerSessionId$;
    expect(id).toBe('tid-xyz');
  });

  it('sendTurnMessage calls resumeThread with the supplied id', async () => {
    const { codex } = makeFakeCodex([
      { type: 'thread.started', thread_id: 'tid-old' },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
      },
    ] as never);
    const p = new CodexProvider(codex);
    await p.sendTurnMessage({ cwd: '/x', prompt: 'msg', model: 'gpt-5.5', effort: null, resumeSessionId: 'tid-old' });
    expect((codex as unknown as { resumeThread: ReturnType<typeof vi.fn> }).resumeThread).toHaveBeenCalledWith(
      'tid-old',
      expect.objectContaining({ workingDirectory: '/x' }),
    );
  });

  it('abortTurn returns false for an unknown session id', () => {
    const { codex } = makeFakeCodex([]);
    const p = new CodexProvider(codex);
    expect(p.abortTurn('unknown')).toBe(false);
  });
});
