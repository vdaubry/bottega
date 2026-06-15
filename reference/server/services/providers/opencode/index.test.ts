import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../openCodeServerPool.js', () => ({
  getOrSpawnOpenCodeServer: vi.fn(),
}));

import { getOrSpawnOpenCodeServer } from '../../openCodeServerPool.js';
import {
  InvalidOpenCodeModelError,
  listOpenCodeModels,
  OpenCodeProvider,
  parseOpenCodeModel,
  createOpenCodeProvider,
  openCodeProvider,
  openCodeGoProvider,
} from './index.js';

interface FakeClient {
  session: {
    create: ReturnType<typeof vi.fn>;
    promptAsync: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  };
  event: {
    subscribe: ReturnType<typeof vi.fn>;
  };
  config: {
    providers: ReturnType<typeof vi.fn>;
  };
}

function makeFakeHandle(events: unknown[]): { handle: { client: FakeClient; pid: number }; client: FakeClient } {
  // The SDK's ServerSentEventsResult.stream yields bare Event objects
  // (not { data: Event } envelopes) — mirror that here so the mock
  // exercises the production iteration shape.
  async function* stream(): AsyncGenerator<unknown> {
    for (const e of events) {
      yield e;
    }
  }
  const client: FakeClient = {
    session: {
      create: vi.fn(async () => ({ data: { id: 'sess_new_123' } })),
      promptAsync: vi.fn(async () => ({ ok: true })),
      abort: vi.fn(async () => true),
    },
    event: {
      subscribe: vi.fn(async () => ({ stream: stream() })),
    },
    config: {
      providers: vi.fn(async () => ({ data: { providers: [] } })),
    },
  };
  return {
    handle: { client, pid: 4242 },
    client,
  };
}

const ENV_WITH_USER = { BOTTEGA_USER_ID: '7', XDG_DATA_HOME: '/tmp/fake/7/data' };

describe('parseOpenCodeModel', () => {
  it("returns { providerID: 'opencode', modelID } for canonical kimi-k2.6", () => {
    expect(parseOpenCodeModel('opencode/kimi-k2.6')).toEqual({
      providerID: 'opencode',
      modelID: 'kimi-k2.6',
    });
  });

  it('parses qwen3-coder', () => {
    expect(parseOpenCodeModel('opencode/qwen3-coder')).toEqual({
      providerID: 'opencode',
      modelID: 'qwen3-coder',
    });
  });

  it('keeps a multi-segment modelID intact (only the first segment is the prefix)', () => {
    expect(parseOpenCodeModel('opencode/claude-opus-4-7')).toEqual({
      providerID: 'opencode',
      modelID: 'claude-opus-4-7',
    });
  });

  it('throws InvalidOpenCodeModelError on empty string', () => {
    expect(() => parseOpenCodeModel('')).toThrow(InvalidOpenCodeModelError);
  });

  it('throws InvalidOpenCodeModelError on a forced falsy value (runtime guard; the type now forbids undefined)', () => {
    expect(() => parseOpenCodeModel(undefined as unknown as string)).toThrow(
      InvalidOpenCodeModelError,
    );
  });

  it('throws on missing prefix', () => {
    expect(() => parseOpenCodeModel('kimi-k2.6')).toThrow(InvalidOpenCodeModelError);
  });

  it('throws on the wrong prefix (e.g. an old anthropic shape)', () => {
    expect(() => parseOpenCodeModel('anthropic/opus')).toThrow(InvalidOpenCodeModelError);
  });

  it('throws on the bare prefix with no modelID', () => {
    expect(() => parseOpenCodeModel('opencode/')).toThrow(InvalidOpenCodeModelError);
  });

  // OpenCode Go prefix tests
  it("returns { providerID: 'opencode-go', modelID } for canonical opencode-go model", () => {
    expect(parseOpenCodeModel('opencode-go/kimi-k2.6')).toEqual({
      providerID: 'opencode-go',
      modelID: 'kimi-k2.6',
    });
  });

  it('parses opencode-go/qwen3-coder', () => {
    expect(parseOpenCodeModel('opencode-go/qwen3-coder')).toEqual({
      providerID: 'opencode-go',
      modelID: 'qwen3-coder',
    });
  });

  it('keeps a multi-segment modelID intact for opencode-go prefix', () => {
    expect(parseOpenCodeModel('opencode-go/claude-opus-4-7')).toEqual({
      providerID: 'opencode-go',
      modelID: 'claude-opus-4-7',
    });
  });

  it('throws on the bare opencode-go prefix with no modelID', () => {
    expect(() => parseOpenCodeModel('opencode-go/')).toThrow(InvalidOpenCodeModelError);
  });
});

