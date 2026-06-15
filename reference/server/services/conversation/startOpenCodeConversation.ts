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
// What this branch does NOT do (capability flags from D8 + R1):
//   - No AskUserQuestion / canUseTool (OpenCode has no canUseTool).
//   - No MCP wait (OpenCode's MCP isn't wired through Bottega in v1).
//   - No image attachments (v1).
//   - No thinking-delta accumulator (ReasoningPart is emitted whole).
//   - No live `getContextUsage()` breakdown.
//   - Review agents are allowed (R1) but `videoConfig` is dropped for
//     them — Playwright capture isn't wired through OpenCode's worktree
//     reflection.

import { promises as fs } from 'fs';
import { agentRunsDb, conversationsDb, tasksDb } from '../../database/db.js';
import { resolveResumeModelEffort } from '../agentModelSettings.js';
import { getWorktreeProjectPath, worktreeExists } from '../worktree.js';
import { generateConversationTitle } from '../titleGenerator.js';
import { createContextUsageTracker } from '../contextUsageTracker.js';
import { getCredentialStore } from '../credentials/registry.js';
import {
  openCodeProvider,
  openCodeGoProvider,
  parseOpenCodeModel,
  type OpenCodeProviderName,
} from '../providers/opencode/index.js';
import { mirrorOpenCodeEvent } from '../providers/opencode/messageMirror.js';
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

