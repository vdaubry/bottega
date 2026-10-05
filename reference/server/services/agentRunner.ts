/**
 * Agent Runner Service
 *
 * Manages agent runs - creating records, linking to conversations,
 * and initiating streaming via the ConversationAdapter.
 *
 * Agent lifecycle (status updates, chaining) is handled centrally
 * by the ConversationAdapter when streaming completes.
 */

import { tasksDb, taskAgentRunsDb, conversationsDb, userDb } from '../database/db.js';
import { startConversation } from './conversationAdapter.js';
import { updateUserBadge } from './notifications.js';
import {
  buildContextPrompt,
  getTaskDocPath,
  getRecordingPath,
} from './documentation.js';
import {
  getWorktreeProjectPath,
  worktreeExists,
  getPullRequestStatus,
  hasUncommittedChanges,
  syncWithBase,
} from './worktree.js';
import { emitTaskEvent } from './tasks/events.js';
import { resolveBaseBranch } from './tasks/baseBranch.js';
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
import type { AgentRunDriver, TaskAgentRunRow, CreatedConversation, TaskWithProject } from '../database/db.js';
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
  /**
   * Who starts this run and therefore reviews its output. Defaults to
   * 'human' (every UI and webhook caller). An automation (the epic
   * orchestrator today) passes 'automation'; chained runs inherit the parent
   * run's driver, so the whole autonomous stretch keeps it. Policy, not
   * identity — see the three driver policies in
   * docs/epics/architecture-v2.md.
   */
  driver?: AgentRunDriver | undefined;
  /**
   * Extra instructions appended to the agent's generated prompt, verbatim.
   * The epic orchestrator uses it to hand a restarted agent the correction a
   * human would have typed — "the Playwright MCP is back, re-run QA", "the
   * 5.05s job is within tolerance, stop reworking it". Never a substitute for
   * the ticket document: it is context for THIS run only.
   */
  extraContext?: string | undefined;
}

export interface StartAgentRunResult {
  agentRun: TaskAgentRunRow;
  conversation: CreatedConversation;
  claudeSessionId: string;
}

/** The task domain's single execution invariant: one running task agent. */
export function getRunningAgentForTask(taskId: number): TaskAgentRunRow | null {
  return taskAgentRunsDb.getByTask(taskId).find((run) => run.status === 'running') ?? null;
}

/** A caller attempted to start a second task agent while one is still running. */
export class TaskAgentRunConflictError extends Error {
  constructor(
    public readonly taskId: number,
    public readonly runningAgent: TaskAgentRunRow,
  ) {
    super(
      `Task ${taskId} already has a running ${runningAgent.agent_type} agent ` +
        `(run ${runningAgent.id})`,
    );
    this.name = 'TaskAgentRunConflictError';
  }
}

/**
 * The worktree could not be brought up to date with the task's base branch
 * because the merge conflicts. The run is already marked failed and the task
 * blocked when this is thrown; the route answers 409.
 */
export class BaseSyncConflictError extends Error {
  constructor(
    public readonly taskId: number,
    public readonly baseBranch: string,
    public readonly gitError: string,
  ) {
    super(
      `Task ${taskId} could not be synced with ${baseBranch}: ${gitError}. ` +
        'Resolve the conflicts in the worktree, then resume the task.',
    );
    this.name = 'BaseSyncConflictError';
  }
}

/**
 * Agent types that open a fresh pass over the ticket. Only these auto-sync the
 * worktree with the epic's feature branch: mid-loop types (implementation,
 * review, refinement) run on a worktree that holds in-flight state, and
 * merging under them would rewrite files the agent is reasoning about.
 */
