// Per-user OpenCode server pool.
//
// Bottega spawns one `opencode serve` per user (D1). The pool keeps
// those subprocesses warm across turns and tears them down when idle.
// Every consumer (`OpenCodeProvider`, REST routes, agentRunner) goes
// through `getOrSpawnOpenCodeServer(userId)` — never spawns directly.
//
// References:
// - D1: per-user lazy-spawned, pooled in-process, idle-reaped (15 min).
// - R5: pool invalidation on credential mutation. When the per-user
//   Zen key is written or cleared, the running server still serves the
//   *old* auth.json it cached at startup. `invalidate(userId)` marks
//   the handle stale and schedules a SIGTERM so the next call awaits
//   shutdown and spawns a fresh server.
// - R13: LRU eviction (`OPENCODE_MAX_SERVERS`), port-race retry on
//   `EADDRINUSE`, `OPENCODE_CONFIG=/dev/null` to block project-local
//   config (set in `buildOpenCodeSpawnEnv`), readiness via stdout
//   grep (the upstream SDK's pattern; `/global/health` isn't exposed
//   on the JS SDK at 1.15.5).
// - Auth: `OPENCODE_SERVER_PASSWORD` gates every endpoint, including
//   `/event` SSE. Without it any process on the box could reach a
//   user's server on 127.0.0.1.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createServer } from 'net';
import { randomBytes } from 'crypto';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { buildOpenCodeSpawnEnv } from './openCodeCredentials.js';

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_REAP_INTERVAL_MS = 60_000;
const READY_LINE_PREFIX = 'opencode server listening';

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface OpenCodeServerHandle {
  userId: number;
  baseUrl: string;
  port: number;
  client: OpencodeClient;
  pid: number | null;
  startedAt: number;
  lastUsedAt: number;
  /** Mark this handle stale so the next get() awaits shutdown. */
  stale: boolean;
}

/**
 * Internal state kept per running server. Distinct from the public
 * handle so consumers can't accidentally hold the child process or the
 * password.
 */
interface OpenCodeServerEntry {
  handle: OpenCodeServerHandle;
  child: ChildProcessWithoutNullStreams;
  password: string;
  /** Pending shutdown promise after invalidate() / idle reap / SIGTERM. */
  shutdown$?: Promise<void>;
  /** Resolves the first time the child exits. */
  exited$: Promise<void>;
}

/**
 * Narrow spawn signature the pool needs — accepts the (command, args,
 * options) form only. Typing this as `typeof spawn` would forbid the
 * single-arg overloads and propagate spurious incompatibilities to
 * `Partial<SpawnDeps>` in tests. We deliberately don't return
 * `ChildProcessWithoutNullStreams` here either, so test mocks can return
 * a lightweight fake; the consumer casts via `as unknown as` after the
 * call.
 */
type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; stdio?: unknown; detached?: boolean },
) => unknown;

interface SpawnDeps {
  spawnFn: SpawnFn;
  pickPort: () => Promise<number>;
  buildEnv: (userId: number) => NodeJS.ProcessEnv;
  createClient: typeof createOpencodeClient;
  readyTimeoutMs: number;
  idleTimeoutMs: number;
  reapIntervalMs: number;
  maxServers: number;
  /** Test hook — current monotonic time. */
  now: () => number;
}

const defaultDeps: SpawnDeps = {
  spawnFn: spawn as unknown as SpawnFn,
  pickPort: pickFreePort,
  buildEnv: (userId) =>
    buildOpenCodeSpawnEnv(userId) as NodeJS.ProcessEnv,
  createClient: createOpencodeClient,
  readyTimeoutMs: parseIntEnv(
    process.env['OPENCODE_READY_TIMEOUT_MS'],
    DEFAULT_READY_TIMEOUT_MS,
  ),
  idleTimeoutMs: parseIntEnv(
    process.env['OPENCODE_IDLE_TIMEOUT_MS'],
    DEFAULT_IDLE_TIMEOUT_MS,
  ),
  reapIntervalMs: parseIntEnv(
    process.env['OPENCODE_REAP_INTERVAL_MS'],
    DEFAULT_REAP_INTERVAL_MS,
  ),
  maxServers: parseIntEnv(
    process.env['OPENCODE_MAX_SERVERS'],
    Number.POSITIVE_INFINITY,
  ),
  now: () => Date.now(),
};

