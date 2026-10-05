// Provider capability matrix.
//
// Ask-user and MCP describe the provider-neutral capability Bottega supplies
// around each harness. Thinking deltas, detailed context usage and images are
// native-provider capabilities. Call sites use this matrix instead of testing
// provider names directly.

import type { Provider, ProviderCapabilities } from './types.js';

export const CAPABILITIES_BY_PROVIDER: Record<Provider, ProviderCapabilities> = {
  anthropic: {
    supportsAskUserQuestion: true,
    supportsThinkingDelta: true,
    supportsContextUsageBreakdown: true,
    supportsMcpServers: true,
    supportsImages: true,
  },
  openai: {
    // Bottega supplies question deferral and MCP independently of the SDK.
    supportsAskUserQuestion: true,
    // Codex emits `reasoning` items but no incremental stream-delta partials
    // shaped like Claude's `stream_event`.
    supportsThinkingDelta: false,
    // Codex provides aggregate token usage via `turn.completed` but no
    // per-tool breakdown.
    supportsContextUsageBreakdown: false,
    supportsMcpServers: true,
    supportsImages: false,
  },
  opencode: {
    // OpenCode has no canUseTool hook, so Bottega provides durable question
    // deferral through its remote MCP layer. It emits ReasoningPart whole,
    // reports only aggregate usage, and does not accept Bottega images yet.
    supportsAskUserQuestion: true,
    supportsThinkingDelta: false,
    supportsContextUsageBreakdown: false,
    supportsMcpServers: true,
    supportsImages: false,
  },
};

export function getCapabilities(provider: Provider): ProviderCapabilities {
  return CAPABILITIES_BY_PROVIDER[provider];
}