describe('OpenCodeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("name is 'opencode' and capabilities match the D8 matrix (all false)", () => {
    const p = createOpenCodeProvider('opencode');
    expect(p.name).toBe('opencode');
    const caps = p.getCapabilities();
    expect(caps.supportsAskUserQuestion).toBe(false);
    expect(caps.supportsThinkingDelta).toBe(false);
    expect(caps.supportsMcpServers).toBe(false);
    expect(caps.supportsImages).toBe(false);
    expect(caps.supportsContextUsageBreakdown).toBe(false);
  });

  it('startTurn calls session.create then session.prompt with the parsed model and serialised parts', async () => {
    const { handle, client } = makeFakeHandle([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'p1',
            sessionID: 'sess_new_123',
            messageID: 'msg_a',
            type: 'text',
            text: 'hi',
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'sess_new_123' } },
    ]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);

    const p = createOpenCodeProvider('opencode');
    const run = await p.startTurn({
      cwd: '/repo/worktree',
      prompt: 'ping',
      model: 'opencode/kimi-k2.6',
      effort: null,
      env: ENV_WITH_USER,
    });

    const collected: { type: string }[] = [];
    for await (const m of run.events) collected.push(m);

    expect(client.session.create).toHaveBeenCalledWith({
      body: { title: '' },
      query: { directory: '/repo/worktree' },
    });
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
    const call = client.session.promptAsync.mock.calls[0]![0];
    expect(call.path).toEqual({ id: 'sess_new_123' });
    expect(call.body.model).toEqual({ providerID: 'opencode', modelID: 'kimi-k2.6' });
    expect(call.body.agent).toBe('build');
    expect(call.body.parts).toEqual([{ type: 'text', text: 'ping' }]);

    // The first emitted message is the synthetic user, then the mapper's events.
    expect(collected[0]?.type).toBe('user');
    // session.idle terminates the stream and yields a result event.
    const lastResult = collected[collected.length - 1];
    expect(lastResult?.type).toBe('result');
  });

  it('sendTurnMessage skips session.create and uses the supplied resumeSessionId', async () => {
    const { handle, client } = makeFakeHandle([
      { type: 'session.idle', properties: { sessionID: 'sess_existing' } },
    ]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);

    const p = createOpenCodeProvider('opencode');
    const run = await p.sendTurnMessage({
      cwd: '/repo/worktree',
      prompt: 'follow up',
      model: 'opencode/qwen3-coder',
      effort: null,
      resumeSessionId: 'sess_existing',
      env: ENV_WITH_USER,
    });
    for await (const _ of run.events) void _;

    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: 'sess_existing' },
        body: expect.objectContaining({
          model: { providerID: 'opencode', modelID: 'qwen3-coder' },
        }),
      }),
    );
  });

  it('resolves providerSessionId$ to the new session id from session.create', async () => {
    const { handle } = makeFakeHandle([
      { type: 'session.idle', properties: { sessionID: 'sess_new_123' } },
    ]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    const p = createOpenCodeProvider('opencode');
    const run = await p.startTurn({
      cwd: '/repo',
      prompt: 'hi',
      model: 'opencode/kimi-k2.6',
      effort: null,
      env: ENV_WITH_USER,
    });
    for await (const _ of run.events) void _;
    expect(await run.providerSessionId$).toBe('sess_new_123');
  });

  it('synthesises a user event as the first emission', async () => {
    const { handle } = makeFakeHandle([
      { type: 'session.idle', properties: { sessionID: 'sess_new_123' } },
    ]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    const p = createOpenCodeProvider('opencode');
    const run = await p.startTurn({
      cwd: '/repo',
      prompt: 'hello world',
      model: 'opencode/kimi-k2.6',
      effort: null,
      env: ENV_WITH_USER,
    });
    const first = await run.events[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    expect((first.value as { type: string }).type).toBe('user');
    expect((first.value as { content: string }).content).toBe('hello world');
    // Drain to clean up the generator.
    for await (const _ of run.events) void _;
  });

  it('passes disallowedTools through as { tool: false } on session.prompt, and always disables `question`', async () => {
    const { handle, client } = makeFakeHandle([
      { type: 'session.idle', properties: { sessionID: 'sess_new_123' } },
    ]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    const p = createOpenCodeProvider('opencode');
    const run = await p.startTurn({
      cwd: '/repo',
      prompt: 'hi',
      model: 'opencode/kimi-k2.6',
      effort: null,
      env: ENV_WITH_USER,
      disallowedTools: ['Bash', 'Edit'],
    });
    for await (const _ of run.events) void _;
    const call = client.session.promptAsync.mock.calls[0]![0];
    expect(call.body.tools).toEqual({ question: false, Bash: false, Edit: false });
  });

  it('always disables `question` even when disallowedTools is empty (Bottega has no UI to answer it)', async () => {
    const { handle, client } = makeFakeHandle([
      { type: 'session.idle', properties: { sessionID: 'sess_new_123' } },
    ]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    const p = createOpenCodeProvider('opencode');
    const run = await p.startTurn({
      cwd: '/repo',
      prompt: 'hi',
      model: 'opencode/kimi-k2.6',
      effort: null,
      env: ENV_WITH_USER,
    });
    for await (const _ of run.events) void _;
    const call = client.session.promptAsync.mock.calls[0]![0];
    expect(call.body.tools).toEqual({ question: false });
  });

  it('threads cwd through to promptAsync as query.directory (without this OpenCode falls back to its serve-time process.cwd)', async () => {
    const { handle, client } = makeFakeHandle([
      { type: 'session.idle', properties: { sessionID: 'sess_new_123' } },
    ]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    const p = createOpenCodeProvider('opencode');
    const run = await p.startTurn({
      cwd: '/home/ubuntu/misc/hello_world-worktrees/task-1036',
      prompt: 'hi',
      model: 'opencode/kimi-k2.6',
      effort: null,
      env: ENV_WITH_USER,
    });
    for await (const _ of run.events) void _;
    const call = client.session.promptAsync.mock.calls[0]![0];
    expect(call.query?.directory).toBe('/home/ubuntu/misc/hello_world-worktrees/task-1036');
    // session.create is the other call that gets the directory.
    const createCall = client.session.create.mock.calls[0]![0];
    expect(createCall.query?.directory).toBe('/home/ubuntu/misc/hello_world-worktrees/task-1036');
  });

  it('includes the model in the promptAsync body when one is supplied (new session)', async () => {
    const { handle, client } = makeFakeHandle([
      { type: 'session.idle', properties: { sessionID: 'sess_new_123' } },
    ]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    const p = createOpenCodeProvider('opencode');
    const run = await p.startTurn({
      cwd: '/repo',
      prompt: 'hi',
      model: 'opencode/kimi-k2.6',
      effort: null,
      env: ENV_WITH_USER,
    });
    for await (const _ of run.events) void _;
    const call = client.session.promptAsync.mock.calls[0]![0];
    expect(call.body.model).toEqual({ providerID: 'opencode', modelID: 'kimi-k2.6' });
  });

  it('resumes WITH the stored model — always includes body.model (deterministic resume)', async () => {
    // The orchestrator now reads the conversation row's stored model and passes
    // it on every resume, so a turn never relies on OpenCode silently reusing
    // SessionTable.model. `model` is required on the provider call.
    const { handle, client } = makeFakeHandle([
      { type: 'session.idle', properties: { sessionID: 'sess_existing_42' } },
    ]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    const p = createOpenCodeProvider('opencode');
    const run = await p.sendTurnMessage({
      cwd: '/repo',
      prompt: 'follow-up message',
      model: 'opencode/kimi-k2.6',
      effort: null,
      resumeSessionId: 'sess_existing_42',
      env: ENV_WITH_USER,
    });
    for await (const _ of run.events) void _;
    const call = client.session.promptAsync.mock.calls[0]![0];
    expect(call.path.id).toBe('sess_existing_42');
    expect(call.body.model).toEqual({ providerID: 'opencode', modelID: 'kimi-k2.6' });
    // The turn still runs (agent + parts present).
    expect(call.body.agent).toBe('build');
    expect(call.body.parts).toEqual([{ type: 'text', text: 'follow-up message' }]);
  });

  it('threads cwd through to event.subscribe as query.directory (OpenCode /event is workspace-scoped — without this the subscription lands on the default bus and session events never reach Bottega)', async () => {
    const { handle, client } = makeFakeHandle([
      { type: 'session.idle', properties: { sessionID: 'sess_new_123' } },
    ]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    const p = createOpenCodeProvider('opencode');
    const run = await p.startTurn({
      cwd: '/home/ubuntu/misc/hello_world-worktrees/task-1036',
      prompt: 'hi',
      model: 'opencode/kimi-k2.6',
      effort: null,
      env: ENV_WITH_USER,
    });
    for await (const _ of run.events) void _;
    const subscribeCall = client.event.subscribe.mock.calls[0]![0];
    expect(subscribeCall.query?.directory).toBe('/home/ubuntu/misc/hello_world-worktrees/task-1036');
    // sseMaxRetryAttempts=1 disables the SDK's default infinite retry loop so
    // the for-await's `finally` can fire when the upstream closes.
    expect(subscribeCall.sseMaxRetryAttempts).toBe(1);
  });

  it('drops message.part.updated events whose part.sessionID belongs to a sub-agent (not the parent session)', async () => {
    const { handle } = makeFakeHandle([
      // Sub-agent tool part — same shape OpenCode publishes for nested Task tool calls.
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'p_subagent',
            sessionID: 'sess_subagent_999',
            messageID: 'msg_sub',
            type: 'tool',
            callID: 'call_x',
            tool: 'bash',
            state: { status: 'completed', input: {}, output: 'ok' },
          },
        },
      },
      { type: 'session.idle', properties: { sessionID: 'sess_new_123' } },
    ]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    const p = createOpenCodeProvider('opencode');
    const run = await p.startTurn({
      cwd: '/repo',
      prompt: 'hi',
      model: 'opencode/kimi-k2.6',
      effort: null,
      env: ENV_WITH_USER,
    });
    const collected: { type: string }[] = [];
    for await (const m of run.events) {
      collected.push(m as { type: string });
    }
    // Only the synthetic user + the session.idle result — no orphan tool_use/tool_result.
    expect(collected.map((m) => m.type)).toEqual(['user', 'result']);
  });

  it('emits a synthetic isError result when the SSE stream ends without session.idle/error', async () => {
    const { handle } = makeFakeHandle([
      // No terminator event — just one assistant text part, then EOS.
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'p1',
            sessionID: 'sess_new_123',
            messageID: 'msg_a',
            type: 'text',
            text: 'partial',
          },
        },
      },
    ]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    const p = createOpenCodeProvider('opencode');
    const run = await p.startTurn({
      cwd: '/repo',
      prompt: 'hi',
      model: 'opencode/kimi-k2.6',
      effort: null,
      env: ENV_WITH_USER,
    });
    const collected: { type: string; isError?: boolean }[] = [];
    for await (const m of run.events) {
      collected.push(m as { type: string; isError?: boolean });
    }
    const last = collected[collected.length - 1]!;
    expect(last.type).toBe('result');
    expect(last.isError).toBe(true);
  });

  it('abortTurn returns false for an unknown session id', () => {
    const p = createOpenCodeProvider('opencode');
    expect(p.abortTurn('not-a-real-session')).toBe(false);
  });

  it('abortTurn returns true and calls session.abort once a turn is registered', async () => {
    const { handle, client } = makeFakeHandle([
      { type: 'session.idle', properties: { sessionID: 'sess_new_123' } },
    ]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    const p = createOpenCodeProvider('opencode');
    const run = await p.startTurn({
      cwd: '/repo',
      prompt: 'hi',
      model: 'opencode/kimi-k2.6',
      effort: null,
      env: ENV_WITH_USER,
    });
    // Drain so providerSessionId$ resolves and the active-sessions map is populated.
    for await (const _ of run.events) void _;
    await run.providerSessionId$;

    expect(p.abortTurn('sess_new_123')).toBe(true);
    // The server-side abort MUST carry the turn's workspace directory —
    // OpenCode's /session/:id/abort is workspace-scoped (same routing as
    // promptAsync/event.subscribe). Without `query.directory` the cancel
    // lands on the serve-time default workspace and the real turn keeps
    // running (caught live by the abort E2E probe: the agent finished
    // counting and wrote its file ~15s after Stop).
    expect(client.session.abort).toHaveBeenCalledWith({
      path: { id: 'sess_new_123' },
      query: { directory: '/repo' },
    });

    // Second call (already aborted, entry deleted) returns false.
    expect(p.abortTurn('sess_new_123')).toBe(false);
  });

  it('throws when the env does not carry BOTTEGA_USER_ID', async () => {
    const p = createOpenCodeProvider('opencode');
    await expect(
      p.startTurn({
        cwd: '/repo',
        prompt: 'hi',
        model: 'opencode/kimi-k2.6',
        effort: null,
        env: { XDG_DATA_HOME: '/tmp/x' },
      }),
    ).rejects.toThrow(/BOTTEGA_USER_ID/);
  });
});

describe('createOpenCodeProvider factory', () => {
  it("creates an opencode provider with name 'opencode'", () => {
    const provider = createOpenCodeProvider('opencode');
    expect(provider.name).toBe('opencode');
    const caps = provider.getCapabilities();
    expect(caps.supportsAskUserQuestion).toBe(false);
    expect(caps.supportsThinkingDelta).toBe(false);
  });

  it("creates an opencode-go provider with name 'opencode-go'", () => {
    const provider = createOpenCodeProvider('opencode-go');
    expect(provider.name).toBe('opencode-go');
    const caps = provider.getCapabilities();
    expect(caps.supportsAskUserQuestion).toBe(false);
    expect(caps.supportsThinkingDelta).toBe(false);
  });

  it('exported openCodeProvider has correct name and capabilities', () => {
    expect(openCodeProvider.name).toBe('opencode');
    const caps = openCodeProvider.getCapabilities();
    expect(caps.supportsAskUserQuestion).toBe(false);
  });

  it('exported openCodeGoProvider has correct name and capabilities', () => {
    expect(openCodeGoProvider.name).toBe('opencode-go');
    const caps = openCodeGoProvider.getCapabilities();
    expect(caps.supportsAskUserQuestion).toBe(false);
  });
});

describe('listOpenCodeModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only the opencode provider's models, prefixed and alpha-sorted", async () => {
    const { handle, client } = makeFakeHandle([]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    client.config.providers.mockResolvedValueOnce({
      data: {
        providers: [
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: { 'claude-opus-4-7': { id: 'claude-opus-4-7', name: 'Opus 4.7' } },
          },
          {
            id: 'opencode',
            name: 'OpenCode',
            models: {
              'qwen3.6-plus': {
                id: 'qwen3.6-plus',
                name: 'Qwen3.6 Plus',
                status: 'active',
                limit: { context: 128000, output: 8000 },
              },
              'kimi-k2.6': {
                id: 'kimi-k2.6',
                name: 'Kimi K2.6',
                status: 'active',
                limit: { context: 200000, output: 8000 },
              },
              'glm-5': {
                id: 'glm-5',
                name: 'GLM 5',
                status: 'beta',
                // No `limit.context` → reported as null in the response.
              },
            },
          },
        ],
      },
    });

    const result = await listOpenCodeModels(7, 'opencode');
    expect(result.map((m) => m.id)).toEqual([
      'opencode/glm-5',
      'opencode/kimi-k2.6',
      'opencode/qwen3.6-plus',
    ]);
    expect(result[0]).toMatchObject({
      id: 'opencode/glm-5',
      bareModelId: 'glm-5',
      name: 'GLM 5',
      status: 'beta',
      contextWindow: null,
    });
    expect(result[1]).toMatchObject({
      id: 'opencode/kimi-k2.6',
      contextWindow: 200000,
    });
  });

  it("returns [] when the response carries no `opencode` provider entry", async () => {
    const { handle, client } = makeFakeHandle([]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    client.config.providers.mockResolvedValueOnce({
      data: {
        providers: [
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: { 'claude-opus-4-7': { id: 'claude-opus-4-7' } },
          },
        ],
      },
    });
    const result = await listOpenCodeModels(7, 'opencode');
    expect(result).toEqual([]);
  });

  it("handles the bare-`providers` shape (no `data` envelope) some SDK versions return", async () => {
    const { handle, client } = makeFakeHandle([]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    client.config.providers.mockResolvedValueOnce({
      providers: [
        {
          id: 'opencode',
          name: 'OpenCode',
          models: { 'kimi-k2.6': { id: 'kimi-k2.6', name: 'Kimi K2.6' } },
        },
      ],
    });
    const result = await listOpenCodeModels(7, 'opencode');
    expect(result.map((m) => m.id)).toEqual(['opencode/kimi-k2.6']);
  });

  it('falls back to bareModelId for the label when OpenCode omits `name`', async () => {
    const { handle, client } = makeFakeHandle([]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    client.config.providers.mockResolvedValueOnce({
      data: {
        providers: [
          {
            id: 'opencode',
            name: 'OpenCode',
            models: { 'oddly-unnamed-model': { id: 'oddly-unnamed-model' } },
          },
        ],
      },
    });
    const result = await listOpenCodeModels(7, 'opencode');
    expect(result[0]?.name).toBe('oddly-unnamed-model');
    expect(result[0]?.status).toBe('unknown');
  });

  it("returns only the opencode-go provider's models with opencode-go/ prefix, alpha-sorted", async () => {
    const { handle, client } = makeFakeHandle([]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    client.config.providers.mockResolvedValueOnce({
      data: {
        providers: [
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: { 'claude-opus-4-7': { id: 'claude-opus-4-7', name: 'Opus 4.7' } },
          },
          {
            id: 'opencode-go',
            name: 'OpenCode Go',
            models: {
              'deepseek-r1': {
                id: 'deepseek-r1',
                name: 'DeepSeek R1',
                status: 'active',
                limit: { context: 64000, output: 8000 },
              },
              'qwen3-coder': {
                id: 'qwen3-coder',
                name: 'Qwen3 Coder',
                status: 'active',
                limit: { context: 128000, output: 8000 },
              },
            },
          },
        ],
      },
    });

    const result = await listOpenCodeModels(7, 'opencode-go');
    expect(result.map((m) => m.id)).toEqual([
      'opencode-go/deepseek-r1',
      'opencode-go/qwen3-coder',
    ]);
    expect(result[0]).toMatchObject({
      id: 'opencode-go/deepseek-r1',
      bareModelId: 'deepseek-r1',
      name: 'DeepSeek R1',
      status: 'active',
      contextWindow: 64000,
    });
  });

  it("returns [] when the response carries no `opencode-go` provider entry", async () => {
    const { handle, client } = makeFakeHandle([]);
    vi.mocked(getOrSpawnOpenCodeServer).mockResolvedValue(handle as never);
    client.config.providers.mockResolvedValueOnce({
      data: {
        providers: [
          {
            id: 'opencode',
            name: 'OpenCode',
            models: { 'kimi-k2.6': { id: 'kimi-k2.6' } },
          },
        ],
      },
    });
    const result = await listOpenCodeModels(7, 'opencode-go');
    expect(result).toEqual([]);
  });
});
