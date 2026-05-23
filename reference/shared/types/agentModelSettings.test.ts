import { describe, it, expect } from 'vitest';

import {
  EFFORTS_FOR_UI,
  MODELS_FOR_UI,
  AGENT_TYPES_WITH_SETTINGS,
  isValidAgentModelSetting,
  defaultSettingForProvider,
  buildSeedSettings,
} from './agentModelSettings.js';

describe('shared/types/agentModelSettings', () => {
  describe('isValidAgentModelSetting', () => {
    it('accepts a well-formed Anthropic triple', () => {
      expect(
        isValidAgentModelSetting({ provider: 'anthropic', model: 'opus', effort: 'high' }),
      ).toBe(true);
    });

    it('accepts a well-formed OpenAI triple', () => {
      expect(
        isValidAgentModelSetting({ provider: 'openai', model: 'gpt-5.5', effort: 'minimal' }),
      ).toBe(true);
    });

    it('accepts an OpenCode entry with a null effort', () => {
      expect(
        isValidAgentModelSetting({
          provider: 'opencode',
          model: 'opencode/kimi-k2.6',
          effort: null,
        }),
      ).toBe(true);
    });

    it('rejects an OpenCode entry with any non-null effort', () => {
      // Per § D6: OpenCode has no effort dimension.
      expect(
        isValidAgentModelSetting({
          provider: 'opencode',
          model: 'opencode/kimi-k2.6',
          effort: 'high',
        }),
      ).toBe(false);
      expect(
        isValidAgentModelSetting({
          provider: 'opencode',
          model: 'opencode/kimi-k2.6',
          effort: '',
        }),
      ).toBe(false);
    });

    it('rejects an OpenCode entry whose model lacks the opencode/ prefix', () => {
      expect(
        isValidAgentModelSetting({ provider: 'opencode', model: 'kimi-k2.6', effort: null }),
      ).toBe(false);
    });

    it('rejects an OpenCode entry whose model belongs to another provider', () => {
      expect(
        isValidAgentModelSetting({ provider: 'opencode', model: 'opus', effort: null }),
      ).toBe(false);
    });

    it('rejects an unknown provider', () => {
      expect(
        isValidAgentModelSetting({ provider: 'cohere', model: 'opus', effort: null }),
      ).toBe(false);
    });
  });

  describe('UI option tables', () => {
    it('exposes an empty OpenCode model list — the Zen catalog is fetched live by the UI', () => {
      // Bottega no longer hardcodes OpenCode model IDs (Phase 12.3
      // fallout: the hand-curated subset contained IDs Zen no longer
      // serves). The UI populates its dropdown from
      // `GET /api/opencode-auth/models`. See `shared/providers/models.ts`
      // for the rationale and the `feedback_no_guessing_external_lists`
      // memory.
      expect([...MODELS_FOR_UI.opencode]).toEqual([]);
    });

    it('exposes an empty OpenCode effort list (UI hides the dropdown)', () => {
      expect([...EFFORTS_FOR_UI.opencode]).toEqual([]);
    });
  });

  describe('defaultSettingForProvider', () => {
    it('defaults anthropic to Sonnet', () => {
      expect(defaultSettingForProvider('anthropic', null)).toEqual({
        provider: 'anthropic',
        model: 'sonnet',
        effort: 'high',
      });
    });

    it('defaults openai to GPT-5.5', () => {
      expect(defaultSettingForProvider('openai', null)).toEqual({
        provider: 'openai',
        model: 'gpt-5.5',
        effort: 'high',
      });
    });

    it('uses the supplied live OpenCode model id (no effort)', () => {
      expect(defaultSettingForProvider('opencode', 'opencode/kimi-k2')).toEqual({
        provider: 'opencode',
        model: 'opencode/kimi-k2',
        effort: null,
      });
    });

    it('returns null for opencode when no live model id is available (never guesses)', () => {
      expect(defaultSettingForProvider('opencode', null)).toBeNull();
    });
  });

  describe('buildSeedSettings', () => {
    it('fills all six agents with the provider default', () => {
      const seed = buildSeedSettings('anthropic', null);
      expect(seed).not.toBeNull();
      for (const agent of AGENT_TYPES_WITH_SETTINGS) {
        expect(seed![agent]).toEqual({ provider: 'anthropic', model: 'sonnet', effort: 'high' });
      }
    });

    it('returns null when the provider cannot be defaulted (opencode, no model id)', () => {
      expect(buildSeedSettings('opencode', null)).toBeNull();
    });
  });
});
