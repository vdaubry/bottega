import { z } from 'zod';
import { conversationsDb } from '../../database/conversations.js';
import { conversationQuestionsDb } from '../../database/conversationQuestions.js';
import { projectsDb } from '../../database/db.js';
import { resolveProjectKey } from '../conversationContentStore.js';
import { sqliteSessionStore } from '../sqliteSessionStore.js';
import { activeSessions, deferredQuestionConversations } from './sessionState.js';
import { ownerAdapterFor } from './ownerAdapters.js';
import { definePortableTool } from './portableTool.js';
import type { ConversationQuestionRow } from '../../database/conversationQuestions.js';
import type { ConversationRow } from '@shared/types/db';
import type { BroadcastFn } from '@shared/websocket/messages';

const questionSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  header: z.string().trim().min(1).max(120),
  options: z.array(z.object({
    label: z.string().trim().min(1).max(200),
    description: z.string().max(1000).optional(),
  })).max(20).optional(),
  multiSelect: z.boolean().optional().default(false),
});

function deferActiveTurn(conversationId: number): void {
  const active = [...activeSessions.entries()].find(
    ([, session]) => session.conversationId === conversationId,
  );
  if (!active) {
    // Nothing is streaming, so no turn-exit path will ever consume the marker.
    // Setting it anyway would poison the NEXT turn on this conversation: it
    // would take the deferred early-return and never complete its agent run.
    console.warn(`[ask_user] Conversation ${conversationId} was not active when its question parked`);
    return;
  }
  deferredQuestionConversations.add(conversationId);
  const [sessionId, session] = active;
  session.abortController.abort();
  const conversation = conversationsDb.getById(conversationId);
  if (conversation) {
    void import('../providers/registry.js')
      .then(({ getProvider }) => getProvider(conversation.provider).abortTurn(sessionId))
      .catch((error) => console.warn(`[ask_user] Provider abort failed for ${sessionId}:`, error));
  }
}

export function isQuestionDeferred(conversationId: number): boolean {
  return deferredQuestionConversations.has(conversationId);
}

export function consumeQuestionDeferred(conversationId: number): boolean {
  return deferredQuestionConversations.delete(conversationId);
}

export function buildPortableQuestionTool(
  conversationId: number,
  broadcastFn?: BroadcastFn,
) {
  return definePortableTool(
    'ask_user',
    'Ask the user one or more blocking questions. This durably pauses the current turn; do not continue or guess after calling it. The user answers in Bottega and a new turn resumes this same conversation.',
    { questions: z.array(questionSchema).min(1).max(8) },
    async ({ questions }) => {
      await parkPortableQuestion(conversationId, questions, broadcastFn);

      // Never hand a value back to the model: returning would let it continue
      // and invent an answer. The provider abort tears down this request.
      return new Promise<never>(() => {});
    },
  );
}

function transcriptLocation(conversation: ConversationRow): {
  projectKey: string;
  sessionId: string;
} | null {
  const sessionId = conversation.provider_session_id ?? conversation.claude_conversation_id;
  if (!sessionId) return null;
  let projectPath = conversation.session_path;
  if (!projectPath) {
    const owner = ownerAdapterFor(conversation).resolveOwner(conversation);
    projectPath = owner
      ? projectsDb.getByIdAdmin(owner.projectId)?.repo_folder_path ?? null
      : null;
  }
  if (!projectPath) return null;
  return { projectKey: resolveProjectKey(projectPath), sessionId };
}

async function appendPortableTranscriptEntry(
  conversation: ConversationRow,
  entry: { uuid: string; type: string; timestamp: string; [key: string]: unknown },
): Promise<void> {
  const location = transcriptLocation(conversation);
  if (!location) return;
  await sqliteSessionStore.append(
    {
      ...location,
      subpath: '',
      provider: conversation.provider,
    },
    [entry],
  );
}

function broadcastPortableTranscriptEntry(
  conversation: ConversationRow,
  entry: Record<string, unknown>,
  broadcastFn?: BroadcastFn,
): void {
  if (!broadcastFn) return;
  const data = {
    ...entry,
    session_id: conversation.provider_session_id ?? conversation.claude_conversation_id,
  };
  broadcastFn(conversation.id, {
    type: 'ai-response',
    provider: conversation.provider,
    data: data as never,
  });
  broadcastFn(conversation.id, { type: 'claude-response', data: data as never });
}

async function emitPortableQuestionUse(
  conversation: ConversationRow,
  row: ConversationQuestionRow,
  questions: unknown[],
  broadcastFn?: BroadcastFn,
): Promise<void> {
  const toolUseId = row.provider_tool_use_id ?? `portable-question:${row.id}`;
  const uuid = `${toolUseId}:use`;
  const timestamp = new Date().toISOString();
  const entry = {
    uuid,
    type: 'assistant',
    timestamp,
    message: {
      id: uuid,
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'ask_user', input: { questions } }],
    },
  };
  await appendPortableTranscriptEntry(conversation, entry).catch((error) => {
    console.warn('[ask_user] Failed to persist portable question card:', error);
  });
  broadcastPortableTranscriptEntry(conversation, entry, broadcastFn);
}

/** Persist and broadcast the result that pairs with a synthetic remote-harness question card. */
export async function emitPortableQuestionResult(
  conversationId: number,
  row: ConversationQuestionRow,
  content: string,
  broadcastFn?: BroadcastFn,
): Promise<void> {
  const toolUseId = row.provider_tool_use_id;
  if (!toolUseId?.startsWith('portable-question:')) return;
  const conversation = conversationsDb.getById(conversationId);
  if (!conversation) return;
  const uuid = `${toolUseId}:result`;
  const timestamp = new Date().toISOString();
  const entry = {
    uuid,
    type: 'user',
    timestamp,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
  };
  await appendPortableTranscriptEntry(conversation, entry).catch((error) => {
    console.warn('[ask_user] Failed to persist portable question answer:', error);
  });
  broadcastPortableTranscriptEntry(conversation, entry, broadcastFn);
}

export async function parkPortableQuestion(
  conversationId: number,
  questions: unknown[],
  broadcastFn?: BroadcastFn,
  providerToolUseId: string | null = null,
) {
  const superseded = conversationQuestionsDb.pendingForConversation(conversationId);
  const row = conversationQuestionsDb.createOrGet(conversationId, questions, providerToolUseId);
  const conversation = conversationsDb.getById(conversationId);
  if (conversation && superseded && superseded.id !== row.id) {
    // createOrGet cancelled a stale round (a different question was still
    // pending). Close its card so the chat stops offering to answer it.
    await emitPortableQuestionResult(
      conversationId,
      superseded,
      'User dismissed this question: the agent asked a different question before it was answered.',
      broadcastFn,
    );
  }
  // Codex/OpenCode abort the request that invoked this handler, so their SDKs
  // never emit a completed MCP tool event. Materialize the tool-use ourselves
  // for both the live stream and transcript reload. Claude supplies its own
  // real tool-use id and message, so it must not receive a duplicate.
  if (conversation && providerToolUseId == null) {
    await emitPortableQuestionUse(conversation, row, questions, broadcastFn);
  }
  broadcastFn?.(conversationId, {
    type: 'awaiting-user-answer',
    conversationId,
    questionId: row.id,
    toolUseId: row.provider_tool_use_id,
    questions,
  });
  if (conversation) {
    void Promise.resolve(ownerAdapterFor(conversation).onQuestionParked(conversation, questions))
      .catch((error) => console.warn('[ask_user] Failed to notify question watchers:', error));
  }
  deferActiveTurn(conversationId);
  return row;
}
