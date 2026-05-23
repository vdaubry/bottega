import { conversationsDb, tasksDb } from '../../database/db.js';
import { resolveProjectKey } from '../conversationContentStore.js';
import { sqliteSessionStore } from '../sqliteSessionStore.js';
import { pendingAskUserQuestions } from './sessionState.js';
import { DEFAULT_PERMISSION_MODE } from './sdkOptions.js';
import { sendMessage } from './startConversation.js';
import type {
  BroadcastFn,
  BroadcastToTaskSubscribersFn,
  ConversationId,
  PermissionMode,
} from '@shared/websocket/messages';

interface ToolUseOptions {
  toolUseID?: string;
  tool_use_id?: string;
  signal?: AbortSignal;
}

interface CanUseToolInput {
  questions?: unknown;
  [key: string]: unknown;
}

interface CanUseToolResult {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
}

interface BuildCanUseToolOptions {
  conversationId?: ConversationId | undefined;
  broadcastFn?: BroadcastFn | undefined;
}

interface ResolveOptions {
  broadcastFn?: BroadcastFn | undefined;
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
  userId?: number | undefined;
  permissionMode?: PermissionMode | undefined;
}

/**
 * Build a `canUseTool` callback for the SDK. Non-AskUserQuestion tools pass
 * through unchanged so `bypassPermissions` semantics are preserved.
 *
 * For AskUserQuestion we use the SDK's canonical pattern: the callback parks
 * on a Promise that's resolved later from a WebSocket handler when the user
 * submits answers via the wizard panel. The SDK's documented contract is that
 * the callback may stay pending indefinitely — the SDK pauses execution until
 * we return.
 */
export function buildCanUseTool({
  conversationId,
  broadcastFn,
}: BuildCanUseToolOptions = {}) {
  return async function canUseTool(
    toolName: string,
    input: CanUseToolInput,
    options: ToolUseOptions,
  ): Promise<CanUseToolResult> {
    if (toolName !== 'AskUserQuestion') {
      return { behavior: 'allow', updatedInput: input };
    }

    const questions = Array.isArray(input?.questions) ? input.questions : [];
    const toolUseId = options?.toolUseID ?? options?.tool_use_id ?? null;

    if (!conversationId) {
      console.warn(
        '[ConversationAdapter] AskUserQuestion fired without a conversationId — rejecting',
      );
      return {
        behavior: 'deny',
        message: 'AskUserQuestion is not supported in this context',
      };
    }

    return new Promise<CanUseToolResult>((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        questions,
        toolUseId,
        signalCleanup: undefined as undefined | (() => void),
      };

      // Reject any prior pending entry for this conversation (shouldn't happen
      // — the SDK only pauses on one callback at a time — but defensive).
      const prior = pendingAskUserQuestions.get(conversationId);
      if (prior && prior !== entry) {
        try {
          prior.reject(new Error('AskUserQuestion superseded'));
        } catch {
          /* ignore */
        }
      }
      pendingAskUserQuestions.set(conversationId, entry);

      const onAbort = () => {
        if (pendingAskUserQuestions.get(conversationId) === entry) {
          pendingAskUserQuestions.delete(conversationId);
          reject(new Error('AskUserQuestion aborted'));
        }
      };
      options?.signal?.addEventListener?.('abort', onAbort, { once: true });
      entry.signalCleanup = () => {
        try {
          options?.signal?.removeEventListener?.('abort', onAbort);
        } catch {
          /* ignore */
        }
      };

      if (broadcastFn) {
        broadcastFn(conversationId, {
          type: 'awaiting-user-answer',
          conversationId,
          toolUseId,
          questions,
        });
      }
    });
  };
}

/**
 * Reject and remove any pending AskUserQuestion entry for a conversation.
 * Called from the streaming-loop's finally and from abortSession to make sure
 * the in-memory promise doesn't leak when the SDK turn ends without resolving
 * the question (process abort, network error, subprocess crash).
 */
export function rejectPendingAskUserQuestion(
  conversationId: ConversationId,
  reason: string = 'conversation ended',
): void {
  const entry = pendingAskUserQuestions.get(conversationId);
  if (!entry) return;
  pendingAskUserQuestions.delete(conversationId);
  try {
    entry.signalCleanup?.();
  } catch {
    /* ignore */
  }
  try {
    entry.reject(new Error(`AskUserQuestion: ${reason}`));
  } catch {
    /* ignore */
  }
}

/**
 * Build the synthetic tool_result content string for an AskUserQuestion that
 * matches what the Claude Agent SDK writes for this tool. The frontend's
 * `parseAnsweredToolResult` (src/components/AskUserQuestion/answerUtils.ts)
 * recognises this exact format. Embedded `"` in answers is collapsed to `'`
 * because the parser regex `/"([^"]*)"="([^"]*)"/g` can't tolerate quotes
 * inside values.
 */
