// Per-user agent (provider, model, effort) resolution.
//
// Each user has a row in `user_agent_model_settings` holding their full
// Record<AgentType, AgentModelSetting>. This replaces the old GLOBAL
// `app_settings.agent_model_settings` blob so each user runs agents on a
// provider/model they actually have credentials for.
//
// Determinism (feedback_deterministic_model_no_fallbacks): resolution NEVER
// silently defaults a model. An unseeded user — or one with a missing/invalid
// entry — throws `MissingUserAgentSettingsError` so the caller fails loud. In
// practice the blocking first-login provider modal guarantees a seed exists
// before any agent can run. The only legacy tolerance is the D6 `provider ??
// 'anthropic'` coercion, which keeps backfilled pre-multi-provider rows valid
// (their model was always an Anthropic model).

import {
  userAgentModelSettingsDb,
  userDb,
  agentRunsDb,
} from '../database/db.js';
import { getCredentialStore } from './credentials/registry.js';
import { listOpenCodeModels } from './providers/opencode/index.js';
import {
  AGENT_TYPES_WITH_SETTINGS,
  isValidAgentModelSetting,
  isAgentTypeWithSettings,
  buildSeedSettings,
  type AgentModelSettings,
} from '../../shared/types/agentModelSettings.js';
import type { Provider } from '../../shared/providers/types.js';
import type { ConversationRow } from '../../shared/types/db.js';

/** Thrown when a user has no usable agent model settings (unseeded/invalid). */
export class MissingUserAgentSettingsError extends Error {
  readonly userId: number;
  constructor(userId: number, detail: string) {
    super(`No valid agent model settings for user ${userId}: ${detail}`);
    this.name = 'MissingUserAgentSettingsError';
    this.userId = userId;
  }
}

/**
 * Load a user's full per-agent settings. Throws `MissingUserAgentSettingsError`
 * when the row is absent or any of the six agents is missing/invalid — callers
 * must not get a silent default.
 */
export function loadAgentModelSettings(userId: number): AgentModelSettings {
  const raw = userAgentModelSettingsDb.getRaw(userId);
  if (!raw) {
    throw new MissingUserAgentSettingsError(userId, 'no settings row');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MissingUserAgentSettingsError(
      userId,
      `unparseable settings JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MissingUserAgentSettingsError(userId, 'settings is not an object');
  }

  const blob = parsed as Record<string, unknown>;
  const result = {} as AgentModelSettings;

  for (const agentType of AGENT_TYPES_WITH_SETTINGS) {
    const entry = blob[agentType];
    if (!entry || typeof entry !== 'object') {
      throw new MissingUserAgentSettingsError(userId, `missing entry for '${agentType}'`);
    }
    const e = entry as { provider?: unknown; model?: unknown; effort?: unknown };
    // D6 legacy compat: backfilled rows from before the `provider` field read
    // back as 'anthropic'. The model is still validated against that provider.
    let provider = e.provider ?? 'anthropic';
    let model = e.model;
    // Migration for corrupt entries written by the original opencode-go
    // implementation: the UI had a stale-closure bug that saved
    // `opencode/` prefixed models under the `opencode-go` provider.
    // Re-prefix them to `opencode-go/<bareModelId>` so they pass the
    // now-correct prefix check.
    if (
      provider === 'opencode-go' &&
      typeof model === 'string' &&
      model.startsWith('opencode/') &&
      model.length > 'opencode/'.length
    ) {
      const bareModelId = model.slice('opencode/'.length);
      model = `opencode-go/${bareModelId}`;
    }
    const candidate = {
      provider,
      model,
      effort: e.effort ?? null,
    };
    if (!isValidAgentModelSetting(candidate)) {
      throw new MissingUserAgentSettingsError(userId, `invalid entry for '${agentType}'`);
    }
    result[agentType] = candidate;
  }

  return result;
}

/** Persist a user's full per-agent settings (caller supplies all six). */
export function saveAgentModelSettings(userId: number, settings: AgentModelSettings): void {
  userAgentModelSettingsDb.set(userId, JSON.stringify(settings));
}

// Highest-priority connected provider wins when seeding a new user.
const SEED_PROVIDER_PRIORITY: readonly Provider[] = ['anthropic', 'openai', 'opencode'];

/**
 * Seed a user's agent settings from their first connected provider, if they
 * have none yet. Returns true when a seed was written. Returns false when the
 * user already has settings, has no connected provider, or chose OpenCode but
 * its live catalog yields no model id (never guess an OpenCode id). Invoked
 * after a successful provider-connect so the blocking modal can be dismissed.
 */
export async function ensureUserAgentModelSettings(userId: number): Promise<boolean> {
  if (userAgentModelSettingsDb.getRaw(userId)) return false;

  let chosen: Provider | null = null;
  for (const provider of SEED_PROVIDER_PRIORITY) {
    try {
      const status = await getCredentialStore(provider).getStatus(userId);
      if (status.authenticated) {
        chosen = provider;
        break;
      }
    } catch {
      // getStatus is non-throwing for the core providers; be defensive anyway.
    }
  }
  if (!chosen) return false;

  let firstOpenCodeModelId: string | null = null;
  if (chosen === 'opencode' || chosen === 'opencode-go') {
    try {
      const models = await listOpenCodeModels(userId);
      firstOpenCodeModelId = models[0]?.id ?? null;
    } catch {
      firstOpenCodeModelId = null;
    }
    if (!firstOpenCodeModelId) return false;
  }

  const seed = buildSeedSettings(chosen, firstOpenCodeModelId);
  if (!seed) return false;

  saveAgentModelSettings(userId, seed);
  userDb.completeOnboarding(userId);
  return true;
}

/**
 * Convenience wrapper for the provider-connect routes: seed-on-connect that
 * never throws, so a seeding hiccup can't turn a successful connect into an
 * error response. Safe to call after every successful credential write.
 */
export async function seedAgentSettingsAfterConnect(userId: number): Promise<void> {
  try {
    await ensureUserAgentModelSettings(userId);
  } catch (err) {
    console.error('[agentModelSettings] seed-on-connect failed for user', userId, err);
  }
}

/**
 * Resolve the (model, effort) to resume a conversation with. Re-resolves from
 * the RESUMING user's per-user setting for the conversation's agent type — but
 * only when that setting targets the SAME provider (provider is session-bound
 * and can't be switched on resume). Falls back to the conversation's stored
 * model/effort for: programmatic resumes (no userId), manual conversations
 * (no agent run), an unseeded resuming user, or a provider mismatch.
 */
export function resolveResumeModelEffort(
  conversation: Pick<ConversationRow, 'id' | 'provider' | 'model' | 'effort'>,
  userId: number | undefined,
): { model: string | null; effort: string | null } {
  const stored = { model: conversation.model, effort: conversation.effort };
  if (userId == null) return stored;

  const agentRun = agentRunsDb.getByConversationId(conversation.id);
  if (!agentRun || !isAgentTypeWithSettings(agentRun.agent_type)) return stored;

  let settings: AgentModelSettings;
  try {
    settings = loadAgentModelSettings(userId);
  } catch {
    // Resuming user is unseeded/invalid — don't break resume.
    return stored;
  }

  const setting = settings[agentRun.agent_type];
  if (setting.provider !== conversation.provider) return stored;
  return { model: setting.model, effort: setting.effort };
}
