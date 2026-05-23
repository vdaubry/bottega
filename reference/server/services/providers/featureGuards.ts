// Tiny helpers for "does this provider support feature X?" call sites.
//
// Phase 4 introduces these so capability checks at gate sites read
// cleanly. Today every conversation runs through Anthropic and every
// flag is `true`, so these are effectively no-ops; once the
// orchestrator's per-agent provider dispatch lands, the checks gate
// Claude-only code paths when a Codex turn is active.

import type {
  Provider,
  ProviderCapabilities,
} from '@shared/providers/types';
import { getCapabilities } from '@shared/providers/capabilities';

/** Truthy when the provider advertises the named capability. */
export function hasCapability<K extends keyof ProviderCapabilities>(
  provider: Provider,
  capability: K,
): boolean {
  return getCapabilities(provider)[capability] === true;
}

/**
 * Run a function only when the provider supports the named capability.
 * Returns the function's return value, or `undefined` when skipped.
 */
export function withCapability<K extends keyof ProviderCapabilities, T>(
  provider: Provider,
  capability: K,
  fn: () => T,
): T | undefined {
  return hasCapability(provider, capability) ? fn() : undefined;
}

/**
 * Throw when the provider does NOT support the named capability — used
 * at call sites that should never reach an unsupported provider (e.g.
 * the canUseTool tool invocation for AskUserQuestion).
 */
export function assertCapability<K extends keyof ProviderCapabilities>(
  provider: Provider,
  capability: K,
): void {
  if (!hasCapability(provider, capability)) {
    throw new Error(
      `Provider '${provider}' does not support capability '${String(capability)}'`,
    );
  }
}
