// Provider registry. Two providers (`'anthropic'`, `'openai'`) register
// themselves at module init in Phase 2 / Phase 9; `getProvider(name)`
// returns the singleton the orchestrator uses.
//
// Keeping registration explicit (rather than auto-discovering) means the
// orchestrator's resolution path is grep-able: `registerProvider('anthropic', ...)`
// vs. trawling the filesystem for handlers.

import type { Provider } from '@shared/providers/types';
import type { LlmProvider } from './types.js';
import { anthropicProvider } from './anthropic/index.js';
import { codexProvider } from './openai/index.js';
import { openCodeProvider, openCodeGoProvider } from './opencode/index.js';

const PROVIDERS = new Map<Provider, LlmProvider>();

// Default registration: all four providers are wired in unconditionally
// at module load. We register here (rather than from each provider's own
// module) so the registry's import graph is finite — the provider
// modules don't reach back into `registry.ts`.
//
// Tests that need an empty registry can call `_resetForTests()` first.
registerProvider('anthropic', anthropicProvider);
registerProvider('openai', codexProvider);
registerProvider('opencode', openCodeProvider);
registerProvider('opencode-go', openCodeGoProvider);

export function registerProvider(name: Provider, provider: LlmProvider): void {
  if (PROVIDERS.has(name)) {
    throw new Error(`Provider '${name}' is already registered`);
  }
  if (provider.name !== name) {
    throw new Error(
      `Provider registration mismatch: registering '${name}' but instance reports '${provider.name}'`,
    );
  }
  PROVIDERS.set(name, provider);
}

export function getProvider(name: Provider): LlmProvider {
  const provider = PROVIDERS.get(name);
  if (!provider) {
    throw new Error(
      `Unknown provider '${name}'. Registered providers: ${[...PROVIDERS.keys()].join(', ') || '(none)'}`,
    );
  }
  return provider;
}

export function hasProvider(name: Provider): boolean {
  return PROVIDERS.has(name);
}

/** Test-only: unregister all providers. Throws outside Vitest. */
export function _resetForTests(): void {
  if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
    throw new Error('_resetForTests is test-only');
  }
  PROVIDERS.clear();
}
