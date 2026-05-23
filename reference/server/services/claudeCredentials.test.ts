import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildClaudeSdkEnv,
  buildClaudeLoginEnv,
  buildClaudeSpawnEnv,
  ClaudeCredentialsError,
  clearClaudeOAuthToken,
  getClaudeAuthStatus,
  getQueryProcessPid,
  prepareClaudeConfigDir,
  readClaudeOAuthToken,
  resolveClaudeConfigDir,
  resolveClaudeOAuthTokenPath,
  validateClaudeCredentials,
  writeClaudeOAuthToken
} from './claudeCredentials.js';

describe('claudeCredentials', () => {
  let tempRoot: string;
  let originalClaudeConfigRoot: string | undefined;
  let originalAnthropicApiKey: string | undefined;
  let originalAnthropicAuthToken: string | undefined;
  let originalClaudeCodeOauthToken: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-claude-creds-'));
    originalClaudeConfigRoot = process.env.CLAUDE_CONFIG_ROOT;
    originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    originalClaudeCodeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CONFIG_ROOT = tempRoot;
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });

    if (originalClaudeConfigRoot === undefined) {
      delete process.env.CLAUDE_CONFIG_ROOT;
    } else {
      process.env.CLAUDE_CONFIG_ROOT = originalClaudeConfigRoot;
    }

    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    }

    if (originalAnthropicAuthToken === undefined) {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    } else {
      process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
    }

    if (originalClaudeCodeOauthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeCodeOauthToken;
    }
  });

  function provisionToken(userId: number, token = 'sk-ant-oat01-test-token') {
    writeClaudeOAuthToken(userId, token);
    return resolveClaudeOAuthTokenPath(userId);
  }

  it('resolves a per-user OAuth token path under CLAUDE_CONFIG_ROOT', () => {
    expect(resolveClaudeOAuthTokenPath(42)).toBe(path.join(tempRoot, '42', 'oauth_token'));
  });

  it('keeps the per-user .claude config dir resolution for the login sandbox', () => {
    expect(resolveClaudeConfigDir(42)).toBe(path.join(tempRoot, '42', '.claude'));
  });

  it('fails closed when no token is provisioned', () => {
    expect(() => buildClaudeSdkEnv(42)).toThrow(ClaudeCredentialsError);
    expect(() => buildClaudeSdkEnv(42)).toThrow(/not provisioned/);
  });

  it('fails closed when the token file is empty', () => {
    const tokenPath = provisionToken(42);
    fs.writeFileSync(tokenPath, '   ', { mode: 0o600 });
    expect(() => readClaudeOAuthToken(42)).toThrow(/empty/);
  });

  it('fails closed when token file permissions are too broad', () => {
    const tokenPath = provisionToken(42);
    fs.chmodSync(tokenPath, 0o644);
    expect(() => readClaudeOAuthToken(42)).toThrow(/chmod 600/);
  });

  it('writes tokens with mode 0600 and reads them back', () => {
    const tokenPath = provisionToken(42, '  sk-ant-oat01-padded-token  ');
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(readClaudeOAuthToken(42).token).toBe('sk-ant-oat01-padded-token');
  });

  it('clearClaudeOAuthToken removes the file and is idempotent', () => {
    provisionToken(42);
    expect(clearClaudeOAuthToken(42)).toBe(true);
    expect(clearClaudeOAuthToken(42)).toBe(false);
  });

  it('validateClaudeCredentials is a back-compat alias for readClaudeOAuthToken', () => {
    provisionToken(42, 'sk-ant-oat01-aliased');
    expect(validateClaudeCredentials(42).token).toBe('sk-ant-oat01-aliased');
  });

  it('writeClaudeOAuthToken refuses to persist empty values', () => {
    expect(() => writeClaudeOAuthToken(42, '')).toThrow(/empty/);
    expect(() => writeClaudeOAuthToken(42, '   ')).toThrow(/empty/);
  });

  it('builds SDK env with the per-user OAuth token and zeroes inherited auth vars', () => {
    provisionToken(42, 'sk-ant-oat01-sdk-token');
    process.env.ANTHROPIC_API_KEY = 'global-api-key';
    process.env.ANTHROPIC_AUTH_TOKEN = 'global-auth-token';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'global-oauth-token';

    const env = buildClaudeSdkEnv(42);

    expect(env).toEqual(expect.objectContaining({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-sdk-token',
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined
    }));
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });

  it('builds spawn env with the per-user OAuth token and strips inherited auth vars', () => {
    provisionToken(42, 'sk-ant-oat01-spawn-token');
    process.env.ANTHROPIC_API_KEY = 'global-api-key';
    process.env.ANTHROPIC_AUTH_TOKEN = 'global-auth-token';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'global-oauth-token';

    const env = buildClaudeSpawnEnv(42);

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-spawn-token');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('prepares a private per-user Claude config directory for the login subprocess', () => {
    const { claudeConfigDir } = prepareClaudeConfigDir(42);

    expect(claudeConfigDir).toBe(path.join(tempRoot, '42', '.claude'));
    expect(fs.statSync(claudeConfigDir).isDirectory()).toBe(true);
    expect(fs.statSync(claudeConfigDir).mode & 0o777).toBe(0o700);
  });

  it('builds login env without inherited Claude auth vars', () => {
    process.env.ANTHROPIC_API_KEY = 'global-api-key';
    process.env.ANTHROPIC_AUTH_TOKEN = 'global-auth-token';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'global-oauth-token';

    const env = buildClaudeLoginEnv(42);

    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(tempRoot, '42', '.claude'));
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('forces a wide terminal so the CLI does not hard-wrap the OAuth URL', () => {
    const env = buildClaudeLoginEnv(42);
    expect(env.COLUMNS).toBe('1000');
  });

  it('getClaudeAuthStatus reports authenticated when the token file is valid', async () => {
    provisionToken(42, 'sk-ant-oat01-status-ok');
    const status = await getClaudeAuthStatus(42);
    expect(status).toEqual(expect.objectContaining({
      authenticated: true,
      status: 'authenticated',
      tokenFingerprint: 'tus-ok'
    }));
  });

  it('getClaudeAuthStatus reports missing when the token file is absent', async () => {
    const status = await getClaudeAuthStatus(42);
    expect(status).toEqual(expect.objectContaining({
      authenticated: false,
      status: 'missing'
    }));
  });

  it('reads SDK query process pid when the SDK exposes one', () => {
    expect(getQueryProcessPid({ transport: { process: { pid: 1234 } } })).toBe(1234);
    expect(getQueryProcessPid({})).toBe(null);
  });
});
