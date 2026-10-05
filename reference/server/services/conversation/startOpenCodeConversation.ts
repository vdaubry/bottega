// OpenCode-flavoured `startConversation` — the third-provider branch
// of the orchestrator.
//
// Structure mirrors `startCodexConversation.ts` (Codex). The Anthropic
// path stays the historical default; `startConversation` forks at the
// top when `options.provider === 'opencode'` and delegates here.
//
// What this branch DOES:
//   - Resolves cwd + worktree path the same way as the Claude/Codex paths.
//   - Loads per-user OpenCode credentials (Zen API key via the
//     `opencode` credential store) and rejects up-front when missing.
//   - Calls `OpenCodeProvider.startTurn(...)` / `sendTurnMessage(...)`
//     and consumes the `AsyncIterable<UnifiedMessage>` it returns.
//   - Stamps `claude_conversation_id` + `provider_session_id` on the
//     conversation row once the OpenCode session id is known
//     (resolved synchronously by `session.create`, so the synthetic
//     user message already carries it).
//   - Broadcasts `ai-response` (and a back-compat `claude-response`)
//     for every UnifiedMessage so the frontend renders OpenCode turns
//     through the same path as Claude/Codex.
//   - Drives `activeSessions`, the streaming lifecycle, and the
//     agent-run completion handler.
//
// Provider-neutral features supplied by Bottega:
//   - AskUserQuestion semantics through the durable `ask_user` MCP tool.
//   - Owner-domain tools through a per-turn loopback MCP gateway.
//
// What this branch does NOT do (capability flags from D8 + R1):
//   - No image attachments (v1).
//   - No thinking-delta accumulator (ReasoningPart is emitted whole).
//   - No live `getContextUsage()` breakdown.
//
// Review agents DO get the operator's MCP servers (Playwright included) and a
// `videoConfig`: `loadOperatorMcpServers` translates `~/.claude.json` into
// OpenCode's `mcp.add` shape on every turn, so the old "degraded review" R1
// carve-out no longer applies.

import { promises as fs } from 'fs';
import { conversationsDb } from '../../database/conversations.js';
import { resolveResumeModelEffort } from '../agentModelSettings.js';
import { generateConversationTitle } from '../titleGenerator.js';
import { createContextUsageTracker } from '../contextUsageTracker.js';
import { getCredentialStore } from '../credentials/registry.js';
import { openCodeProvider } from '../providers/opencode/index.js';
import { mirrorOpenCodeEvent } from '../providers/opencode/messageMirror.js';
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
import type { UnifiedMessage } from '@shared/providers/types';

function composeOnComplete(ctx: StreamingContext): () => Promise<void> {
  return composeAsync<void>(
    buildAgentRunCompletionHandler(ctx),
    () => handleStreamingComplete(ctx),
  );
}

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
        parent_tool_use_id: unified.isSubAgent ? '__opencode_subagent__' : null,
        message: {
          id: unified.id,
          model: unified.model ? `opencode/${unified.model.replace(/^opencode\//, '')}` : null,
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
      return {
        type: 'system',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        subtype: unified.subtype ?? 'opencode',
      };
    case 'stream_delta':
      return null;
    case 'assistant_image':
      return null; // Only Codex reports generated images today.
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
    provider: 'opencode',
  });
  broadcastFn(conversationId, {
    type: 'claude-response',
    data: wire as never,
  });
}

/**
 * Resume an existing OpenCode conversation. Mirrors `sendMessage` for
 * the Anthropic path: looks the conversation up, builds the per-user
 * env, and calls `openCodeProvider.sendTurnMessage(resumeSessionId)`.
 */
