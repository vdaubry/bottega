import { describe, it, expect } from 'vitest';

import {
  ANTHROPIC_MODELS,
  ANTHROPIC_EFFORTS,
  OPENAI_MODELS,
  OPENAI_EFFORTS,
  OPENCODE_MODELS,
  OPENCODE_EFFORTS,
  PROVIDERS,
  modelsForProvider,
  effortsForProvider,
  isProvider,
  isAnthropicModel,
  isAnthropicEffort,
  isOpenAIModel,
  isOpenAIEffort,
  isOpenCodeModel,
  isOpenCodeGoModel,
  isOpenCodeEffort,
  isModelForProvider,
  isEffortForProvider,
} from './models.js';

describe('shared/providers/models', () => {
  describe('static lists', () => {
    it('exposes the canonical Anthropic model list (sonnet, opus — no haiku)', () => {
      expect(ANTHROPIC_MODELS).toEqual(['sonnet', 'opus']);
    });

    it('exposes Anthropic efforts including xhigh and max', () => {
      expect(ANTHROPIC_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    });

    it('exposes the canonical OpenAI model list (gpt-5.5, gpt-5.4, gpt-5.4-mini)', () => {
      expect(OPENAI_MODELS).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
    });

    it('exposes OpenAI efforts mirroring the SDK ModelReasoningEffort union (minimal..xhigh)', () => {
      expect(OPENAI_EFFORTS).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    });

    it('ships no hardcoded OpenCode model list — the Zen catalog is fetched live from /api/opencode-auth/models', () => {
      // The Zen catalog (≈40 models, owned by OpenCode) changes faster
      // than we can chase. Hardcoding it caused the Phase 12.3 marquee
      // run to fail with `Model not found: opencode/qwen3-coder. Did
      // you mean: qwen3.5-plus, qwen3.6-plus, qwen3.6-plus-free?`.
      // Truth lives in OpenCode's `/config/providers`; Bottega proxies
      // it via `/api/opencode-auth/models` and the settings UI fetches
      // at render time. See feedback_no_guessing_external_lists.
      expect([...OPENCODE_MODELS]).toEqual([]);
    });

    it('exposes no OpenCode efforts (reasoning lives in the modelID)', () => {
      expect([...OPENCODE_EFFORTS]).toEqual([]);
    });

    it('enumerates all four providers', () => {
      expect([...PROVIDERS]).toEqual(['anthropic', 'openai', 'opencode', 'opencode-go']);
    });
  });

  describe('per-provider list helpers', () => {
    it('modelsForProvider returns the Anthropic list', () => {
      expect(modelsForProvider('anthropic')).toEqual(ANTHROPIC_MODELS);
    });
    it('modelsForProvider returns the OpenAI list', () => {
      expect(modelsForProvider('openai')).toEqual(OPENAI_MODELS);
    });
    it('modelsForProvider returns the OpenCode list', () => {
      expect(modelsForProvider('opencode')).toEqual(OPENCODE_MODELS);
    });
    it('effortsForProvider returns the Anthropic list', () => {
      expect(effortsForProvider('anthropic')).toEqual(ANTHROPIC_EFFORTS);
    });
    it('effortsForProvider returns the OpenAI list', () => {
      expect(effortsForProvider('openai')).toEqual(OPENAI_EFFORTS);
    });
    it('effortsForProvider returns an empty list for OpenCode (both Zen and Go)', () => {
      expect(effortsForProvider('opencode')).toEqual([]);
      expect(effortsForProvider('opencode-go')).toEqual([]);
    });
  });

  describe('type guards', () => {
    it('isProvider accepts anthropic/openai/opencode/opencode-go and rejects bogus values', () => {
      expect(isProvider('anthropic')).toBe(true);
      expect(isProvider('openai')).toBe(true);
      expect(isProvider('opencode')).toBe(true);
      expect(isProvider('opencode-go')).toBe(true);
      expect(isProvider('claude')).toBe(false);
      expect(isProvider('')).toBe(false);
      expect(isProvider(undefined)).toBe(false);
      expect(isProvider(42)).toBe(false);
    });

    it('isAnthropicModel rejects openai models', () => {
      expect(isAnthropicModel('sonnet')).toBe(true);
      expect(isAnthropicModel('opus')).toBe(true);
      expect(isAnthropicModel('haiku')).toBe(false);
      expect(isAnthropicModel('gpt-5.5')).toBe(false);
    });

    it('isAnthropicEffort rejects bogus efforts', () => {
      expect(isAnthropicEffort('high')).toBe(true);
      expect(isAnthropicEffort('max')).toBe(true);
      expect(isAnthropicEffort('minimal')).toBe(false);
      expect(isAnthropicEffort('extreme')).toBe(false);
    });

    it('isOpenAIModel accepts gpt-5.* and rejects anthropic models', () => {
      expect(isOpenAIModel('gpt-5.5')).toBe(true);
      expect(isOpenAIModel('gpt-5.4-mini')).toBe(true);
      expect(isOpenAIModel('opus')).toBe(false);
      expect(isOpenAIModel('gpt-4')).toBe(false);
    });

    it('isOpenAIEffort accepts minimal..xhigh and rejects max', () => {
      expect(isOpenAIEffort('minimal')).toBe(true);
      expect(isOpenAIEffort('xhigh')).toBe(true);
      expect(isOpenAIEffort('max')).toBe(false);
      expect(isOpenAIEffort(undefined)).toBe(false);
    });

    it('isOpenCodeModel accepts anything with the opencode/ prefix — Zen owns the namespace', () => {
      expect(isOpenCodeModel('opencode/kimi-k2.6')).toBe(true);
      expect(isOpenCodeModel('opencode/qwen3.6-plus')).toBe(true);
      // Unknown model names also pass — runtime validation happens
      // at the SDK boundary where OpenCode itself returns "Model not
      // found". The alternative (hardcoded enum) is what we explicitly
      // removed in Phase 12.3.
      expect(isOpenCodeModel('opencode/some-future-model')).toBe(true);
      // Bare modelID (SDK form) is not the Bottega-persisted shape.
      expect(isOpenCodeModel('kimi-k2.6')).toBe(false);
      expect(isOpenCodeModel('opus')).toBe(false);
      // Empty bare ID is not a valid OpenCode model string.
      expect(isOpenCodeModel('opencode/')).toBe(false);
      expect(isOpenCodeModel('opencode')).toBe(false);
    });

    it('isOpenCodeGoModel accepts anything with the opencode-go/ prefix — Go owns the namespace', () => {
      expect(isOpenCodeGoModel('opencode-go/qwen3.7-plus')).toBe(true);
      expect(isOpenCodeGoModel('opencode-go/deepseek-v5')).toBe(true);
      expect(isOpenCodeGoModel('opencode-go/some-future-model')).toBe(true);
      // Must not accept the Zen prefix.
      expect(isOpenCodeGoModel('opencode/kimi-k2.6')).toBe(false);
      // Bare modelID is not the Bottega-persisted shape.
      expect(isOpenCodeGoModel('qwen3.7-plus')).toBe(false);
      // Empty bare ID is invalid.
      expect(isOpenCodeGoModel('opencode-go/')).toBe(false);
      expect(isOpenCodeGoModel('opencode-go')).toBe(false);
    });

    it('isOpenCodeEffort always returns false (OpenCode has no effort dimension)', () => {
      expect(isOpenCodeEffort('high')).toBe(false);
      expect(isOpenCodeEffort('minimal')).toBe(false);
      expect(isOpenCodeEffort('')).toBe(false);
      expect(isOpenCodeEffort(undefined)).toBe(false);
      expect(isOpenCodeEffort(null)).toBe(false);
    });

    it('isModelForProvider rejects cross-provider models', () => {
      expect(isModelForProvider('anthropic', 'opus')).toBe(true);
      expect(isModelForProvider('anthropic', 'gpt-5.5')).toBe(false);
      expect(isModelForProvider('openai', 'gpt-5.4-mini')).toBe(true);
      expect(isModelForProvider('openai', 'opus')).toBe(false);
      expect(isModelForProvider('openai', null)).toBe(false);
      // Zen: any opencode/ prefix passes — Zen owns the catalog.
      expect(isModelForProvider('opencode', 'opencode/kimi-k2.6')).toBe(true);
      expect(isModelForProvider('opencode', 'opencode/some-future-model')).toBe(true);
      expect(isModelForProvider('opencode', 'kimi-k2.6')).toBe(false);
      expect(isModelForProvider('opencode', 'opus')).toBe(false);
      // opencode-go/ models must NOT pass the Zen check.
      expect(isModelForProvider('opencode', 'opencode-go/qwen3.7-plus')).toBe(false);
      // Go: any opencode-go/ prefix passes.
      expect(isModelForProvider('opencode-go', 'opencode-go/qwen3.7-plus')).toBe(true);
      expect(isModelForProvider('opencode-go', 'opencode-go/deepseek-v5')).toBe(true);
      expect(isModelForProvider('opencode-go', 'opencode-go/some-future-model')).toBe(true);
      // Zen models must NOT pass the Go check.
      expect(isModelForProvider('opencode-go', 'opencode/kimi-k2.6')).toBe(false);
      expect(isModelForProvider('opencode-go', 'qwen3.7-plus')).toBe(false);
      expect(isModelForProvider('anthropic', 'opencode/kimi-k2.6')).toBe(false);
      expect(isModelForProvider('anthropic', 'opencode-go/qwen3.7-plus')).toBe(false);
    });

    it('isEffortForProvider rejects cross-provider efforts', () => {
      expect(isEffortForProvider('anthropic', 'max')).toBe(true);
      expect(isEffortForProvider('anthropic', 'minimal')).toBe(false);
      expect(isEffortForProvider('openai', 'minimal')).toBe(true);
      expect(isEffortForProvider('openai', 'max')).toBe(false);
      expect(isEffortForProvider('opencode', 'high')).toBe(false);
      expect(isEffortForProvider('opencode', 'max')).toBe(false);
      expect(isEffortForProvider('opencode', 'minimal')).toBe(false);
    });
  });
});
