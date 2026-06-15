/**
 * Agent Runner Service
 *
 * Manages agent runs - creating records, linking to conversations,
 * and initiating streaming via the ConversationAdapter.
 *
 * Agent lifecycle (status updates, chaining) is handled centrally
 * by the ConversationAdapter when streaming completes.
 */

import { tasksDb, agentRunsDb, conversationsDb, userDb } from '../database/db.js';
import { startConversation } from './conversationAdapter.js';
import { updateUserBadge } from './notifications.js';
import { buildContextPrompt, getTaskDocPath, getRecordingPath } from './documentation.js';
import { getWorktreeProjectPath, worktreeExists, getPullRequestStatus } from './worktree.js';
import { getCredentialStore } from './credentials/registry.js';
import { ProviderCredentialsMissingError } from './credentials/types.js';
import {
  generateImplementationMessage,
  generateReviewMessage,
  generateRefinementMessage,
  generatePlanificationMessage,
  generatePrAgentMessage,
  generatePrAgentCommentMessage,
  generatePrAgentReviewMessage,
  generateYoloMessage,
} from '../constants/agentPrompts.js';
import { loadAgentModelSettings } from './agentModelSettings.js';
import type { AgentRunRow, CreatedConversation } from '../database/db.js';
import type {
  AgentType,
  BroadcastFn,
  BroadcastToTaskSubscribersFn,
} from '@shared/websocket/messages';
import type { VideoConfig } from './conversation/types.js';

export interface StartAgentRunOptions {
  broadcastFn?: BroadcastFn | undefined;
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
  userId?: number | undefined;
  webhookContext?: {
    comments?: unknown;
    [key: string]: unknown;
  } | undefined;
}

export interface StartAgentRunResult {
  agentRun: AgentRunRow;
  conversation: CreatedConversation;
  claudeSessionId: string;
}

/**
 * Start an agent run for a task
 * Creates agent run record, conversation, and starts streaming via adapter
 */
