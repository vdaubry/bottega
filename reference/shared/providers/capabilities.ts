// Provider capability matrix.
//
// Every Claude-specific feature in the runtime (AskUserQuestion mid-turn,
// thinking deltas via `stream_event`, the live per-tool context-usage
// breakdown, MCP server config, image attachments) is gated on a flag
// here. Call sites that use the feature must check the flag; this is the
// single mechanism that keeps the Codex code path from accidentally
// triggering Claude-only behaviour and vice versa.
//
// Per docs/tasks/codex-support.md § Phase 1: Anthropic flags are all
// `true`; OpenAI flags start as placeholders and get filled in during
// Phase 9 once the Codex SDK's actual shape is confirmed by the spike.

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
    // v1: Codex SDK has no `canUseTool`-style hook. Codex agents are
    // instructed in the prompt to ask in plain text. (D3)
    supportsAskUserQuestion: false,
    // Codex emits `reasoning` items but no incremental stream-delta partials
    // shaped like Claude's `stream_event`.
    supportsThinkingDelta: false,
    // Codex provides aggregate token usage via `turn.completed` but no
    // per-tool breakdown.
    supportsContextUsageBreakdown: false,
    // The Codex CLI has MCP via TOML configs at ~/.codex/config.toml; not
    // wired into Bottega in v1 (the reference impl supports it; we
    // intentionally stay narrower for the first cut).
    supportsMcpServers: false,
    supportsImages: false,
  },
  opencode: {
    // Per docs/opencode/00-context-decisions.md § D8. OpenCode has no
    // canUseTool hook (agents ask in plain text), emits ReasoningPart
    // whole rather than as deltas, reports only aggregate usage, and ships
    // its own MCP layer that v1 does not wire into Bottega. Image
    // attachments are deferred to v2.
    supportsAskUserQuestion: false,
    supportsThinkingDelta: false,
    supportsContextUsageBreakdown: false,
    supportsMcpServers: false,
    supportsImages: false,
  },
  'opencode-go': {
    // Same capability profile as OpenCode Zen — all features deferred.
    supportsAskUserQuestion: false,
    supportsThinkingDelta: false,
    supportsContextUsageBreakdown: false,
    supportsMcpServers: false,
    supportsImages: false,
  },
};

export function getCapabilities(provider: Provider): ProviderCapabilities {
  return CAPABILITIES_BY_PROVIDER[provider];
}
