import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openCodeCredentialStore } from './opencode.js';
import {
  OpenCodeCredentialsError,
  resolveOpenCodeAuthPath,
  resolveOpenCodeCacheDir,
  resolveOpenCodeConfigDir,
  resolveOpenCodeDataDir,
  resolveOpenCodeStateDir,
} from '../openCodeCredentials.js';

describe('credentials/opencode adapter', () => {
  let tempRoot: string;
  let originalRoot: string | undefined;
  const ENV_KEYS_TO_RESET = [
    'OPENCODE_AUTH_CONTENT',
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_CONFIG_DIR',
    'GH_CONFIG_DIR',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-opencode-adapter-'));
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

  it('read() throws when no credential is configured', () => {
    expect(() => openCodeCredentialStore.read(42)).toThrow(OpenCodeCredentialsError);
  });

  it('write() persists the key and read() returns it', () => {
    const { tokenPath } = openCodeCredentialStore.write(42, 'sk-zen-write-test');
    expect(tokenPath).toBe(resolveOpenCodeAuthPath(42));
    const out = openCodeCredentialStore.read(42);
    expect(out.token).toBe('sk-zen-write-test');
    expect(out.tokenPath).toBe(resolveOpenCodeAuthPath(42));
  });

  it('write() rejects empty / whitespace payloads', () => {
    expect(() => openCodeCredentialStore.write(42, '')).toThrow(/non-empty/);
    expect(() => openCodeCredentialStore.write(42, '   ')).toThrow(/non-empty/);
  });

  it('clear() removes the credential', () => {
    openCodeCredentialStore.write(42, 'sk-zen-clear-test');
    expect(openCodeCredentialStore.clear(42)).toBe(true);
    expect(openCodeCredentialStore.clear(42)).toBe(false);
    expect(() => openCodeCredentialStore.read(42)).toThrow(/not provisioned/);
  });

  it('getStatus() returns authenticated + fingerprint when key is present', async () => {
    openCodeCredentialStore.write(42, 'abcdef-zen-tail123');
    const status = await openCodeCredentialStore.getStatus(42);
    expect(status.authenticated).toBe(true);
    expect(status.status).toBe('authenticated');
    expect(status.tokenPath).toBe(resolveOpenCodeAuthPath(42));
    expect(status.tokenFingerprint).toBe('ail123');
  });

  it('getStatus() returns missing + reason when no key is set', async () => {
    const status = await openCodeCredentialStore.getStatus(42);
    expect(status.authenticated).toBe(false);
    expect(status.status).toBe('missing');
    expect(status.tokenPath).toBe(resolveOpenCodeAuthPath(42));
    expect(status.reason).toBeDefined();
  });

  it('buildSdkEnv() tags BOTTEGA_USER_ID so the provider can pluck userId off options.env', () => {
    const env = openCodeCredentialStore.buildSdkEnv(99);
    expect(env['BOTTEGA_USER_ID']).toBe('99');
  });

  it('buildSdkEnv() pins per-user XDG dirs, preserves host gh config, and strips global OPENCODE_* keys', () => {
    process.env['OPENCODE_AUTH_CONTENT'] = '{"opencode":{"type":"api","key":"bad"}}';
    process.env['OPENCODE_CONFIG'] = '/etc/passwd';
    process.env['OPENCODE_CONFIG_CONTENT'] = '{"bad":true}';
    process.env['OPENCODE_CONFIG_DIR'] = '/tmp/bad';
    process.env['GH_CONFIG_DIR'] = '/host/gh';

    const env = openCodeCredentialStore.buildSdkEnv(42);

    expect(env['XDG_DATA_HOME']).toBe(resolveOpenCodeDataDir(42));
    expect(env['XDG_CONFIG_HOME']).toBe(resolveOpenCodeConfigDir(42));
    expect(env['XDG_STATE_HOME']).toBe(resolveOpenCodeStateDir(42));
    expect(env['XDG_CACHE_HOME']).toBe(resolveOpenCodeCacheDir(42));
    // gh gets a targeted host config override so OpenCode can keep a
    // per-user XDG_CONFIG_HOME without breaking `gh pr create`.
    expect(env['GH_CONFIG_DIR']).toBe('/host/gh');
    expect(env['OPENCODE_AUTH_CONTENT']).toBeUndefined();
    expect(env['OPENCODE_CONFIG_DIR']).toBeUndefined();
    expect(env['OPENCODE_CONFIG']).toBe('/dev/null');
    // OPENCODE_CONFIG_CONTENT is reset to a Bottega-owned inline config
    // (grants external_directory: allow). Inherited value (`{"bad":true}`)
    // is stripped first, then replaced with our config — verify both
    // the override happened and the parent value did not leak.
    const parsed = JSON.parse(env['OPENCODE_CONFIG_CONTENT'] as string) as {
      permission?: { external_directory?: string };
      bad?: unknown;
    };
    expect(parsed.permission?.external_directory).toBe('allow');
    expect(parsed.bad).toBeUndefined();
  });
});