export async function startAgentRun(
  taskId: number,
  agentType: AgentType,
  options: StartAgentRunOptions = {},
): Promise<StartAgentRunResult> {
  const { broadcastFn, broadcastToTaskSubscribersFn, userId } = options;

  // Get task and project info
  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task ${taskId} not found`);
  }
  const effectiveUserId = userId ?? taskWithProject.user_id ?? undefined;

  // Get effective path (worktree if exists, otherwise main repo)
  let effectivePath = taskWithProject.repo_folder_path;
  if (await worktreeExists(effectivePath, taskId)) {
    effectivePath = getWorktreeProjectPath(effectivePath, taskId, taskWithProject.subproject_path);
  }
  // Task doc lives in the central archive, not the worktree — survives PR merge
  const taskDocPath = getTaskDocPath(taskWithProject.project_id, taskId);

  // Generate message based on agent type
  let message: string;
  switch (agentType) {
    case 'planification': {
      // Tech-vs-non-tech follows the user *triggering* the run, not the
      // task creator. effectiveUserId already falls back to the task owner
      // when no acting user is supplied (programmatic callers).
      const actor = effectiveUserId ? userDb.getUserById(effectiveUserId) : null;
      const actorIsTechnical = actor ? actor.is_technical !== 0 : true;
      message = await generatePlanificationMessage(taskDocPath, taskId, actorIsTechnical);
      break;
    }
    case 'implementation':
      message = await generateImplementationMessage(taskDocPath, taskId);
      break;
    case 'review':
      message = await generateReviewMessage(taskDocPath, taskId);
      break;
    case 'refinement':
      message = await generateRefinementMessage(taskDocPath, taskId);
      break;
    case 'pr': {
      // IMPORTANT: Use main repo path (not worktree path) for getPullRequestStatus
      // getPullRequestStatus internally derives the worktree path from repo + taskId
      const prStatus = await getPullRequestStatus(taskWithProject.repo_folder_path, taskId);
      const prUrl = prStatus.exists ? prStatus.url ?? null : null;

      // Use review-specific prompt if triggered by webhook with review comments
      // Use comment-specific prompt if triggered by webhook with single comment context
      const webhookCtx = options.webhookContext;
      if (webhookCtx?.comments) {
        // Shape is validated by the webhook route (commit 5: zod boundary).
        message = await generatePrAgentReviewMessage(taskDocPath, taskId, prUrl, webhookCtx as never);
      } else if (webhookCtx) {
        message = await generatePrAgentCommentMessage(taskDocPath, taskId, prUrl, webhookCtx as never);
      } else {
        message = await generatePrAgentMessage(taskDocPath, taskId, prUrl);
      }
      break;
    }
    case 'yolo': {
      const yoloPrStatus = await getPullRequestStatus(taskWithProject.repo_folder_path, taskId);
      const yoloPrUrl = yoloPrStatus.exists ? yoloPrStatus.url ?? null : null;
      message = await generateYoloMessage(taskDocPath, taskId, yoloPrUrl);
      break;
    }
    default:
      throw new Error(`Unknown agent type: ${agentType}`);
  }

  // Resolve THIS USER's configured provider for this agent up-front so we can
  // (a) validate the right backend's credentials before we start
  // touching task state and (b) stamp the right provider on the new
  // task_agent_runs and conversations rows below. Settings are per-user; an
  // unseeded user throws (fail loud) rather than silently defaulting.
  if (effectiveUserId == null) {
    throw new Error(`Cannot start agent run for task ${taskId}: no acting user to resolve agent model settings`);
  }
  const agentSettings = loadAgentModelSettings(effectiveUserId)[agentType];
  const { provider, model, effort } = agentSettings;

  // Fail closed if the user has no credentials for the configured
  // provider. Surfaces as a typed ProviderCredentialsMissingError so
  // the route layer can render a "Connect <provider>" prompt rather
  // than a server-side stacktrace.
  try {
    getCredentialStore(provider).read(effectiveUserId);
  } catch (err) {
    throw new ProviderCredentialsMissingError(
      provider,
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }

  // Create video recording config for review agents (Playwright MCP video capture).
  // Per docs/opencode/00-context-decisions.md § R1: OpenCode runs review
  // agents in degraded mode — no Playwright MCP, no recording temp dir.
  let videoConfig: VideoConfig | null = null;
  if (agentType === 'review' && provider !== 'opencode' && provider !== 'opencode-go') {
    const tempDir = `/tmp/bottega-video-${taskId}-${Date.now()}`;
    videoConfig = {
      tempDir,
      taskId,
      recordingDestPath: getRecordingPath(taskWithProject.project_id, taskId),
      // Fallback scan location: if Playwright MCP's `browser_start_video` is called with a
      // `filename` arg, it resolves against cwd (the worktree) rather than --output-dir.
      // See playwright-core/lib/tools/backend/response.js:60 and context.js:263.
      worktreePath: effectivePath,
    };
  }

  // Increment workflow run count (for infinite loop prevention)
  tasksDb.incrementRunCount(taskId);

  // Create agent run record (stamped with provider for diagnostics).
  // (provider, model, effort) were loaded above so credential
  // validation could see the right backend.
  void agentSettings;
  const agentRun = agentRunsDb.create(taskId, agentType, null, provider);
  console.log(
    `[AgentRunner] Created agent run ${agentRun.id} (${agentType}) for task ${taskId} (provider=${provider})`,
  );

  // Set agent run status to 'running' immediately
  agentRunsDb.updateStatus(agentRun.id, 'running');
  agentRun.status = 'running';

  // Create conversation. Stamp the configured (provider, model, effort) so
  // follow-up messages dispatch to the right backend and resume on the exact
  // same model — sendMessage resolves all three off this row, and a mismatch
  // would feed an OpenAI model name into the Anthropic SDK (the gpt-5.5 → 404
  // bug).
  const conversation = conversationsDb.create(taskId, provider, model, effort);
  console.log(
    `[AgentRunner] Created conversation ${conversation.id} for task ${taskId} (provider=${provider}, model=${model})`,
  );

  // Link conversation to agent run
  agentRunsDb.linkConversation(agentRun.id, conversation.id);
  console.log(`[AgentRunner] Linked conversation ${conversation.id} to agent run ${agentRun.id}`);

  // Broadcast agent run created/running to task subscribers
  if (broadcastToTaskSubscribersFn) {
    broadcastToTaskSubscribersFn(taskId, {
      type: 'agent-run-updated',
      agentRun: {
        id: agentRun.id,
        status: 'running',
        agent_type: agentType,
        conversation_id: conversation.id,
      },
    });
  }

  // Update task status to 'in_progress' if it's currently 'pending'
  if (taskWithProject.status === 'pending') {
    tasksDb.update(taskId, { status: 'in_progress' });
    console.log(`[AgentRunner] Updated task ${taskId} status to in_progress`);

    // Send badge update notification (fire and forget)
    if (userId) {
      updateUserBadge(userId).catch((err: unknown) => {
        console.error('[AgentRunner] Failed to update badge:', err);
      });
    }
  }

  // Build context prompt from task markdown + input files (central archive)
  const contextPrompt = buildContextPrompt(taskWithProject.project_id, taskId);

  // (provider, model, effort) loaded above before agentRunsDb.create
  // so the agent run row carries the right provider stamp.

  // Prevent implementation and yolo agents from delegating to sub-agents via the Agent tool.
  // Without this, they may spawn a sub-agent that runs for hours with zero visibility
  // in the parent conversation's JSONL. YOLO is designed as one continuous conversation.
  const disallowedTools = agentType === 'implementation' || agentType === 'yolo' ? ['Agent'] : [];

  // Start conversation via adapter
  // The adapter handles all lifecycle events (streaming-started, streaming-ended,
  // agent status updates, notifications, and chaining)
  const { claudeSessionId } = await startConversation(taskId, message, {
    broadcastFn,
    broadcastToTaskSubscribersFn,
    userId: effectiveUserId,
    customSystemPrompt: contextPrompt,
    permissionMode: 'bypassPermissions',
    conversationId: conversation.id,
    provider,
    model,
    ...(effort !== null ? { effort } : {}),
    disallowedTools,
    videoConfig: videoConfig,
  });

  return { agentRun, conversation, claudeSessionId };
}

/**
 * Check if an agent is currently running for a task
 */
export function getRunningAgentForTask(taskId: number): AgentRunRow | null {
  const allRuns = agentRunsDb.getByTask(taskId);
  return allRuns.find((r) => r.status === 'running') || null;
}

/**
 * Force-complete all running agent runs for a task
 * Used for recovery from stuck states
 */
export function forceCompleteRunningAgents(taskId: number): number {
  const agentRuns = agentRunsDb.getByTask(taskId);
  let count = 0;

  for (const run of agentRuns) {
    if (run.status === 'running') {
      agentRunsDb.updateStatus(run.id, 'completed');
      console.log(`[AgentRunner] Force-completed stuck agent run ${run.id}`);
      count++;
    }
  }

  return count;
}
