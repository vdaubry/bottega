import { conversationsDb } from '../../database/conversations.js';
import { conversationQuestionsDb } from '../../database/conversationQuestions.js';
import { projectsDb } from '../../database/db.js';
import { ownerAdapterFor } from './ownerAdapters.js';
import type { ConversationRow } from '@shared/types/db';
import { resolveProjectKey } from '../conversationContentStore.js';
import { sqliteSessionStore } from '../sqliteSessionStore.js';
import {
  activeSessions,
  activeStreamingSessions,
  pendingAskUserQuestions,
} from './sessionState.js';
import { MONITOR_DENY_MESSAGE } from './backgroundTaskGate.js';
import { DEFAULT_PERMISSION_MODE } from './sdkOptions.js';
import { sendMessage } from './startConversation.js';
import { emitPortableQuestionResult, parkPortableQuestion } from './portableQuestionTool.js';
import type {
  BroadcastFn,
  BroadcastToTaskSubscribersFn,
  BroadcastToEpicSubscribersFn,
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
  broadcastToEpicSubscribersFn?: BroadcastToEpicSubscribersFn | undefined;
  userId?: number | undefined;
  permissionMode?: PermissionMode | undefined;
}

const PORTABLE_QUESTION_QUIESCE_TIMEOUT_MS = 15_000;
const CONTINUATION_START_POLL_MS = 25;

function isConversationStreaming(conversationId: number): boolean {
  return [...activeStreamingSessions.values()].some((session) => session.conversationId === conversationId);
}

function hasActiveConversationTurn(conversationId: number): boolean {
  return [...activeSessions.values()].some((session) => session.conversationId === conversationId)
    || isConversationStreaming(conversationId);
}

/**
 * A portable ask aborts its provider process, then resumes on a fresh turn.
 * The answer can arrive before the old iterator/finally blocks have removed
 * their session entries. Starting the continuation during that window would
 * reuse the same provider session id and let the old cleanup delete the new
 * turn's bookkeeping. Wait for the parked turn to finish unwinding first.
 */
