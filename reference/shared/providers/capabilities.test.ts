import { describe, it, expect } from 'vitest';

import { CAPABILITIES_BY_PROVIDER, getCapabilities } from './capabilities.js';
import { PROVIDERS } from './models.js';

describe('shared/providers/capabilities', () => {
  it('has an entry for every Provider value', () => {
    for (const provider of PROVIDERS) {
      expect(CAPABILITIES_BY_PROVIDER[provider]).toBeDefined();
    }
  });

  it('Anthropic has every capability on', () => {
    const caps = CAPABILITIES_BY_PROVIDER.anthropic;
    expect(caps.supportsAskUserQuestion).toBe(true);
    expect(caps.supportsThinkingDelta).toBe(true);
    expect(caps.supportsContextUsageBreakdown).toBe(true);
    expect(caps.supportsMcpServers).toBe(true);
    expect(caps.supportsImages).toBe(true);
  });

  it('OpenAI starts with conservative placeholders for v1', () => {
    const caps = CAPABILITIES_BY_PROVIDER.openai;
    // Per D3: AskUserQuestion is Claude-only in v1.
    expect(caps.supportsAskUserQuestion).toBe(false);
    expect(caps.supportsThinkingDelta).toBe(false);
    expect(caps.supportsContextUsageBreakdown).toBe(false);
    expect(caps.supportsMcpServers).toBe(false);
    expect(caps.supportsImages).toBe(false);
  });

  it('OpenCode mirrors the Codex posture (every flag off in v1)', () => {
    // Per docs/opencode/00-context-decisions.md § D8.
    const caps = CAPABILITIES_BY_PROVIDER.opencode;
    expect(caps.supportsAskUserQuestion).toBe(false);
    expect(caps.supportsThinkingDelta).toBe(false);
    expect(caps.supportsContextUsageBreakdown).toBe(false);
    expect(caps.supportsMcpServers).toBe(false);
    expect(caps.supportsImages).toBe(false);
  });

  it('OpenCode Go has identical capabilities to OpenCode (every flag off in v1)', () => {
    const caps = CAPABILITIES_BY_PROVIDER['opencode-go'];
    expect(caps.supportsAskUserQuestion).toBe(false);
    expect(caps.supportsThinkingDelta).toBe(false);
    expect(caps.supportsContextUsageBreakdown).toBe(false);
    expect(caps.supportsMcpServers).toBe(false);
    expect(caps.supportsImages).toBe(false);
  });

  it('getCapabilities returns the same object as the matrix lookup', () => {
    expect(getCapabilities('anthropic')).toBe(CAPABILITIES_BY_PROVIDER.anthropic);
    expect(getCapabilities('openai')).toBe(CAPABILITIES_BY_PROVIDER.openai);
    expect(getCapabilities('opencode')).toBe(CAPABILITIES_BY_PROVIDER.opencode);
    expect(getCapabilities('opencode-go')).toBe(CAPABILITIES_BY_PROVIDER['opencode-go']);
  });
});
