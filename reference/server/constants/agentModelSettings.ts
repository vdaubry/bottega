// Server-side re-exports for the per-agent model/effort constants.
//
// Note: the values stored in `AgentModel` ('sonnet' | 'opus' | 'fable') ARE the
// SDK family aliases — the Anthropic API resolves them to the current recommended
// version automatically (e.g. `sonnet` → Claude Sonnet 5.5, `opus` → Claude Opus 5.5,
// `fable` → Claude Fable 5.1 today). We pass the alias straight through to the
// SDK rather than pinning a versioned ID, so new model releases pick up with just
// an SDK bump (the alias table lives in the bundled Claude Code CLI).
//
//   https://code.claude.com/docs/en/model-config — "Model aliases"

export {
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  DEFAULT_AGENT_MODEL_SETTINGS,
  AGENT_TYPES_WITH_SETTINGS,
  isAgentModel,
  isAgentEffort,
  isAgentTypeWithSettings,
} from '../../shared/types/agentModelSettings.js';

export type {
  AgentModel,
  AgentEffort,
  AgentModelSetting,
  AgentModelSettings,
} from '../../shared/types/agentModelSettings.js';
