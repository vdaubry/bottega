import { describe, it, expect, beforeEach } from 'vitest';

import { registerProvider, getProvider, hasProvider, _resetForTests } from './registry.js';
import type { LlmProvider } from './types.js';

function makeFake(name: 'anthropic' | 'openai'): LlmProvider {
  return {
    name,
    getCapabilities: () => ({
      supportsAskUserQuestion: false,
      supportsThinkingDelta: false,
      supportsContextUsageBreakdown: false,
      supportsMcpServers: false,
      supportsImages: false,
    }),
    startTurn: async () => {
      throw new Error('not implemented (fake)');
    },
    sendTurnMessage: async () => {
      throw new Error('not implemented (fake)');
    },
    loadTranscript: async () => [],
    abortTurn: () => false,
  };
}

describe('server/services/providers/registry', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('round-trips a provider registration', () => {
    const fake = makeFake('anthropic');
    registerProvider('anthropic', fake);
    expect(getProvider('anthropic')).toBe(fake);
    expect(hasProvider('anthropic')).toBe(true);
  });

  it('throws when registering the same provider twice', () => {
    registerProvider('anthropic', makeFake('anthropic'));
    expect(() => registerProvider('anthropic', makeFake('anthropic'))).toThrow(/already registered/);
  });

  it('throws when the registered name disagrees with the instance', () => {
    expect(() => registerProvider('anthropic', makeFake('openai'))).toThrow(
      /registration mismatch/,
    );
  });

  it('throws on getProvider for an unknown provider', () => {
    expect(() => getProvider('openai')).toThrow(/Unknown provider 'openai'/);
  });

  it('hasProvider returns false for unregistered providers', () => {
    expect(hasProvider('openai')).toBe(false);
  });
});
