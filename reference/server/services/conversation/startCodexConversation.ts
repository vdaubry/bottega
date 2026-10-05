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
// Provider-neutral features supplied by Bottega:
//   - AskUserQuestion semantics through the durable `ask_user` MCP tool.
//   - Owner-domain tools through a per-turn loopback MCP gateway.
//
// What this branch does NOT do (capability flags from Phase 4):
//   - No image attachments (Codex v1).
//   - No thinking-delta accumulator (no `stream_event` deltas).
//   - No live `getContextUsage()` breakdown (no per-tool breakdown).
//
// The 401-recycle retry path is also unused; Codex SDK auto-refreshes
// `auth.json` on its own, so we surface SDK errors verbatim.

import { promises as fs } from 'fs';
import { conversationsDb } from '../../database/conversations.js';
import { resolveResumeModelEffort } from '../agentModelSettings.js';
import { generateConversationTitle } from '../titleGenerator.js';
import { createContextUsageTracker } from '../contextUsageTracker.js';
import { storeConversationImage } from '../conversationImages.js';
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
import {
  buildAgentRunCompletionHandler,
  failLinkedAgentRunIfRunning,
  handleAgentRunTurnStarted,
} from './agentRunLifecycle.js';
import { resolveSlashCommand } from './slashCommands.js';
import {
  type ConversationTarget,
} from './conversationScope.js';
import { resolveProviderResumeScope, resolveProviderStartScope } from './providerScope.js';
import { mcpGatewayExtras, ownerDisallowedTools, startOwnerMcpGateway } from './portableMcpForTurn.js';
import { loadOperatorMcpServers } from './operatorMcpForTurn.js';
import { consumeQuestionDeferred, isQuestionDeferred } from './portableQuestionTool.js';
import type { ConversationOptions, StreamingContext } from './types.js';
import type { BroadcastFn } from '@shared/websocket/messages';
import { generatedImageBlock } from '@shared/providers/generatedImage';
import type {
  UnifiedAssistantImageMessage,
  UnifiedMessage,
  UnifiedResultMessage,
} from '@shared/providers/types';

