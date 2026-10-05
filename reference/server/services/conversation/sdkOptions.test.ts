import { describe, it, expect, vi } from 'vitest';

// mapOptionsToSDK imports sqliteSessionStore (which touches the DB layer at
// import) via sdkOptions.ts; stub it so this stays a fast unit test.
vi.mock('../sqliteSessionStore.js', () => ({
  sqliteSessionStore: {},
}));

import { mapOptionsToSDK } from './sdkOptions.js';

describe('mapOptionsToSDK — background-task PreToolUse gate wiring', () => {
  it('registers a PreToolUse hook that neutralizes background execution', async () => {
    const sdk = mapOptionsToSDK({ model: 'sonnet' });

    const hooks = sdk.hooks;
    if (!hooks) throw new Error('expected hooks to be wired');
    const preToolUse = hooks.PreToolUse;
    if (!preToolUse) throw new Error('expected a PreToolUse matcher');
    const matcher = preToolUse[0];
    if (!matcher) throw new Error('expected a PreToolUse matcher entry');
    expect(matcher.hooks).toHaveLength(1);

    const hook = matcher.hooks[0];
    if (!hook) throw new Error('expected a PreToolUse hook callback');

    // Bash run_in_background is forced to the foreground.
    const bashOut = (await hook({
      tool_name: 'Bash',
      tool_input: { command: 'x', run_in_background: true },
    })) as { hookSpecificOutput?: { updatedInput?: { run_in_background?: unknown } } };
    expect(bashOut.hookSpecificOutput?.updatedInput?.run_in_background).toBe(false);

    // Monitor is denied.
    const monitorOut = (await hook({ tool_name: 'Monitor', tool_input: {} })) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(monitorOut.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('appends extra PreToolUse hooks after the background gate, in order', async () => {
    const extra = vi.fn().mockResolvedValue({});
    const sdk = mapOptionsToSDK({
      model: 'sonnet',
      extraPreToolUseHooks: [extra],
    });

    const matcher = sdk.hooks?.PreToolUse?.[0];
    if (!matcher) throw new Error('expected a PreToolUse matcher entry');
    expect(matcher.hooks).toHaveLength(2);
    // The background gate stays first — an added hook can only narrow the
    // surface further, never re-open what it closed.
    const monitorOut = (await matcher.hooks[0]!({ tool_name: 'Monitor', tool_input: {} })) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(monitorOut.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(matcher.hooks[1]).toBe(extra);
  });

  it('registers only the background gate when no extra hooks are passed', () => {
    const sdk = mapOptionsToSDK({ model: 'sonnet', extraPreToolUseHooks: [] });
    expect(sdk.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
  });

  it('always sets an explicit model on the SDK options', () => {
    const sdk = mapOptionsToSDK({ model: 'opus' });
    expect(sdk.model).toBe('opus');
  });
});
