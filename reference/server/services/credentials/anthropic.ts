// Anthropic adapter for the ProviderCredentialStore interface.
//
// This is a thin facade over the existing `claudeCredentials.ts` helpers.
// Behaviour, paths, and security checks are unchanged — Phase 6 only
// re-shapes the API so the orchestrator and agentRunner can ask for
// credentials by provider name.

import {
  ClaudeCredentialsError,
  readClaudeOAuthToken,
  writeClaudeOAuthToken,
  clearClaudeOAuthToken,
  getClaudeAuthStatus,
  buildClaudeSdkEnv,
  resolveClaudeOAuthTokenPath,
} from '../claudeCredentials.js';
import type { ProviderCredentialStore } from './types.js';

export const anthropicCredentialStore: ProviderCredentialStore = {
  read(userId) {
    const { token } = readClaudeOAuthToken(userId);
    return { token, tokenPath: resolveClaudeOAuthTokenPath(userId) };
  },
  write(userId, payload) {
    writeClaudeOAuthToken(userId, payload);
    return { tokenPath: resolveClaudeOAuthTokenPath(userId) };
  },
  clear(userId) {
    return clearClaudeOAuthToken(userId);
  },
  async getStatus(userId) {
    const status = await getClaudeAuthStatus(userId);
    return {
      authenticated: status.authenticated,
      status: status.status,
      tokenPath: status.tokenPath,
      ...(status.tokenFingerprint !== undefined
        ? { tokenFingerprint: status.tokenFingerprint }
        : {}),
      ...(status.reason !== undefined ? { reason: status.reason } : {}),
    };
  },
  buildSdkEnv(userId) {
    return buildClaudeSdkEnv(userId);
  },
};

export { ClaudeCredentialsError };
