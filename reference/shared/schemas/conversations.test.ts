import { describe, it, expect } from 'vitest';
import { CreateConversationBodySchema } from './conversations.js';

describe('CreateConversationBodySchema', () => {
  it('rejects an empty body (provider + model are always required)', () => {
    expect(CreateConversationBodySchema.safeParse({}).success).toBe(false);
  });

  it('rejects a body that omits provider/model', () => {
    const r = CreateConversationBodySchema.safeParse({
      message: 'hi',
      projectPath: '/repo',
      permissionMode: 'bypassPermissions',
    });
    expect(r.success).toBe(false);
  });

  it('accepts each known provider with a matching model', () => {
    expect(
      CreateConversationBodySchema.safeParse({ provider: 'anthropic', model: 'opus' }).success,
    ).toBe(true);
    expect(
      CreateConversationBodySchema.safeParse({ provider: 'openai', model: 'gpt-6.1-sol' }).success,
    ).toBe(true);
    expect(
      CreateConversationBodySchema.safeParse({
        provider: 'opencode',
        model: 'opencode/kimi-k2.7-code',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown provider', () => {
    expect(
      CreateConversationBodySchema.safeParse({ provider: 'bogus', model: 'x' }).success,
    ).toBe(false);
  });

  it('rejects a model that does not belong to the provider', () => {
    // anthropic model namespace does not include an opencode-prefixed id
    expect(
      CreateConversationBodySchema.safeParse({
        provider: 'anthropic',
        model: 'opencode/kimi-k2.7-code',
      }).success,
    ).toBe(false);
    // openai model under anthropic
    expect(
      CreateConversationBodySchema.safeParse({ provider: 'anthropic', model: 'gpt-6.1-sol' }).success,
    ).toBe(false);
    // opencode requires the 'opencode/' prefix
    expect(
      CreateConversationBodySchema.safeParse({ provider: 'opencode', model: 'kimi-k2.7-code' }).success,
    ).toBe(false);
  });

  it('requires an explicit provider — there is no default', () => {
    // provider omitted → rejected, even with an otherwise-valid model.
    expect(CreateConversationBodySchema.safeParse({ model: 'opus' }).success).toBe(false);
    // model omitted → rejected too.
    expect(CreateConversationBodySchema.safeParse({ provider: 'anthropic' }).success).toBe(false);
  });

  it('allows atlas only on the anthropic provider', () => {
    expect(
      CreateConversationBodySchema.safeParse({ provider: 'anthropic', model: 'opus', atlas: true })
        .success,
    ).toBe(true);
    // atlas: false / omitted is fine on any provider.
    expect(
      CreateConversationBodySchema.safeParse({ provider: 'openai', model: 'gpt-6.1-sol', atlas: false })
        .success,
    ).toBe(true);
    // atlas: true on a non-SDK provider is rejected — the in-process MCP
    // server only attaches to Claude Agent SDK sessions.
    expect(
      CreateConversationBodySchema.safeParse({ provider: 'openai', model: 'gpt-6.1-sol', atlas: true })
        .success,
    ).toBe(false);
    expect(
      CreateConversationBodySchema.safeParse({
        provider: 'opencode',
        model: 'opencode/kimi-k2.7-code',
        atlas: true,
      }).success,
    ).toBe(false);
  });
});
