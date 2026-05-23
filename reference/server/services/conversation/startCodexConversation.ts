// Codex-flavoured `startConversation` — the second-provider branch of
// the orchestrator.
//
// `startConversation` (in `startConversation.ts`) forks at the top: when
// the conversation's provider is `'openai'`, it delegates here. The
// existing Claude path stays bit-identical for Anthropic conversations.
//
// What this branch DOES:
//   - Resolves cwd + worktree path the same way as the Claude path.
//   - Loads per-user Codex credentials (CODEX_HOME) and rejects up-front
//     when missing (matches Claude's `buildClaudeSdkEnv` fail-closed).
//   - Calls `CodexProvider.startTurn(...)` and consumes the
//     `AsyncIterable<UnifiedMessage>` it returns.
//   - Stamps `claude_conversation_id` + `provider_session_id` on the
//     conversation row once `thread.started` fires.
//   - Broadcasts `ai-response` (and a back-compat `claude-response`) for
//     every UnifiedMessage so the frontend renders Codex turns through
//     the same path as Claude.
//   - Drives `activeSessions`, the streaming lifecycle, and the
//     agent-run completion handler.
//
// What this branch does NOT do (capability flags from Phase 4):
//   - No AskUserQuestion / canUseTool (Codex SDK has no canUseTool).
//   - No MCP wait (Codex v1 doesn't speak Bottega MCP configs).
//   - No image attachments (Codex v1).
//   - No thinking-delta accumulator (no `stream_event` deltas).
//   - No live `getContextUsage()` breakdown (no per-tool breakdown).
//
// The 401-recycle retry path is also unused; Codex SDK auto-refreshes
// `auth.json` on its own, so we surface SDK errors verbatim.

import { promises as fs } from 'fs';
import { conversationsDb, tasksDb } from '../../database/db.js';
import { resolveResumeModelEffort } from '../agentModelSettings.js';
import { getWorktreeProjectPath, worktreeExists } from '../worktree.js';
import { generateConversationTitle } from '../titleGenerator.js';
import { createContextUsageTracker } from '../contextUsageTracker.js';
import { getCredentialStore } from '../credentials/registry.js';
import { codexProvider } from '../providers/openai/index.js';
import { mirrorCodexEvent } from '../providers/openai/messageMirror.js';
import { activeSessions } from './sessionState.js';
import { validateAndNormalizeOptions } from './sdkOptions.js';
import { handleImages, cleanupTempFiles, handleVideoRecording } from './media.js';
import {
  handleStreamingStarted,
  handleStreamingComplete,
  composeAsync,
} from './streamingLifecycle.js';
import { buildAgentRunCompletionHandler } from './agentRunLifecycle.js';
import { resolveSlashCommand } from './slashCommands.js';
import type { ConversationOptions, StreamingContext } from './types.js';
import type { BroadcastFn } from '@shared/websocket/messages';
import type { UnifiedMessage } from '@shared/providers/types';

function composeOnComplete(ctx: StreamingContext): () => Promise<void> {
  return composeAsync<void>(
    () => handleStreamingComplete(ctx),
    buildAgentRunCompletionHandler(ctx),
  );
}

/**
 * Translate a UnifiedMessage into the Claude-shaped wire payload the
 * frontend has historically consumed via the `claude-response` WS event.
 *
 * For each UnifiedMessage type, we synthesise the minimal subset of the
 * Claude SDKMessage shape that `MessageComponent` and the SQLite
 * transcript reader both look at. Anything not synthesised stays
 * accessible via `raw` on the unified message; the `ai-response`
 * variant carries the same payload alongside the provider tag.
 */
function unifiedToWireMessage(unified: UnifiedMessage): Record<string, unknown> | null {
  switch (unified.type) {
    case 'user':
      return {
        type: 'user',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        message: { role: 'user', content: unified.content },
      };
    case 'assistant':
      return {
        type: 'assistant',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        parent_tool_use_id: unified.isSubAgent ? '__codex_subagent__' : null,
        message: {
          id: unified.id,
          model: unified.model ?? null,
          ...(unified.usage ? { usage: unified.usage } : {}),
          content: [{ type: 'text', text: unified.text }],
        },
      };
    case 'tool_use':
      return {
        type: 'assistant',
        uuid: `${unified.id}:wire`,
        session_id: unified.providerSessionId,
        parent_tool_use_id: null,
        message: {
          id: unified.id,
          content: [
            {
              type: 'tool_use',
              id: unified.toolUseId,
              name: unified.toolName,
              input: unified.toolInput,
            },
          ],
        },
      };
    case 'tool_result':
      return {
        type: 'user',
        uuid: `${unified.id}:wire`,
        session_id: unified.providerSessionId,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: unified.toolUseId,
              content: unified.content,
              ...(unified.isError ? { is_error: true } : {}),
            },
          ],
        },
      };
    case 'assistant_thinking':
      return {
        type: 'assistant',
        uuid: `${unified.id}:thinking`,
        session_id: unified.providerSessionId,
        parent_tool_use_id: null,
        message: {
          id: unified.id,
          content: [{ type: 'thinking', thinking: unified.text }],
        },
      };
    case 'result':
      return {
        type: 'result',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        is_error: unified.isError,
        ...(unified.usage ? { usage: unified.usage } : {}),
        ...(unified.errors ? { errors: unified.errors } : {}),
      };
    case 'system':
      // thread.started / turn.started — surface so consumers can ignore.
      return {
        type: 'system',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        subtype: unified.subtype ?? 'codex',
      };
    case 'stream_delta':
      return null; // Codex doesn't emit these; defensive.
  }
}

