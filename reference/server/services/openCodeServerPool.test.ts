import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import {
  _resetOpenCodeServerPool,
  getOpenCodeServerStatus,
  getOrSpawnOpenCodeServer,
  invalidateOpenCodeServer,
  shutdownAllOpenCodeServers,
  shutdownOpenCodeServer,
} from './openCodeServerPool.js';

/** Spawn a fake child process that emits a ready line on stdout, with controllable lifecycle. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 1000 + Math.floor(Math.random() * 9000);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  spawnArgs: string[];
  env: NodeJS.ProcessEnv;

  constructor(args: string[], env: NodeJS.ProcessEnv) {
    super();
    this.spawnArgs = args;
    this.env = env;
  }

  emitReady(port: number): void {
    this.stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`);
  }

  emitCrash(code: number): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }

  kill(signal: NodeJS.Signals | number | undefined): boolean {
    this.killed = true;
    if (this.exitCode === null) {
      this.exitCode = 0;
      this.signalCode =
        typeof signal === 'string' ? signal : ('SIGTERM' as NodeJS.Signals);
      // simulate async exit
      setImmediate(() => this.emit('exit', null, this.signalCode));
    }
    return true;
  }
}

interface SpawnRecord {
  port: number;
  args: string[];
  env: NodeJS.ProcessEnv;
  child: FakeChild;
}

function makeDeps() {
  let nextPort = 41001;
  const spawnRecords: SpawnRecord[] = [];
  const pendingPorts: number[] = [];

  // pickPort returns predictable ports.
  const pickPort = vi.fn(async () => {
    if (pendingPorts.length > 0) return pendingPorts.shift()!;
    return nextPort++;
  });

  const spawnFn = vi.fn((_cmd: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
    const portIdx = args.indexOf('--port');
    const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 0;
    const child = new FakeChild(Array.from(args), options.env ?? {});
    spawnRecords.push({ port, args: Array.from(args), env: options.env ?? {}, child });
    // Emit ready on next tick so the consumer registers listeners first.
    setImmediate(() => child.emitReady(port));
    return child as unknown as ReturnType<typeof import('child_process').spawn>;
  });

  const buildEnv = vi.fn((userId: number) => ({
    HOME: '/tmp/fake-home',
    XDG_DATA_HOME: `/tmp/fake/${userId}/data`,
    XDG_CONFIG_HOME: `/tmp/fake/${userId}/config`,
    XDG_STATE_HOME: `/tmp/fake/${userId}/state`,
    XDG_CACHE_HOME: `/tmp/fake/${userId}/cache`,
    GH_CONFIG_DIR: '/tmp/fake-host-gh',
    OPENCODE_CONFIG: '/dev/null',
  })) as unknown as (userId: number) => NodeJS.ProcessEnv;

  const createClient = vi.fn((config?: { baseUrl?: string; headers?: Record<string, string> }) => {
    return {
      __test_baseUrl: config?.baseUrl,
      __test_headers: config?.headers,
    } as unknown as ReturnType<typeof import('@opencode-ai/sdk').createOpencodeClient>;
  }) as unknown as typeof import('@opencode-ai/sdk').createOpencodeClient;

  let mockNow = 1_000_000_000;
  const now = vi.fn(() => mockNow);

  return {
    deps: {
      spawnFn,
      pickPort,
      buildEnv,
      createClient,
      readyTimeoutMs: 5000,
      idleTimeoutMs: 60_000,
      reapIntervalMs: 1000,
      maxServers: Number.POSITIVE_INFINITY,
      now,
    },
    spawnFn,
    pickPort,
    buildEnv,
    createClient,
    spawnRecords,
    pendingPorts,
    advanceTime: (ms: number) => {
      mockNow += ms;
    },
    setNow: (t: number) => {
      mockNow = t;
    },
  };
}

describe('openCodeServerPool', () => {
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    ctx = makeDeps();
    _resetOpenCodeServerPool(ctx.deps);
  });

  afterEach(async () => {
    await shutdownAllOpenCodeServers();
    _resetOpenCodeServerPool();
  });

  it('lazy-spawns one server on first call and reuses it on the second', async () => {
    const handle1 = await getOrSpawnOpenCodeServer(7);
    expect(handle1.userId).toBe(7);
    expect(handle1.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(handle1.port).toBeGreaterThan(0);
    expect(ctx.spawnFn).toHaveBeenCalledTimes(1);

    const handle2 = await getOrSpawnOpenCodeServer(7);
    expect(handle2).toBe(handle1);
    expect(ctx.spawnFn).toHaveBeenCalledTimes(1);
  });

  it('spawns separate servers per user', async () => {
    const a = await getOrSpawnOpenCodeServer(1);
    const b = await getOrSpawnOpenCodeServer(2);
    expect(a.port).not.toBe(b.port);
    expect(a.baseUrl).not.toBe(b.baseUrl);
    expect(ctx.spawnFn).toHaveBeenCalledTimes(2);
  });

  it('serialises concurrent first-spawn requests for the same user', async () => {
    const [a, b] = await Promise.all([
      getOrSpawnOpenCodeServer(7),
      getOrSpawnOpenCodeServer(7),
    ]);
    expect(a).toBe(b);
    expect(ctx.spawnFn).toHaveBeenCalledTimes(1);
  });

  it('passes a per-server password via env and uses it in the Basic auth header', async () => {
    const handle = await getOrSpawnOpenCodeServer(7);
    const rec = ctx.spawnRecords[0]!;
    expect(rec.env['OPENCODE_SERVER_PASSWORD']).toBeDefined();
    expect(rec.env['OPENCODE_SERVER_PASSWORD']!.length).toBeGreaterThan(20);
    expect(rec.env['OPENCODE_SERVER_USERNAME']).toBe('opencode');
    const expectedAuth = `Basic ${Buffer.from(`opencode:${rec.env['OPENCODE_SERVER_PASSWORD']}`).toString('base64')}`;
    expect((handle.client as unknown as { __test_headers: Record<string, string> }).__test_headers!['authorization']).toBe(expectedAuth);
  });

  it('passes the per-user XDG dirs through to the spawned process env', async () => {
    await getOrSpawnOpenCodeServer(42);
    const rec = ctx.spawnRecords[0]!;
    expect(rec.env['XDG_DATA_HOME']).toBe('/tmp/fake/42/data');
    expect(rec.env['XDG_CONFIG_HOME']).toBe('/tmp/fake/42/config');
    expect(rec.env['GH_CONFIG_DIR']).toBe('/tmp/fake-host-gh');
    expect(rec.env['OPENCODE_CONFIG']).toBe('/dev/null');
  });

  it('drops the handle from the pool on unexpected child exit', async () => {
    const handle = await getOrSpawnOpenCodeServer(7);
    expect(getOpenCodeServerStatus(7).running).toBe(true);
    const rec = ctx.spawnRecords[0]!;
    rec.child.emitCrash(137);
    // Allow the exit listeners to run.
    await new Promise((r) => setImmediate(r));
    expect(getOpenCodeServerStatus(7).running).toBe(false);
    expect(handle.stale).toBe(true);
  });

  it('spawns a fresh server after a crash on the next get', async () => {
    await getOrSpawnOpenCodeServer(7);
    ctx.spawnRecords[0]!.child.emitCrash(1);
    await new Promise((r) => setImmediate(r));
    await getOrSpawnOpenCodeServer(7);
    expect(ctx.spawnFn).toHaveBeenCalledTimes(2);
  });

  it('idle reaper SIGTERMs servers idle past the timeout', async () => {
    const handle = await getOrSpawnOpenCodeServer(7);
    expect(getOpenCodeServerStatus(7).running).toBe(true);
    // Bump clock past idleTimeoutMs.
    ctx.advanceTime(61_000);
    // Fire the reaper interval directly via vi.useFakeTimers to avoid
    // depending on wall-clock — instead just advance and manually trigger
    // by re-creating the pool with reapIntervalMs short enough to hit.
    // Wait for the next interval (1s configured).
    await vi.waitFor(
      () => {
        expect(handle.stale).toBe(true);
        expect(getOpenCodeServerStatus(7).running).toBe(false);
      },
      { timeout: 3000, interval: 50 },
    );
  });

  it('shutdownAll SIGTERMs every child and clears the pool', async () => {
    await getOrSpawnOpenCodeServer(1);
    await getOrSpawnOpenCodeServer(2);
    expect(ctx.spawnRecords.length).toBe(2);
    await shutdownAllOpenCodeServers();
    expect(ctx.spawnRecords[0]!.child.killed).toBe(true);
    expect(ctx.spawnRecords[1]!.child.killed).toBe(true);
    expect(getOpenCodeServerStatus(1).running).toBe(false);
    expect(getOpenCodeServerStatus(2).running).toBe(false);
  });

  it('shutdownOpenCodeServer terminates a single user', async () => {
    await getOrSpawnOpenCodeServer(1);
    await getOrSpawnOpenCodeServer(2);
    await shutdownOpenCodeServer(1);
    expect(ctx.spawnRecords[0]!.child.killed).toBe(true);
    expect(ctx.spawnRecords[1]!.child.killed).toBe(false);
  });

  it('invalidate triggers a fresh spawn on the next get', async () => {
    const first = await getOrSpawnOpenCodeServer(7);
    await invalidateOpenCodeServer(7);
    expect(first.stale).toBe(true);
    const second = await getOrSpawnOpenCodeServer(7);
    expect(second).not.toBe(first);
    expect(ctx.spawnFn).toHaveBeenCalledTimes(2);
  });

  it('LRU evicts when the pool reaches OPENCODE_MAX_SERVERS', async () => {
    _resetOpenCodeServerPool({ ...ctx.deps, maxServers: 2 });
    await getOrSpawnOpenCodeServer(1);
    ctx.advanceTime(10);
    await getOrSpawnOpenCodeServer(2);
    ctx.advanceTime(10);
    // user 3 should evict user 1 (oldest lastUsedAt)
    await getOrSpawnOpenCodeServer(3);
    expect(getOpenCodeServerStatus(1).running).toBe(false);
    expect(getOpenCodeServerStatus(2).running).toBe(true);
    expect(getOpenCodeServerStatus(3).running).toBe(true);
  });

  it('retries once on EADDRINUSE during spawn', async () => {
    // Make pickPort return 42000, then 42001.
    ctx.pendingPorts.push(42000, 42001);
    // First spawn call: emit error EADDRINUSE before stdout.
    const realSpawn = ctx.spawnFn.getMockImplementation()!;
    let call = 0;
    ctx.spawnFn.mockImplementation(((cmd: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      call += 1;
      if (call === 1) {
        const child = new FakeChild(Array.from(args), options.env ?? {});
        setImmediate(() => {
          const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
          child.emit('error', err);
        });
        return child as unknown as ReturnType<typeof import('child_process').spawn>;
      }
      return realSpawn(cmd, args, options);
    }) as typeof ctx.spawnFn extends (...a: infer A) => infer R ? (...a: A) => R : never);
    const handle = await getOrSpawnOpenCodeServer(7);
    expect(handle.port).toBe(42001);
    expect(ctx.spawnFn).toHaveBeenCalledTimes(2);
  });

  it('rejects when readiness times out and kills the half-spawned child', async () => {
    _resetOpenCodeServerPool({ ...ctx.deps, readyTimeoutMs: 100 });
    // Override spawnFn to NOT emit ready.
    let captured: FakeChild | null = null;
    ctx.spawnFn.mockImplementation(((_cmd: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(Array.from(args), options.env ?? {});
      captured = child;
      return child as unknown as ReturnType<typeof import('child_process').spawn>;
    }) as typeof ctx.spawnFn extends (...a: infer A) => infer R ? (...a: A) => R : never);

    await expect(getOrSpawnOpenCodeServer(9)).rejects.toThrow(/Timeout waiting/);
    expect(captured).not.toBeNull();
    expect((captured as unknown as FakeChild).killed).toBe(true);
  });
});
