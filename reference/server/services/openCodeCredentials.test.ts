import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildOpenCodeSpawnEnv,
  clearOpenCodeKey,
  ensureOpenCodeDataDir,
  getOpenCodeAuthStatus,
  OpenCodeCredentialsError,
  readOpenCodeAuth,
  resolveOpenCodeAuthPath,
  resolveOpenCodeCacheDir,
  resolveOpenCodeConfigDir,
  resolveOpenCodeDataDir,
  resolveOpenCodeStateDir,
  setOpenCodeKey,
} from './openCodeCredentials.js';

describe('openCodeCredentials', () => {
  let tempRoot: string;
  let originalRoot: string | undefined;
  const ENV_KEYS_TO_RESET = [
    'OPENCODE_AUTH_CONTENT',
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_CONFIG_DIR',
    'GH_CONFIG_DIR',
    'XDG_CONFIG_HOME',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-opencode-creds-'));
    originalRoot = process.env['OPENCODE_CONFIG_ROOT'];
    process.env['OPENCODE_CONFIG_ROOT'] = tempRoot;
    for (const key of ENV_KEYS_TO_RESET) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (originalRoot === undefined) delete process.env['OPENCODE_CONFIG_ROOT'];
    else process.env['OPENCODE_CONFIG_ROOT'] = originalRoot;
    for (const key of ENV_KEYS_TO_RESET) {
      const v = savedEnv[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  });

  function provisionAuth(userId: number, key = 'sk-zen-test-123'): string {
    const { authPath } = setOpenCodeKey(userId, key);
    return authPath;
  }

  it('resolves the per-user XDG dirs under the configured root', () => {
    const userDir = path.join(tempRoot, '42');
    expect(resolveOpenCodeDataDir(42)).toBe(path.join(userDir, 'opencode-data'));
    expect(resolveOpenCodeConfigDir(42)).toBe(path.join(userDir, 'opencode-config'));
    expect(resolveOpenCodeStateDir(42)).toBe(path.join(userDir, 'opencode-state'));
    expect(resolveOpenCodeCacheDir(42)).toBe(path.join(userDir, 'opencode-cache'));
    expect(resolveOpenCodeAuthPath(42)).toBe(
      path.join(userDir, 'opencode-data', 'opencode', 'auth.json'),
    );
  });

  it('creates the per-user data dir with mode 0700', () => {
    const { dataDir } = ensureOpenCodeDataDir(42);
    const stat = fs.statSync(dataDir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);

    // The parent users/{userId} dir is also 0700.
    const userDirStat = fs.statSync(path.join(tempRoot, '42'));
    expect(userDirStat.mode & 0o777).toBe(0o700);

    // The auth.json's parent directory (data/opencode) is also 0700.
    const authParent = path.dirname(resolveOpenCodeAuthPath(42));
    const authParentStat = fs.statSync(authParent);
    expect(authParentStat.isDirectory()).toBe(true);
    expect(authParentStat.mode & 0o777).toBe(0o700);
  });

  it('rejects non-numeric or non-positive user ids', () => {
    expect(() => resolveOpenCodeDataDir(undefined)).toThrow(OpenCodeCredentialsError);
    expect(() => resolveOpenCodeDataDir(0)).toThrow(OpenCodeCredentialsError);
    expect(() => resolveOpenCodeDataDir('foo')).toThrow(OpenCodeCredentialsError);
  });

  it('writes auth.json with mode 0600 and the expected dual-provider shape', () => {
    const authPath = provisionAuth(42, 'sk-zen-abc');
    const stat = fs.statSync(authPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8')) as unknown;
    expect(parsed).toEqual({
      opencode: { type: 'api', key: 'sk-zen-abc' },
      'opencode-go': { type: 'api', key: 'sk-zen-abc' },
    });
  });

  it('readOpenCodeAuth round-trips the payload with both provider entries', () => {
    provisionAuth(42, 'sk-zen-roundtrip');
    const out = readOpenCodeAuth(42);
    expect(out.opencode.key).toBe('sk-zen-roundtrip');
    expect(out.opencode.type).toBe('api');
    expect(out['opencode-go'].key).toBe('sk-zen-roundtrip');
    expect(out['opencode-go'].type).toBe('api');
  });

  it('readOpenCodeAuth rejects an empty JSON object', () => {
    ensureOpenCodeDataDir(42);
    fs.writeFileSync(resolveOpenCodeAuthPath(42), JSON.stringify({}), { mode: 0o600 });
    expect(() => readOpenCodeAuth(42)).toThrow(/does not carry.*API key/);
  });

  it('readOpenCodeAuth rejects an unrecognised provider record', () => {
    ensureOpenCodeDataDir(42);
    fs.writeFileSync(
      resolveOpenCodeAuthPath(42),
      JSON.stringify({ moonshot: { type: 'api', key: 'bad' } }),
      { mode: 0o600 },
    );
    expect(() => readOpenCodeAuth(42)).toThrow(/does not carry.*API key/);
  });

  it('readOpenCodeAuth rejects when only opencode entry is present (requires both providers)', () => {
    ensureOpenCodeDataDir(42);
    fs.writeFileSync(
      resolveOpenCodeAuthPath(42),
      JSON.stringify({
        opencode: { type: 'api', key: 'sk-zen-ok' },
      }),
      { mode: 0o600 },
    );
    expect(() => readOpenCodeAuth(42)).toThrow(/does not carry.*API key/);
  });

  it('readOpenCodeAuth rejects when only opencode-go entry is present (requires both providers)', () => {
    ensureOpenCodeDataDir(42);
    fs.writeFileSync(
      resolveOpenCodeAuthPath(42),
      JSON.stringify({
        'opencode-go': { type: 'api', key: 'sk-zen-ok' },
      }),
      { mode: 0o600 },
    );
    expect(() => readOpenCodeAuth(42)).toThrow(/does not carry.*API key/);
  });

  it('readOpenCodeAuth rejects when extra keys are present beyond opencode and opencode-go', () => {
    ensureOpenCodeDataDir(42);
    fs.writeFileSync(
      resolveOpenCodeAuthPath(42),
      JSON.stringify({
        opencode: { type: 'api', key: 'sk-zen-ok' },
        'opencode-go': { type: 'api', key: 'sk-zen-ok' },
        moonshot: { type: 'api', key: 'stale' },
      }),
      { mode: 0o600 },
    );
    expect(() => readOpenCodeAuth(42)).toThrow(/does not carry.*API key/);
  });

  it('readOpenCodeAuth rejects a malformed JSON file', () => {
    ensureOpenCodeDataDir(42);
    fs.writeFileSync(resolveOpenCodeAuthPath(42), 'not json', { mode: 0o600 });
    expect(() => readOpenCodeAuth(42)).toThrow(/is not valid JSON/);
  });

  it('readOpenCodeAuth rejects an auth.json with wrong file mode (e.g. 0644)', () => {
    const authPath = provisionAuth(42);
    fs.chmodSync(authPath, 0o644);
    expect(() => readOpenCodeAuth(42)).toThrow(/must not be accessible/);
  });

  it('readOpenCodeAuth returns ENOENT-shaped error when auth.json is missing', () => {
    expect(() => readOpenCodeAuth(42)).toThrow(/not provisioned/);
  });

  it('setOpenCodeKey overwrites previous key cleanly', () => {
    setOpenCodeKey(42, 'k1');
    setOpenCodeKey(42, 'k2');
    expect(readOpenCodeAuth(42).opencode.key).toBe('k2');
  });

  it('setOpenCodeKey rejects empty / whitespace-only keys', () => {
    expect(() => setOpenCodeKey(42, '')).toThrow(/empty OpenCode API key/);
    expect(() => setOpenCodeKey(42, '   ')).toThrow(/empty OpenCode API key/);
  });

  it('clearOpenCodeKey removes the auth.json and returns true; false on second call', () => {
    provisionAuth(42);
    expect(clearOpenCodeKey(42)).toBe(true);
    expect(clearOpenCodeKey(42)).toBe(false);
  });

  it('getOpenCodeAuthStatus reports authenticated with fingerprint when set', async () => {
    provisionAuth(42, 'abcdefghijk-zen-xyz123');
    const status = await getOpenCodeAuthStatus(42);
    expect(status.authenticated).toBe(true);
    expect(status.status).toBe('authenticated');
    expect(status.tokenFingerprint).toBe('xyz123');
    expect(status.authPath).toBe(resolveOpenCodeAuthPath(42));
  });

  it('getOpenCodeAuthStatus reports missing when no auth.json exists', async () => {
    const status = await getOpenCodeAuthStatus(42);
    expect(status.authenticated).toBe(false);
    expect(status.status).toBe('missing');
    expect(status.reason).toBeDefined();
  });

  it('getOpenCodeAuthStatus reports missing after clearOpenCodeKey', async () => {
    provisionAuth(42);
    clearOpenCodeKey(42);
    const status = await getOpenCodeAuthStatus(42);
    expect(status.authenticated).toBe(false);
    expect(status.status).toBe('missing');
  });

  it('buildOpenCodeSpawnEnv sets per-user XDG dirs, preserves host gh config, and strips inherited OPENCODE_* keys', () => {
    process.env['OPENCODE_AUTH_CONTENT'] = '{"opencode":{"type":"api","key":"bad"}}';
    process.env['OPENCODE_CONFIG'] = '/etc/passwd';
    process.env['OPENCODE_CONFIG_CONTENT'] = '{}';
    process.env['OPENCODE_CONFIG_DIR'] = '/tmp/bad';
    process.env['XDG_CONFIG_HOME'] = '/host/config';

    const env = buildOpenCodeSpawnEnv(42);

    expect(env['XDG_DATA_HOME']).toBe(resolveOpenCodeDataDir(42));
    expect(env['XDG_CONFIG_HOME']).toBe(resolveOpenCodeConfigDir(42));
    expect(env['XDG_STATE_HOME']).toBe(resolveOpenCodeStateDir(42));
    expect(env['XDG_CACHE_HOME']).toBe(resolveOpenCodeCacheDir(42));
    // gh stores credentials under its own config dir. Pin it before
    // redirecting XDG_CONFIG_HOME so `gh pr create` keeps using the
    // host's login while OpenCode remains isolated.
    expect(env['GH_CONFIG_DIR']).toBe(path.join('/host/config', 'gh'));
    expect(env['OPENCODE_AUTH_CONTENT']).toBeUndefined();
    expect(env['OPENCODE_CONFIG_DIR']).toBeUndefined();
    // OPENCODE_CONFIG is pinned to /dev/null so a worktree-local
    // opencode.json cannot override the spawn config (R13).
    expect(env['OPENCODE_CONFIG']).toBe('/dev/null');
    // OPENCODE_CONFIG_CONTENT is reset to a Bottega-owned inline config
    // (grants external_directory: allow so the `build` agent's `read`
    // tool doesn't hang on bottega-internal paths). Inherited values
    // from the parent process must be stripped first; the assertion
    // is that the final value is what Bottega computed, not what the
    // parent process tried to inject.
    const parsedContent = JSON.parse(env['OPENCODE_CONFIG_CONTENT'] as string) as {
      permission?: { external_directory?: string };
    };
    expect(parsedContent.permission?.external_directory).toBe('allow');
    expect(env['HOME']).toBe(process.env['HOME']);
    expect(env['PATH']).toBe(process.env['PATH']);
  });

  it('cross-user isolation: user 1 status reports its own credential, user 2 reads as missing', async () => {
    provisionAuth(1);
    const s1 = await getOpenCodeAuthStatus(1);
    const s2 = await getOpenCodeAuthStatus(2);
    expect(s1.authenticated).toBe(true);
    expect(s2.authenticated).toBe(false);
    expect(fs.existsSync(resolveOpenCodeAuthPath(2))).toBe(false);
  });

  it('rejects an auth.json owned by a foreign uid', () => {
    if (typeof process.getuid !== 'function') return; // skip on platforms without uids
    const authPath = provisionAuth(42);

    // Spy on fs.statSync just for this call site — return a synthetic
    // stat with a foreign uid. The real file still has mode 0600 so the
    // mode check passes; we want the uid branch to fire first.
    const realStat = fs.statSync(authPath);
    const original = fs.statSync;
    const spy = ((p: fs.PathLike, ...rest: unknown[]) => {
      if (typeof p === 'string' && p === authPath) {
        return Object.assign(Object.create(realStat) as fs.Stats, {
          uid: realStat.uid + 1,
          mode: realStat.mode,
        });
      }
      return (original as unknown as (...args: unknown[]) => fs.Stats)(p, ...rest);
    }) as typeof fs.statSync;
    (fs as { statSync: typeof fs.statSync }).statSync = spy;
    try {
      expect(() => readOpenCodeAuth(42)).toThrow(/must be owned by the current user/);
    } finally {
      (fs as { statSync: typeof fs.statSync }).statSync = original;
    }
  });

  // Dual-provider tests
  it('setOpenCodeKey writes both opencode and opencode-go entries with the same key', () => {
    const { authPath } = setOpenCodeKey(99, 'sk-dual-key');
    const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>;
    expect(parsed).toHaveProperty('opencode');
    expect(parsed).toHaveProperty('opencode-go');
    expect((parsed['opencode'] as { key: string }).key).toBe('sk-dual-key');
    expect((parsed['opencode-go'] as { key: string }).key).toBe('sk-dual-key');
  });

  it('clearOpenCodeKey removes auth.json file entirely', () => {
    const authPath = provisionAuth(99, 'sk-to-be-cleared');
    expect(fs.existsSync(authPath)).toBe(true);
    const cleared = clearOpenCodeKey(99);
    expect(cleared).toBe(true);
    expect(fs.existsSync(authPath)).toBe(false);
  });

  it('clearOpenCodeKey returns false when no auth.json exists', () => {
    ensureOpenCodeDataDir(99);
    const cleared = clearOpenCodeKey(99);
    expect(cleared).toBe(false);
  });

  it('readOpenCodeAuth accepts exactly both opencode and opencode-go keys (no more, no fewer)', () => {
    provisionAuth(99, 'sk-both-keys');
    const auth = readOpenCodeAuth(99);
    expect(Object.keys(auth).sort()).toEqual(['opencode', 'opencode-go']);
  });
});
