import { describe, it, expect } from 'vitest';

import { assertCapability, hasCapability, withCapability } from './featureGuards.js';

describe('featureGuards', () => {
  it('hasCapability returns true for anthropic + supportsAskUserQuestion', () => {
    expect(hasCapability('anthropic', 'supportsAskUserQuestion')).toBe(true);
  });

  it('hasCapability returns false for openai + supportsAskUserQuestion', () => {
    expect(hasCapability('openai', 'supportsAskUserQuestion')).toBe(false);
  });

  it('withCapability runs the callback when supported and returns its value', () => {
    const result = withCapability('anthropic', 'supportsThinkingDelta', () => 'ran');
    expect(result).toBe('ran');
  });

  it('withCapability skips the callback and returns undefined when unsupported', () => {
    let invoked = false;
    const result = withCapability('openai', 'supportsThinkingDelta', () => {
      invoked = true;
      return 'should not run';
    });
    expect(invoked).toBe(false);
    expect(result).toBeUndefined();
  });

  it('assertCapability throws on the unsupported branch', () => {
    expect(() => assertCapability('openai', 'supportsAskUserQuestion')).toThrow(
      /Provider 'openai' does not support capability 'supportsAskUserQuestion'/,
    );
  });

  it('assertCapability is a no-op when supported', () => {
    expect(() => assertCapability('anthropic', 'supportsContextUsageBreakdown')).not.toThrow();
  });
});