export async function sendOpenCodeMessage(
  conversationId: number,
  message: string | null,
  options: ConversationOptions = {},
): Promise<void> {
  const normalizedOptions = validateAndNormalizeOptions(options, 'sendOpenCodeMessage');
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
      `OpenCode conversation ${conversationId} has no provider_session_id yet`,
    );
  }

  const scope = await resolveProviderResumeScope(conversation);
  const { taskId, epicId, projectId } = scope;
  const projectPath = conversation.session_path ?? scope.cwd;

  const openCodeEnv = getCredentialStore('opencode').buildSdkEnv(userId);
  const promptText = message ?? '';

  // Resume on an explicit model — re-resolved from the RESUMING user's per-user
  // agent settings (same provider only), falling back to the stamped row value.
  // OpenCode has no effort. Explicit options only win for internal callers.
  const userOverride = resolveResumeModelEffort(conversation, userId);
  const model = normalizedOptions.model ?? userOverride.model;
  if (!model) {
    throw new Error(`Conversation ${conversationId} has no stored model to resume with`);
  }
  if (model !== conversation.model) {
    conversationsDb.updateModelEffort(conversationId, model, conversation.effort);
  }

  const abortController = new AbortController();
  const mcpGateway = await startOwnerMcpGateway(scope, conversationId, normalizedOptions);
  // The operator's own MCP servers (Playwright above all) — the Claude path
  // gets these through `sdkOptions.mcpServers`; OpenCode gets them here.
  const operatorMcpServers = await loadOperatorMcpServers(projectPath, videoConfig);
  const disallowedTools = [
    ...new Set([
      ...(normalizedOptions.disallowedTools ?? []),
      ...ownerDisallowedTools(scope, conversationId),
    ]),
  ];
  let run;
  try {
    run = await openCodeProvider.sendTurnMessage({
      cwd: projectPath,
      prompt: promptText,
      resumeSessionId,
      model,
      effort: null,
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      env: openCodeEnv,
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

  try {
    for await (const unified of run.events) {
      broadcastUnified(broadcastFn, conversationId, unified);
      await mirrorOpenCodeEvent(
        { projectFolderPath: projectPath, providerSessionId: resumeSessionId },
        unified,
      ).catch((err) => {
        console.warn('[ConversationAdapter] OpenCode resume mirror failed:', err);
      });
      if (unified.type === 'result') {
        if (unified.isError && !isQuestionDeferred(conversationId)) {
          failLinkedAgentRunIfRunning(conversationId);
        }
        await contextUsageTracker.onResult({
          type: 'result',
          ...(unified.usage ? { modelUsage: { opencode: unified.usage } } : {}),
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
    console.error('[ConversationAdapter] OpenCode resume error:', error);
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

export async function startOpenCodeConversation(
  targetOrTaskId: ConversationTarget | number,
  message: string,
  options: ConversationOptions = {},
): Promise<{ conversationId: number; claudeSessionId: string }> {
  const { target, scope } = await resolveProviderStartScope(targetOrTaskId);
  const normalizedOptions = validateAndNormalizeOptions(options, 'startOpenCodeConversation');
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

  // OpenCode turns always run on an explicit `opencode/<id>` model. OpenCode
  // has no effort dimension (D6), so effort is always null.
  const model = normalizedOptions.model;
  if (!model) {
    throw new Error('startOpenCodeConversation requires an explicit model');
  }

  const { taskId, epicId, projectId } = scope;
  const projectPath = scope.cwd;

  // Per-user OpenCode env (Zen API key). Throws if the user has no
  // provisioned auth.json, matching Claude/Codex fail-closed posture.
  const openCodeEnv = getCredentialStore('opencode').buildSdkEnv(userId);

  let conversationId = options.conversationId;
  if (!conversationId) {
    const conversation = target.kind === 'epic'
      ? conversationsDb.createForEpic(target.epicId, 'opencode', model, null)
      : conversationsDb.create(target.taskId, 'opencode', model, null);
    conversationId = conversation.id;
    console.log(
      `[ConversationAdapter] Created OpenCode conversation ${conversationId} for ${target.kind} ${taskId ?? epicId} (model=${model})`,
    );
  }

  const imageResult = images && images.length > 0
    ? await handleImages(message, images, projectPath)
    : { modifiedCommand: message, tempImagePaths: [] as string[], tempDir: null };
  // OpenCode v1 is text-only — images are silently stripped (the chat
  // UI disables upload for OpenCode providers in Phase 11).
  const finalMessageRaw = imageResult.modifiedCommand;
  const finalMessage = await resolveSlashCommand(finalMessageRaw, projectPath);
  const promptText = (finalMessage ?? message) +
    (customSystemPrompt ? `\n\n[System]\n${customSystemPrompt}` : '');

  const abortController = new AbortController();
  const mcpGateway = await startOwnerMcpGateway(scope, conversationId, normalizedOptions);
  // The operator's own MCP servers (Playwright above all) — the Claude path
  // gets these through `sdkOptions.mcpServers`; OpenCode gets them here.
  const operatorMcpServers = await loadOperatorMcpServers(projectPath, videoConfig);
  let run;
  try {
    run = await openCodeProvider.startTurn({
      cwd: projectPath,
      prompt: promptText,
      model,
      effort: null,
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      env: openCodeEnv,
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
      if (!resolved) reject(new Error('OpenCode session creation timeout'));
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

    const contextUsageTracker = createContextUsageTracker({
      conversationId: conversationId,
      broadcastFn,
    });

    // OpenCode resolves the session id synchronously inside startTurn
    // (session.create returns it before any SSE event lands), so the
    // first emitted UnifiedMessage already carries `providerSessionId`.
    // The pre-session buffer is kept as a defensive no-op in case the
    // provider ever changes that contract.
    const preSessionBuffer: UnifiedMessage[] = [];

    void (async () => {
      try {
        for await (const unified of run.events) {
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

          broadcastUnified(broadcastFn, conversationId, unified);

          if (ctx.claudeSessionId) {
            if (preSessionBuffer.length > 0) {
              const sid = ctx.claudeSessionId;
              for (const buffered of preSessionBuffer) {
                const patched = { ...buffered, providerSessionId: sid };
                await mirrorOpenCodeEvent(
                  { projectFolderPath: projectPath, providerSessionId: sid },
                  patched,
                ).catch((err) => {
                  console.warn('[ConversationAdapter] OpenCode mirror failed (buffered):', err);
                });
              }
              preSessionBuffer.length = 0;
            }
            await mirrorOpenCodeEvent(
              {
                projectFolderPath: projectPath,
                providerSessionId: ctx.claudeSessionId,
              },
              unified,
            ).catch((err) => {
              console.warn('[ConversationAdapter] OpenCode mirror failed:', err);
            });
          } else {
            preSessionBuffer.push(unified);
          }

          if (unified.type === 'result') {
            if (unified.isError && !isQuestionDeferred(conversationId)) {
              failLinkedAgentRunIfRunning(conversationId);
            }
            await contextUsageTracker.onResult({
              type: 'result',
              ...(unified.usage ? { modelUsage: { opencode: unified.usage } } : {}),
            } as never);
          }
        }

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
        console.error('[ConversationAdapter] OpenCode streaming error:', error);
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
