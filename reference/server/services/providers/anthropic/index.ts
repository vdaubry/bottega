// AnthropicProvider — implements `LlmProvider` for the Claude Agent SDK.
//
// This is a thin wrapper around the existing `query()` call. The Phase 3
// orchestrator refactor will move `startConversation` / `sendMessage`
// onto this surface; for now the provider can be invoked but the
// orchestrator still calls `query()` directly. Tests cover the mapping
// edges (`mapMessage`, `loadTranscript`) so the refactor lands on a
// validated foundation.

import { query } from '@anthropic-ai/claude-agent-sdk';

import { mapMessage } from './mapMessage.js';
import { loadAnthropicTranscript } from './sessionStore.js';
import { mapOptionsToSDK } from './sdkOptionsBuilder.js';
import { activeSessions } from '../../conversation/sessionState.js';
import { agentRunsDb } from '../../../database/db.js';
import { getCapabilities } from '@shared/providers/capabilities';
import type {
  ProviderCapabilities,
  ProviderRunOptions,
  ProviderRunResult,
  UnifiedMessage,
} from '@shared/providers/types';
import type { LlmProvider, LoadTranscriptOptions } from '../types.js';
import type { SDKMessage } from '@shared/sdk/transcript';

interface QueryInstance extends AsyncIterable<SDKMessage> {
  // The runtime exposes more (interrupt(), getContextUsage(), …) but we
  // only need iteration + the underlying subprocess pid for audit logs.
  // The orchestrator does the heavy lifting; provider-level callers can
  // attach an `AbortController` to cancel.
  [key: string]: unknown;
}

async function* streamUnified(
  queryInstance: QueryInstance,
  resolveSessionId: (id: string) => void,
): AsyncGenerator<UnifiedMessage, void, unknown> {
  let providerSessionId: string | null = null;
  for await (const sdkMessage of queryInstance) {
    const raw = sdkMessage as unknown as Record<string, unknown>;
    const sid = raw.session_id;
    if (typeof sid === 'string' && providerSessionId === null) {
      providerSessionId = sid;
      resolveSessionId(sid);
    }
    for (const unified of mapMessage(sdkMessage, providerSessionId)) {
      yield unified;
    }
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;

  getCapabilities(): ProviderCapabilities {
    return getCapabilities('anthropic');
  }

  async startTurn(options: ProviderRunOptions): Promise<ProviderRunResult> {
    const abortController = options.abortController ?? new AbortController();
    const sdkOptions = mapOptionsToSDK({
      cwd: options.cwd,
      sessionId: options.resumeSessionId ?? undefined,
      ...(options.permissionMode !== undefined
        ? { permissionMode: options.permissionMode as never }
        : {}),
      ...(options.customSystemPrompt !== undefined
        ? { customSystemPrompt: options.customSystemPrompt }
        : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      model: options.model,
      effort: options.effort,
      ...(options.disallowedTools !== undefined
        ? { disallowedTools: options.disallowedTools }
        : {}),
    });

    const prompt = options.prompt;
    async function* promptStream() {
      yield {
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
      };
    }

    const queryInstance = query({
      prompt: promptStream() as never,
      options: { ...sdkOptions, abortController } as never,
    }) as unknown as QueryInstance;

    let resolveSessionId!: (id: string) => void;
    const providerSessionId$ = new Promise<string>((resolve) => {
      resolveSessionId = resolve;
    });

    const pidFromSdk = (queryInstance as { _processPid?: number; pid?: number })._processPid
      ?? (queryInstance as { pid?: number }).pid
      ?? null;

    return {
      events: streamUnified(queryInstance, resolveSessionId),
      providerSessionId$,
      abort: () => abortController.abort(),
      pid: typeof pidFromSdk === 'number' ? pidFromSdk : null,
    };
  }

  async sendTurnMessage(
    options: ProviderRunOptions & { resumeSessionId: string },
  ): Promise<ProviderRunResult> {
    return this.startTurn({ ...options, resumeSessionId: options.resumeSessionId });
  }

  async loadTranscript(options: LoadTranscriptOptions): Promise<UnifiedMessage[]> {
    return loadAnthropicTranscript(options);
  }

  abortTurn(providerSessionId: string): boolean {
    const active = activeSessions.get(providerSessionId);
    if (!active) return false;
    // Mirror `abortSession` in sessionControl.ts: the agent_run row is the
    // source of truth for "did the user stop this run", so write it
    // synchronously before the abort lands.
    const linked = agentRunsDb.getByConversationId(active.conversationId);
    if (linked && linked.status === 'running') {
      agentRunsDb.updateStatus(linked.id, 'failed');
    }
    active.abortController.abort();
    active.status = 'aborted';
    return true;
  }
}

export const anthropicProvider = new AnthropicProvider();
