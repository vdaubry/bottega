// Server-side `LlmProvider` interface.
//
// Concrete implementations:
//   - `server/services/providers/anthropic/index.ts`  (Phase 2)
//   - `server/services/providers/openai/index.ts`     (Phase 9)
//
// The orchestrator (`server/services/conversation/runConversation.ts`)
// resolves a provider by name through `registry.ts` and drives it via
// this surface — start a turn, stream events, abort, load history. The
// Claude-specific shape of `query()` lives entirely inside the Anthropic
// provider; nothing above this interface should ever import the Claude
// or Codex SDK directly.

import type {
  Provider,
  ProviderCapabilities,
  ProviderRunOptions,
  ProviderRunResult,
  UnifiedMessage,
} from '@shared/providers/types';

export interface LoadTranscriptOptions {
  /** Provider session id (Claude session id / Codex thread id). */
  providerSessionId: string;
  /** cwd used when the session started — `sqliteSessionStore` resolves the projectKey off this. */
  projectFolderPath: string;
}

export interface LlmProvider {
  readonly name: Provider;
  /** Static capability matrix for this provider — does not vary per call. */
  getCapabilities(): ProviderCapabilities;

  /** Start a new session/turn. The runner subscribes to `events` to stream output. */
  startTurn(options: ProviderRunOptions): Promise<ProviderRunResult>;

  /** Resume an existing session/turn with a follow-up message. */
  sendTurnMessage(
    options: ProviderRunOptions & { resumeSessionId: string },
  ): Promise<ProviderRunResult>;

  /**
   * Load and normalise the conversation transcript for `providerSessionId`.
   * Returns a `UnifiedMessage[]` already mapped — callers never see raw
   * SDK shapes.
   */
  loadTranscript(options: LoadTranscriptOptions): Promise<UnifiedMessage[]>;

  /**
   * Abort the *currently running* turn for `providerSessionId`. Returns
   * `true` if a live turn was found and aborted. Callers should also
   * remove the session from their own `activeSessions` map.
   */
  abortTurn(providerSessionId: string): boolean;
}