function unifiedToWireMessage(unified: UnifiedMessage): Record<string, unknown> | null {
  switch (unified.type) {
    case 'user':
      return {
        type: 'user',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        message: { role: 'user', content: unified.content },
      };
    case 'assistant': {
      // Model may already be prefixed with `opencode/` or `opencode-go/`
      let canonicalModel = null;
      if (unified.model) {
        if (unified.model.startsWith('opencode/') || unified.model.startsWith('opencode-go/')) {
          canonicalModel = unified.model;
        } else {
          // Bare model — shouldn't happen, but default to opencode prefix for safety
          canonicalModel = `opencode/${unified.model}`;
        }
      }
      return {
        type: 'assistant',
        uuid: unified.id,
        session_id: unified.providerSessionId,
        parent_tool_use_id: unified.isSubAgent ? '__opencode_subagent__' : null,
        message: {
          id: unified.id,
          model: canonicalModel,
          ...(unified.usage ? { usage: unified.usage } : {}),
          content: [{ type: 'text', text: unified.text }],
        },
      };
    }
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
 * Pre-mark a still-running agent run as 'failed' the instant we see a
 * `result` event with `isError: true`. Without this the streaming loop
 * ends normally (no thrown exception — OpenCode reports model errors as
 * SSE events, not HTTP errors), composeOnComplete sees status='running'
 * → marks 'completed' → auto-chains → next agent fails the same way →
 * runaway loop until MAX_WORKFLOW_RUNS=25 trips. Setting the status
 * here makes composeOnComplete's "status === 'failed' → no-op" branch
 * fire instead. Safe to call when there is no taskId or no linked
 * agent run (no-op).
 */
function failLinkedAgentRunIfRunning(
  taskId: number | undefined,
  conversationId: number,
): void {
  if (!taskId) return;
  try {
    const runs = agentRunsDb.getByTask(taskId);
    const linked = runs.find((r) => r.conversation_id === conversationId);
    if (linked && linked.status === 'running') {
      agentRunsDb.updateStatus(linked.id, 'failed');
    }
  } catch (err) {
    // Best-effort: never throw out of an error-handling path.
    console.warn(
      '[ConversationAdapter] failed to pre-mark OpenCode agent run as failed:',
      err,
    );
  }
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
      `OpenCode conversation ${conversationId} has no provider_session_id yet`,
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

  // Extract provider name from model prefix
  const { providerID } = parseOpenCodeModel(model);
  const provider = providerID === 'opencode' ? openCodeProvider : openCodeGoProvider;
  
  const openCodeEnv = getCredentialStore(providerID).buildSdkEnv(userId);
  const promptText = message ?? '';

  const abortController = new AbortController();
  const run = await provider.sendTurnMessage({
    cwd: projectPath,
    prompt: promptText,
    resumeSessionId,
    model,
    effort: null,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    env: openCodeEnv,
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
      await mirrorOpenCodeEvent(
        { projectFolderPath: projectPath, providerSessionId: resumeSessionId },
        unified,
        providerID,
      ).catch((err) => {
        console.warn('[ConversationAdapter] OpenCode resume mirror failed:', err);
      });
      if (unified.type === 'result') {
        if (unified.isError) {
          failLinkedAgentRunIfRunning(taskId ?? undefined, conversationId);
        }
        await contextUsageTracker.onResult({
          type: 'result',
          ...(unified.usage ? { modelUsage: { [providerID]: unified.usage } } : {}),
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
    console.error('[ConversationAdapter] OpenCode resume error:', error);
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

export async function startOpenCodeConversation(
  taskId: number,
  message: string,
  options: ConversationOptions = {},
): Promise<{ conversationId: number; claudeSessionId: string }> {
  const normalizedOptions = validateAndNormalizeOptions(options, 'startOpenCodeConversation');
  const {
    broadcastFn,
    broadcastToTaskSubscribersFn,
    userId,
    permissionMode,
    images,
    customSystemPrompt,
    videoConfig,
  } = normalizedOptions;

  // OpenCode turns always run on an explicit `opencode/<id>` or `opencode-go/<id>` model.
  // OpenCode has no effort dimension (D6), so effort is always null.
  const model = normalizedOptions.model;
  if (!model) {
    throw new Error('startOpenCodeConversation requires an explicit model');
  }

  // Extract provider name from model prefix
  const { providerID } = parseOpenCodeModel(model);
  const provider = providerID === 'opencode' ? openCodeProvider : openCodeGoProvider;

  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task ${taskId} not found`);
  }

  let projectPath = taskWithProject.repo_folder_path;
  if (await worktreeExists(projectPath, taskId)) {
    projectPath = getWorktreeProjectPath(projectPath, taskId, taskWithProject.subproject_path);
  }

  // Per-user OpenCode env (Zen API key). Throws if the user has no
  // provisioned auth.json, matching Claude/Codex fail-closed posture.
  const openCodeEnv = getCredentialStore(providerID).buildSdkEnv(userId);

  let conversationId = options.conversationId;
  if (!conversationId) {
    const conversation = conversationsDb.create(taskId, providerID, model, null);
    conversationId = conversation.id;
    console.log(
      `[ConversationAdapter] Created OpenCode conversation ${conversationId} for task ${taskId} (provider=${providerID}, model=${model})`,
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

  const run = await provider.startTurn({
    cwd: projectPath,
    prompt: promptText,
    model,
    effort: null,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    env: openCodeEnv,
    abortController,
  });

  const { tempImagePaths, tempDir } = imageResult;

  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error('OpenCode session creation timeout'));
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

    const contextUsageTracker = createContextUsageTracker({
      conversationId: conversationId!,
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

          if (ctx.claudeSessionId) {
            if (preSessionBuffer.length > 0) {
              const sid = ctx.claudeSessionId;
              for (const buffered of preSessionBuffer) {
                const patched = { ...buffered, providerSessionId: sid };
                await mirrorOpenCodeEvent(
                  { projectFolderPath: projectPath, providerSessionId: sid },
                  patched,
                  providerID,
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
              providerID,
            ).catch((err) => {
              console.warn('[ConversationAdapter] OpenCode mirror failed:', err);
            });
          } else {
            preSessionBuffer.push(unified);
          }

          if (unified.type === 'result') {
            if (unified.isError) {
              failLinkedAgentRunIfRunning(taskId, conversationId!);
            }
            await contextUsageTracker.onResult({
              type: 'result',
              ...(unified.usage ? { modelUsage: { [providerID]: unified.usage } } : {}),
            } as never);
          }
        }

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
        console.error('[ConversationAdapter] OpenCode streaming error:', error);
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
