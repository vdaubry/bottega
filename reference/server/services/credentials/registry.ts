// Registry of per-provider credential stores.
//
// Phase 6 registers only the Anthropic store at module-load. Phase 10
// (Codex auth) plugs the OpenAI store in here; once that happens, the
// orchestrator can build the right SDK env via
// `getCredentialStore(provider).buildSdkEnv(userId)` without knowing
// which backend is on the other end.

import type { Provider } from '@shared/providers/types';
import { anthropicCredentialStore } from './anthropic.js';
import { codexCredentialStore } from './openai.js';
import { openCodeCredentialStore } from './opencode.js';
import type { ProviderCredentialStore } from './types.js';

const STORES = new Map<Provider, ProviderCredentialStore>();

export function registerCredentialStore(
  name: Provider,
  store: ProviderCredentialStore,
): void {
  if (STORES.has(name)) {
    throw new Error(`Credential store for '${name}' is already registered`);
  }
  STORES.set(name, store);
}

export function getCredentialStore(name: Provider): ProviderCredentialStore {
  const store = STORES.get(name);
  if (!store) {
    throw new Error(
      `No credential store registered for '${name}'. Registered: ${[...STORES.keys()].join(', ') || '(none)'}`,
    );
  }
  return store;
}

export function hasCredentialStore(name: Provider): boolean {
  return STORES.has(name);
}

/** Test-only: clear the registry. */
export function _resetForTests(): void {
  if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
    throw new Error('_resetForTests is test-only');
  }
  STORES.clear();
}

// Default registration: all stores are wired in at module load.
// Anthropic is the legacy path; OpenAI / Codex are later tenants.
// OpenCode and OpenCode Go share the same credential store (single Zen API key).
registerCredentialStore('anthropic', anthropicCredentialStore);
registerCredentialStore('openai', codexCredentialStore);
registerCredentialStore('opencode', openCodeCredentialStore);
registerCredentialStore('opencode-go', openCodeCredentialStore);
