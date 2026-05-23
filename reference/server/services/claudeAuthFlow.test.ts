import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildClaudeLoginEnv,
  getClaudeAuthStatus,
  prepareClaudeConfigDir,
  writeClaudeOAuthToken
} from './claudeCredentials.js';
import {
  cancelClaudeAuthLogin,
  clearClaudeAuthLoginSessions,
  ClaudeAuthLoginError,
  completeClaudeAuthLogin,
  getActiveClaudeAuthLogin,
  startClaudeAuthLogin
} from './claudeAuthFlow.js';

// --- node-pty mock -----------------------------------------------------------

type OnDataCb = (chunk: string) => void;
type OnExitCb = (e: { exitCode: number | undefined; signal: string | undefined }) => void;

interface MockPty {
  pid: number;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  // helpers for tests
  _emitData: (chunk: string) => void;
  _emitExit: (exitCode?: number, signal?: string) => void;
}

const ptySpawnMock = vi.hoisted(() => vi.fn());

vi.mock('node-pty', () => ({
  spawn: ptySpawnMock,
}));

vi.mock('./claudeCredentials.js', () => ({
  prepareClaudeConfigDir: vi.fn((userId) => ({
    claudeConfigDir: `/home/test/.config/bottega/users/${userId}/.claude`
  })),
  buildClaudeLoginEnv: vi.fn((userId) => ({
    PATH: '/usr/bin',
    HOME: '/home/test',
    CLAUDE_CONFIG_DIR: `/home/test/.config/bottega/users/${userId}/.claude`
  })),
  writeClaudeOAuthToken: vi.fn(),
  getClaudeAuthStatus: vi.fn().mockResolvedValue({
    authenticated: true,
    status: 'authenticated',
    tokenFingerprint: 'abcdef'
  })
}));

function createMockPty(pid = 1234): MockPty {
  let dataCb: OnDataCb | null = null;
  let exitCb: OnExitCb | null = null;

  const pty: MockPty = {
    pid,
    onData: vi.fn((cb: OnDataCb) => { dataCb = cb; }),
    onExit: vi.fn((cb: OnExitCb) => { exitCb = cb; }),
    write: vi.fn(),
    kill: vi.fn(),
    _emitData: (chunk) => dataCb?.(chunk),
    _emitExit: (exitCode, signal) => exitCb?.({ exitCode, signal }),
  };
  return pty;
}

// -----------------------------------------------------------------------------