function composeOnComplete(ctx: StreamingContext): () => Promise<void> {
  return composeAsync<void>(
    buildAgentRunCompletionHandler(ctx),
    () => handleStreamingComplete(ctx),
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
    case 'assistant_image':
      return {
        type: 'assistant',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        parent_tool_use_id: null,
        message: {
          id: unified.id,
          content: [generatedImageBlock(unified)],
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

/**
 * Copy a generated image out of Codex's per-user scratch folder into the
 * conversation's own image store — the transcript entry names the file, and
 * the store is what serves it. Returns false when the copy failed: the caller
 * drops the message rather than leave the chat pointing at a missing file.
 */
async function adoptGeneratedImage(
  conversationId: number,
  unified: UnifiedAssistantImageMessage,
): Promise<boolean> {
  try {
    await storeConversationImage(conversationId, unified.sourcePath, unified.fileName);
    return true;
  } catch (err) {
    console.warn(
      `[ConversationAdapter] Could not store generated image ${unified.sourcePath} for conversation ${conversationId}:`,
      err,
    );
    return false;
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
 * Surface a terminal Codex turn error in the conversation transcript.
 *
 * The provider reports usage-limit / stream errors as a `result` event with
 * `isError: true`. That entry is persisted, but the chat UI only renders
 * user/assistant messages, so a failed turn otherwise looks empty on reload —
 * the run is correctly marked failed, yet the reason is invisible. We broadcast
 * and mirror a synthetic *assistant* message carrying the error text so the
 * failure reason shows up both live and on reload. The uuid is derived from the
 * result id, so the mirror upserts (no duplicate) if the turn is ever replayed.
 */
async function surfaceCodexTurnError(
  result: UnifiedResultMessage,
  broadcastFn: BroadcastFn | undefined,
  conversationId: number,
  projectPath: string,
  providerSessionId: string,
): Promise<void> {
  const detail =
    (result.errors ?? [])
      .map((e) =>
        e && typeof e === 'object' && 'message' in e
          ? String(e.message)
          : String(e),
      )
      .filter((m) => m && m !== 'undefined')
      .join('\n') || 'The turn failed without a specific error message.';

  const synthetic: UnifiedMessage = {
    type: 'assistant',
    id: `error_message:${result.id}`,
    provider: 'openai',
    providerSessionId,
    raw: null,
    text: `⚠️ This agent run failed and was stopped.\n\n${detail}`,
    isSubAgent: false,
  };

  broadcastUnified(broadcastFn, conversationId, synthetic);
  await mirrorCodexEvent({ projectFolderPath: projectPath, providerSessionId }, synthetic);
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
  const {
    broadcastFn,
    broadcastToTaskSubscribersFn,
    broadcastToEpicSubscribersFn,
    userId,
    permissionMode,
    videoConfig,
  } = normalizedOptions;

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

  const scope = await resolveProviderResumeScope(conversation);
  const { taskId, epicId, projectId } = scope;
  const projectPath = conversation.session_path ?? scope.cwd;

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
  const mcpGateway = await startOwnerMcpGateway(scope, conversationId, normalizedOptions);
  const operatorMcpServers = await loadOperatorMcpServers(projectPath, videoConfig);
  const disallowedTools = [
    ...new Set([
      ...(normalizedOptions.disallowedTools ?? []),
      ...ownerDisallowedTools(scope, conversationId),
    ]),
  ];
  let run;
  try {
    run = await codexProvider.sendTurnMessage({
      cwd: projectPath,
      prompt: promptText,
      resumeSessionId,
      model,
      effort,
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      env: codexEnv,
      abortController,
      extras: mcpGatewayExtras(mcpGateway, operatorMcpServers),
      disallowedTools,
    });
  } catch (error) {
    await mcpGateway?.close();
    throw error;
  }

  const ctx: StreamingContext = {
    conversationId,
    taskId: taskId ?? undefined,
    epicId: epicId ?? undefined,
    claudeSessionId: resumeSessionId,
    userId,
    broadcastFn,
    broadcastToTaskSubscribersFn,
    broadcastToEpicSubscribersFn,
    isNewSession: false,
  };

  activeSessions.set(resumeSessionId, {
    instance: run,
    abortController,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths: [],
    tempDir: null,
    conversationId,
    taskId: taskId ?? null,
    epicId,
    projectId,
    userId: userId ?? null,
  });

  try {
    await handleAgentRunTurnStarted(ctx);
  } catch (error) {
    run.abort();
    activeSessions.delete(resumeSessionId);
    await mcpGateway?.close();
    throw error;
  }
  handleStreamingStarted(ctx);

  const contextUsageTracker = createContextUsageTracker({
    conversationId,
    broadcastFn,
  });

  // Codex reports a failed turn as a pair (stream_error + turn_failed); only
  // surface the reason once.
  let turnErrorSurfaced = false;

  try {
    for await (const unified of run.events) {
      if (unified.type === 'assistant_image' && !(await adoptGeneratedImage(conversationId, unified))) {
        continue;
      }
      broadcastUnified(broadcastFn, conversationId, unified);
      await mirrorCodexEvent(
        { projectFolderPath: projectPath, providerSessionId: resumeSessionId },
        unified,
      ).catch((err) => {
        console.warn('[ConversationAdapter] Codex resume mirror failed:', err);
      });
      if (unified.type === 'result') {
        // A terminal Codex error (e.g. "You've hit your usage limit") arrives
        // as an in-band result event, not a thrown exception, so the loop ends
        // cleanly. Pre-mark the agent run failed here so composeOnComplete
        // stops the chain instead of treating the dead turn as a pass and
        // looping to MAX_WORKFLOW_RUNS. Mirrors the OpenCode path.
        if (unified.isError && !isQuestionDeferred(conversationId)) {
          failLinkedAgentRunIfRunning(conversationId);
          if (!turnErrorSurfaced) {
            turnErrorSurfaced = true;
            await surfaceCodexTurnError(
              unified,
              broadcastFn,
              conversationId,
              projectPath,
              resumeSessionId,
            ).catch((err) =>
              console.warn('[ConversationAdapter] failed to surface Codex turn error:', err),
            );
          }
        }
        await contextUsageTracker.onResult({
          type: 'result',
          ...(unified.usage ? { modelUsage: { codex: unified.usage } } : {}),
        } as never);
      }
    }

    activeSessions.delete(resumeSessionId);
    if (consumeQuestionDeferred(conversationId)) {
      await handleStreamingComplete(ctx);
      return;
    }
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
    if (consumeQuestionDeferred(conversationId)) {
      await handleStreamingComplete(ctx);
      return;
    }
    if (broadcastFn) {
      const errMsg = error instanceof Error ? error.message : String(error);
      broadcastFn(conversationId, {
        type: 'claude-error',
        error: errMsg,
      });
    }
    await composeOnComplete(ctx)();
    throw error;
  } finally {
    await mcpGateway?.close();
  }
}

export async function startCodexConversation(
  targetOrTaskId: ConversationTarget | number,
  message: string,
  options: ConversationOptions = {},
): Promise<{ conversationId: number; claudeSessionId: string }> {
  const { target, scope } = await resolveProviderStartScope(targetOrTaskId);
  const normalizedOptions = validateAndNormalizeOptions(options, 'startCodexConversation');
  const {
    broadcastFn,
    broadcastToTaskSubscribersFn,
    broadcastToEpicSubscribersFn,
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

  const { taskId, epicId, projectId } = scope;
  const projectPath = scope.cwd;

  // Per-user CODEX_HOME. Throws if the user has no provisioned auth.json,
  // matching the Claude path's fail-closed posture.
  const codexEnv = getCredentialStore('openai').buildSdkEnv(userId);

  let conversationId = options.conversationId;
  if (!conversationId) {
    const conversation = target.kind === 'epic'
      ? conversationsDb.createForEpic(target.epicId, 'openai', model, effort)
      : conversationsDb.create(target.taskId, 'openai', model, effort);
    conversationId = conversation.id;
    console.log(
      `[ConversationAdapter] Created Codex conversation ${conversationId} for ${target.kind} ${taskId ?? epicId} (model=${model})`,
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
  const mcpGateway = await startOwnerMcpGateway(scope, conversationId, normalizedOptions);
  // The operator's own MCP servers (Playwright above all) — the Claude path
  // gets these through `sdkOptions.mcpServers`; Codex gets them here.
  const operatorMcpServers = await loadOperatorMcpServers(projectPath, videoConfig);
  let run;
  try {
    run = await codexProvider.startTurn({
      cwd: projectPath,
      prompt: promptText,
      model,
      effort,
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      env: codexEnv,
      abortController,
      extras: mcpGatewayExtras(mcpGateway, operatorMcpServers),
      disallowedTools: normalizedOptions.disallowedTools,
    });
  } catch (error) {
    await mcpGateway?.close();
    await cleanupTempFiles(imageResult.tempImagePaths, imageResult.tempDir);
    throw error;
  }

  const { tempImagePaths, tempDir } = imageResult;

  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error('Codex session creation timeout'));
    }, 60000);

    const ctx: StreamingContext = {
      conversationId: conversationId,
      taskId,
      epicId,
      claudeSessionId: null,
      userId,
      broadcastFn,
      broadcastToTaskSubscribersFn,
      broadcastToEpicSubscribersFn,
      isNewSession: true,
      videoConfig,
    };

    // Token usage from `turn.completed` flows through the existing
    // baseline path. The breakdown capability is off for Codex so
    // `onAssistant` is never called.
    const contextUsageTracker = createContextUsageTracker({
      conversationId: conversationId,
      broadcastFn,
    });

    // Buffer events that arrive before providerSessionId resolves
    // (the synthetic user message arrives first, before thread.started).
    // Once the id lands we patch and mirror them in order.
    const preSessionBuffer: UnifiedMessage[] = [];

    // Codex reports a failed turn as a pair (stream_error + turn_failed); only
    // surface the reason once.
    let turnErrorSurfaced = false;

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
            conversationsDb.updateClaudeId(conversationId, sid);
            conversationsDb.updateProviderSessionId(conversationId, sid);
            conversationsDb.updateSessionPath(conversationId, projectPath);
            activeSessions.set(sid, {
              instance: run,
              abortController,
              startTime: Date.now(),
              status: 'active',
              tempImagePaths,
              tempDir,
              conversationId: conversationId,
              taskId,
              epicId,
              projectId,
              userId: userId ?? null,
            });

            generateConversationTitle(conversationId, message, {
              broadcastFn,
              userId,
              ...(taskId != null ? { taskId } : {}),
              ...(epicId != null ? { epicId } : {}),
              broadcastToTaskSubscribersFn,
              broadcastToEpicSubscribersFn,
            });

            await handleAgentRunTurnStarted(ctx);
            handleStreamingStarted(ctx);

            if (broadcastFn) {
              broadcastFn(conversationId, {
                type: 'conversation-created',
                conversationId: conversationId,
                claudeSessionId: sid,
              });
              broadcastFn(conversationId, {
                type: 'session-created',
                sessionId: sid,
              });
            }
            if (broadcastToTaskSubscribersFn && taskId != null) {
              broadcastToTaskSubscribersFn(taskId, {
                type: 'conversation-added',
                conversation: {
                  id: conversationId,
                  task_id: taskId,
                  epic_id: epicId,
                  claude_conversation_id: sid,
                  created_at: new Date().toISOString(),
                },
              });
            }
            if (broadcastToEpicSubscribersFn && epicId != null) {
              broadcastToEpicSubscribersFn(epicId, {
                type: 'conversation-added',
                conversation: {
                  id: conversationId,
                  task_id: taskId,
                  epic_id: epicId,
                  claude_conversation_id: sid,
                  created_at: new Date().toISOString(),
                },
              });
            }

            clearTimeout(timeout);
            resolved = true;
            resolve({ conversationId: conversationId, claudeSessionId: sid });
          }

          if (unified.type === 'assistant_image' && !(await adoptGeneratedImage(conversationId, unified))) {
            continue;
          }

          broadcastUnified(broadcastFn, conversationId, unified);

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
            // Terminal Codex error (usage limit, stream error) surfaces as an
            // in-band result event; pre-mark the run failed so the loop stops
            // here instead of chaining a dead turn. See the resume path above.
            if (unified.isError && !isQuestionDeferred(conversationId)) {
              failLinkedAgentRunIfRunning(conversationId);
              if (!turnErrorSurfaced && ctx.claudeSessionId) {
                turnErrorSurfaced = true;
                await surfaceCodexTurnError(
                  unified,
                  broadcastFn,
                  conversationId,
                  projectPath,
                  ctx.claudeSessionId,
                ).catch((err) =>
                  console.warn('[ConversationAdapter] failed to surface Codex turn error:', err),
                );
              }
            }
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
        if (consumeQuestionDeferred(conversationId)) {
          await cleanupTempFiles(tempImagePaths, tempDir);
          await handleStreamingComplete(ctx);
          return;
        }
        await cleanupTempFiles(tempImagePaths, tempDir);
        if (ctx.videoConfig) {
          await handleVideoRecording(ctx.videoConfig);
        }

        if (broadcastFn) {
          broadcastFn(conversationId, {
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
        if (consumeQuestionDeferred(conversationId)) {
          await cleanupTempFiles(tempImagePaths, tempDir);
          await handleStreamingComplete(ctx);
          return;
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
          broadcastFn(conversationId, {
            type: 'claude-error',
            error: errMsg,
          });
        }
        await composeOnComplete(ctx)();
      } finally {
        await mcpGateway?.close();
      }
    })();
  });
}
