// Provider-agnostic type surface shared between frontend and backend.
//
// Bottega used to be Claude-only; introducing the OpenAI Codex SDK as a
// second backend means every layer above the SDK call needs to speak in
// provider-neutral vocabulary. This file is the contract:
//
//  - `Provider` names the backend (anthropic | openai).
//  - `ProviderModel` / `ProviderEffort` are opaque per-provider unions —
//    callers narrow off `Provider` to know which subset is valid.
//  - `UnifiedMessage` is the discriminated union the streaming loop emits.
//    Both the Anthropic mapper (`server/services/providers/anthropic/mapMessage.ts`)
//    and the Codex mapper (`server/services/providers/openai/mapEvent.ts`)
//    funnel through this shape. Anyone who needs provider-specific fields
//    reaches into `raw`.
//  - `ProviderCapabilities` is the feature-flag matrix used to skip
//    Claude-only call paths (AskUserQuestion, thinking deltas, MCP wait)
//    when a Codex turn is active.
//
// Per the plan in docs/tasks/codex-support.md (§ Phase 1), nothing in this
// file imports the Claude SDK or the Codex SDK; both wrap the world in
// terms of these types.

import type {
  AnthropicModel,
  AnthropicEffort,
  OpenAIModel,
  OpenAIEffort,
  OpenCodeModel,
  OpenCodeEffort,
} from './models.js';

export type Provider = 'anthropic' | 'openai' | 'opencode' | 'opencode-go';

export type ProviderModel = AnthropicModel | OpenAIModel | OpenCodeModel;

export type ProviderEffort = AnthropicEffort | OpenAIEffort | OpenCodeEffort;

/**
 * Capability flags per provider. Call sites that depend on a
 * provider-specific feature MUST check the flag before invoking the
 * feature; this is what keeps `mapMessage` mapping invariants from
 * leaking into the Codex code path and vice versa.
 *
 * Adding a flag here is the right move whenever a piece of Claude-specific
 * code (thinking deltas, `canUseTool`, the live `getContextUsage()`
 * breakdown) needs to be skipped on Codex.
 */
export interface ProviderCapabilities {
  /** Provider can host an `AskUserQuestion` mid-turn (Claude only in v1). */
  supportsAskUserQuestion: boolean;
  /** Provider emits incremental thinking deltas (Claude `stream_event` partials). */
  supportsThinkingDelta: boolean;
  /** Provider supports the live per-tool context-usage breakdown (Claude only). */
  supportsContextUsageBreakdown: boolean;
  /** Provider honours MCP server config (Claude only in v1; Codex CLI's TOML format is unsupported). */
  supportsMcpServers: boolean;
  /** Provider can accept image attachments on user messages (Claude only in v1). */
  supportsImages: boolean;
}

/**
 * Per-turn options passed to `LlmProvider.startTurn` / `sendTurnMessage`.
 * Generic across providers; each provider's options-builder translates
 * this into the SDK-native shape.
 */
export interface ProviderRunOptions {
  /** Working directory for the agent (repo or worktree path). */
  cwd: string;
  /**
   * Provider-specific model identifier (e.g. `'opus'`, `'gpt-5.5'`,
   * `'opencode/kimi-k2.6'`). Always required — the orchestrator resolves a
   * concrete model from the chosen settings (start) or the conversation row
   * (resume) before reaching any provider, so a turn never runs on a defaulted
   * or inferred model.
   */
  model: string;
  /**
   * Provider-specific reasoning effort (e.g. `'high'`, `'minimal'`), or `null`
   * when the provider has no effort dimension (OpenCode) or none was chosen.
   */
  effort: string | null;
  /** Override the default system prompt (custom agents). */
  customSystemPrompt?: string | undefined;
  /** SDK-permission mode (default | acceptEdits | plan | bypassPermissions). */
  permissionMode?: string | undefined;
  /** Tools to disallow for this turn. */
  disallowedTools?: string[] | undefined;
  /** Env vars to inject into the SDK subprocess (per-user credentials live here). */
  env?: Record<string, string | undefined> | undefined;
  /** Optional `AbortController` for mid-turn cancel. */
  abortController?: AbortController | undefined;
  /** Resume an existing provider session by id (null for new). */
  resumeSessionId?: string | null | undefined;
  /** Input prompt for this turn (`null` only when re-driving an AskUserQuestion tool_result). */
  prompt: string | null;
  /** Provider-specific extras the orchestrator passes through opaquely. */
  extras?: Record<string, unknown> | undefined;
}

