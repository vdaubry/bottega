// OpenCode adapter for the ProviderCredentialStore interface.
//
// Wraps the per-user openCodeCredentials.ts helpers so the credential
// registry can hand the orchestrator the OpenCode spawn env without
// orchestrator code knowing anything about XDG_DATA_HOME / auth.json.
//
// Single Zen API key per user (R15) — `write` takes the bare API key,
// not a JSON document. The OpenCode auth panel POSTs the pasted key
// verbatim; this adapter persists it under the on-disk shape
// `{ opencode: { type: 'api', key } }` that `opencode serve` reads.

import {
  buildOpenCodeSpawnEnv,
  clearOpenCodeKey,
  getOpenCodeAuthStatus,
  OpenCodeCredentialsError,
  readOpenCodeAuth,
  resolveOpenCodeAuthPath,
  setOpenCodeKey,
} from '../openCodeCredentials.js';
import type { ProviderCredentialStore } from './types.js';

export const openCodeCredentialStore: ProviderCredentialStore = {
  read(userId) {
    const auth = readOpenCodeAuth(userId);
    // Both `opencode` and `opencode-go` entries have the same key (Zen billing).
    // Read from either — validation already ensures both are present and well-formed.
    return {
      token: auth.opencode.key || auth['opencode-go'].key,
      tokenPath: resolveOpenCodeAuthPath(userId),
    };
  },

  write(userId, payload) {
    const apiKey = typeof payload === 'string' ? payload.trim() : '';
    if (!apiKey) {
      throw new OpenCodeCredentialsError(
        'OpenCode credential payload must be a non-empty Zen API key string',
      );
    }
    const { authPath } = setOpenCodeKey(userId, apiKey);
    return { tokenPath: authPath };
  },

  clear(userId) {
    return clearOpenCodeKey(userId);
  },

  async getStatus(userId) {
    const status = await getOpenCodeAuthStatus(userId);
    return {
      authenticated: status.authenticated,
      status: status.status,
      tokenPath: status.authPath,
      ...(status.tokenFingerprint !== undefined
        ? { tokenFingerprint: status.tokenFingerprint }
        : {}),
      ...(status.reason !== undefined ? { reason: status.reason } : {}),
    };
  },

  buildSdkEnv(userId) {
    // The base env is what the spawned `opencode serve` reads. We tag on
    // BOTTEGA_USER_ID so the provider on the orchestrator side can pluck
    // the userId back out of `ProviderRunOptions.env` without having to
    // extend the shared `ProviderRunOptions` shape (R4: no churn). The
    // server-pool spawn rebuilds its own env from scratch via
    // `buildOpenCodeSpawnEnv(userId)`, so this tag never leaks into the
    // opencode-serve subprocess.
    return {
      ...buildOpenCodeSpawnEnv(userId),
      BOTTEGA_USER_ID: String(userId ?? ''),
    };
  },
};

export { OpenCodeCredentialsError };
