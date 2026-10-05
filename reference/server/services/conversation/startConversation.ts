// Public conversation orchestrators: `startConversation` (new task conversation)
// and `sendMessage` (resume an existing conversation). Both share the unified
// streaming loop in `runStreamingLoop.ts` and compose lifecycle hooks via
// `composeAsync`.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadEnabledPlugins } from './pluginConfig.js';
import { promises as fs } from 'fs';
import { conversationsDb } from '../../database/conversations.js';
import { getOwnerAdapter } from './ownerAdapters.js';
import {
  resolveConversationScope,
  targetFromConversation,
  type ConversationTarget,
} from './conversationScope.js';
import { resolveResumeModelEffort } from '../agentModelSettings.js';
import { generateConversationTitle } from '../titleGenerator.js';
import { auditClaudeLaunch, buildClaudeSdkEnv, getQueryProcessPid } from '../claudeCredentials.js';
import { createContextUsageTracker } from '../contextUsageTracker.js';
import { resolveSlashCommand } from './slashCommands.js';
import { handleVideoRecording, handleImages, cleanupTempFiles } from './media.js';
import { ThinkingAccumulator, patchThinking } from './thinkingPatcher.js';
import {
  validateAndNormalizeOptions,
  mapOptionsToSDK,
  loadMcpConfig,
} from './sdkOptions.js';
import { injectVideoRecording, waitForMcpServers } from './mcpReadiness.js';
import { activeSessions } from './sessionState.js';
import { buildCanUseTool, rejectPendingAskUserQuestion } from './askUserQuestion.js';
import {
  handleStreamingStarted,
  handleStreamingComplete,
  composeAsync,
} from './streamingLifecycle.js';
import {
  assertAgentRunTurnCanStart,
  buildAgentRunCompletionHandler,
  handleAgentRunTurnStarted,
} from './agentRunLifecycle.js';
import { runStreamingLoop } from './runStreamingLoop.js';
import { isClaudeAuthError, delay, AUTH_RETRY_BACKOFF_MS } from './retryOn401.js';
import { startCodexConversation, sendCodexMessage } from './startCodexConversation.js';
import {
  startOpenCodeConversation,
  sendOpenCodeMessage,
} from './startOpenCodeConversation.js';
import type { ConversationOptions, StreamingContext } from './types.js';
import { buildInteractionMcpServer } from './interactionMcpServer.js';
import { consumeQuestionDeferred } from './portableQuestionTool.js';

/**
 * Compose the streaming-complete handlers: persist owner-domain completion,
 * then release the conversation-busy guard and broadcast streaming-ended.
 * This ordering prevents a message sent immediately after Stop from reopening
 * a blocked epic run before the aborted turn has observed that block.
 *
 * Neither handler takes an isError argument. User interruption, technical
 * failure and restart recovery are persisted through their owner-specific
 * paths, not derived from a boolean threaded through the streaming loop.
 */
function composeOnComplete(ctx: StreamingContext): () => Promise<void> {
  return composeAsync<void>(
    buildAgentRunCompletionHandler(ctx),
    () => handleStreamingComplete(ctx),
  );
}

/**
 * Start a new conversation for a task or for an epic.
 *
 * The target decides the owner row, the working directory and which channel
 * carries the lifecycle events; everything after that (streaming, transcripts,
 * agent-run completion) is conversation-keyed and identical for both.
 */
