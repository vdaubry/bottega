// Typed REST contracts for /api/user-agent-model-settings/*.
//
// Per-user agent (provider, model, effort) settings — the per-user
// replacement for the global app-settings `agent_model_settings` blob.

import type { Provider } from '../providers/types.js';
import type { AgentModelSettings } from '../types/agentModelSettings.js';

// GET /api/user-agent-model-settings
// Discriminated on whether the user has been seeded yet. `needsSeeding: true`
// means the user has no settings row (unseeded) — the UI should prompt them to
// connect a provider rather than render empty dropdowns.
export type GetUserAgentModelSettingsResponse =
  | { needsSeeding: false; settings: AgentModelSettings }
  | { needsSeeding: true };

// PUT /api/user-agent-model-settings — echoes the saved settings.
export interface UpdateUserAgentModelSettingsResponse {
  settings: AgentModelSettings;
}

// GET /api/user-agent-model-settings/connected-providers
// The providers the calling user has valid credentials for. Drives both the
// settings-tab provider dropdown (filtered to these) and the blocking
// first-login modal (empty array ⇒ block until ≥1 connected).
export interface ConnectedProvidersResponse {
  connected: Provider[];
}
