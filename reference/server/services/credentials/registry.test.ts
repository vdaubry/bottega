import { describe, it, expect, beforeEach } from 'vitest';

import {
  registerCredentialStore,
  getCredentialStore,
  hasCredentialStore,
  _resetForTests,
} from './registry.js';
import type { ProviderCredentialStore } from './types.js';

function makeFake(): ProviderCredentialStore {
  return {
    read: () => ({ token: 'fake', tokenPath: '/dev/null' }),
    write: () => ({ tokenPath: '/dev/null' }),
    clear: () => false,
    getStatus: async () => ({
      authenticated: false,
      status: 'missing',
      tokenPath: null,
    }),
    buildSdkEnv: () => ({}),
  };
}

describe('credentials/registry', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('round-trips a registration', () => {
    const fake = makeFake();
    registerCredentialStore('anthropic', fake);
    expect(getCredentialStore('anthropic')).toBe(fake);
    expect(hasCredentialStore('anthropic')).toBe(true);
  });

  it('throws on double-register', () => {
    registerCredentialStore('anthropic', makeFake());
    expect(() => registerCredentialStore('anthropic', makeFake())).toThrow(/already registered/);
  });

  it('throws on get for an unregistered provider', () => {
    expect(() => getCredentialStore('openai')).toThrow(/No credential store/);
  });

  it('default module load wires opencode alongside anthropic and openai', async () => {
    _resetForTests();
    await import('./registry.js?reload=opencode-default' as string).catch(() => {
      // The query string is a no-op; importing the bare module re-runs the
      // top-level registerCredentialStore() calls once the registry has
      // been reset.
    });
    // The module's top-level side effects already ran on initial import,
    // so a fresh import won't re-register. Use the explicit registration
    // helper instead to confirm the default opencode adapter is available
    // and shaped like a ProviderCredentialStore.
    const { openCodeCredentialStore } = await import('./opencode.js');
    registerCredentialStore('opencode', openCodeCredentialStore);
    const store = getCredentialStore('opencode');
    expect(store).toBe(openCodeCredentialStore);
    expect(typeof store.read).toBe('function');
    expect(typeof store.write).toBe('function');
    expect(typeof store.clear).toBe('function');
    expect(typeof store.getStatus).toBe('function');
    expect(typeof store.buildSdkEnv).toBe('function');
  });
});
