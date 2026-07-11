// Per-provider model + effort lists.
//
// These are the canonical sources for what the UI offers and what the
// settings validator accepts. Each list is opaque to consumers — the
// strings flow through to the SDK options-builder for the corresponding
// provider, and there is no "common" subset between Anthropic, OpenAI, and
// OpenCode.
//
// Per docs/tasks/codex-support.md § D2 + § D5:
//   - Anthropic models: Sonnet, Opus (no Haiku).
//   - OpenAI models: GPT-5.5, GPT-5.4, GPT-5.4 mini.
//   - Anthropic efforts: low / medium / high / xhigh / max.
//   - OpenAI efforts: minimal / low / medium / high / xhigh
//     (mirrors the TS Codex SDK's `ModelReasoningEffort` union — see
//     `openai/codex/sdk/typescript/src/threadOptions.ts`).
//
// Per docs/opencode/00-context-decisions.md § R15 + § D5 + § D6:
//   - OpenCode models: curated subset of the Zen catalog, prefixed
//     'opencode/' for unambiguous persistence. The agent runner strips
//     the prefix before passing modelID to the SDK.
//   - OpenCode efforts: none — reasoning lives inside the modelID.

import type { Provider } from './types.js';

export const ANTHROPIC_MODELS = ['sonnet', 'opus'] as const;
export type AnthropicModel = (typeof ANTHROPIC_MODELS)[number];

export const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

export const OPENAI_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'] as const;
export type OpenAIModel = (typeof OPENAI_MODELS)[number];

export const OPENAI_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type OpenAIEffort = (typeof OPENAI_EFFORTS)[number];

// The Zen catalog is owned by OpenCode (≈40 models, churned by their
// team). Bottega does NOT hardcode it — the source of truth is the
// live OpenCode server's `GET /config/providers` endpoint, surfaced
// to the frontend via `GET /api/opencode-auth/models`. The settings
// UI fetches that list to populate its dropdown. Storage uses
// `opencode/<modelID>` (D5) so a row persisted today survives even
// after the upstream catalog changes.
//
// Why no enum: when this was a hand-curated list it contained ids
// Zen no longer serves (`qwen3-coder`, `kimi-k2-thinking`). The
// Phase 12.3 marquee run failed instantly with
// `Model not found: opencode/qwen3-coder`. See
// `feedback_no_guessing_external_lists` in the memory store.
export const OPENCODE_MODELS = [] as const;
// Storage shape: `opencode/<bare-modelID>`. The bare modelID is whatever
// Zen serves at any given time; we don't constrain it at the type level
// because doing so would re-create the problem this comment exists to
// prevent.
export type OpenCodeModel = `opencode/${string}`;

// OpenCode has no reasoning_effort dimension — reasoning is encoded into the
// modelID (e.g. `kimi-k2-thinking` is its own model). UI hides the effort
// dropdown when the array is empty.
export const OPENCODE_EFFORTS = [] as const;
export type OpenCodeEffort = never;

export const PROVIDERS = ['anthropic', 'openai', 'opencode', 'opencode-go'] as const;

/**
 * Return the model list for a provider. Used by the settings UI and
 * server-side validation when a settings entry's `provider` decides
 * which model namespace is in scope.
 */
export function modelsForProvider(provider: Provider): readonly string[] {
  if (provider === 'anthropic') return ANTHROPIC_MODELS;
  if (provider === 'openai') return OPENAI_MODELS;
  return OPENCODE_MODELS; // Both 'opencode' and 'opencode-go' use the live catalog
}

export function effortsForProvider(provider: Provider): readonly string[] {
  if (provider === 'anthropic') return ANTHROPIC_EFFORTS;
  if (provider === 'openai') return OPENAI_EFFORTS;
  return OPENCODE_EFFORTS; // Both 'opencode' and 'opencode-go' have no efforts
}

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

export function isAnthropicModel(value: unknown): value is AnthropicModel {
  return typeof value === 'string' && (ANTHROPIC_MODELS as readonly string[]).includes(value);
}

export function isAnthropicEffort(value: unknown): value is AnthropicEffort {
  return typeof value === 'string' && (ANTHROPIC_EFFORTS as readonly string[]).includes(value);
}

export function isOpenAIModel(value: unknown): value is OpenAIModel {
  return typeof value === 'string' && (OPENAI_MODELS as readonly string[]).includes(value);
}

export function isOpenAIEffort(value: unknown): value is OpenAIEffort {
  return typeof value === 'string' && (OPENAI_EFFORTS as readonly string[]).includes(value);
}

// Prefix-only check — the Zen catalog is dynamic (see the OPENCODE_MODELS
// comment). Anything past `opencode/` is opaque to Bottega; runtime
// validation happens at the SDK boundary where OpenCode itself returns
// `Model not found: ...` for an unknown ID.
export function isOpenCodeModel(value: unknown): value is OpenCodeModel {
  return typeof value === 'string' && value.startsWith('opencode/') && value.length > 'opencode/'.length;
}

// Prefix-only check for the Go provider catalog. Go models are stored as
// `opencode-go/<bare-modelID>` — distinct from the Zen `opencode/<id>` shape.
export type OpenCodeGoModel = `opencode-go/${string}`;
export function isOpenCodeGoModel(value: unknown): value is OpenCodeGoModel {
  return typeof value === 'string' && value.startsWith('opencode-go/') && value.length > 'opencode-go/'.length;
}

export function isOpenCodeEffort(value: unknown): value is OpenCodeEffort {
  // OpenCode has no efforts — nothing satisfies this guard.
  void value;
  return false;
}

/** True when `model` is a valid model for `provider`. */
export function isModelForProvider(
  provider: Provider,
  model: unknown,
): model is string {
  if (typeof model !== 'string') return false;
  // OpenCode providers use dynamic catalogs owned upstream; we only enforce
  // the correct prefix shape for each variant rather than a static enum.
  // Runtime validation of the bare model ID happens at the SDK boundary.
  if (provider === 'opencode') return isOpenCodeModel(model);
  if (provider === 'opencode-go') return isOpenCodeGoModel(model);
  return modelsForProvider(provider).includes(model);
}

/** True when `effort` is a valid effort for `provider`. */
export function isEffortForProvider(
  provider: Provider,
  effort: unknown,
): effort is string {
  if (typeof effort !== 'string') return false;
  return effortsForProvider(provider).includes(effort);
}