function buildAnsweredToolResultText(
  answers: Record<string, string>,
): string {
  const sanitize = (s: unknown): string => {
    if (s == null) return '';
    if (typeof s === 'string') return s.replace(/"/g, "'");
    return JSON.stringify(s).replace(/"/g, "'");
  };
  const pairs = Object.entries(answers || {})
    .map(([q, a]) => `"${sanitize(q)}"="${sanitize(a)}"`)
    .join(', ');
  return `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.`;
}

interface OrphanAsk {
  toolUseId: string;
  projectKey: string;
  sessionId: string;
}

interface ConversationRow {
  task_id?: number | null;
  claude_conversation_id?: string | null;
  session_path?: string | null;
}

/**
 * Walk SQLite messages for a conversation in reverse and return the most
 * recent AskUserQuestion `tool_use` block whose `id` has no matching
 * `tool_result`. Used by the restart-fallback path.
 */
async function findOrphanAskUserQuestion(
  conversation: ConversationRow,
): Promise<OrphanAsk | null> {
  const sessionId = conversation.claude_conversation_id;
  if (!sessionId) return null;

  let pathForKey = conversation.session_path;
  if (!pathForKey && conversation.task_id) {
    const taskWithProject = tasksDb.getWithProject(conversation.task_id);
    pathForKey = taskWithProject?.repo_folder_path;
  }
  if (!pathForKey) return null;

  const projectKey = resolveProjectKey(pathForKey);
  const entries = await sqliteSessionStore.load({ projectKey, sessionId });
  if (!entries || entries.length === 0) return null;

  const resolved = new Set<string>();
  for (const entry of entries) {
    if ((entry as { type?: string })?.type !== 'user') continue;
    const content = (entry as { message?: { content?: unknown } }).message
      ?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block?.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        resolved.add(block.tool_use_id);
      }
    }
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if ((entry as { type?: string })?.type !== 'assistant') continue;
    const content = (entry as { message?: { content?: unknown } }).message
      ?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (block?.type !== 'tool_use') continue;
      if (block.name !== 'AskUserQuestion') continue;
      if (!block.id || resolved.has(block.id)) continue;
      return { toolUseId: block.id, projectKey, sessionId };
    }
  }
  return null;
}

/**
 * Resolve an AskUserQuestion. Happy path: there's a pending canUseTool callback
 * in memory — resolve it with the user's answers. Restart fallback: the
 * callback is gone (process restarted while waiting), so we resume the SDK
 * session by yielding a synthesised tool_result for the orphan tool_use as
 * the very first prompt block.
 */
export async function resolveAskUserQuestion(
  conversationId: ConversationId,
  answers: Record<string, string>,
  options: ResolveOptions = {},
): Promise<{ kind: string; conversationId: ConversationId; toolUseId?: string }> {
  const safeAnswers: Record<string, string> =
    answers && typeof answers === 'object' ? answers : {};
  const entry = pendingAskUserQuestions.get(conversationId);

  if (entry) {
    pendingAskUserQuestions.delete(conversationId);
    try {
      entry.signalCleanup?.();
    } catch {
      /* ignore */
    }

    // The model expects answers keyed by `question.question` text. Re-key by
    // matching on either the full text or the header — the panel sends keyed
    // by question text already, but tolerate both shapes.
    const keyedAnswers: Record<string, string> = {};
    for (const q of entry.questions as Array<{
      question?: string;
      header?: string;
    }>) {
      const key = q?.question;
      if (!key) continue;
      const fromText = safeAnswers[q.question!];
      const fromHeader = q.header ? safeAnswers[q.header] : undefined;
      const value = fromText ?? fromHeader ?? '';
      keyedAnswers[key] = value;
    }

    // The SDK turn is about to resume — flip the UI back into the streaming
    // state so the spinner reappears until the next assistant chunk lands.
    // Dual-emit on conversation channel (chat indicator) AND task channel
    // (live badge), mirroring streamingLifecycle.ts.
    if (options.broadcastFn) {
      options.broadcastFn(conversationId, {
        type: 'streaming-started',
        conversationId,
      });
    }
    if (options.broadcastToTaskSubscribersFn) {
      const conversation = conversationsDb.getById(conversationId);
      if (conversation?.task_id) {
        options.broadcastToTaskSubscribersFn(conversation.task_id, {
          type: 'streaming-started',
          conversationId,
        });
      }
    }

    entry.resolve({
      behavior: 'allow',
      updatedInput: { questions: entry.questions, answers: keyedAnswers },
    });
    return { kind: 'resolved', conversationId };
  }

  // Restart fallback — no in-memory callback, so the SDK process is gone.
  // Resume the session and inject a synthetic tool_result for the orphan
  // tool_use. Anthropic's API requires every tool_use to have a matching
  // tool_result in the next user turn; a plain text user message would error.
  const conversation = conversationsDb.getById(conversationId) as
    | ConversationRow
    | null;
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} not found`);
  }
  const orphan = await findOrphanAskUserQuestion(conversation);
  if (!orphan) {
    throw new Error(
      'No pending AskUserQuestion to resolve for this conversation',
    );
  }

  const text = buildAnsweredToolResultText(safeAnswers);

  await sendMessage(conversationId, null, {
    ...options,
    permissionMode: options.permissionMode || DEFAULT_PERMISSION_MODE,
    askUserQuestionToolResult: {
      tool_use_id: orphan.toolUseId,
      content: text,
    },
  });

  return {
    kind: 'recovered',
    conversationId,
    toolUseId: orphan.toolUseId,
  };
}