export async function startConversation(
  target: ConversationTarget,
  message: string,
  options: ConversationOptions = {},
): Promise<{ conversationId: number; claudeSessionId: string }> {
  // Provider dispatch. The Anthropic path is the original body of this
  // function — preserved verbatim below. The 'openai' path lives in
  // `startCodexConversation.ts` and only re-uses provider-agnostic
  // pieces (streaming lifecycle, agent-run completion handler).
  //
  // The owner domain may still impose a provider restriction for a future
  // domain, but task and epic conversations are both harness-agnostic.
  if (options.provider === 'openai' || options.provider === 'opencode') {
    getOwnerAdapter(target.kind).assertProviderAllowed(options.provider);
    return options.provider === 'openai'
      ? startCodexConversation(target, message, options)
      : startOpenCodeConversation(target, message, options);
  }

  const normalizedOptions = validateAndNormalizeOptions(options, 'startConversation');
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

  // Every conversation runs on an explicit model — resolved from the chosen
  // settings by the caller (route / agentRunner). No SDK default, ever.
  const model = normalizedOptions.model;
  const effort = normalizedOptions.effort ?? null;
  if (!model) {
    throw new Error('startConversation requires an explicit model');
  }

  // Owner (task worktree/repo, or the epic's main checkout), project and cwd.
  const scope = await resolveConversationScope(target);
  const { taskId, epicId } = scope;
  const projectPath = scope.cwd;

  const claudeEnv = buildClaudeSdkEnv(userId);

  let conversationId = options.conversationId;
  if (!conversationId) {
    // This is the Anthropic branch (the dispatch at the top routed
    // openai/opencode away), so the row is stamped 'anthropic' with the
    // explicit model+effort the turn will run on.
    const conversation =
      target.kind === 'epic'
        ? conversationsDb.createForEpic(target.epicId, 'anthropic', model, effort)
        : conversationsDb.create(target.taskId, 'anthropic', model, effort);
    conversationId = conversation.id;
    console.log(
      `[ConversationAdapter] Created conversation ${conversationId} for ${target.kind} ${
        taskId ?? epicId
      } (provider=anthropic, model=${model})`,
    );
  }

  const abortController = new AbortController();

  // The owner domain's per-turn containment (e.g. the epic docs write gate,
  // derived from the conversation's rows — the agent run is linked before
  // this call — so the resume path below applies the identical hooks).
  const ownerAdapter = getOwnerAdapter(scope.kind);
  const ownerHooks = ownerAdapter.extraPreToolUseHooks(conversationId);

  const sdkOptions = mapOptionsToSDK({
    cwd: projectPath,
    permissionMode,
    customSystemPrompt,
    model,
    effort,
    disallowedTools: normalizedOptions.disallowedTools,
    env: claudeEnv,
    canUseTool: buildCanUseTool({ conversationId, broadcastFn }),
    ...(ownerHooks.length > 0 ? { extraPreToolUseHooks: ownerHooks } : {}),
  });

  let mcpServers = await loadMcpConfig(projectPath);
  if (mcpServers && videoConfig) {
    mcpServers = (injectVideoRecording(mcpServers as never, videoConfig) ?? null);
  }
  // The owner domain merges its in-process MCP servers (atlas for tasks,
  // bottega for epics).
  mcpServers = ownerAdapter.augmentMcpServers(mcpServers, {
    conversationId,
    ownerId: (taskId ?? epicId)!,
    userId,
    broadcastFn,
    broadcastToTaskSubscribersFn,
    broadcastToEpicSubscribersFn,
  });
  if (!ownerAdapter.extraDisallowedTools(conversationId).includes('AskUserQuestion')) {
    mcpServers = {
      ...(mcpServers ?? {}),
      bottega_interaction: buildInteractionMcpServer(conversationId, broadcastFn),
    };
  }
  if (mcpServers) {
    sdkOptions.mcpServers = mcpServers;
  }

  // The operator's plugins (the Figma MCP) are named explicitly on every turn.
  // A fresh turn would find them through `settingSources` anyway; the resume
  // path below would not — see `pluginConfig.ts`.
  const plugins = await loadEnabledPlugins();
  if (plugins.length > 0) {
    sdkOptions.plugins = plugins;
  }

  const imageResult = await handleImages(message, images, projectPath);
  let finalMessage: string | null = imageResult.modifiedCommand;
  const { tempImagePaths, tempDir } = imageResult;

  finalMessage = await resolveSlashCommand(finalMessage, projectPath);

  // Deferred prompt: start the CLI subprocess first so MCP servers begin
  // connecting, wait for them to be ready, then deliver the user message.
  // Ensures Claude's first turn has all MCP tools available.
  let releaseFn: () => void = () => {};
  const mcpReady = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  async function* deferredPrompt() {
    await mcpReady;
    yield {
      type: 'user',
      message: { role: 'user', content: finalMessage },
      parent_tool_use_id: null,
    };
  }

  const queryInstance = query({
    prompt: deferredPrompt() as never,
    options: { ...sdkOptions, abortController } as never,
  });
  auditClaudeLaunch({
    source: 'startConversation',
    userId,
    pid: getQueryProcessPid(queryInstance),
    conversationId,
    claudeSessionId: null,
    cwd: projectPath,
  });

  // Always release, even on timeout.
  void waitForMcpServers(queryInstance).finally(() => releaseFn());

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Session creation timeout'));
    }, 60000);

    const thinkingAcc = new ThinkingAccumulator();
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

    const onSessionId = async (sid: string) => {
      ctx.claudeSessionId = sid;
      clearTimeout(timeout);

      activeSessions.set(sid, {
        instance: queryInstance,
        abortController,
        startTime: Date.now(),
        status: 'active',
        tempImagePaths,
        tempDir,
        conversationId,
        taskId,
        epicId,
        projectId: scope.projectId,
        userId: userId ?? null,
      });

      conversationsDb.updateClaudeId(conversationId, sid);
      // Provider-agnostic session id: for Anthropic conversations this just
      // duplicates claude_conversation_id. Codex conversations (Phase 9)
      // write only this column.
      conversationsDb.updateProviderSessionId(conversationId, sid);
      // session_path stores the cwd we passed to the SDK so the read path can
      // recover the canonical projectKey (worktree paths and repo paths produce
      // different projectKeys; without this we'd miss sessions started inside
      // worktrees).
      conversationsDb.updateSessionPath(conversationId, projectPath);
      console.log(`[ConversationAdapter] Updated conversation ${conversationId} with session ${sid}`);

      // Fire-and-forget AI title generation. Dual-emits the rename on the
      // conversation channel (chat header) and task channel (task viewer's
      // conversation list).
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
      }

      // `conversation-added` goes to the owning entity's channel: the task
      // viewer's conversation list, or the epic page's.
      const summary = {
        id: conversationId,
        task_id: taskId,
        epic_id: epicId,
        claude_conversation_id: sid,
        created_at: new Date().toISOString(),
      };
      if (broadcastToTaskSubscribersFn && taskId != null) {
        broadcastToTaskSubscribersFn(taskId, {
          type: 'conversation-added',
          conversation: summary,
        });
      }
      if (broadcastToEpicSubscribersFn && epicId != null) {
        broadcastToEpicSubscribersFn(epicId, {
          type: 'conversation-added',
          conversation: summary,
        });
      }

      resolve({ conversationId: conversationId, claudeSessionId: sid });
    };

    void (async () => {
      try {
        const { authError } = await runStreamingLoop({
          queryInstance: queryInstance as never,
          conversationId: conversationId,
          broadcastFn,
          thinkingAcc,
          contextUsageTracker,
          initialSessionId: null,
          onSessionId,
          broadcastClaudeStatus: true,
          // Force the SDK subprocess to exit after `result`; otherwise a
          // background bash the agent left running (intentional or
          // `assistantAutoBackgrounded`) keeps the iterator open and this
          // loop never returns. runStreamingLoop swallows the resulting
          // abort error so we still reach the success path below.
          onResult: () => abortController.abort(),
        });

        // In-band 401: the SDK delivered the auth failure as data instead
        // of throwing. Synthesise the equivalent throw so the existing
        // catch-block recovery path (subprocess recycle + transparent
        // retry) runs uniformly for both representations.
        if (authError) {
          throw new Error(
            'Claude Code returned an error result: Failed to authenticate. API Error: 401 Invalid authentication credentials',
          );
        }

        if (ctx.claudeSessionId) {
          activeSessions.delete(ctx.claudeSessionId);
        }

        await cleanupTempFiles(tempImagePaths, tempDir);
        if (consumeQuestionDeferred(conversationId)) {
          await handleStreamingComplete(ctx);
          return;
        }
        await patchThinking(ctx.claudeSessionId, projectPath, userId, thinkingAcc);

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
        console.error('[ConversationAdapter] Streaming error:', error);

        if (ctx.claudeSessionId) {
          activeSessions.delete(ctx.claudeSessionId);
        }
        await cleanupTempFiles(tempImagePaths, tempDir);

        if (consumeQuestionDeferred(conversationId)) {
          await handleStreamingComplete(ctx);
          return;
        }

        if (ctx.videoConfig?.tempDir) {
          await fs.rm(ctx.videoConfig.tempDir, { recursive: true, force: true }).catch(() => {});
        }

        if (!ctx.claudeSessionId) {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        // Subprocess auth credential aged out mid-stream: the on-disk token is
        // still good, so kill this dead subprocess and resume the conversation
        // once in a fresh one. Don't broadcast claude-error — keep it transparent.
        if (isClaudeAuthError(error) && !normalizedOptions.isAuthRetry) {
          console.warn(
            `[ConversationAdapter] Auth 401 on conversation ${conversationId} — recycling subprocess and resuming (1 retry)`,
          );
          await delay(AUTH_RETRY_BACKOFF_MS);
          try {
            await sendMessage(conversationId, message, { ...options, isAuthRetry: true });
          } catch {
            // sendMessage already broadcast claude-error + ran composeOnComplete().
          }
          return;
        }

        if (broadcastFn) {
          const errMsg = error instanceof Error ? error.message : String(error);
          broadcastFn(conversationId, {
            type: 'claude-error',
            error: errMsg,
          });
        }

        // Run the same completion handler the success path does. A user Stop
        // has already persisted the owner-specific terminal/interrupted state;
        // a technical SDK error leaves the row running so the established
        // recovery/chaining behavior can pick it up.
        await composeOnComplete(ctx)();
      } finally {
        rejectPendingAskUserQuestion(conversationId, 'streaming ended');
      }
    })();
  });
}