/**
 * Singleton pool state. Exposed via the exported functions; the
 * `_resetForTests` hook below replaces this for unit tests.
 */
class OpenCodeServerPool {
  private readonly entries = new Map<number, OpenCodeServerEntry>();
  private readonly pending = new Map<number, Promise<OpenCodeServerHandle>>();
  private reapTimer: NodeJS.Timeout | null = null;
  private deps: SpawnDeps;

  constructor(deps: SpawnDeps) {
    this.deps = deps;
  }

  setDeps(partial: Partial<SpawnDeps>): void {
    this.deps = { ...this.deps, ...partial };
  }

  getStatus(userId: number): { running: boolean; lastUsedAt: number | null } {
    const entry = this.entries.get(userId);
    if (!entry) return { running: false, lastUsedAt: null };
    return { running: !entry.handle.stale, lastUsedAt: entry.handle.lastUsedAt };
  }

  async getOrSpawn(userId: number): Promise<OpenCodeServerHandle> {
    const existing = this.entries.get(userId);
    if (existing && !existing.handle.stale) {
      existing.handle.lastUsedAt = this.deps.now();
      return existing.handle;
    }
    if (existing && existing.handle.stale) {
      // Wait for in-flight shutdown to complete before spawning fresh.
      await existing.shutdown$;
    }
    const inFlight = this.pending.get(userId);
    if (inFlight) return inFlight;
    const promise = this.spawnEntry(userId).finally(() => {
      this.pending.delete(userId);
    });
    this.pending.set(userId, promise);
    return promise;
  }

  async invalidate(userId: number): Promise<void> {
    const entry = this.entries.get(userId);
    if (!entry) return;
    entry.handle.stale = true;
    if (!entry.shutdown$) {
      entry.shutdown$ = this.terminate(entry);
    }
    await entry.shutdown$;
  }

  async shutdown(userId: number): Promise<void> {
    return this.invalidate(userId);
  }