export async function waitForConversationTurnToQuiesce(
  conversationId: number,
  timeoutMs = PORTABLE_QUESTION_QUIESCE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (hasActiveConversationTurn(conversationId)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for conversation ${conversationId} to pause`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Wait until the continuation turn behind `turn` has been ACCEPTED: its
 * streaming lifecycle registered the conversation in `activeStreamingSessions`
 * (the map the quiesce wait above drains), which every resume path does once
 * the owner admitted the turn and before it consumes the provider stream.
 *
 * Resolves on acceptance, or when the turn already settled successfully (a
 * turn shorter than one poll still delivered its prompt). Rejects only when
 * the turn fails BEFORE acceptance — the answers never reached a provider. A
 * failure after acceptance is the turn's own: the streaming path has already
 * broadcast it and run its completion hooks, so it is logged here and nothing
 * more.
 */
export async function waitForContinuationTurnToStart(
  conversationId: number,
  turn: Promise<void>,
  pollMs = CONTINUATION_START_POLL_MS,
): Promise<void> {
  const outcome: { settled: boolean; failed: boolean; error: unknown; accepted: boolean } = {
    settled: false,
    failed: false,
    error: undefined,
    accepted: false,
  };
  const observed = turn.then(
    () => {
      outcome.settled = true;
    },
    (error: unknown) => {
      outcome.settled = true;
      outcome.failed = true;
      outcome.error = error;
      if (outcome.accepted) {
        console.error(
          `[ask_user] Continuation turn for conversation ${conversationId} failed after its answers were delivered:`,
          error,
        );
      }
    },
  );
  while (!outcome.settled && !isConversationStreaming(conversationId)) {
    await Promise.race([observed, new Promise((resolve) => setTimeout(resolve, pollMs))]);
  }
  if (outcome.failed) throw outcome.error;
  outcome.accepted = true;
}

/**
 * Build a `canUseTool` callback for the SDK. Non-AskUserQuestion tools pass
 * through unchanged so `bypassPermissions` semantics are preserved, with two
 * exceptions normalized here because Bottega runs one SDK subprocess per turn
 * and aborts it at the terminal `result` (startConversation.ts onResult):
 *
 *  - `Bash` with `run_in_background: true` is rewritten to run in the
 *    foreground — a backgrounded shell is killed at turn end and its
 *    cross-turn `<task-notification>` can never be delivered, deadlocking the
 *    conversation.
 *  - `Monitor` (the SDK's until-loop waiter, itself a background task) is
 *    denied with guidance to run the command synchronously in the foreground.
 *
 * This is the same choke point that gates AskUserQuestion under
 * `bypassPermissions`, so it neutralizes background execution independently of
 * the SDK's internal `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` flag (which is
 * undocumented and liable to rename across versions).
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
    if (
      toolName === 'Bash' &&
      (input as { run_in_background?: unknown })?.run_in_background
    ) {
      return {
        behavior: 'allow',
        updatedInput: { ...input, run_in_background: false },
      };
    }

    if (toolName === 'Monitor') {
      return { behavior: 'deny', message: MONITOR_DENY_MESSAGE };
    }

    if (toolName === 'mcp__bottega_interaction__ask_user') {
      const questions = Array.isArray(input?.questions) ? input.questions : [];
      const toolUseId = options?.toolUseID ?? options?.tool_use_id ?? null;
      if (!conversationId) {
        return { behavior: 'deny', message: 'ask_user requires a conversation' };
      }
      await parkPortableQuestion(conversationId, questions, broadcastFn, toolUseId);
      return new Promise<CanUseToolResult>(() => {});
    }

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

      // Somebody has to answer this. For a task conversation the parked
      // question is published as a domain event — an orchestrated ticket's
      // orchestrator subscribes and answers it (it holds the specification the
      // asking agent cannot see); nobody listening means the widget broadcast
      // above was the whole story. When the ORCHESTRATOR itself is the one
      // asking, the question really is for the user, so they get a push.
      void notifyQuestionWatchers(conversationId, questions);
    });
  };
}

/**
 * Route a parked question to whoever can answer it. Best-effort and fully
 * detached: a failure here must never stop the question reaching the UI, which
 * has already been broadcast by the time this runs.
 */
async function notifyQuestionWatchers(
  conversationId: number,
  questions: unknown[],
): Promise<void> {
  try {
    const conversation = conversationsDb.getById(conversationId);
    if (!conversation) return;
    await ownerAdapterFor(conversation).onQuestionParked(conversation, questions);
  } catch (err) {
    console.warn('[AskUserQuestion] Failed to route a parked question:', err);
  }
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

  let pathForKey: string | null | undefined = conversation.session_path;
  if (!pathForKey) {
    // Fall back to the owning project's repo path (epic conversations run in
    // the main checkout; a task conversation's real cwd is its session_path,
    // stored at start).
    const owner = ownerAdapterFor(conversation).resolveOwner(conversation);
    pathForKey = owner ? projectsDb.getByIdAdmin(owner.projectId)?.repo_folder_path : undefined;
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
      const name = String(block.name ?? '');
      if (name !== 'AskUserQuestion' && name !== 'ask_user' && !name.endsWith('__ask_user')) continue;
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
    if (options.broadcastToTaskSubscribersFn || options.broadcastToEpicSubscribersFn) {
      const conversation = conversationsDb.getById(conversationId);
      if (options.broadcastToTaskSubscribersFn && conversation?.task_id) {
        options.broadcastToTaskSubscribersFn(conversation.task_id, {
          type: 'streaming-started',
          conversationId,
        });
      }
      if (options.broadcastToEpicSubscribersFn && conversation?.epic_id) {
        options.broadcastToEpicSubscribersFn(conversation.epic_id, {
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

  // Provider-neutral ask_user path. The row was committed before the active
  // provider turn was aborted, so it remains answerable after a restart.
  const durable = conversationQuestionsDb.pendingForConversation(conversationId);
  if (durable) {
    conversationQuestionsDb.answer(durable.id, safeAnswers);
    try {
      await waitForConversationTurnToQuiesce(conversationId);
      const text = buildAnsweredToolResultText(safeAnswers);
      await emitPortableQuestionResult(conversationId, durable, text, options.broadcastFn);
      // Deliver the answers as an ordinary user message on every harness.
      // A tool_result is only required when the aborted turn left a tool_use
      // unpaired — which never happens here: the ask_user tool is a *server*
      // tool, so each harness closes its own tool call when the turn aborts
      // (Claude writes "completed with no output" for the real tool_use id).
      // Injecting our own tool_result would reference an id the provider's
      // history does not carry, and Claude's transcript repair silently drops
      // the whole block — the user's answers would never reach the model.
      const continuation = Promise.resolve(
        sendMessage(conversationId, text, {
          ...options,
          permissionMode: options.permissionMode || DEFAULT_PERMISSION_MODE,
        }),
      );
      // The row is resolved as soon as the continuation turn is ACCEPTED, not
      // when its promise settles minutes later. From acceptance on the
      // provider holds the answers and the transcript carries them (the
      // tool_result above plus the user message), so there is nothing left to
      // redeliver: a later failure of that turn is the turn's own. Waiting for
      // settlement instead left every delivered round `answered` until the
      // next boot sweep reopened it as pending — and the following ask_user
      // then reused that stale row instead of getting its own.
      await waitForContinuationTurnToStart(conversationId, continuation);
      conversationQuestionsDb.resolve(durable.id);
    } catch (error) {
      // Genuine failure to deliver: the parked turn never unwound, or the
      // resume was rejected before a turn was accepted. Back to pending so the
      // widget can be submitted again.
      conversationQuestionsDb.reopen(durable.id);
      throw error;
    }
    return {
      kind: 'durable-resolved',
      conversationId,
      ...(durable.provider_tool_use_id ? { toolUseId: durable.provider_tool_use_id } : {}),
    };
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