const LOOP_ENTRY_AGENT_TYPES: readonly AgentType[] = ['planification', 'yolo', 'pr'];

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
  const driver: AgentRunDriver = options.driver ?? 'human';

  // Get task and project info
  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject) {
    throw new Error(`Task ${taskId} not found`);
  }
  // Before any side effect (run counter, run row): no agent works in a
  // worktree that is still being set up, or whose setup failed.
  tasksDb.assertWorktreeReady(taskId);
  const effectiveUserId = userId ?? taskWithProject.user_id ?? undefined;

  // Get effective path (worktree if exists, otherwise main repo)
  let effectivePath = taskWithProject.repo_folder_path;
  if (await worktreeExists(effectivePath, taskId)) {
    effectivePath = getWorktreeProjectPath(effectivePath, taskId, taskWithProject.subproject_path);
  }
  // Task doc lives in the central archive, not the worktree — survives PR merge
  const taskDocPath = getTaskDocPath(taskWithProject.project_id, taskId);

  // The branch this ticket forked from and will merge back into. Resolved once
  // here and threaded into every prompt that talks about `origin/<base>`, so a
  // `master`-default repo and an epic ticket both get correct instructions
  // instead of a hardcoded `origin/main`.
  const baseBranch = await resolveBaseBranch(
    taskWithProject,
    taskWithProject.repo_folder_path,
  );

  // Generate message based on agent type
  let message: string;
  switch (agentType) {
    case 'planification': {
      // Driver policy 1: an automation-driven run always gets the technical
      // prompt variant — the driver reviews the plan itself, so the
      // non-technical variant (which exists to auto-chain straight into
      // implementation) would be reviewing nothing. For human runs,
      // tech-vs-non-tech follows the user *triggering* the run, not the task
      // creator. effectiveUserId already falls back to the task owner when no
      // acting user is supplied (programmatic callers).
      const actor = effectiveUserId ? userDb.getUserById(effectiveUserId) : null;
      const actorIsTechnical =
        driver === 'automation' ? true : actor ? actor.is_technical !== 0 : true;
      // The project's sensitive-areas list feeds the non-technical guardrail;
      // the builder ignores it for the technical variant.
      message = await generatePlanificationMessage(
        taskDocPath,
        taskId,
        actorIsTechnical,
        taskWithProject.sensitive_areas ?? null,
      );
      break;
    }
    case 'implementation':
      message = await generateImplementationMessage(taskDocPath, taskId);
      break;
    case 'review':
      message = await generateReviewMessage(taskDocPath, taskId);
      break;
    case 'refinement':
      message = await generateRefinementMessage(taskDocPath, taskId, baseBranch);
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
        message = await generatePrAgentReviewMessage(
          taskDocPath,
          taskId,
          prUrl,
          webhookCtx as never,
          baseBranch,
        );
      } else if (webhookCtx) {
        message = await generatePrAgentCommentMessage(
          taskDocPath,
          taskId,
          prUrl,
          webhookCtx as never,
          baseBranch,
        );
      } else {
        message = await generatePrAgentMessage(taskDocPath, taskId, prUrl, baseBranch);
      }
      break;
    }
    case 'yolo': {
      const yoloPrStatus = await getPullRequestStatus(taskWithProject.repo_folder_path, taskId);
      const yoloPrUrl = yoloPrStatus.exists ? yoloPrStatus.url ?? null : null;
      message = await generateYoloMessage(taskDocPath, taskId, yoloPrUrl, baseBranch);
      break;
    }
    default:
      throw new Error(`Unknown agent type: ${agentType}`);
  }

  if (options.extraContext?.trim()) {
    message +=
      `\n\n---\n\n## Note from your supervisor\n\n${options.extraContext.trim()}\n\n` +
      'This note is about this run specifically. The task document above remains the brief.';
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
  // Every provider now receives the operator's MCP servers — Claude through
  // `sdkOptions.mcpServers`, Codex and OpenCode through the turn `extras`
  // (`shared/providers/operatorMcpServers.ts`) — so a review agent gets Playwright
  // and a recording temp dir whatever it runs on. The old OpenCode carve-out
  // ("degraded mode, no Playwright MCP") is gone with the gap that caused it.
  let videoConfig: VideoConfig | null = null;
  if (agentType === 'review') {
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

  // This is the authoritative task-local concurrency guard. All preparation
  // above is read-only; keep this final check immediately adjacent to the
  // synchronous SQLite writes below so two async callers cannot both insert a
  // running row in this single-process server.
  const runningAgent = getRunningAgentForTask(taskId);
  if (runningAgent) {
    throw new TaskAgentRunConflictError(taskId, runningAgent);
  }

  // Increment workflow run count (for infinite loop prevention)
  tasksDb.incrementRunCount(taskId);

  // Create agent run record (stamped with provider for diagnostics).
  // (provider, model, effort) were loaded above so credential
  // validation could see the right backend.
  void agentSettings;
  const agentRun = taskAgentRunsDb.create(taskId, agentType, null, provider, driver);
  console.log(
    `[AgentRunner] Created agent run ${agentRun.id} (${agentType}) for task ${taskId} (provider=${provider}, driver=${driver})`,
  );

  // Set agent run status to 'running' immediately
  taskAgentRunsDb.updateStatus(agentRun.id, 'running');
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
  taskAgentRunsDb.linkConversation(agentRun.id, conversation.id);
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

  // Bring the worktree up to date with the task's base branch before the
  // agent starts reading code. Only at a loop entry point, only on a clean
  // tree, and only when the task HAS an explicit base (an epic ticket's
  // feature branch) — a standalone task's base is the default branch, and
  // syncing that is still the user's explicit call.
  await autoSyncWithBase(taskWithProject, agentType, {
    agentRunId: agentRun.id,
    conversationId: conversation.id,
    ...(broadcastToTaskSubscribersFn ? { broadcastToTaskSubscribersFn } : {}),
  });

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
  const { claudeSessionId } = await startConversation({ kind: 'task', taskId }, message, {
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
 * Merge the task's base branch into its worktree before an entry-point agent
 * run. Silent no-op for a task with no explicit base (`base_branch` NULL).
 *
 * A conflict is terminal for this run: the agent would otherwise start on a
 * tree full of conflict markers. The run is failed, the task blocked (the
 * existing "resume" affordance is the recovery path) and a typed error thrown
 * for the route to translate into a 409.
 */
async function autoSyncWithBase(
  task: TaskWithProject,
  agentType: AgentType,
  ctx: {
    agentRunId: number;
    conversationId: number;
    broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
  },
): Promise<void> {
  if (!LOOP_ENTRY_AGENT_TYPES.includes(agentType)) return;

  const baseBranch = task.base_branch;
  if (!baseBranch) return;

  if (!(await worktreeExists(task.repo_folder_path, task.id))) return;

  const dirty = await hasUncommittedChanges(task.repo_folder_path, task.id);
  if (!dirty.success || dirty.hasChanges) {
    console.log(
      `[AgentRunner] Skipping base sync for task ${task.id}: worktree has uncommitted changes`,
    );
    return;
  }

  const sync = await syncWithBase(task.repo_folder_path, task.id, baseBranch);
  if (sync.success) {
    console.log(`[AgentRunner] Synced task ${task.id} worktree with ${baseBranch}`);
    return;
  }

  console.error(
    `[AgentRunner] Base sync failed for task ${task.id} (${baseBranch}): ${sync.error}`,
  );
  taskAgentRunsDb.updateStatus(ctx.agentRunId, 'failed');
  tasksDb.blockWorkflow(task.id);

  ctx.broadcastToTaskSubscribersFn?.(task.id, {
    type: 'agent-run-updated',
    agentRun: {
      id: ctx.agentRunId,
      status: 'failed',
      agent_type: agentType,
      conversation_id: ctx.conversationId,
    },
  });
  ctx.broadcastToTaskSubscribersFn?.(task.id, {
    type: 'task-blocked',
    reason: 'base-sync-conflict',
  });

  // Whoever supervises this task (the epic orchestrator, via its subscriber)
  // cannot fix this itself, but it must know the ticket it just started is
  // dead in the water.
  emitTaskEvent('workflow-blocked', {
    taskId: task.id,
    reason: 'base-sync-conflict',
    detail: `Merging ${baseBranch} into the ticket worktree failed: ${sync.error ?? 'unknown error'}`,
  });

  throw new BaseSyncConflictError(task.id, baseBranch, sync.error ?? 'unknown error');
}

/**
 * Force-complete all running agent runs for a task
 * Used for recovery from stuck states
 */
export function forceCompleteRunningAgents(taskId: number): number {
  const agentRuns = taskAgentRunsDb.getByTask(taskId);
  let count = 0;

  for (const run of agentRuns) {
    if (run.status === 'running') {
      taskAgentRunsDb.updateStatus(run.id, 'completed');
      console.log(`[AgentRunner] Force-completed stuck agent run ${run.id}`);
      count++;
    }
  }

  return count;
}