function broadcastUnified(
  broadcastFn: BroadcastFn | undefined,
  conversationId: number,
  unified: UnifiedMessage,
): void {
  if (!broadcastFn) return;
  const wire = unifiedToWireMessage(unified);
  if (!wire) return;
  broadcastFn(conversationId, {
    type: 'ai-response',
    data: wire as never,
    provider: 'openai',
  });
  // Back-compat dual-emit for the one-release window — same as the
  // Anthropic path in runStreamingLoop.
  broadcastFn(conversationId, {
    type: 'claude-response',
    data: wire as never,
  });
}

/**
 * Resume an existing Codex conversation. Mirrors `sendMessage` for
 * the Anthropic path: looks the conversation up, builds the CODEX_HOME
 * env, and calls `codexProvider.sendTurnMessage(resumeSessionId)`.
 *
 * Codex SDK resumes via `codex.resumeThread(threadId).runStreamed(...)`;
 * we pass the conversation's `provider_session_id` (falls back to
 * `claude_conversation_id` since they're populated identically by
 * `startCodexConversation`).
 */
export async function sendCodexMessage(
  conversationId: number,
  message: string | null,
  options: ConversationOptions = {},
): Promise<void> {
  const normalizedOptions = validateAndNormalizeOptions(options, 'sendCodexMessage');
  const { broadcastFn, broadcastToTaskSubscribersFn, userId, permissionMode } =
    normalizedOptions;

  const conversation = conversationsDb.getById(conversationId);
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} not found`);
  }
  const resumeSessionId =
    conversation.provider_session_id ?? conversation.claude_conversation_id;
  if (!resumeSessionId) {
    throw new Error(
      `Codex conversation ${conversationId} has no provider_session_id yet`,
    );
  }

  const taskId = conversation.task_id;
  const taskWithProject = taskId ? tasksDb.getWithProject(taskId) : null;
  if (!taskWithProject) {
    throw new Error(`Task for conversation ${conversationId} not found`);
  }
  const projectId = taskWithProject.project_id;

  let projectPath: string;
  if (conversation.session_path) {
    projectPath = conversation.session_path;
  } else {
    projectPath = taskWithProject.repo_folder_path;
    if (await worktreeExists(projectPath, taskId!)) {
      projectPath = getWorktreeProjectPath(
        projectPath,
        taskId!,
        taskWithProject.subproject_path,
      );
    }
  }

  const codexEnv = getCredentialStore('openai').buildSdkEnv(userId);
  const promptText = message ?? '';

  // Resume on an explicit model+effort — re-resolved from the RESUMING user's
  // per-user agent settings (same provider only), falling back to the stamped
  // row value. Explicit options only win for internal callers.
  const userOverride = resolveResumeModelEffort(conversation, userId);
  const model = normalizedOptions.model ?? userOverride.model;
  const effort = normalizedOptions.effort ?? userOverride.effort;
  if (!model) {
    throw new Error(`Conversation ${conversationId} has no stored model to resume with`);
  }
  if (model !== conversation.model || effort !== conversation.effort) {
    conversationsDb.updateModelEffort(conversationId, model, effort);
  }

  const abortController = new AbortController();
  const run = await codexProvider.sendTurnMessage({
    cwd: projectPath,
    prompt: promptText,
    resumeSessionId,
    model,
    effort,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    env: codexEnv,
    abortController,
  });

  const ctx: StreamingContext = {
    conversationId,
    taskId: taskId ?? undefined,
    claudeSessionId: resumeSessionId,
    userId,
    broadcastFn,
    broadcastToTaskSubscribersFn,
    isNewSession: false,
  };

  activeSessions.set(resumeSessionId, {
    instance: run as unknown,
    abortController,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths: [],
    tempDir: null,
    conversationId,
    taskId: taskId ?? null,
    projectId,
    userId: userId ?? null,
  });

  handleStreamingStarted(ctx);

  const contextUsageTracker = createContextUsageTracker({
    conversationId,
    broadcastFn,
  });

  try {
    for await (const unified of run.events) {
      broadcastUnified(broadcastFn, conversationId, unified);
      await mirrorCodexEvent(
        { projectFolderPath: projectPath, providerSessionId: resumeSessionId },
        unified,
      ).catch((err) => {
        console.warn('[ConversationAdapter] Codex resume mirror failed:', err);
      });
      if (unified.type === 'result') {
        await contextUsageTracker.onResult({
          type: 'result',
          ...(unified.usage ? { modelUsage: { codex: unified.usage } } : {}),
        } as never);
      }
    }

    activeSessions.delete(resumeSessionId);
    if (broadcastFn) {
      broadcastFn(conversationId, {
        type: 'claude-complete',
        sessionId: resumeSessionId,
        exitCode: 0,
        isNewSession: false,
      });
    }
    await composeOnComplete(ctx)();
  } catch (error) {
    console.error('[ConversationAdapter] Codex resume error:', error);
    activeSessions.delete(resumeSessionId);
    if (broadcastFn) {
      const errMsg = error instanceof Error ? error.message : String(error);
      broadcastFn(conversationId, {
        type: 'claude-error',
        error: errMsg,
      });
    }
    await composeOnComplete(ctx)();
    throw error;
  }
}

export async function startCodexConversation(
  taskId: number,
  message: string,
  options: ConversationOptions = {},
): Promise<{ conversationId: number; claudeSessionId: string }> {
  const normalizedOptions = validateAndNormalizeOptions(options, 'startCodexConversation');
  const {
    broadcastFn,
    broadcastToTaskSubscribersFn,
    userId,
    permissionMode,
    images,
    customSystemPrompt,
    videoConfig,
  } = normalizedOptions;

  // Codex turns always run on an explicit model+effort (no SDK default).
  const model = normalizedOptions.model;
  const effort = normalizedOptions.effort ?? null;
  if (!model) {
    throw new Error('startCodexConversation requires an explicit model');
  }

  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task ${taskId} not found`);
  }

  let projectPath = taskWithProject.repo_folder_path;
  if (await worktreeExists(projectPath, taskId)) {
    projectPath = getWorktreeProjectPath(projectPath, taskId, taskWithProject.subproject_path);
  }

  // Per-user CODEX_HOME. Throws if the user has no provisioned auth.json,
  // matching the Claude path's fail-closed posture.
  const codexEnv = getCredentialStore('openai').buildSdkEnv(userId);

  let conversationId = options.conversationId;
  if (!conversationId) {
    const conversation = conversationsDb.create(taskId, 'openai', model, effort);
    conversationId = conversation.id;
    console.log(
      `[ConversationAdapter] Created Codex conversation ${conversationId} for task ${taskId} (model=${model})`,
    );
  }

  const imageResult = images && images.length > 0
    ? await handleImages(message, images, projectPath)
    : { modifiedCommand: message, tempImagePaths: [] as string[], tempDir: null };
  // Codex SDK accepts plain-text input only in v1 (capability flag).
  // If the user attached images they'll be stripped here — the chat UI
  // disables image upload for Codex providers (Phase 11 capability gate).
  const finalMessageRaw = imageResult.modifiedCommand;
  const finalMessage = await resolveSlashCommand(finalMessageRaw, projectPath);
  const promptText = (finalMessage ?? message) +
    (customSystemPrompt ? `\n\n[System]\n${customSystemPrompt}` : '');

  const abortController = new AbortController();

  const run = await codexProvider.startTurn({
    cwd: projectPath,
    prompt: promptText,
    model,
    effort,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    env: codexEnv,
    abortController,
  });

  const { tempImagePaths, tempDir } = imageResult;

  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error('Codex session creation timeout'));
    }, 60000);

    const ctx: StreamingContext = {
      conversationId: conversationId!,
      taskId,
      claudeSessionId: null,
      userId,
      broadcastFn,
      broadcastToTaskSubscribersFn,
      isNewSession: true,
      videoConfig,
    };

    // Token usage from `turn.completed` flows through the existing
    // baseline path. The breakdown capability is off for Codex so
    // `onAssistant` is never called.
    const contextUsageTracker = createContextUsageTracker({
      conversationId: conversationId!,
      broadcastFn,
    });

    // Buffer events that arrive before providerSessionId resolves
    // (the synthetic user message arrives first, before thread.started).
    // Once the id lands we patch and mirror them in order.
    const preSessionBuffer: UnifiedMessage[] = [];

    void (async () => {
      try {
        for await (const unified of run.events) {
          // First time we see a provider session id, stamp the row +
          // fire the streaming-started lifecycle.
          if (
            !resolved &&
            unified.providerSessionId &&
            ctx.claudeSessionId === null
          ) {
            const sid = unified.providerSessionId;
            ctx.claudeSessionId = sid;
            conversationsDb.updateClaudeId(conversationId!, sid);
            conversationsDb.updateProviderSessionId(conversationId!, sid);
            conversationsDb.updateSessionPath(conversationId!, projectPath);
            activeSessions.set(sid, {
              instance: run as unknown,
              abortController,
              startTime: Date.now(),
              status: 'active',
              tempImagePaths,
              tempDir,
              conversationId: conversationId!,
              taskId,
              projectId: taskWithProject.project_id,
              userId: userId ?? null,
            });

            generateConversationTitle(
              conversationId!,
              message,
              broadcastFn,
              userId,
              taskId,
              broadcastToTaskSubscribersFn,
            );

            handleStreamingStarted(ctx);

            if (broadcastFn) {
              broadcastFn(conversationId!, {
                type: 'conversation-created',
                conversationId: conversationId!,
                claudeSessionId: sid,
              });
              broadcastFn(conversationId!, {
                type: 'session-created',
                sessionId: sid,
              });
            }
            if (broadcastToTaskSubscribersFn) {
              broadcastToTaskSubscribersFn(taskId, {
                type: 'conversation-added',
                conversation: {
                  id: conversationId!,
                  task_id: taskId,
                  claude_conversation_id: sid,
                  created_at: new Date().toISOString(),
                },
              });
            }

            clearTimeout(timeout);
            resolved = true;
            resolve({ conversationId: conversationId!, claudeSessionId: sid });
          }

          broadcastUnified(broadcastFn, conversationId!, unified);

          // Mirror to the messages table so the conversation reloads
          // with full history. The synthetic user message arrives
          // before thread.started so it's buffered and replayed (with
          // the now-known providerSessionId patched in) when the sid
          // first lands.
          if (ctx.claudeSessionId) {
            if (preSessionBuffer.length > 0) {
              const sid = ctx.claudeSessionId;
              for (const buffered of preSessionBuffer) {
                const patched = { ...buffered, providerSessionId: sid };
                await mirrorCodexEvent(
                  { projectFolderPath: projectPath, providerSessionId: sid },
                  patched,
                ).catch((err) => {
                  console.warn('[ConversationAdapter] Codex mirror failed (buffered):', err);
                });
              }
              preSessionBuffer.length = 0;
            }
            await mirrorCodexEvent(
              {
                projectFolderPath: projectPath,
                providerSessionId: ctx.claudeSessionId,
              },
              unified,
            ).catch((err) => {
              console.warn('[ConversationAdapter] Codex mirror failed:', err);
            });
          } else {
            preSessionBuffer.push(unified);
          }

          if (unified.type === 'result') {
            await contextUsageTracker.onResult({
              type: 'result',
              ...(unified.usage ? { modelUsage: { codex: unified.usage } } : {}),
            } as never);
          }
        }

        // Stream ended cleanly.
        if (ctx.claudeSessionId) {
          activeSessions.delete(ctx.claudeSessionId);
        }
        await cleanupTempFiles(tempImagePaths, tempDir);
        if (ctx.videoConfig) {
          await handleVideoRecording(ctx.videoConfig);
        }

        if (broadcastFn) {
          broadcastFn(conversationId!, {
            type: 'claude-complete',
            sessionId: ctx.claudeSessionId,
            exitCode: 0,
            isNewSession: true,
          });
        }

        await composeOnComplete(ctx)();
      } catch (error) {
        console.error('[ConversationAdapter] Codex streaming error:', error);
        if (ctx.claudeSessionId) {
          activeSessions.delete(ctx.claudeSessionId);
        }
        await cleanupTempFiles(tempImagePaths, tempDir);
        if (ctx.videoConfig?.tempDir) {
          await fs.rm(ctx.videoConfig.tempDir, { recursive: true, force: true }).catch(() => {});
        }

        if (!resolved) {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (broadcastFn) {
          const errMsg = error instanceof Error ? error.message : String(error);
          broadcastFn(conversationId!, {
            type: 'claude-error',
            error: errMsg,
          });
        }
        await composeOnComplete(ctx)();
      }
    })();
  });
}
