import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import { verifyClient, getUpgradeToken, type AuthenticatedUpgradeRequest } from './verifyClient.js';

vi.mock('../database/db.js', () => ({
  userDb: {
    getFirstUser: vi.fn(),
    getUserById: vi.fn(),
    isAdmin: vi.fn(),
    getTokenVersion: vi.fn(),
    bumpTokenVersion: vi.fn(),
  },
}));

vi.mock('../services/userApiKey.js', () => ({
  isApiKeyFormat: vi.fn(
    (token: unknown) => typeof token === 'string' && token.startsWith('ccui_'),
  ),
  findUserByApiKey: vi.fn(),
}));

import { findUserByApiKey } from '../services/userApiKey.js';

const busy = () => new Database.SqliteError('database is locked', 'SQLITE_BUSY');
const asUser = (u: { id: number; username: string }) => u as never;

type VerifyCallback = Parameters<typeof verifyClient>[1];

const callVerify = (url: string) => {
  const cb = vi.fn<VerifyCallback>();
  const req = { url, headers: {} } as unknown as AuthenticatedUpgradeRequest;
  verifyClient({ origin: '', secure: false, req }, cb);
  return { cb, req };
};

const silenceConsole = () => ({
  log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
});

describe('verifyClient', () => {
  let spies: ReturnType<typeof silenceConsole>;

  beforeEach(() => {
    vi.clearAllMocks();
    spies = silenceConsole();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a valid credential and stamps the user on the request', () => {
    vi.mocked(findUserByApiKey).mockReturnValue(asUser({ id: 7, username: 'seven' }));
    const { cb, req } = callVerify('/ws?token=ccui_ok');
    expect(cb).toHaveBeenCalledWith(true);
    expect(req.user).toEqual({ id: 7, userId: 7, username: 'seven' });
  });

  it('rejects an unknown credential with 401', () => {
    vi.mocked(findUserByApiKey).mockReturnValue(null);
    const { cb, req } = callVerify('/ws?token=ccui_nope');
    expect(cb).toHaveBeenCalledWith(false, 401, 'Unauthorized');
    expect(req.user).toBeUndefined();
  });

  it('answers 503 with Retry-After when the credential lookup hits SQLITE_BUSY', () => {
    vi.mocked(findUserByApiKey).mockImplementation(() => {
      throw busy();
    });
    const { cb, req } = callVerify('/ws?token=ccui_locked');
    expect(cb).toHaveBeenCalledWith(false, 503, expect.any(String), { 'Retry-After': '1' });
    expect(req.user).toBeUndefined();
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(String(spies.warn.mock.calls[0]?.[0])).toContain('SQLITE_BUSY');
  });

  it('answers 500 — not a crash — on an unexpected lookup error', () => {
    vi.mocked(findUserByApiKey).mockImplementation(() => {
      throw new TypeError('boom');
    });
    const { cb } = callVerify('/ws?token=ccui_bug');
    expect(cb).toHaveBeenCalledWith(false, 500, 'Internal Server Error');
    expect(spies.error).toHaveBeenCalledTimes(1);
  });
});

describe('the upgrade over a real socket', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    silenceConsole();
    server = http.createServer();
    wss = new WebSocketServer({ server, verifyClient });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  type Outcome = 'open' | { status: number; retryAfter: string | undefined };

  const handshake = (token: string): Promise<Outcome> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      ws.on('unexpected-response', (_req, res) => {
        resolve({ status: res.statusCode ?? 0, retryAfter: res.headers['retry-after'] });
        res.resume();
      });
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('error', reject);
    });

  it('rejects with 503 + Retry-After on SQLITE_BUSY, and the server keeps serving', async () => {
    vi.mocked(findUserByApiKey).mockImplementation(() => {
      throw busy();
    });
    await expect(handshake('ccui_locked')).resolves.toEqual({ status: 503, retryAfter: '1' });

    vi.mocked(findUserByApiKey).mockReturnValue(asUser({ id: 1, username: 'dev' }));
    await expect(handshake('ccui_ok')).resolves.toBe('open');
  });

  it('still rejects a bad credential with 401', async () => {
    vi.mocked(findUserByApiKey).mockReturnValue(null);
    await expect(handshake('ccui_nope')).resolves.toMatchObject({ status: 401 });
  });
});

describe('getUpgradeToken', () => {
  const request = (url: string, authorization?: string): http.IncomingMessage =>
    ({ url, headers: authorization ? { authorization } : {} }) as unknown as http.IncomingMessage;

  it('reads ?token= first, then the bearer header', () => {
    expect(getUpgradeToken(request('/ws?token=abc'))).toBe('abc');
    expect(getUpgradeToken(request('/ws', 'Bearer xyz'))).toBe('xyz');
    expect(getUpgradeToken(request('/ws?token=abc', 'Bearer xyz'))).toBe('abc');
    expect(getUpgradeToken(request('/ws'))).toBeUndefined();
  });

  it('yields no token for a request target the URL parser rejects', () => {
    // Node's HTTP parser hands these to the 'upgrade' listener; `new URL`
    // throws on every one of them.
    for (const target of ['http://[', 'http://a:99999/ws', 'http://a:b:c/ws', '//[']) {
      expect(getUpgradeToken(request(target, 'Bearer xyz'))).toBeUndefined();
    }
  });
});
