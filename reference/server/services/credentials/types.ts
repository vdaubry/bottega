// Provider-agnostic credential-store contract + the typed throw the
// orchestrator hands the route layer when a configured provider is
// missing credentials.

import type { Provider } from '@shared/providers/types';

/**
 * Typed throw a route layer can catch to render a "Connect <provider>"
 * UI affordance. The credential registry's `read` returns provider-
 * specific errors; the agent runner wraps them in this so any caller
 * can `instanceof` test without knowing the underlying helper.
 */
export class ProviderCredentialsMissingError extends Error {
  readonly provider: Provider;
  override readonly cause?: unknown;
  constructor(provider: Provider, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'ProviderCredentialsMissingError';
    this.provider = provider;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

//
// Phase 6 introduces this interface alongside the Anthropic adapter; Phase
// 10's Codex auth flow registers a second store under `'openai'`. Above
// this layer, code asks the registry for the right store by provider name
// and never touches the per-provider credential helpers directly.

export interface ProviderAuthStatus {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  /** On-disk path to the token file (or null if the store has no on-disk artefact). */
  tokenPath: string | null;
  /** Short identifier for the credential, suitable for showing in the UI. */
  tokenFingerprint?: string;
  /** Optional email/identity surfaced from the credential when known. */
  email?: string;
  /** Failure reason when not authenticated. */
  reason?: string;
}

/**
 * Per-user credential store contract. Implementations are responsible for
 * (a) reading and validating an on-disk token, (b) producing the env the
 * SDK invocation needs (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` etc.) with
 * global keys stripped per the provider's auth-precedence rules, (c) the
 * "is this user authenticated?" status check.
 *
 * The store does NOT spawn login subprocesses — that's the auth-flow
 * module's job (`claudeAuthFlow.ts` / `codexAuthFlow.ts` in Phase 10).
 * The store just persists what the flow produces and reads it back.
 */
export interface ProviderCredentialStore {
  /** Throws when no credential is configured for this user. */
  read(userId: number | string | undefined): { token: string; tokenPath: string };
  /**
   * Persist a freshly-issued credential to the per-user dir. Implementation
   * is responsible for mode 0600 / 0700 enforcement.
   */
  write(userId: number | string | undefined, payload: string): { tokenPath: string };
  /** Best-effort removal. Returns true if a file was removed. */
  clear(userId: number | string | undefined): boolean;
  /** Authenticated / missing / error — surface for the settings UI. */
  getStatus(userId: number | string | undefined): Promise<ProviderAuthStatus>;
  /**
   * Build the env the SDK invocation should inherit. Always strips
   * provider-specific global auth keys so the per-user credential wins
   * over anything in process.env.
   */
  buildSdkEnv(userId: number | string | undefined): Record<string, string | undefined>;
}
