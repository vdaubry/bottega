import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelCodexAuthLogin,
  clearCodexAuthLoginSessions,
  CodexAuthLoginError,
  getActiveCodexAuthLogin,
  startCodexAuthLogin,
  waitForCodexAuthLoginCompletion,
} from './codexAuthFlow.js';

// --- node-pty mock -----------------------------------------------------------

type OnDataCb = (chunk: string) => void;
type OnExitCb = (e: { exitCode: number | undefined; signal: number | undefined }) => void;

interface MockPty {
  pid: number;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  _emitData: (chunk: string) => void;
  _emitExit: (exitCode?: number, signal?: number) => void;
}

const ptySpawnMock = vi.hoisted(() => vi.fn());

vi.mock('node-pty', () => ({
  spawn: ptySpawnMock,
}));

vi.mock('./codexCredentials.js', () => ({
  CodexCredentialsError: class CodexCredentialsError extends Error {},
  ensureCodexHomeDir: vi.fn((userId) => ({
    codexHome: `/home/test/.config/bottega/users/${userId}/codex/`,
  })),
  buildCodexSdkEnv: vi.fn((userId) => ({
    PATH: '/usr/bin',
    HOME: '/home/test',
    CODEX_HOME: `/home/test/.config/bottega/users/${userId}/codex/`,
  })),
  getCodexAuthStatus: vi.fn().mockResolvedValue({
    authenticated: true,
    status: 'authenticated',
    authPath: '/x/auth.json',
    method: 'oauth',
    tokenFingerprint: 'abcdef',
  }),
  resolveCodexAuthJsonPath: vi.fn((u: number) => `/home/test/.config/bottega/users/${u}/codex/auth.json`),
}));

function createMockPty(pid = 1234): MockPty {
  let dataCb: OnDataCb | null = null;
  let exitCb: OnExitCb | null = null;
  const pty: MockPty = {
    pid,
    onData: vi.fn((cb: OnDataCb) => {
      dataCb = cb;
    }),
    onExit: vi.fn((cb: OnExitCb) => {
      exitCb = cb;
    }),
    write: vi.fn(),
    kill: vi.fn(),
    _emitData: (chunk) => dataCb?.(chunk),
    _emitExit: (exitCode, signal) => exitCb?.({ exitCode, signal }),
  };
  return pty;
}

