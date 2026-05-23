// OpenAI/Codex adapter for the ProviderCredentialStore interface.
//
// Wraps the per-user codexCredentials.ts helpers so the credential
// registry can hand the orchestrator a Codex env without orchestrator
// code knowing anything about CODEX_HOME.
//
// Note: the `write` operation here takes a *string* (the JSON of the
// auth.json). The codex-login PTY flow (Phase 10 part 2) writes the
// file directly via `codex login --device-auth`, so this write path
// is reserved for the manual paste-auth.json fallback (Path B).

import {
  buildCodexSdkEnv,
  clearCodexAuth,
  getCodexAuthStatus,
  readCodexAuth,
  resolveCodexAuthJsonPath,
  writeCodexAuth,
} from '../codexCredentials.js';
import type { ProviderCredentialStore } from './types.js';

export const codexCredentialStore: ProviderCredentialStore = {
  read(userId) {
    const { payload, authPath } = readCodexAuth(userId);
    // We surface the access_token as the "token" since that's what
    // every cross-provider call shape expects. If only an
    // OPENAI_API_KEY is present, that becomes the token.
    const token =
      payload.tokens?.access_token ??
      payload.tokens?.id_token ??
      payload.OPENAI_API_KEY ??
      '';
    return { token, tokenPath: authPath };
  },

  write(userId, payload) {
    // Treat the payload string as auth.json contents (JSON). Path B
    // paste-auth.json validates JSON shape; this just persists.
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new Error('Codex credential payload must be valid JSON (auth.json contents)');
    }
    const { authPath } = writeCodexAuth(userId, parsed);
    return { tokenPath: authPath };
  },

  clear(userId) {
    return clearCodexAuth(userId);
  },

  async getStatus(userId) {
    const status = await getCodexAuthStatus(userId);
    return {
      authenticated: status.authenticated,
      status: status.status,
      tokenPath: status.authPath ?? resolveCodexAuthJsonPath(userId),
      ...(status.tokenFingerprint !== undefined
        ? { tokenFingerprint: status.tokenFingerprint }
        : {}),
      ...(status.email !== undefined ? { email: status.email } : {}),
      ...(status.reason !== undefined ? { reason: status.reason } : {}),
    };
  },

  buildSdkEnv(userId) {
    return buildCodexSdkEnv(userId);
  },
};