  async shutdownAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      entry.handle.stale = true;
      if (!entry.shutdown$) entry.shutdown$ = this.terminate(entry);
      tasks.push(entry.shutdown$);
    }
    await Promise.allSettled(tasks);
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
  }

  /** Test helper — drop every entry without awaiting termination. */
  _hardReset(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    for (const entry of this.entries.values()) {
      try {
        entry.child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    this.entries.clear();
    this.pending.clear();
  }

  private startReaperIfNeeded(): void {
    if (this.reapTimer) return;
    if (!Number.isFinite(this.deps.reapIntervalMs)) return;
    const timer = setInterval(() => {
      this.reapIdle().catch((err) => {
        console.error('[OpenCodeServerPool] reaper error', err);
      });
    }, this.deps.reapIntervalMs);
    // Don't keep the event loop alive solely for the reaper.
    if (typeof timer.unref === 'function') timer.unref();
    this.reapTimer = timer;
  }

  private async reapIdle(): Promise<void> {
    const now = this.deps.now();
    const idleEntries: OpenCodeServerEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.handle.stale) continue;
      if (now - entry.handle.lastUsedAt > this.deps.idleTimeoutMs) {
        idleEntries.push(entry);
      }
    }
    for (const entry of idleEntries) {
      entry.handle.stale = true;
      if (!entry.shutdown$) entry.shutdown$ = this.terminate(entry);
    }
  }

  private async evictLruIfFull(): Promise<void> {
    if (!Number.isFinite(this.deps.maxServers)) return;
    while (this.entries.size >= this.deps.maxServers) {
      let oldest: OpenCodeServerEntry | null = null;
      for (const entry of this.entries.values()) {
        if (entry.handle.stale) continue;
        if (!oldest || entry.handle.lastUsedAt < oldest.handle.lastUsedAt) {
          oldest = entry;
        }
      }
      if (!oldest) break;
      oldest.handle.stale = true;
      if (!oldest.shutdown$) oldest.shutdown$ = this.terminate(oldest);
      await oldest.shutdown$;
    }
  }

  private async spawnEntry(userId: number): Promise<OpenCodeServerHandle> {
    await this.evictLruIfFull();
    const entry = await this.attemptSpawn(userId).catch(async (firstErr) => {
      if (isEAddrInUse(firstErr)) {
        return this.attemptSpawn(userId);
      }
      throw firstErr;
    });
    this.entries.set(userId, entry);
    this.startReaperIfNeeded();
    auditOpenCodeLaunch({
      source: 'openCodeServerPool',
      userId,
      pid: entry.child.pid ?? null,
      port: entry.handle.port,
    });
    return entry.handle;
  }

  private async attemptSpawn(userId: number): Promise<OpenCodeServerEntry> {
    const port = await this.deps.pickPort();
    const password = randomBytes(24).toString('base64url');
    const env: NodeJS.ProcessEnv = {
      ...this.deps.buildEnv(userId),
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_SERVER_USERNAME: 'opencode',
    };
    // `detached: true` makes the spawned process the leader of a new
    // process group. We can then signal the whole group via
    // `process.kill(-pid, signal)` in `terminate()` — important because
    // the opencode binary may fork worker processes that wouldn't
    // otherwise receive SIGTERM when we kill the parent.
    const child = this.deps.spawnFn(
      'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
      { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    ) as unknown as ChildProcessWithoutNullStreams;

    const exited$ = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    let buffer = '';
    let onReady: ((url: string) => void) | null = null;
    let onError: ((err: Error) => void) | null = null;
    let readyTimer: NodeJS.Timeout | null = null;

    const stdoutListener = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const idx = buffer.indexOf(READY_LINE_PREFIX);
      if (idx === -1) return;
      const lineEnd = buffer.indexOf('\n', idx);
      const line = buffer.slice(idx, lineEnd === -1 ? undefined : lineEnd);
      const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
      if (!match) {
        onError?.(new Error(`Failed to parse server url from output: ${line}`));
        return;
      }
      onReady?.(match[1]!);
    };
    const stderrListener = (chunk: Buffer): void => {
      buffer += chunk.toString();
    };
    const exitListener = (code: number | null): void => {
      onError?.(new Error(
        `opencode serve exited with code ${code} before becoming ready. Output: ${buffer.trim() || '(empty)'}`,
      ));
    };
    const errorListener = (err: Error): void => {
      onError?.(err);
    };

    child.stdout.on('data', stdoutListener);
    child.stderr.on('data', stderrListener);
    child.once('exit', exitListener);
    child.once('error', errorListener);

    const baseUrl = await new Promise<string>((resolve, reject) => {
      readyTimer = setTimeout(() => {
        reject(new Error(
          `Timeout waiting for opencode serve to become ready after ${this.deps.readyTimeoutMs}ms. Output: ${buffer.trim() || '(empty)'}`,
        ));
      }, this.deps.readyTimeoutMs);
      if (typeof readyTimer.unref === 'function') readyTimer.unref();
      onReady = (url: string) => {
        if (readyTimer) clearTimeout(readyTimer);
        resolve(url);
      };
      onError = (err: Error) => {
        if (readyTimer) clearTimeout(readyTimer);
        reject(err);
      };
    }).catch(async (err) => {
      // Make sure the half-spawned subprocess can't linger.
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      throw err;
    });

    // Detach the ready-time listeners; the long-lived listeners below
    // pick up stdout/stderr (drain to avoid backpressure) and exit
    // (drop from pool on crash).
    child.stdout.off('data', stdoutListener);
    child.stderr.off('data', stderrListener);
    child.off('exit', exitListener);
    child.off('error', errorListener);

    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    const client = this.deps.createClient({
      baseUrl,
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      },
    });

    const handle: OpenCodeServerHandle = {
      userId,
      baseUrl,
      port,
      client,
      pid: child.pid ?? null,
      startedAt: this.deps.now(),
      lastUsedAt: this.deps.now(),
      stale: false,
    };

    const entry: OpenCodeServerEntry = {
      handle,
      child,
      password,
      exited$,
    };

    child.once('exit', () => {
      handle.stale = true;
      // Only drop the entry from the pool if no replacement has been
      // registered already (e.g. shutdownAll → terminate path).
      const current = this.entries.get(userId);
      if (current === entry) this.entries.delete(userId);
    });

    return entry;
  }

  private terminate(entry: OpenCodeServerEntry): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.entries.delete(entry.handle.userId);
        resolve();
      };
      entry.exited$.then(finish);
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
        finish();
        return;
      }
      const pid = entry.child.pid;
      if (!pid) {
        finish();
        return;
      }
      // Real spawns use `detached: true` so the child is the leader
      // of its own process group; signal the *group* (negative pid) so
      // any worker subprocesses opencode forked also receive the
      // signal. We also send the same signal to the child directly —
      // idempotent for real processes, but it's the only delivery path
      // for unit-test fakes whose pid isn't actually a real process
      // group leader.
      const signalBoth = (signal: NodeJS.Signals): void => {
        try {
          process.kill(-pid, signal);
        } catch {
          // ignore — group may not exist (test fake, or already gone)
        }
        try {
          entry.child.kill(signal);
        } catch {
          // ignore
        }
      };

      signalBoth('SIGTERM');
      const killTimer = setTimeout(() => {
        signalBoth('SIGKILL');
      }, 5000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
      entry.exited$.then(() => clearTimeout(killTimer));
    });
  }
}