/**
 * The discriminated union the streaming loop emits to the rest of the app.
 * Each variant carries enough Bottega-native context that downstream
 * consumers (UI rendering, context tracker, agent lifecycle) never need to
 * look at provider-specific SDK shapes; if they do, they reach into `raw`.
 */
export type UnifiedMessageType =
  | 'user'
  | 'assistant'
  | 'assistant_thinking'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'result'
  | 'stream_delta';

export interface UnifiedMessageBase {
  type: UnifiedMessageType;
  /**
   * Stable id across the provider's wire format. For Claude this is the
   * `SDKMessage.message.id` (when present); for Codex it's the
   * `item.id` (or the synthesised id for `turn.*` / `thread.*` envelopes).
   */
  id: string;
  provider: Provider;
  providerSessionId: string | null;
  /** Server-assigned monotonic ordering integer; set by the mirror writer. */
  seq?: number | undefined;
  /**
   * The original SDK payload, untouched. Reserved for forensics and to
   * keep consumers tolerant of variants the mapper hasn't normalised yet.
   * Anyone reading `raw` is implicitly coupled to a provider; the goal
   * over time is for `raw` to become unused.
   */
  raw: unknown;
}

export interface UnifiedUserMessage extends UnifiedMessageBase {
  type: 'user';
  /** Plain text content. Image attachments live in `raw` for now (Claude-only). */
  content: string | unknown;
}

export interface UnifiedAssistantMessage extends UnifiedMessageBase {
  type: 'assistant';
  /** Concatenated text blocks emitted by the assistant on this turn. */
  text: string;
  /** True iff this is a sub-agent message (Claude parent_tool_use_id is set). */
  isSubAgent: boolean;
  /** Per-turn token-usage snapshot if the SDK attached one. */
  usage?: { input_tokens?: number; output_tokens?: number } | undefined;
  /** Model the SDK reports as authoring this message. Used for context-usage attribution. */
  model?: string | undefined;
}

export interface UnifiedAssistantThinkingMessage extends UnifiedMessageBase {
  type: 'assistant_thinking';
  text: string;
}

export interface UnifiedToolUseMessage extends UnifiedMessageBase {
  type: 'tool_use';
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
}

export interface UnifiedToolResultMessage extends UnifiedMessageBase {
  type: 'tool_result';
  toolUseId: string;
  content: unknown;
  isError?: boolean | undefined;
}

export interface UnifiedSystemMessage extends UnifiedMessageBase {
  type: 'system';
  /** Optional sub-type (`'mirror_error' | 'unknown'` etc.) */
  subtype?: string | undefined;
  text?: string | undefined;
}

export interface UnifiedResultMessage extends UnifiedMessageBase {
  type: 'result';
  isError: boolean;
  /** Aggregate token usage for the turn (Anthropic populates this in detail; Codex via turn.completed). */
  usage?: { input_tokens?: number; output_tokens?: number } | undefined;
  /** Per-model usage breakdown (Claude only). */
  modelUsage?: unknown;
  /** Free-form list of error details when `isError` is true. */
  errors?: unknown[] | undefined;
}

export interface UnifiedStreamDeltaMessage extends UnifiedMessageBase {
  type: 'stream_delta';
  /** The unwrapped delta payload. Shape is provider-specific; thinking accumulator unwraps. */
  delta: unknown;
}

export type UnifiedMessage =
  | UnifiedUserMessage
  | UnifiedAssistantMessage
  | UnifiedAssistantThinkingMessage
  | UnifiedToolUseMessage
  | UnifiedToolResultMessage
  | UnifiedSystemMessage
  | UnifiedResultMessage
  | UnifiedStreamDeltaMessage;

/**
 * Shape returned by `LlmProvider.startTurn` / `sendTurnMessage`. Callers
 * iterate `events` and resolve `providerSessionId$` whenever the wire id
 * is first known.
 */
export interface ProviderRunResult {
  events: AsyncIterable<UnifiedMessage>;
  providerSessionId$: Promise<string>;
  abort: () => void;
  pid: number | null;
}