describe('claudeAuthFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ptySpawnMock.mockImplementation(() => createMockPty());
  });

  afterEach(() => {
    clearClaudeAuthLoginSessions();
  });

  it('starts claude setup-token with a per-user login env and returns the auth URL', async () => {
    const child = createMockPty(4567);
    ptySpawnMock.mockReturnValue(child);

    const startPromise = startClaudeAuthLogin(42, { ttlMs: 60000, urlWaitMs: 1000 });
    child._emitData('Visit: https://platform.claude.com/oauth/authorize?state=abc to continue');

    const login = await startPromise;

    expect(prepareClaudeConfigDir).toHaveBeenCalledWith(42);
    expect(buildClaudeLoginEnv).toHaveBeenCalledWith(42);
    expect(ptySpawnMock).toHaveBeenCalledWith(
      expect.stringContaining('claude'),
      ['setup-token'],
      expect.objectContaining({
        env: expect.objectContaining({
          CLAUDE_CONFIG_DIR: '/home/test/.config/bottega/users/42/.claude'
        }),
      })
    );
    expect(login.authUrl).toBe('https://platform.claude.com/oauth/authorize?state=abc');
    expect(login.loginSessionId).toEqual(expect.any(String));
  });

  it('reassembles an OAuth URL that the CLI hard-wrapped across 80-col lines', async () => {
    const child = createMockPty(4567);
    ptySpawnMock.mockReturnValue(child);

    const startPromise = startClaudeAuthLogin(42, { ttlMs: 60000, urlWaitMs: 1000 });
    child._emitData(
      'Use the url below to sign in (c to copy)\r\r\n\r\r\n' +
        'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88\r\r\n',
    );
    child._emitData(
      'ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.co\r\r\n' +
        'm%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abc123&code_ch\r\r\n' +
        'allenge_method=S256&state=xyz789\r\r\n\r\r\nPaste code here if prompted >\r\r\n',
    );

    const login = await startPromise;
    expect(login.authUrl).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abc123&code_challenge_method=S256&state=xyz789',
    );
  });

  it('does not capture a still-incomplete URL that is missing its state param', async () => {
    const child = createMockPty(4567);
    ptySpawnMock.mockReturnValue(child);

    const startPromise = startClaudeAuthLogin(42, { ttlMs: 60000, urlWaitMs: 50 });
    child._emitData(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88',
    );

    await expect(startPromise).rejects.toThrow(/did not produce a login URL/i);
  });

  it('cancel-and-replaces an active login process for the same user', async () => {
    const firstChild = createMockPty(1111);
    const secondChild = createMockPty(2222);
    ptySpawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);

    const firstStart = startClaudeAuthLogin(42, { ttlMs: 60000, urlWaitMs: 1000 });
    firstChild._emitData('https://platform.claude.com/oauth/authorize?state=first');
    await firstStart;

    const secondStart = startClaudeAuthLogin(42, { ttlMs: 60000, urlWaitMs: 1000 });
    secondChild._emitData('https://platform.claude.com/oauth/authorize?state=second');
    const secondLogin = await secondStart;

    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(secondLogin.authUrl).toBe('https://platform.claude.com/oauth/authorize?state=second');
    expect(getActiveClaudeAuthLogin(42)!.loginSessionId).toBe(secondLogin.loginSessionId);
  });

  it('captures the token from output (TUI lingers), kills the process, and persists', async () => {
    const child = createMockPty(4567);
    ptySpawnMock.mockReturnValue(child);

    const startPromise = startClaudeAuthLogin(42, { ttlMs: 60000, urlWaitMs: 1000 });
    child._emitData('https://platform.claude.com/oauth/authorize?state=abc');
    const login = await startPromise;

    const completePromise = completeClaudeAuthLogin(42, login.loginSessionId, ' pasted-code ');

    // setup-token prints the token mid-stream; the TUI does NOT exit on its own.
    child._emitData('Your token: sk-ant-oat01-abcdef0123456789ABCDEF0123456789abcdef0123 (copy this)');

    await expect(completePromise).resolves.toEqual(expect.objectContaining({
      authenticated: true
    }));
    // Code and CR are written separately so the CLI's paste-detection doesn't
    // swallow the Enter.
    expect(child.write).toHaveBeenNthCalledWith(1, 'pasted-code');
    expect(child.write).toHaveBeenNthCalledWith(2, '\r');
    expect(writeClaudeOAuthToken).toHaveBeenCalledWith(
      42,
      'sk-ant-oat01-abcdef0123456789ABCDEF0123456789abcdef0123'
    );
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(getClaudeAuthStatus).toHaveBeenCalledWith(42);
    expect(getActiveClaudeAuthLogin(42)).toBe(null);
  });

  it('fails when the CLI exits cleanly but no token is emitted', async () => {
    const child = createMockPty(4567);
    ptySpawnMock.mockReturnValue(child);

    const startPromise = startClaudeAuthLogin(42, { ttlMs: 60000, urlWaitMs: 1000 });
    child._emitData('https://platform.claude.com/oauth/authorize?state=abc');
    const login = await startPromise;

    const completePromise = completeClaudeAuthLogin(42, login.loginSessionId, 'pasted-code');
    child._emitExit(0);

    await expect(completePromise).rejects.toMatchObject({
      name: 'ClaudeAuthLoginError',
      message: expect.stringMatching(/no token was emitted/)
    });
    expect(writeClaudeOAuthToken).not.toHaveBeenCalled();
  });

  it('rejects with the parsed CLI error when Anthropic returns 400 for the code', async () => {
    const child = createMockPty(4567);
    ptySpawnMock.mockReturnValue(child);

    const startPromise = startClaudeAuthLogin(42, { ttlMs: 60000, urlWaitMs: 1000 });
    child._emitData('https://platform.claude.com/oauth/authorize?state=abc');
    const login = await startPromise;

    const completePromise = completeClaudeAuthLogin(42, login.loginSessionId, 'pasted-code');
    // Same shape we observed live: cursor escapes between words, then the
    // human-readable error line.
    child._emitData('\x1b[1COAuth\x1b[1Cerror:\x1b[1CRequest\x1b[1Cfailed\x1b[1Cwith\x1b[1Cstatus\x1b[1Ccode\x1b[1C400\r\n');

    await expect(completePromise).rejects.toMatchObject({
      name: 'ClaudeAuthLoginError',
      message: expect.stringMatching(/Claude rejected the authentication code:.*400/)
    });
    expect(writeClaudeOAuthToken).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('fails when the CLI exits non-zero after the code is submitted', async () => {
    const child = createMockPty(4567);
    ptySpawnMock.mockReturnValue(child);

    const startPromise = startClaudeAuthLogin(42, { ttlMs: 60000, urlWaitMs: 1000 });
    child._emitData('https://platform.claude.com/oauth/authorize?state=abc');
    const login = await startPromise;

    const completePromise = completeClaudeAuthLogin(42, login.loginSessionId, 'bad-code');
    child._emitExit(1);

    await expect(completePromise).rejects.toMatchObject({
      name: 'ClaudeAuthLoginError',
      message: expect.stringMatching(/Check the code/)
    });
    expect(writeClaudeOAuthToken).not.toHaveBeenCalled();
  });

  it('rejects completion for a replaced login session', async () => {
    const child = createMockPty(4567);
    ptySpawnMock.mockReturnValue(child);

    const startPromise = startClaudeAuthLogin(42, { ttlMs: 60000, urlWaitMs: 1000 });
    child._emitData('https://platform.claude.com/oauth/authorize?state=abc');
    await startPromise;

    await expect(completeClaudeAuthLogin(42, 'old-session', 'code')).rejects.toMatchObject({
      name: 'ClaudeAuthLoginError',
      statusCode: 409
    });
  });

  it('kills an active login process when cancelled', async () => {
    const child = createMockPty(4567);
    ptySpawnMock.mockReturnValue(child);

    const startPromise = startClaudeAuthLogin(42, { ttlMs: 60000, urlWaitMs: 1000 });
    child._emitData('https://platform.claude.com/oauth/authorize?state=abc');
    await startPromise;

    expect(cancelClaudeAuthLogin(42)).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(getActiveClaudeAuthLogin(42)).toBe(null);
  });

  it('fails completion when no login process is active', async () => {
    await expect(completeClaudeAuthLogin(42, 'session', 'code')).rejects.toBeInstanceOf(ClaudeAuthLoginError);
  });
});
