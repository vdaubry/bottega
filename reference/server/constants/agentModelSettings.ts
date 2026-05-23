// Server-side re-exports for the per-agent model/effort constants.
//
// Note: the values stored in `AgentModel` ('sonnet' | 'opus') ARE the SDK
// family aliases — the Anthropic API resolves them to the current recommended
// version automatically (e.g. `opus` → Claude Opus 4.7 today). We pass the
// alias straight through to the SDK rather than pinning a versioned ID, so
// new model releases pick up without a code change.
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