let pool = new OpenCodeServerPool(defaultDeps);

export function getOrSpawnOpenCodeServer(
  userId: number,
): Promise<OpenCodeServerHandle> {
  return pool.getOrSpawn(userId);
}

export function getOpenCodeServerStatus(
  userId: number,
): { running: boolean; lastUsedAt: number | null } {
  return pool.getStatus(userId);
}

export async function shutdownOpenCodeServer(userId: number): Promise<void> {
  await pool.shutdown(userId);
}

export async function invalidateOpenCodeServer(userId: number): Promise<void> {
  await pool.invalidate(userId);
}

export async function shutdownAllOpenCodeServers(): Promise<void> {
  await pool.shutdownAll();
}

/** Test-only: swap dependency injections (spawn, time, etc.). */
export function _setOpenCodeServerPoolDeps(deps: Partial<SpawnDeps>): void {
  if (process.env['VITEST'] !== 'true' && process.env['NODE_ENV'] !== 'test') {
    throw new Error('_setOpenCodeServerPoolDeps is test-only');
  }
  pool.setDeps(deps);
}

/** Test-only: reset pool state for isolation between tests. */
export function _resetOpenCodeServerPool(
  overrides: Partial<SpawnDeps> = {},
): void {
  if (process.env['VITEST'] !== 'true' && process.env['NODE_ENV'] !== 'test') {
    throw new Error('_resetOpenCodeServerPool is test-only');
  }
  pool._hardReset();
  pool = new OpenCodeServerPool({ ...defaultDeps, ...overrides });
}

/**
 * Listens on a fresh TCP socket bound to 127.0.0.1:0, captures the
 * assigned port, closes the socket, and hands the port off. Susceptible
 * to a race if another process binds the same port between close and
 * handoff — `spawnEntry` retries once on `EADDRINUSE` (R13).
 */
async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr !== 'object') {
        srv.close(() => reject(new Error('Failed to allocate a free port')));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

function isEAddrInUse(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

export interface AuditOpenCodeLaunchArgs {
  source: string;
  userId: number;
  pid: number | null;
  port: number;
}

export function auditOpenCodeLaunch({
  source,
  userId,
  pid,
  port,
}: AuditOpenCodeLaunchArgs): void {
  console.log(
    '[OpenCodeServerPool] Launch audit:',
    JSON.stringify({
      source,
      userId,
      pid: pid ?? 'unavailable',
      port,
    }),
  );
}

// Best-effort process-exit cleanup. The pool isn't load-bearing for
// data integrity (sessions persist on disk via XDG_DATA_HOME), but
// leaving zombies is bad citizenship on a shared box.
if (typeof process !== 'undefined' && process.env['VITEST'] !== 'true') {
  const onShutdown = (signal: string): void => {
    void pool.shutdownAll().finally(() => {
      // Re-raise the signal so the parent's default handlers can run.
      if (signal === 'SIGTERM' || signal === 'SIGINT') {
        process.exit(0);
      }
    });
  };
  process.once('SIGTERM', () => onShutdown('SIGTERM'));
  process.once('SIGINT', () => onShutdown('SIGINT'));
  process.once('beforeExit', () => {
    void pool.shutdownAll();
  });
}
