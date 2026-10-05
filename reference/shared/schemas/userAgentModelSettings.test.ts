import { describe, it, expect } from 'vitest';
import { PutUserAgentModelSettingsBodySchema } from './userAgentModelSettings.js';
import {
  AGENT_TYPES_WITH_SETTINGS,
  ANTHROPIC_LOCKED_KEYS,
  type AgentModelKey,
  type AgentModelSetting,
} from '../types/agentModelSettings.js';

// Build a full PUT body, optionally overriding individual keys.
function fullBody(
  base: AgentModelSetting,
  overrides: Partial<Record<AgentModelKey, AgentModelSetting>> = {},
): Record<string, AgentModelSetting> {
  const out: Record<string, AgentModelSetting> = {};
  for (const key of AGENT_TYPES_WITH_SETTINGS) out[key] = { ...base };
  return { ...out, ...overrides };
}

describe('PutUserAgentModelSettingsBodySchema', () => {
  it('requires every key including schema (a partial body is rejected)', () => {
    const body = fullBody({ provider: 'anthropic', model: 'opus', effort: 'high' });
    delete (body as Record<string, unknown>).schema;
    expect(PutUserAgentModelSettingsBodySchema.safeParse(body).success).toBe(false);
  });

  it('accepts a full body with an Anthropic schema entry', () => {
    const body = fullBody({ provider: 'anthropic', model: 'opus', effort: 'high' });
    expect(PutUserAgentModelSettingsBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects a schema entry whose provider is not Anthropic', () => {
    const body = fullBody(
      { provider: 'anthropic', model: 'opus', effort: 'high' },
      { schema: { provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' } },
    );
    const result = PutUserAgentModelSettingsBodySchema.safeParse(body);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'schema.provider')).toBe(true);
    }
  });

  it('accepts non-Anthropic providers for task and epic agent rows (only schema is locked)', () => {
    const body = fullBody({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' });
    // Only schema must still be Anthropic.
    body.schema = { provider: 'anthropic', model: 'opus', effort: 'high' };
    for (const key of ANTHROPIC_LOCKED_KEYS) {
      body[key] = { provider: 'anthropic', model: 'opus', effort: 'high' };
    }
    expect(PutUserAgentModelSettingsBodySchema.safeParse(body).success).toBe(true);
  });

  it('accepts OpenAI for every epic stage', () => {
    const body = fullBody({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' });
    body.schema = { provider: 'anthropic', model: 'opus', effort: 'high' };
    expect(PutUserAgentModelSettingsBodySchema.safeParse(body).success).toBe(true);
  });

  it('requires every epic stage key (a body missing one is rejected)', () => {
    for (const key of ANTHROPIC_LOCKED_KEYS) {
      const body = fullBody({ provider: 'anthropic', model: 'opus', effort: 'high' });
      delete (body as Record<string, unknown>)[key];
      expect(PutUserAgentModelSettingsBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it('rejects an Anthropic-locked entry whose provider is not Anthropic', () => {
    for (const key of ANTHROPIC_LOCKED_KEYS) {
      const body = fullBody(
        { provider: 'anthropic', model: 'opus', effort: 'high' },
        { [key]: { provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' } },
      );
      const result = PutUserAgentModelSettingsBodySchema.safeParse(body);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) => i.path.join('.') === `${key}.provider`),
        ).toBe(true);
      }
    }
  });
});
