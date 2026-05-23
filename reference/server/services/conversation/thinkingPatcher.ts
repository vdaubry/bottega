// SDK 0.2.x ships final assistant messages with empty `thinking` fields — only
// the encrypted `signature` survives. Plaintext thinking arrives only as raw
// stream events (`thinking_delta`). This accumulator collects those deltas and
// patches the assembled message before broadcast, plus the SQLite-backed
// transcript so reloaded history shows thinking too.

import { conversationContentStore } from '../conversationContentStore.js';

interface ThinkingDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta?: { type: string; thinking?: string };
}

interface MessageStartEvent {
  type: 'message_start';
  message?: { id?: string };
}

type StreamEvent =
  | ThinkingDeltaEvent
  | MessageStartEvent
  | { type: string; [key: string]: unknown }
  | null
  | undefined;

interface AssistantSdkMessage {
  message?: {
    id?: string;
    content?: Array<{ type?: string; thinking?: string; [key: string]: unknown }>;
  };
}

export class ThinkingAccumulator {
  // messageId -> Map(blockIndex -> accumulated text)
  byMessage: Map<string, Map<number, string>> = new Map();
  currentMessageId: string | null = null;
  currentBlocks: Map<number, string> | null = null;

  handleStreamEvent(event: StreamEvent): void {
    if (!event) return;
    if (event.type === 'message_start') {
      const id = (event as MessageStartEvent).message?.id;
      if (id) {
        this.currentMessageId = id;
        this.currentBlocks = new Map();
        this.byMessage.set(id, this.currentBlocks);
      }
      return;
    }
    if (
      event.type === 'content_block_delta' &&
      (event as ThinkingDeltaEvent).delta?.type === 'thinking_delta' &&
      this.currentBlocks &&
      typeof (event as ThinkingDeltaEvent).index === 'number'
    ) {
      const delta = (event as ThinkingDeltaEvent).delta;
      const text = delta?.thinking || '';
      if (!text) return;
      const idx = (event as ThinkingDeltaEvent).index;
      const prev = this.currentBlocks.get(idx) || '';
      this.currentBlocks.set(idx, prev + text);
    }
  }

  patchAssistantMessage(sdkMessage: AssistantSdkMessage | null | undefined): void {
    const messageId = sdkMessage?.message?.id;
    if (!messageId) return;
    const blocks = this.byMessage.get(messageId);
    if (!blocks?.size) return;
    const content = sdkMessage?.message?.content;
    if (!Array.isArray(content)) return;
    content.forEach((block, idx) => {
      if (block?.type === 'thinking' && !block.thinking) {
        const text = blocks.get(idx);
        if (text) block.thinking = text;
      }
    });
  }

  hasContent(): boolean {
    return this.byMessage.size > 0;
  }

  get(messageId: string): Map<number, string> | undefined {
    return this.byMessage.get(messageId);
  }
}

export async function patchThinking(
  claudeSessionId: string | null,
  projectPath: string | null | undefined,
  _userId: number | undefined,
  accumulator: ThinkingAccumulator | null | undefined,
): Promise<void> {
  if (!claudeSessionId || !projectPath || !accumulator?.hasContent()) return;
  try {
    const modified = await conversationContentStore.patchThinking({
      claudeSessionId,
      projectFolderPath: projectPath,
      accumulator,
    });
    if (modified) {
      console.log(`[ConversationAdapter] Patched thinking deltas in SQLite for session ${claudeSessionId}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ConversationAdapter] Failed to patch thinking for ${claudeSessionId}:`, message);
  }
}
