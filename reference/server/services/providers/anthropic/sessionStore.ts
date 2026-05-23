// Cross-provider transcript-load API for Anthropic.
//
// `loadTranscript({ providerSessionId, projectFolderPath })` is the read
// path that `routes/conversations.ts` will call via
// `provider.loadTranscript()` (Phase 4). Internally it just delegates to
// `sqliteSessionStore.load` (via `resolveProjectKey`) and maps each entry
// through `mapMessage`, so callers get `UnifiedMessage[]` rather than raw
// SDK rows.

import { sqliteSessionStore } from '../../sqliteSessionStore.js';
import { resolveProjectKey } from '../../conversationContentStore.js';
import { mapMessage } from './mapMessage.js';
import type { LoadTranscriptOptions } from '../types.js';
import type { UnifiedMessage } from '@shared/providers/types';
import type { SDKMessage } from '@shared/sdk/transcript';

export async function loadAnthropicTranscript(
  options: LoadTranscriptOptions,
): Promise<UnifiedMessage[]> {
  const { providerSessionId, projectFolderPath } = options;
  const projectKey = resolveProjectKey(projectFolderPath);
  const entries = await sqliteSessionStore.load({
    projectKey,
    sessionId: providerSessionId,
  });
  if (!entries) return [];

  const out: UnifiedMessage[] = [];
  for (const entry of entries) {
    out.push(...mapMessage(entry as unknown as SDKMessage, providerSessionId));
  }
  return out;
}
