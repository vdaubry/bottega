import { describe, it, expect } from 'vitest';

import {
  EFFORTS_FOR_UI,
  MODELS_FOR_UI,
  AGENT_TYPES_WITH_SETTINGS,
  DEFAULT_AGENT_MODEL_SETTINGS,
  SCHEMA_DEFAULT_SETTING,
  ANTHROPIC_LOCKED_DEFAULTS,
  isAnthropicLockedKey,
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
        isValidAgentModelSetting({ provider: 'openai', model: 'gpt-6-astra', effort: 'medium' }),
      ).toBe(true);
    });

    it('accepts an OpenCode entry with a null effort', () => {
      expect(
        isValidAgentModelSetting({
          provider: 'opencode',
          model: 'opencode/kimi-k2.7-code',
          effort: null,
        }),
      ).toBe(true);
    });

    it('rejects an OpenCode entry with any non-null effort', () => {
      // Per § D6: OpenCode has no effort dimension.
      expect(
        isValidAgentModelSetting({
          provider: 'opencode',
          model: 'opencode/kimi-k2.7-code',
          effort: 'high',
        }),
      ).toBe(false);
      expect(
        isValidAgentModelSetting({
          provider: 'opencode',
          model: 'opencode/kimi-k2.7-code',
          effort: '',
        }),
      ).toBe(false);
    });

    it('rejects an OpenCode entry whose model lacks the opencode/ prefix', () => {
      expect(
        isValidAgentModelSetting({ provider: 'opencode', model: 'kimi-k2.7-code', effort: null }),
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

    it('defaults openai to GPT-6.1 Sol', () => {
      expect(defaultSettingForProvider('openai', null)).toEqual({
        provider: 'openai',
        model: 'gpt-6.1-sol',
        effort: 'high',
      });
    });

    it('uses the supplied live OpenCode model id (no effort)', () => {
      expect(defaultSettingForProvider('opencode', 'opencode/kimi-k2.7-code')).toEqual({
        provider: 'opencode',
        model: 'opencode/kimi-k2.7-code',
        effort: null,
      });
    });

    it('returns null for opencode when no live model id is available (never guesses)', () => {
      expect(defaultSettingForProvider('opencode', null)).toBeNull();
    });
  });

  describe('buildSeedSettings', () => {
    it('fills every agent with the provider default and every locked key with its own', () => {
      const seed = buildSeedSettings('anthropic', null);
      expect(seed).not.toBeNull();
      for (const key of AGENT_TYPES_WITH_SETTINGS) {
        const expected = ANTHROPIC_LOCKED_DEFAULTS[key] ?? {
          provider: 'anthropic',
          model: 'sonnet',
          effort: 'high',
        };
        expect(seed![key]).toEqual(expected);
      }
    });

    it('seeds every epic stage to the selected provider', () => {
      const seed = buildSeedSettings('openai', null);
      expect(seed).not.toBeNull();
      expect(seed!['epic-architecture']).toEqual({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' });
      expect(seed!['epic-orchestrator']).toEqual({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' });
    });

    it('seeds schema as Anthropic even when the other agents seed to a different provider', () => {
      const seed = buildSeedSettings('openai', null);
      expect(seed).not.toBeNull();
      // The agent rows follow the chosen provider…
      expect(seed!.planification).toEqual({ provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' });
      // …but schema is locked to the Anthropic default.
      expect(seed!.schema).toEqual(SCHEMA_DEFAULT_SETTING);
      expect(seed!.schema.provider).toBe('anthropic');
    });

    it('returns null when the provider cannot be defaulted (opencode, no model id)', () => {
      expect(buildSeedSettings('opencode', null)).toBeNull();
    });
  });

  describe('schema model key', () => {
    it("includes 'schema' in the settings list", () => {
      expect(AGENT_TYPES_WITH_SETTINGS).toContain('schema');
    });

    it('includes every epic stage key in the settings list', () => {
      for (const key of [
        'epic-architecture',
        'epic-specification',
        'epic-stories',
        'epic-orchestrator',
      ]) {
        expect(AGENT_TYPES_WITH_SETTINGS).toContain(key);
        expect(isAnthropicLockedKey(key as never)).toBe(false);
      }
    });

    it('exposes an Anthropic schema default', () => {
      expect(DEFAULT_AGENT_MODEL_SETTINGS.schema.provider).toBe('anthropic');
      expect(SCHEMA_DEFAULT_SETTING.provider).toBe('anthropic');
      expect(isValidAgentModelSetting(SCHEMA_DEFAULT_SETTING)).toBe(true);
    });
  });
});
