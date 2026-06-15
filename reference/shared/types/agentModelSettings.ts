// Per-agent (provider, model, effort) selection — now scoped PER USER.
// Surfaced in the Settings → Agent Models tab (one entry per AgentType) and
// consumed by `agentRunner.ts` when starting a run. Persisted as a JSON string
// in `user_agent_model_settings.settings_json`, one row per user. (Previously
// a single global `app_settings.agent_model_settings` blob — removed so each
// user runs agents on a provider/model they actually have credentials for.)
//
// Each entry carries a `provider` field so each agent picks its own LLM
// backend among the providers the user has connected.

import type { AgentType } from './db.js';
import type { Provider } from '../providers/types.js';
import {
  ANTHROPIC_MODELS,
  ANTHROPIC_EFFORTS,
  OPENAI_MODELS,
  OPENAI_EFFORTS,
  OPENCODE_MODELS,
  OPENCODE_EFFORTS,
  isModelForProvider,
  isEffortForProvider,
} from '../providers/models.js';

// Legacy Anthropic-only union — kept so existing callers compile while
// migration lands. New code should use `AgentModelSetting.model` (a
// generic provider-specific string) instead.
export const MODEL_OPTIONS = ANTHROPIC_MODELS;
export type AgentModel = (typeof MODEL_OPTIONS)[number];

export const EFFORT_OPTIONS = ANTHROPIC_EFFORTS;
export type AgentEffort = (typeof EFFORT_OPTIONS)[number];

export interface AgentModelSetting {
  /** Which provider runs this agent — defaults to 'anthropic' for legacy entries. */
  provider: Provider;
  /** Provider-specific model identifier (e.g. 'opus', 'gpt-5.5'). */
  model: string;
  /** Provider-specific reasoning effort, or null when the provider has none. */
  effort: string | null;
}

export type AgentModelSettings = Record<AgentType, AgentModelSetting>;

export const AGENT_TYPES_WITH_SETTINGS: readonly AgentType[] = [
  'planification',
  'implementation',
  'refinement',
  'review',
  'pr',
  'yolo',
];

// Historical global default (all agents on Opus/high). No longer a runtime
// resolution fallback — per-user resolution fails loud when a user is unseeded
// (see `loadAgentModelSettings`). Kept only as the value the one-shot backfill
// migration replicates when no prior global config existed.
export const DEFAULT_AGENT_MODEL_SETTINGS: AgentModelSettings = {
  planification: { provider: 'anthropic', model: 'opus', effort: 'high' },
  implementation: { provider: 'anthropic', model: 'opus', effort: 'high' },
  refinement: { provider: 'anthropic', model: 'opus', effort: 'high' },
  review: { provider: 'anthropic', model: 'opus', effort: 'high' },
  pr: { provider: 'anthropic', model: 'opus', effort: 'high' },
  yolo: { provider: 'anthropic', model: 'opus', effort: 'high' },
};

// First-connect seed defaults (chosen with the user): a new user who connects
// a provider gets all six agents pointed at that provider's default model.
//   - anthropic → Sonnet
//   - openai (Codex) → GPT-5.5
//   - opencode → the FIRST entry of the user's live Zen catalog (resolved at
//     seed time, NOT hardcoded — the Zen catalog is owned upstream and a
//     guessed id fails at the SDK boundary).
const ANTHROPIC_SEED: { model: string; effort: string } = { model: 'sonnet', effort: 'high' };
const OPENAI_SEED: { model: string; effort: string } = { model: 'gpt-5.5', effort: 'high' };

/**
 * The default (provider, model, effort) for a freshly-connected provider.
 * Returns `null` for `opencode` when no live model id is available — callers
 * must not seed in that case rather than guess a catalog id.
 */
export function defaultSettingForProvider(
  provider: Provider,
  firstOpenCodeModelId: string | null,
): AgentModelSetting | null {
  if (provider === 'anthropic') {
    return { provider, model: ANTHROPIC_SEED.model, effort: ANTHROPIC_SEED.effort };
  }
  if (provider === 'openai') {
    return { provider, model: OPENAI_SEED.model, effort: OPENAI_SEED.effort };
  }
  // opencode: no static catalog — a live id is required to seed.
  if (!firstOpenCodeModelId) return null;
  return { provider, model: firstOpenCodeModelId, effort: null };
}

/**
 * Build a full per-user settings map (all six agents) seeded to one provider's
 * default. Returns `null` when the provider can't be defaulted (opencode with
 * no live model id) so the caller declines to seed.
 */
export function buildSeedSettings(
  provider: Provider,
  firstOpenCodeModelId: string | null,
): AgentModelSettings | null {
  const setting = defaultSettingForProvider(provider, firstOpenCodeModelId);
  if (!setting) return null;
  const result = {} as AgentModelSettings;
  for (const agentType of AGENT_TYPES_WITH_SETTINGS) {
    result[agentType] = { ...setting };
  }
  return result;
}

export function isAgentModel(value: unknown): value is AgentModel {
  return typeof value === 'string' && (MODEL_OPTIONS as readonly string[]).includes(value);
}

export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === 'string' && (EFFORT_OPTIONS as readonly string[]).includes(value);
}

export function isAgentTypeWithSettings(value: unknown): value is AgentType {
  return (
    typeof value === 'string' &&
    (AGENT_TYPES_WITH_SETTINGS as readonly string[]).includes(value)
  );
}

/** Validate a (provider, model, effort) triple. The effort can be null. */
export function isValidAgentModelSetting(
  setting: { provider: unknown; model: unknown; effort: unknown },
): setting is AgentModelSetting {
  if (
    setting.provider !== 'anthropic' &&
    setting.provider !== 'openai' &&
    setting.provider !== 'opencode' &&
    setting.provider !== 'opencode-go'
  ) {
    return false;
  }
  if (!isModelForProvider(setting.provider, setting.model)) return false;
  if (setting.effort !== null && !isEffortForProvider(setting.provider, setting.effort)) {
    return false;
  }
  return true;
}

// Per-provider option lists exposed to the UI.
export const MODELS_FOR_UI = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
  opencode: OPENCODE_MODELS,
  'opencode-go': OPENCODE_MODELS,
} as const;

export const EFFORTS_FOR_UI = {
  anthropic: ANTHROPIC_EFFORTS,
  openai: OPENAI_EFFORTS,
  opencode: OPENCODE_EFFORTS,
  'opencode-go': OPENCODE_EFFORTS,
} as const;
