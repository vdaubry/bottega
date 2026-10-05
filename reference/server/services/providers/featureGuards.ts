// Tiny helpers for "does this provider support feature X?" call sites.
//
// Capability checks at gate sites read cleanly and remain independent of the
// concrete provider name.

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
