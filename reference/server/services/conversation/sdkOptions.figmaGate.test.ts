/**
 * The Figma write denial is a global invariant: no Bottega agent may ever
 * mutate a Figma file. Enforcement lives in `mapOptionsToSDK`, so it is tested
 * here rather than per-agent.
 */
import { describe, it, expect } from 'vitest';
import { mapOptionsToSDK } from './sdkOptions.js';
import { FIGMA_WRITE_TOOLS } from '../../constants/figmaTools.js';

const base = { model: 'claude-opus-5-5' };

describe('mapOptionsToSDK — Figma write gate', () => {
  it('denies every Figma write tool when the caller passes no disallowedTools', () => {
    const opts = mapOptionsToSDK({ ...base });
    expect(opts.disallowedTools).toEqual(expect.arrayContaining([...FIGMA_WRITE_TOOLS]));
  });

  it('denies every Figma write tool when the caller passes an empty list', () => {
    // The common case: agentRunner passes [] for every non-implementation
    // agent. Gating on `.length` here would have silently skipped the denial.
    const opts = mapOptionsToSDK({ ...base, disallowedTools: [] });
    expect(opts.disallowedTools).toEqual(expect.arrayContaining([...FIGMA_WRITE_TOOLS]));
  });

  it("preserves the caller's own denials alongside the Figma ones", () => {
    const opts = mapOptionsToSDK({ ...base, disallowedTools: ['Bash', 'Write'] });
    expect(opts.disallowedTools).toEqual(
      expect.arrayContaining(['Bash', 'Write', ...FIGMA_WRITE_TOOLS]),
    );
  });

  it('leaves the Figma read tools callable — the read surface is the feature', () => {
    const opts = mapOptionsToSDK({ ...base });
    for (const readTool of [
      'mcp__plugin_figma_figma__get_design_context',
      'mcp__plugin_figma_figma__get_screenshot',
      'mcp__plugin_figma_figma__get_metadata',
      'mcp__plugin_figma_figma__get_variable_defs',
      'mcp__plugin_figma_figma__search_design_system',
    ]) {
      expect(opts.disallowedTools).not.toContain(readTool);
    }
  });

  it('denies use_figma, the arbitrary-JS-in-file-context tool', () => {
    // Regression anchor: this is the one the Epic planner reached for
    // unprompted on a pure read task.
    expect(mapOptionsToSDK({ ...base }).disallowedTools).toContain(
      'mcp__plugin_figma_figma__use_figma',
    );
  });
});