describe('codexAuthFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ptySpawnMock.mockImplementation(() => createMockPty());
  });

  afterEach(() => {
    clearCodexAuthLoginSessions();
  });

  it("spawns `codex login --device-auth` with per-user CODEX_HOME env", async () => {
    const child = createMockPty(7777);
    ptySpawnMock.mockReturnValue(child);
    const startPromise = startCodexAuthLogin(42, { ttlMs: 60000, urlWaitMs: 1000 });

    // CLI prints "Open this URL: <url>" and "Then enter this one-time code: <code>"
    child._emitData(
      'Welcome to Codex\r\n' +
        '1. Open this link in your browser\r\n' +
        '   https://auth.openai.com/codex/device\r\n' +
        '2. Enter this one-time code\r\n' +
        '   WX12-AB34\r\n',
    );
    const login = await startPromise;

    expect(login.authUrl).toBe('https://auth.openai.com/codex/device');
    expect(login.deviceCode).toBe('WX12-AB34');
    expect(login.loginSessionId).toEqual(expect.any(String));
    expect(ptySpawnMock).toHaveBeenCalledWith(
      expect.stringContaining('codex'),
      ['login', '--device-auth'],
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_HOME: '/home/test/.config/bottega/users/42/codex/',
        }),
      }),
    );
  });

  it("falls back to the default TTL when options.ttlMs is omitted and the env var is unset", async () => {
    const prev = process.env['CODEX_AUTH_LOGIN_TTL_MS'];
    delete process.env['CODEX_AUTH_LOGIN_TTL_MS'];
    try {
      const child = createMockPty();
      ptySpawnMock.mockReturnValue(child);
      const startPromise = startCodexAuthLogin(42, { urlWaitMs: 1000 });
      child._emitData('https://auth.openai.com/codex/device\nABCD-1234\n');
      const login = await startPromise;
      // Regression: previously `Number(undefined)` produced NaN, which fell
      // through `??` and crashed `new Date(NaN).toISOString()` with
      // "Invalid time value".
      expect(login.expiresAt).toEqual(expect.any(String));
      expect(Number.isFinite(Date.parse(login.expiresAt))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['CODEX_AUTH_LOGIN_TTL_MS'];
      else process.env['CODEX_AUTH_LOGIN_TTL_MS'] = prev;
    }
  });

  it("rejects when codex login exits before producing a URL", async () => {
    const child = createMockPty();
    ptySpawnMock.mockReturnValue(child);
    const startPromise = startCodexAuthLogin(42, { ttlMs: 60000, urlWaitMs: 100 });
    // CLI exits immediately with no URL output.
    setImmediate(() => child._emitExit(1, undefined));
    await expect(startPromise).rejects.toBeInstanceOf(CodexAuthLoginError);
  });

  it("replaces a prior login session when start() fires twice for the same user", async () => {
    const first = createMockPty(1);
    const second = createMockPty(2);
    ptySpawnMock.mockReturnValueOnce(first);
    ptySpawnMock.mockReturnValueOnce(second);

    const p1 = startCodexAuthLogin(42, { ttlMs: 60000, urlWaitMs: 500 });
    first._emitData('https://auth.openai.com/codex/device\nABCD-1234\n');
    await p1;

    const p2 = startCodexAuthLogin(42, { ttlMs: 60000, urlWaitMs: 500 });
    second._emitData('https://auth.openai.com/codex/device\nWXYZ-9876\n');
    const login2 = await p2;

    expect(login2.deviceCode).toBe('WXYZ-9876');
    expect(first.kill).toHaveBeenCalled();
  });

  it("getActiveCodexAuthLogin returns null when no session is running", () => {
    expect(getActiveCodexAuthLogin(42)).toBeNull();
  });

  it("cancelCodexAuthLogin terminates the PTY and returns true", async () => {
    const child = createMockPty();
    ptySpawnMock.mockReturnValue(child);
    const p = startCodexAuthLogin(42, { ttlMs: 60000, urlWaitMs: 500 });
    child._emitData('https://auth.openai.com/codex/device\nABCD-1234\n');
    await p;

    expect(cancelCodexAuthLogin(42, 'user')).toBe(true);
    expect(child.kill).toHaveBeenCalled();
  });

  it("cancelCodexAuthLogin returns false when no session exists", () => {
    expect(cancelCodexAuthLogin(42, 'user')).toBe(false);
  });

  it("waitForCodexAuthLoginCompletion resolves with auth status on exit-0", async () => {
    const child = createMockPty();
    ptySpawnMock.mockReturnValue(child);
    const p = startCodexAuthLogin(42, { ttlMs: 60000, urlWaitMs: 500 });
    child._emitData('https://auth.openai.com/codex/device\nABCD-1234\n');
    const start = await p;

    setImmediate(() => child._emitExit(0, undefined));
    const status = await waitForCodexAuthLoginCompletion(42, start.loginSessionId, {
      completeWaitMs: 5000,
    });
    expect(status.authenticated).toBe(true);
  });

  it("rejects with a 400-style error when codex login exits non-zero", async () => {
    const child = createMockPty();
    ptySpawnMock.mockReturnValue(child);
    const p = startCodexAuthLogin(42, { ttlMs: 60000, urlWaitMs: 500 });
    child._emitData('https://auth.openai.com/codex/device\nABCD-1234\n');
    const start = await p;

    setImmediate(() => child._emitExit(2, undefined));
    await expect(
      waitForCodexAuthLoginCompletion(42, start.loginSessionId, { completeWaitMs: 5000 }),
    ).rejects.toBeInstanceOf(CodexAuthLoginError);
  });

  it("rejects with 409 when the wait sessionId no longer matches (replaced)", async () => {
    const child = createMockPty();
    ptySpawnMock.mockReturnValue(child);
    const p = startCodexAuthLogin(42, { ttlMs: 60000, urlWaitMs: 500 });
    child._emitData('https://auth.openai.com/codex/device\nABCD-1234\n');
    const start = await p;

    // Bump the session by starting again — the old session id is now stale.
    const next = createMockPty();
    ptySpawnMock.mockReturnValueOnce(next);
    const p2 = startCodexAuthLogin(42, { ttlMs: 60000, urlWaitMs: 500 });
    next._emitData('https://auth.openai.com/codex/device\nWXYZ-9876\n');
    await p2;

    await expect(
      waitForCodexAuthLoginCompletion(42, start.loginSessionId, { completeWaitMs: 5000 }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
