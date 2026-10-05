import { describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ThreadEvent } from '@openai/codex-sdk';

import {
  buildCodexOptions,
  CODEX_BOTTEGA_QUESTION_INSTRUCTIONS,
  CodexProvider,
} from './index.js';
import type { UnifiedMessage } from '@shared/providers/types';

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
  it('pre-approves only the per-turn allowlisted MCP gateway tools', () => {
    expect(buildCodexOptions({
      cwd: '/x',
      prompt: 'hello',
      model: 'gpt-6.1-sol',
      effort: null,
      extras: {
        mcpGateway: {
          name: 'bottega_turn_1',
          url: 'http://127.0.0.1:1234/mcp',
          token: 'secret-token',
          toolNames: ['ask_user', 'write_epic_document'],
        },
      },
    })).toEqual({
      config: {
        developer_instructions: CODEX_BOTTEGA_QUESTION_INSTRUCTIONS,
        mcp_servers: {
          bottega_turn_1: {
            url: 'http://127.0.0.1:1234/mcp',
            http_headers: { Authorization: 'Bearer secret-token' },
            enabled_tools: ['ask_user', 'write_epic_document'],
            default_tools_approval_mode: 'approve',
            required: true,
          },
        },
      },
    });
  });

  it('does not inject ask-user routing when the gateway does not expose that tool', () => {
    const options = buildCodexOptions({
      cwd: '/x',
      prompt: 'hello',
      model: 'gpt-6.1-sol',
      effort: null,
      extras: {
        mcpGateway: {
          name: 'bottega_turn_1',
          url: 'http://127.0.0.1:1234/mcp',
          token: 'secret-token',
          toolNames: ['write_epic_document'],
        },
      },
    });

    expect(options.config?.developer_instructions).toBeUndefined();
  });

  it("name is 'openai' and advertises portable interaction/MCP support", () => {
    const { codex } = makeFakeCodex([]);
    const p = new CodexProvider(codex);
    expect(p.name).toBe('openai');
    const caps = p.getCapabilities();
    expect(caps.supportsAskUserQuestion).toBe(true);
    expect(caps.supportsThinkingDelta).toBe(false);
    expect(caps.supportsMcpServers).toBe(true);
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
    const run = await p.startTurn({ cwd: '/x', prompt: 'hello', model: 'gpt-6.1-sol', effort: null });
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
    const run = await p.startTurn({ cwd: '/x', prompt: 'hi', model: 'gpt-6.1-sol', effort: null });
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
    await p.sendTurnMessage({ cwd: '/x', prompt: 'msg', model: 'gpt-6.1-sol', effort: null, resumeSessionId: 'tid-old' });
    expect((codex as unknown as { resumeThread: ReturnType<typeof vi.fn> }).resumeThread).toHaveBeenCalledWith(
      'tid-old',
      expect.objectContaining({ workingDirectory: '/x' }),
    );
  });

  describe('generated images', () => {
    // Signature + IHDR (64x48) + IEND: the least a complete PNG can be.
    const PNG = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
      Buffer.from('IHDR', 'ascii'),
      Buffer.from([0, 0, 0, 64, 0, 0, 0, 48]),
      Buffer.alloc(16),
      Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
    ]);
    const COMPLETED = {
      type: 'turn.completed',
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 },
    };

    /** A Codex whose turn drops an image into the thread's folder mid-stream, as `image_gen` does. */
    function makeImageGeneratingCodex(codexHome: string, threadId: string, fileName: string) {
      const thread = {
        async runStreamed(): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
          async function* gen(): AsyncGenerator<ThreadEvent> {
            yield { type: 'thread.started', thread_id: threadId };
            yield { type: 'turn.started' };
            const dir = path.join(codexHome, 'generated_images', threadId);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(path.join(dir, fileName), PNG);
            yield {
              type: 'item.completed',
              item: { type: 'agent_message', id: 'i1', text: 'The image is displayed above.' },
            };
            yield COMPLETED as ThreadEvent;
          }
          return { events: gen() };
        },
      };
      return {
        startThread: vi.fn(() => thread),
        resumeThread: vi.fn(() => thread),
      } as unknown as ConstructorParameters<typeof CodexProvider>[0];
    }

    it('reports an image Codex saved mid-turn, ahead of the message that mentions it', async () => {
      const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
      try {
        const p = new CodexProvider(makeImageGeneratingCodex(codexHome, 'tid-img', 'exec-1.png'));
        const run = await p.startTurn({
          cwd: '/x',
          prompt: 'draw',
          model: 'gpt-6.1-sol',
          effort: null,
          env: { CODEX_HOME: codexHome },
        });
        const collected: UnifiedMessage[] = [];
        for await (const m of run.events) collected.push(m);

        expect(collected.map((m) => m.type)).toEqual([
          'user',
          'system',
          'system',
          'assistant_image',
          'assistant',
          'result',
        ]);
        expect(collected[3]).toMatchObject({
          id: 'generated_image:exec-1.png',
          providerSessionId: 'tid-img',
          sourcePath: path.join(codexHome, 'generated_images', 'tid-img', 'exec-1.png'),
          fileName: 'exec-1.png',
          mimeType: 'image/png',
          width: 64,
          height: 48,
        });
      } finally {
        await fs.rm(codexHome, { recursive: true, force: true });
      }
    });

    it('on a resumed thread, reports only the image this turn produced', async () => {
      const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
      try {
        const dir = path.join(codexHome, 'generated_images', 'tid-old');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'earlier-turn.png'), PNG);

        const p = new CodexProvider(makeImageGeneratingCodex(codexHome, 'tid-old', 'this-turn.png'));
        const run = await p.sendTurnMessage({
          cwd: '/x',
          prompt: 'another',
          model: 'gpt-6.1-sol',
          effort: null,
          env: { CODEX_HOME: codexHome },
          resumeSessionId: 'tid-old',
        });
        const images: UnifiedMessage[] = [];
        for await (const m of run.events) if (m.type === 'assistant_image') images.push(m);

        expect(images.map((m) => (m as { fileName?: string }).fileName)).toEqual(['this-turn.png']);
      } finally {
        await fs.rm(codexHome, { recursive: true, force: true });
      }
    });
  });

  it('abortTurn returns false for an unknown session id', () => {
    const { codex } = makeFakeCodex([]);
    const p = new CodexProvider(codex);
    expect(p.abortTurn('unknown')).toBe(false);
  });
});
