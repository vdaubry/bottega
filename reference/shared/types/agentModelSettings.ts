// Per-agent (provider, model, effort) selection — now scoped PER USER.
// Surfaced in the Settings → Agent Models tab (one entry per AgentType) and
// consumed by `agentRunner.ts` when starting a run. Persisted as a JSON string
// in `user_agent_model_settings.settings_json`, one row per user. (Previously
// a single global `app_settings.agent_model_settings` blob — removed so each
// user runs agents on a provider/model they actually have credentials for.)
//
// Each entry carries a `provider` field so each agent picks its own LLM
// backend among the providers the user has connected.

import type { AgentType, EpicAgentType } from './db.js';
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
  /** Provider-specific model identifier (e.g. 'opus', 'gpt-6.1-sol'). */
  model: string;
  /** Provider-specific reasoning effort, or null when the provider has none. */
  effort: string | null;
}

// The model-settings map is keyed by `AgentModelKey`, a superset of `AgentType`
// that adds the non-agent `'schema'` key plus the `EpicAgentType` stages.
// `'schema'` configures the Explore schema-generation model; the epic keys
// configure each stage of the epic pipeline. `'schema'` is not an agent-run
// type (no `task_agent_runs` row, no WS `agentType`) and the epic types are
// deliberately kept out of `AgentType` (which stays the six task types), so
// neither may ever be added to it. Because `AgentType ⊆ AgentModelKey`, every
// existing consumer that indexes this map by an `AgentType` still typechecks.
export type AgentModelKey = AgentType | 'schema' | EpicAgentType;

export type AgentModelSettings = Record<AgentModelKey, AgentModelSetting>;

export const AGENT_TYPES_WITH_SETTINGS: readonly AgentModelKey[] = [
  'planification',
  'implementation',
  'refinement',
  'review',
  'pr',
  'yolo',
  // Not an agent run — the Explore schema-generation model. Anthropic-only
  // (the code-atlas HTML/diagram engine is in-process Claude).
  'schema',
  // Epic pipeline stages. Every key exists from the start so the fail-loud
  // loader never meets a half-seeded blob mid-feature; all are provider-neutral.
  'epic-architecture',
  'epic-specification',
  'epic-stories',
  'epic-spec-review',
  'epic-orchestrator',
  'epic-pr-review',
  // Not a stage: the agent that lands the epic's final pull request. It needs
  // its own key because the GitHub webhook starts it with no human present to
  // pick a model (see `docs/epics/delivery.md`).
  'epic-delivery',
  // The QA step: the scenario writer (stage 'qa') and the executor (stage-less,
  // delivery-style — any number of runs).
  'epic-qa-scenarios',
  'epic-qa-execution',
  // Stage-less like delivery: the autonomous fix mission from failed QA
  // scenarios to a merged fix PR.
  'epic-qa-fix',
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
  // Schema generation is Anthropic-only regardless of the agents' providers.
  schema: { provider: 'anthropic', model: 'opus', effort: 'high' },
  // Epic stages default to Anthropic but are not locked to it.
  'epic-architecture': { provider: 'anthropic', model: 'opus', effort: 'high' },
  'epic-specification': { provider: 'anthropic', model: 'opus', effort: 'high' },
  'epic-stories': { provider: 'anthropic', model: 'opus', effort: 'high' },
  'epic-spec-review': { provider: 'anthropic', model: 'opus', effort: 'high' },
  'epic-orchestrator': { provider: 'anthropic', model: 'opus', effort: 'high' },
  'epic-pr-review': { provider: 'anthropic', model: 'opus', effort: 'high' },
  'epic-delivery': { provider: 'anthropic', model: 'opus', effort: 'high' },
  'epic-qa-scenarios': { provider: 'anthropic', model: 'opus', effort: 'high' },
  'epic-qa-execution': { provider: 'anthropic', model: 'opus', effort: 'high' },
  'epic-qa-fix': { provider: 'anthropic', model: 'opus', effort: 'high' },
};

// First-connect seed defaults (chosen with the user): a new user who connects
// a provider gets all six agents pointed at that provider's default model.
//   - anthropic → Sonnet
//   - openai (Codex) → GPT-6.1 Sol
//   - opencode → the FIRST entry of the user's live Zen catalog (resolved at
//     seed time, NOT hardcoded — the Zen catalog is owned upstream and a
//     guessed id fails at the SDK boundary).
const ANTHROPIC_SEED: { model: string; effort: string } = { model: 'sonnet', effort: 'high' };
const OPENAI_SEED: { model: string; effort: string } = { model: 'gpt-6.1-sol', effort: 'high' };

// The Anthropic default the `schema` key always seeds/backfills to — schema
// generation runs the in-process code-atlas MCP server, which only attaches to
// the Claude Agent SDK, so this key is locked to Anthropic for every user
// regardless of which provider their agents seed to.
export const SCHEMA_DEFAULT_SETTING: AgentModelSetting = {
  provider: 'anthropic',
  model: ANTHROPIC_SEED.model,
  effort: ANTHROPIC_SEED.effort,
};

// The historical default the `epic-architecture` key seeds/backfills to. It
// remains Sonnet for continuity, but users may select any connected harness.
export const EPIC_DEFAULT_SETTING: AgentModelSetting = {
  provider: 'anthropic',
  model: ANTHROPIC_SEED.model,
  effort: ANTHROPIC_SEED.effort,
};

// The Anthropic default the judgment-heavy epic stages seed/backfill to
// (specification, stories, specification review, orchestrator, PR reviewer).
// These run long-horizon work — interrogating the user, splitting an epic,
// cross-checking every document against every other and the code, supervising
// tickets, reviewing a pull request against the whole specification — so they
// default to Opus rather than the Sonnet exploration seed.
export const EPIC_STAGE_DEFAULT_SETTING: AgentModelSetting = {
  provider: 'anthropic',
  model: 'opus',
  effort: 'high',
};

// Keys that remain locked to Anthropic. Explore/schema still depends on the
// Claude-specific code-atlas server. Epic stages use Bottega's portable MCP
// catalog and may run on any connected harness.
export const ANTHROPIC_LOCKED_DEFAULTS: Readonly<
  Partial<Record<AgentModelKey, AgentModelSetting>>
> = {
  schema: SCHEMA_DEFAULT_SETTING,
};

export const ANTHROPIC_LOCKED_KEYS: readonly AgentModelKey[] = Object.keys(
  ANTHROPIC_LOCKED_DEFAULTS,
) as AgentModelKey[];

/** True when this key can only ever run on Anthropic. */
export function isAnthropicLockedKey(key: AgentModelKey): boolean {
  return key in ANTHROPIC_LOCKED_DEFAULTS;
}

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
  for (const key of AGENT_TYPES_WITH_SETTINGS) {
    // Anthropic-locked keys (`schema`) keep their own
    // defaults — never seed them to the user's chosen provider.
    const locked = ANTHROPIC_LOCKED_DEFAULTS[key];
    result[key] = locked ? { ...locked } : { ...setting };
  }
  return result;
}

export function isAgentModel(value: unknown): value is AgentModel {
  return typeof value === 'string' && (MODEL_OPTIONS as readonly string[]).includes(value);
}

export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === 'string' && (EFFORT_OPTIONS as readonly string[]).includes(value);
}

export function isAgentTypeWithSettings(value: unknown): value is AgentModelKey {
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
    setting.provider !== 'opencode'
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
} as const;

export const EFFORTS_FOR_UI = {
  anthropic: ANTHROPIC_EFFORTS,
  openai: OPENAI_EFFORTS,
  opencode: OPENCODE_EFFORTS,
} as const;