/**
 * Send a message to an existing conversation (resume).
 */
export async function sendMessage(
  conversationId: number,
  message: string | null,
  options: ConversationOptions = {},
): Promise<void> {
  // Provider dispatch on resume. Resolve the provider off the existing
  // conversation row rather than trusting options — a resume hits the
  // same backend that created the session. Explicit options.provider
  // (passed by agentRunner) is the override.
  const conversationForProvider = conversationsDb.getById(conversationId);
  if (!conversationForProvider) {
    throw new Error(`Conversation ${conversationId} not found`);
  }
  // Owner policy is checked before provider setup. In particular, reopening
  // an old PR-review conversation cannot overlap the epic's current reviewer.
  assertAgentRunTurnCanStart(conversationId);
  // The row's provider is the source of truth on resume (NOT NULL column);
  // an explicit options.provider override only matters for internal callers.
  const resolvedProvider = options.provider ?? conversationForProvider.provider;
  if (resolvedProvider === 'openai') {
    return sendCodexMessage(conversationId, message, options);
  }
  if (resolvedProvider === 'opencode') {
    return sendOpenCodeMessage(conversationId, message, options);
  }

  const normalizedOptions = validateAndNormalizeOptions(options, 'sendMessage');
  const {
    broadcastFn,
    broadcastToTaskSubscribersFn,
    broadcastToEpicSubscribersFn,
    userId,
    images,
    permissionMode,
    askUserQuestionToolResult,
  } = normalizedOptions;

  const conversation = conversationsDb.getById(conversationId);
  if (!conversation) {
    throw new Error(`Conversation ${conversationId} not found`);
  }

  // Resume runs on an explicit model+effort — never the SDK's silent default.
  // Re-resolve from the RESUMING user's per-user agent settings (same provider
  // only; provider is session-bound), falling back to the row's stamped value.
  // Explicit options on the call still win (internal callers only).
  const userOverride = resolveResumeModelEffort(conversation, userId);
  const resumeModel = normalizedOptions.model ?? userOverride.model;
  const resumeEffort = normalizedOptions.effort ?? userOverride.effort;
  if (!resumeModel) {
    throw new Error(`Conversation ${conversationId} has no stored model to resume with`);
  }
  // Keep the row authoritative for later turns when this turn's resolved
  // model/effort differs from what was stamped.
  if (resumeModel !== conversation.model || resumeEffort !== conversation.effort) {
    conversationsDb.updateModelEffort(conversationId, resumeModel, resumeEffort);
  }

  if (!conversation.claude_conversation_id) {
    throw new Error(`Conversation ${conversationId} has no Claude session ID yet`);
  }

  const claudeSessionId = conversation.claude_conversation_id;

  // Always resolve the owner (task or epic) so we can stamp `projectId` onto
  // the ActiveSession entry — WS auth (`abort-session`,
  // `check-session-status`, `get-active-sessions`) and the filtered
  // `/api/streaming-sessions` REST endpoint depend on it.
  const scope = await resolveConversationScope(targetFromConversation(conversation));
  const { taskId, epicId, projectId } = scope;

  // Prefer the stored session_path so worktree-started sessions resume in the
  // same cwd.
  const projectPath = conversation.session_path ?? scope.cwd;

  const abortController = new AbortController();
  const claudeEnv = buildClaudeSdkEnv(userId);

  // Same rows, same hooks as the run's first turn — a revision request typed
  // into a specification conversation is contained exactly like the run that
  // opened it. The owner's tool denials are merged with (never replaced by)
  // the caller's own list, so they cannot be weakened on a wake or revision
  // turn.
  const ownerAdapter = getOwnerAdapter(scope.kind);
  const ownerHooks = ownerAdapter.extraPreToolUseHooks(conversationId);
  const resumeDisallowedTools = [
    ...new Set([
      ...(normalizedOptions.disallowedTools ?? []),
      ...ownerAdapter.extraDisallowedTools(conversationId),
    ]),
  ];

  // Resume reads transcripts from sqliteSessionStore.load(). The SDK then
  // materializes them into a temporary CLAUDE_CONFIG_DIR of its own
  // (`/tmp/claude-resume-<uuid>/`) for the subprocess — which is why the
  // operator's plugins have to be named explicitly below (`pluginConfig.ts`).
  const sdkOptions = mapOptionsToSDK({
    cwd: projectPath,
    sessionId: claudeSessionId,
    permissionMode,
    env: claudeEnv,
    canUseTool: buildCanUseTool({ conversationId, broadcastFn }),
    model: resumeModel,
    effort: resumeEffort,
    ...(resumeDisallowedTools.length > 0 ? { disallowedTools: resumeDisallowedTools } : {}),
    ...(ownerHooks.length > 0 ? { extraPreToolUseHooks: ownerHooks } : {}),
  });

  let mcpServers = await loadMcpConfig(projectPath);
  mcpServers = ownerAdapter.augmentMcpServers(mcpServers, {
    conversationId,
    ownerId: (taskId ?? epicId)!,
    userId,
    broadcastFn,
    broadcastToTaskSubscribersFn,
    broadcastToEpicSubscribersFn,
  });
  if (!ownerAdapter.extraDisallowedTools(conversationId).includes('AskUserQuestion')) {
    mcpServers = {
      ...(mcpServers ?? {}),
      bottega_interaction: buildInteractionMcpServer(conversationId, broadcastFn),
    };
  }
  if (mcpServers) {
    sdkOptions.mcpServers = mcpServers;
  }

  // Without this a resumed turn has no plugin MCP server at all: the SDK's
  // temporary config dir carries no `plugins/`, so the Figma tools the first
  // turn had are removed from the catalog on the second.
  const plugins = await loadEnabledPlugins();
  if (plugins.length > 0) {
    sdkOptions.plugins = plugins;
  }

  // Skip image handling when sending a synthesised tool_result for an orphan
  // AskUserQuestion — there's no user text to attach images to.
  const imageResult = askUserQuestionToolResult
    ? { modifiedCommand: null as string | null, tempImagePaths: [], tempDir: null }
    : await handleImages(message, images, projectPath);
  let finalMessage: string | null = imageResult.modifiedCommand;
  const { tempImagePaths, tempDir } = imageResult;

  if (!askUserQuestionToolResult) {
    finalMessage = await resolveSlashCommand(finalMessage, projectPath);
  }

  const ctx: StreamingContext = {
    conversationId,
    taskId,
    epicId,
    claudeSessionId,
    userId,
    broadcastFn,
    broadcastToTaskSubscribersFn,
    broadcastToEpicSubscribersFn,
    isNewSession: false,
  };

  // Deferred prompt: wait for MCP servers before delivering the user message.
  // When askUserQuestionToolResult is set, yield a tool_result block instead
  // of plain text — Anthropic's API requires this whenever the previous
  // assistant turn ended with a tool_use that had no matching tool_result.
  let releaseFn: () => void = () => {};
  const mcpReady = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  async function* deferredPrompt() {
    await mcpReady;
    if (askUserQuestionToolResult) {
      yield {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: askUserQuestionToolResult.tool_use_id,
              content: askUserQuestionToolResult.content,
            },
          ],
        },
        parent_tool_use_id: null,
      };
      return;
    }
    yield {
      type: 'user',
      message: { role: 'user', content: finalMessage },
      parent_tool_use_id: null,
    };
  }

  const queryInstance = query({
    prompt: deferredPrompt() as never,
    options: { ...sdkOptions, abortController } as never,
  });
  auditClaudeLaunch({
    source: 'sendMessage',
    userId,
    pid: getQueryProcessPid(queryInstance),
    conversationId,
    claudeSessionId,
    cwd: projectPath,
  });

  void waitForMcpServers(queryInstance).finally(() => releaseFn());

  activeSessions.set(claudeSessionId, {
    instance: queryInstance,
    abortController,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths,
    tempDir,
    conversationId,
    taskId,
    epicId,
    projectId,
    userId: userId ?? null,
  });

  try {
    await handleAgentRunTurnStarted(ctx);
  } catch (error) {
    // A final owner-domain concurrency check can still lose its preflight
    // race to another conversation. No stream has been announced yet: abort
    // this just-created provider turn and leave the winning run untouched.
    abortController.abort();
    activeSessions.delete(claudeSessionId);
    await cleanupTempFiles(tempImagePaths, tempDir);
    throw error;
  }
  handleStreamingStarted(ctx);

  const thinkingAcc = new ThinkingAccumulator();
  const contextUsageTracker = createContextUsageTracker({ conversationId, broadcastFn });

  try {
    const { authError } = await runStreamingLoop({
      queryInstance: queryInstance as never,
      conversationId,
      broadcastFn,
      thinkingAcc,
      contextUsageTracker,
      initialSessionId: claudeSessionId,
      broadcastClaudeStatus: false,
      // See the matching comment in startConversation: abort the SDK
      // subprocess after `result` so a leftover background bash can't pin
      // the iterator open. runStreamingLoop swallows the abort error.
      onResult: () => abortController.abort(),
    });

    // In-band 401: see matching comment in startConversation.
    if (authError) {
      throw new Error(
        'Claude Code returned an error result: Failed to authenticate. API Error: 401 Invalid authentication credentials',
      );
    }

    activeSessions.delete(claudeSessionId);
    await cleanupTempFiles(tempImagePaths, tempDir);
    if (consumeQuestionDeferred(conversationId)) {
      await handleStreamingComplete(ctx);
      return;
    }
    await patchThinking(claudeSessionId, projectPath, userId, thinkingAcc);

    if (broadcastFn) {
      broadcastFn(conversationId, {
        type: 'claude-complete',
        sessionId: claudeSessionId,
        exitCode: 0,
        isNewSession: false,
      });
    }

    await composeOnComplete(ctx)();
  } catch (error) {
    console.error('[ConversationAdapter] Resume streaming error:', error);

    activeSessions.delete(claudeSessionId);
    await cleanupTempFiles(tempImagePaths, tempDir);

    if (consumeQuestionDeferred(conversationId)) {
      await handleStreamingComplete(ctx);
      return;
    }

    // Subprocess auth credential aged out mid-stream: recycle it and resume
    // once in a fresh subprocess. Skip for AskUserQuestion-resume turns —
    // re-driving a synthesised tool_result is fiddly and the case is rare.
    if (isClaudeAuthError(error) && !normalizedOptions.isAuthRetry && !askUserQuestionToolResult) {
      console.warn(
        `[ConversationAdapter] Auth 401 on conversation ${conversationId} — recycling subprocess and resuming (1 retry)`,
      );
      await delay(AUTH_RETRY_BACKOFF_MS);
      return await sendMessage(conversationId, message, { ...options, isAuthRetry: true });
    }

    if (broadcastFn) {
      const errMsg = error instanceof Error ? error.message : String(error);
      broadcastFn(conversationId, {
        type: 'claude-error',
        error: errMsg,
      });
    }

    // Let the completion handler decide whether to chain (based on the
    // agent_run row's status: 'failed' → no-op, 'running' → mark
    // 'completed' and chain).
    await composeOnComplete(ctx)();

    throw error;
  } finally {
    rejectPendingAskUserQuestion(conversationId, 'streaming ended');
  }
}
