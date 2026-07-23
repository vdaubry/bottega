// Public conversation orchestrators: `startConversation` (new task conversation)
// and `sendMessage` (resume an existing conversation). Both share the unified
// streaming loop in `runStreamingLoop.ts` and compose lifecycle hooks via
// `composeAsync`.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { promises as fs } from 'fs';
import { conversationsDb, tasksDb } from '../../database/db.js';
import { resolveResumeModelEffort } from '../agentModelSettings.js';
import { getWorktreeProjectPath, worktreeExists } from '../worktree.js';
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
import { buildAgentRunCompletionHandler } from './agentRunLifecycle.js';
import { runStreamingLoop } from './runStreamingLoop.js';
import { isClaudeAuthError, delay, AUTH_RETRY_BACKOFF_MS } from './retryOn401.js';
import { startCodexConversation, sendCodexMessage } from './startCodexConversation.js';
import {
  startOpenCodeConversation,
  sendOpenCodeMessage,
} from './startOpenCodeConversation.js';
import type { ConversationOptions, StreamingContext } from './types.js';

/**
 * Compose the streaming-complete handlers: universal broadcast + map cleanup,
 * then agent-run-aware status update / chaining / push notification.
 *
 * Neither handler takes an isError argument anymore — failure is recorded
 * separately on the agent_run row by `abortSession` (user-Stop) or
 * the server-startup orphan recovery, not derived from a boolean threaded
 * through the streaming loop.
 */
function composeOnComplete(ctx: StreamingContext): () => Promise<void> {
  return composeAsync<void>(
    () => handleStreamingComplete(ctx),
    buildAgentRunCompletionHandler(ctx),
  );
}

/**
 * Start a new conversation for a task.
 */
export async function startConversation(
  taskId: number,
  message: string,
  options: ConversationOptions = {},
): Promise<{ conversationId: number; claudeSessionId: string }> {
  // Provider dispatch. The Anthropic path is the original body of this
  // function — preserved verbatim below. The 'openai' path lives in
  // `startCodexConversation.ts` and only re-uses provider-agnostic
  // pieces (streaming lifecycle, agent-run completion handler).
  if (options.provider === 'openai') {
    return startCodexConversation(taskId, message, options);
  }
  if (options.provider === 'opencode' || options.provider === 'opencode-go') {
    return startOpenCodeConversation(taskId, message, options);
  }

  const normalizedOptions = validateAndNormalizeOptions(options, 'startConversation');
  const {
    broadcastFn,
    broadcastToTaskSubscribersFn,
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

  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task ${taskId} not found`);
  }

  let projectPath = taskWithProject.repo_folder_path;

  // Use worktree path if one exists for this task.
  if (await worktreeExists(projectPath, taskId)) {
    projectPath = getWorktreeProjectPath(projectPath, taskId, taskWithProject.subproject_path);
  }

  const claudeEnv = buildClaudeSdkEnv(userId);

  let conversationId = options.conversationId;
  if (!conversationId) {
    // This is the Anthropic branch (the dispatch at the top routed
    // openai/opencode away), so the row is stamped 'anthropic' with the
    // explicit model+effort the turn will run on.
    const conversation = conversationsDb.create(taskId, 'anthropic', model, effort);
    conversationId = conversation.id;
    console.log(
      `[ConversationAdapter] Created conversation ${conversationId} for task ${taskId} (provider=anthropic, model=${model})`,
    );
  }

  const abortController = new AbortController();

  const sdkOptions = mapOptionsToSDK({
    cwd: projectPath,
    permissionMode,
    customSystemPrompt,
    model,
    effort,
    disallowedTools: normalizedOptions.disallowedTools,
    env: claudeEnv,
    canUseTool: buildCanUseTool({ conversationId, broadcastFn }),
  });

  let mcpServers = await loadMcpConfig(projectPath);
  if (mcpServers && videoConfig) {
    mcpServers = (injectVideoRecording(mcpServers as never, videoConfig) ?? null);
  }
  if (mcpServers) {
    sdkOptions.mcpServers = mcpServers;
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
      claudeSessionId: null,
      userId,
      broadcastFn,
      broadcastToTaskSubscribersFn,
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
        projectId: taskWithProject.project_id,
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
      generateConversationTitle(
        conversationId,
        message,
        broadcastFn,
        userId,
        taskId,
        broadcastToTaskSubscribersFn,
      );

      handleStreamingStarted(ctx);

      if (broadcastFn) {
        broadcastFn(conversationId, {
          type: 'conversation-created',
          conversationId: conversationId,
          claudeSessionId: sid,
        });
      }

      if (broadcastToTaskSubscribersFn) {
        broadcastToTaskSubscribersFn(taskId, {
          type: 'conversation-added',
          conversation: {
            id: conversationId,
            task_id: taskId,
            claude_conversation_id: sid,
            created_at: new Date().toISOString(),
          },
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

        // Run the same completion handler the success path does — the agent
        // run row was either already marked 'failed' by abortSession (no
        // chain) or is still 'running' and will be marked 'completed' here
        // (chain continues, next agent picks up the recovery).
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
  // The row's provider is the source of truth on resume (NOT NULL column);
  // an explicit options.provider override only matters for internal callers.
  const resolvedProvider = options.provider ?? conversationForProvider.provider;
  if (resolvedProvider === 'openai') {
    return sendCodexMessage(conversationId, message, options);
  }
  if (resolvedProvider === 'opencode' || resolvedProvider === 'opencode-go') {
    return sendOpenCodeMessage(conversationId, message, options);
  }

  const normalizedOptions = validateAndNormalizeOptions(options, 'sendMessage');
  const {
    broadcastFn,
    broadcastToTaskSubscribersFn,
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
  const taskId = conversation.task_id;

  // Always resolve the parent task so we can stamp `projectId` onto the
  // ActiveSession entry — WS auth (`abort-session`,
  // `check-session-status`, `get-active-sessions`) and the filtered
  // `/api/streaming-sessions` REST endpoint depend on it.
  if (!taskId) {
    throw new Error(`Conversation ${conversationId} has no task_id`);
  }
  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task ${taskId} not found`);
  }
  const projectId = taskWithProject.project_id;

  let projectPath: string;

  // Prefer the stored session_path so worktree-started sessions resume in the
  // same cwd.
  if (conversation.session_path) {
    projectPath = conversation.session_path;
  } else {
    projectPath = taskWithProject.repo_folder_path;

    if (await worktreeExists(projectPath, taskId)) {
      projectPath = getWorktreeProjectPath(projectPath, taskId, taskWithProject.subproject_path);
    }
  }

  const abortController = new AbortController();
  const claudeEnv = buildClaudeSdkEnv(userId);

  // Resume reads transcripts from sqliteSessionStore.load() — no per-user
  // CLAUDE_CONFIG_DIR materialization required.
  const sdkOptions = mapOptionsToSDK({
    cwd: projectPath,
    sessionId: claudeSessionId,
    permissionMode,
    env: claudeEnv,
    canUseTool: buildCanUseTool({ conversationId, broadcastFn }),
    model: resumeModel,
    effort: resumeEffort,
  });

  const mcpServers = await loadMcpConfig(projectPath);
  if (mcpServers) {
    sdkOptions.mcpServers = mcpServers;
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
    claudeSessionId,
    userId,
    broadcastFn,
    broadcastToTaskSubscribersFn,
    isNewSession: false,
  };

  handleStreamingStarted(ctx);

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
    projectId,
    userId: userId ?? null,
  });

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
