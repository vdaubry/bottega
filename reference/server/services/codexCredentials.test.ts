import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildCodexSdkEnv,
  clearCodexAuth,
  CodexCredentialsError,
  ensureCodexHomeDir,
  getCodexAuthStatus,
  readCodexAuth,
  resolveCodexAuthJsonPath,
  resolveCodexHomeDir,
  writeCodexAuth,
} from './codexCredentials.js';

describe('codexCredentials', () => {
  let tempRoot: string;
  let originalRoot: string | undefined;
  const ENV_KEYS_TO_RESET = [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORG_ID',
    'CODEX_HOME',
    'CODEX_API_KEY',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-codex-creds-'));
    originalRoot = process.env['CODEX_CONFIG_ROOT'];
    process.env['CODEX_CONFIG_ROOT'] = tempRoot;
    for (const key of ENV_KEYS_TO_RESET) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (originalRoot === undefined) delete process.env['CODEX_CONFIG_ROOT'];
    else process.env['CODEX_CONFIG_ROOT'] = originalRoot;
    for (const key of ENV_KEYS_TO_RESET) {
      const v = savedEnv[key];
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  });

  function provisionAuth(
    userId: number,
    payload: object = {
      tokens: { access_token: 'codex-access-token-xyz', id_token: 'unused' },
    },
  ) {
    writeCodexAuth(userId, payload);
    return resolveCodexAuthJsonPath(userId);
  }

  it('resolves the per-user CODEX_HOME under the configured root', () => {
    expect(resolveCodexHomeDir(42)).toBe(path.join(tempRoot, '42', 'codex'));
    expect(resolveCodexAuthJsonPath(42)).toBe(
      path.join(tempRoot, '42', 'codex', 'auth.json'),
    );
  });

  it('creates the per-user CODEX_HOME with mode 0700', () => {
    const { codexHome } = ensureCodexHomeDir(42);
    const stat = fs.statSync(codexHome);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('rejects non-numeric or non-positive user ids', () => {
    expect(() => resolveCodexHomeDir(undefined)).toThrow(CodexCredentialsError);
    expect(() => resolveCodexHomeDir(0)).toThrow(CodexCredentialsError);
    expect(() => resolveCodexHomeDir('foo')).toThrow(CodexCredentialsError);
  });

  it('writes auth.json with mode 0600', () => {
    const authPath = provisionAuth(42);
    const stat = fs.statSync(authPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('readCodexAuth round-trips the payload', () => {
    provisionAuth(42, { tokens: { access_token: 'abc' } });
    const out = readCodexAuth(42);
    expect(out.payload.tokens?.access_token).toBe('abc');
  });

  it('readCodexAuth rejects when neither tokens nor OPENAI_API_KEY are present', () => {
    ensureCodexHomeDir(42);
    fs.writeFileSync(resolveCodexAuthJsonPath(42), JSON.stringify({}), { mode: 0o600 });
    expect(() => readCodexAuth(42)).toThrow(/neither OAuth tokens nor OPENAI_API_KEY/);
  });

  it('accepts an OPENAI_API_KEY-only auth.json', () => {
    provisionAuth(42, { OPENAI_API_KEY: 'sk-test-123' });
    const out = readCodexAuth(42);
    expect(out.payload.OPENAI_API_KEY).toBe('sk-test-123');
  });

  it('rejects an auth.json with wrong file mode (e.g. 0644)', () => {
    const authPath = provisionAuth(42);
    fs.chmodSync(authPath, 0o644);
    expect(() => readCodexAuth(42)).toThrow(/must not be accessible/);
  });

  it('returns ENOENT-shaped error when auth.json is missing', () => {
    expect(() => readCodexAuth(42)).toThrow(/not provisioned/);
  });

  it('clearCodexAuth removes the auth.json and returns true; false on second call', () => {
    provisionAuth(42);
    expect(clearCodexAuth(42)).toBe(true);
    expect(clearCodexAuth(42)).toBe(false);
  });

  it('getCodexAuthStatus reports authenticated when tokens.access_token is set', async () => {
    provisionAuth(42);
    const status = await getCodexAuthStatus(42);
    expect(status.authenticated).toBe(true);
    expect(status.method).toBe('oauth');
    expect(status.tokenFingerprint).toBe('en-xyz');
  });

  it('getCodexAuthStatus reports missing when no auth.json exists', async () => {
    const status = await getCodexAuthStatus(42);
    expect(status.authenticated).toBe(false);
    expect(status.status).toBe('missing');
    expect(status.reason).toBeDefined();
  });

  it('buildCodexSdkEnv sets CODEX_HOME and strips inherited OPENAI_*/CODEX_* keys', () => {
    process.env['OPENAI_API_KEY'] = 'sk-bad-from-process-env';
    process.env['OPENAI_BASE_URL'] = 'https://wrong.example';
    process.env['OPENAI_ORG_ID'] = 'org_bad';
    process.env['CODEX_HOME'] = '/should/be/stripped';
    process.env['CODEX_API_KEY'] = 'codex-bad';

    const env = buildCodexSdkEnv(42);

    expect(env['CODEX_HOME']).toBe(resolveCodexHomeDir(42));
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['OPENAI_BASE_URL']).toBeUndefined();
    expect(env['OPENAI_ORG_ID']).toBeUndefined();
    expect(env['CODEX_API_KEY']).toBeUndefined();
    expect(env['HOME']).toBe(process.env['HOME']);
  });

  it('cross-user isolation: user 1 status reports its own credential, user 2 reads as missing', async () => {
    provisionAuth(1);
    const s1 = await getCodexAuthStatus(1);
    const s2 = await getCodexAuthStatus(2);
    expect(s1.authenticated).toBe(true);
    expect(s2.authenticated).toBe(false);
    // user 2's auth.json path must not exist on disk.
    expect(fs.existsSync(resolveCodexAuthJsonPath(2))).toBe(false);
  });
});
