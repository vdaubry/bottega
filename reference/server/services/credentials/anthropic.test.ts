import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../claudeCredentials.js', () => ({
  ClaudeCredentialsError: class extends Error {},
  readClaudeOAuthToken: vi.fn(),
  writeClaudeOAuthToken: vi.fn(),
  clearClaudeOAuthToken: vi.fn(),
  getClaudeAuthStatus: vi.fn(),
  buildClaudeSdkEnv: vi.fn(),
  resolveClaudeOAuthTokenPath: vi.fn(),
}));

import {
  readClaudeOAuthToken,
  writeClaudeOAuthToken,
  clearClaudeOAuthToken,
  getClaudeAuthStatus,
  buildClaudeSdkEnv,
  resolveClaudeOAuthTokenPath,
} from '../claudeCredentials.js';
import { anthropicCredentialStore } from './anthropic.js';

describe('anthropicCredentialStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveClaudeOAuthTokenPath).mockReturnValue('/path/to/token');
  });

  it('read delegates to readClaudeOAuthToken and returns tokenPath', () => {
    vi.mocked(readClaudeOAuthToken).mockReturnValue({ token: 't-123', tokenPath: '/x' });
    const out = anthropicCredentialStore.read(42);
    expect(out.token).toBe('t-123');
    expect(out.tokenPath).toBe('/path/to/token');
    expect(readClaudeOAuthToken).toHaveBeenCalledWith(42);
  });

  it('write delegates to writeClaudeOAuthToken', () => {
    const out = anthropicCredentialStore.write(42, 'payload');
    expect(writeClaudeOAuthToken).toHaveBeenCalledWith(42, 'payload');
    expect(out.tokenPath).toBe('/path/to/token');
  });

  it('clear delegates to clearClaudeOAuthToken', () => {
    vi.mocked(clearClaudeOAuthToken).mockReturnValue(true);
    expect(anthropicCredentialStore.clear(42)).toBe(true);
  });

  it('buildSdkEnv delegates to buildClaudeSdkEnv', () => {
    vi.mocked(buildClaudeSdkEnv).mockReturnValue({
      HOME: '/home/u',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: 'abc',
    } as never);
    const env = anthropicCredentialStore.buildSdkEnv(42);
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('abc');
  });

  it('getStatus translates a successful authenticated status', async () => {
    vi.mocked(getClaudeAuthStatus).mockResolvedValueOnce({
      authenticated: true,
      status: 'authenticated',
      tokenPath: '/x',
      tokenFingerprint: 'abcdef',
    });
    const out = await anthropicCredentialStore.getStatus(42);
    expect(out).toEqual({
      authenticated: true,
      status: 'authenticated',
      tokenPath: '/x',
      tokenFingerprint: 'abcdef',
    });
  });

  it('getStatus passes through the missing reason', async () => {
    vi.mocked(getClaudeAuthStatus).mockResolvedValueOnce({
      authenticated: false,
      status: 'missing',
      tokenPath: '/x',
      reason: 'ENOENT',
    });
    const out = await anthropicCredentialStore.getStatus(42);
    expect(out.authenticated).toBe(false);
    expect(out.reason).toBe('ENOENT');
  });
});
