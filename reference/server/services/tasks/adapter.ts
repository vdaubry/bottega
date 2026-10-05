// The TASK domain's conversation-owner adapter (architecture-v2 step 5): how
// the conversation runtime asks the task layer its ownership questions. The
// turn-end path here is the historical task branch of the agent-run
// completion handler — status write → broadcast → **emit `run-ended`** →
// chain → notify — with the load-bearing notify-before-chain ordering intact.
//
// Chaining uses dynamic `await import('../agentRunner.js')` — agentRunner
// imports startConversation, which transitively imports the runtime that
// dispatches back here. Keep it dynamic.

import { tasksDb, taskAgentRunsDb } from '../../database/tasks.js';
import { conversationQuestionsDb } from '../../database/conversationQuestions.js';
import { userDb } from '../../database/db.js';
import { worktreeExists, getWorktreeProjectPath } from '../worktree.js';
import { notifyClaudeComplete } from '../notifications.js';
import { emitTaskEvent } from './events.js';
import { withAtlasMcpServer } from '../conversation/atlasInjection.js';
import {
  registerOwnerAdapter,
  type ConversationOwnerAdapter,
} from '../conversation/ownerAdapters.js';
import type { ConversationScope, ConversationTarget } from '../conversation/conversationScope.js';
import type { StreamingContext } from '../conversation/types.js';
import type { AgentRunDriver, ConversationRow } from '@shared/types/db';
import type { AgentType, BroadcastToTaskSubscribersFn } from '@shared/websocket/messages';

// Maximum number of agent iterations before auto-blocking (prevents infinite loops).
// Only affects automatic agent chaining, not manual conversations.
export const MAX_WORKFLOW_RUNS = 25;

async function resolveScope(target: ConversationTarget): Promise<ConversationScope> {
  if (target.kind !== 'task') {
    throw new Error(`Task owner adapter cannot resolve a '${target.kind}' target`);
  }
  const task = tasksDb.getWithProject(target.taskId);
  if (!task) {
    throw new Error(`Task ${target.taskId} not found`);
  }
  let cwd = task.repo_folder_path;
  if (await worktreeExists(task.repo_folder_path, target.taskId)) {
    cwd = getWorktreeProjectPath(task.repo_folder_path, target.taskId, task.subproject_path);
  }
  return {
    kind: 'task',
    taskId: task.id,
    epicId: null,
    projectId: task.project_id,
    repoFolderPath: task.repo_folder_path,
    subprojectPath: task.subproject_path,
    cwd,
  };
}

/**
 * The task turn-end hook. Looks up the linked agent run:
 *  - `status === 'running'`: the loop exited normally → mark 'completed',
 *    broadcast, publish `run-ended`, and chain to the next agent.
 *  - `status === 'failed'`: the user already clicked Stop (written
 *    synchronously in `abortSession`) or a provider surfaced a terminal
 *    error → publish `run-ended`, don't chain.
 * Then a push notification for any task conversation (whether or not a run
 * is linked), muted for automation-driven runs.
 */
async function onTurnEnded(ctx: StreamingContext): Promise<void> {
  const { conversationId, taskId, userId, broadcastToTaskSubscribersFn } = ctx;
  if (!taskId) return;

  const linkedAgentRun = taskAgentRunsDb.getByConversationId(conversationId);

  let shouldChain = false;

  if (linkedAgentRun) {
    const { id: agentRunId, agent_type: agentType, status } = linkedAgentRun;

    if (status === 'running') {
      taskAgentRunsDb.updateStatus(agentRunId, 'completed');
      console.log(`[ConversationAdapter] Agent run ${agentRunId} (${agentType}) completed`);

      if (broadcastToTaskSubscribersFn) {
        broadcastToTaskSubscribersFn(taskId, {
          type: 'agent-run-updated',
          agentRun: {
            id: agentRunId,
            status: 'completed',
            agent_type: agentType,
            conversation_id: conversationId,
          },
        });
      }

      // Chain implementation/review/refinement, plus planification for
      // non-technical owners (handleAgentChaining decides per-owner).
      // PR agent is terminal — no chaining after it completes.
      if (
        agentType === 'planification' ||
        agentType === 'implementation' ||
        agentType === 'review' ||
        agentType === 'refinement'
      ) {
        shouldChain = true;
      }
    } else {
      // status='failed' is the expected non-running case — either a user
      // abort or a terminal provider error pre-marked by
      // failLinkedRunIfRunning. Anything else is a state we didn't
      // model — log so it's visible.
      console.log(
        `[ConversationAdapter] Agent run ${agentRunId} (${agentType}) status='${status}' on stream end — no chain`,
      );
    }
  }

  // Publish the turn end — every agent type, every outcome; subscribers
  // filter. Deliberately before the chaining below (the notify-before-chain
  // ordering): an orchestrated planification does not auto-chain, so for the
  // epic layer this event IS what moves the ticket forward. `status` is the
  // run's terminal status: a row still 'running' has just completed normally.
  if (linkedAgentRun) {
    emitTaskEvent('run-ended', {
      taskId,
      runId: linkedAgentRun.id,
      agentType: linkedAgentRun.agent_type,
      driver: linkedAgentRun.driver,
      status: linkedAgentRun.status === 'running' ? 'completed' : linkedAgentRun.status,
      conversationId,
    });
  }

  if (shouldChain && linkedAgentRun) {
    // The chain inherits the ending run's driver, so an autonomous stretch
    // stays 'automation' end to end.
    await handleAgentChaining(taskId, linkedAgentRun.agent_type, linkedAgentRun.driver, ctx);
  }

  // Push notification for any task conversation (manual or agent-run-driven).
  // Sent even on abort — the user already knows they aborted, but reaching
  // a clean loop end is still something to notify about.
  if (userId) {
    const taskInfo = tasksDb.getById(taskId);
    const taskTitle = taskInfo?.title || null;
    const projectId = taskInfo?.project_id ?? null;
    const workflowComplete = !!taskInfo?.workflow_complete;
    const agentType = linkedAgentRun?.agent_type || null;

    notifyClaudeComplete(userId, taskTitle, taskId, conversationId, projectId, {
      agentType,
      workflowComplete,
      // Driver policy 3: an automation-driven run's turn end never pushes —
      // its driver reviews it. A conversation with no run behind it
      // (a manual chat) always notifies its human.
      driver: linkedAgentRun?.driver ?? 'human',
    }).catch((err: unknown) => {
      console.error('[ConversationAdapter] Failed to send notification:', err);
    });
  }
}

function failLinkedRunIfRunning(conversationId: number) {
  const linked = taskAgentRunsDb.getByConversationId(conversationId);
  if (linked && linked.status === 'running') {
    taskAgentRunsDb.updateStatus(linked.id, 'failed');
    return linked;
  }
  return null;
}

/**
 * The agent blocked its own workflow mid-turn, with
 * `scripts/block-workflow.ts`. That runs in a separate process and writes
 * straight to SQLite, so this — the chain re-reading the row once the turn has
 * ended — is the first moment the server can see it. Announce it: the ticket
 * stopping silently is exactly how epic 4's ticket #1664 sat blocked with its
 * orchestrator asleep.
 *
 * Reached only at the end of a turn on a task that is now blocked, and the
 * orchestrator unblocks before it restarts anything, so a re-emission means a
 * fresh block — which is news.
 */
function announceAgentBlock(
  taskId: number,
  reason: string | null | undefined,
  broadcastToTaskSubscribersFn: BroadcastToTaskSubscribersFn | undefined,
): void {
  console.log(`[ConversationAdapter] Task ${taskId} workflow blocked, stopping loop`);

  broadcastToTaskSubscribersFn?.(taskId, { type: 'task-blocked', reason: 'agent_requested' });

  emitTaskEvent('workflow-blocked', {
    taskId,
    reason: 'agent-requested',
    detail:
      reason?.trim() ||
      'The agent blocked its own workflow and gave no reason. Read the ticket document — ' +
        'the review agent writes what stopped it into the "Review Findings" section.',
  });
}

/**
 * Handle agent chaining (implementation ↔ review loop, and PR agent triggering).
 */
async function handleAgentChaining(
  taskId: number,
  agentType: AgentType,
  driver: AgentRunDriver,
  context: StreamingContext,
): Promise<void> {
  const { broadcastFn, broadcastToTaskSubscribersFn, userId } = context;
  const task = tasksDb.getById(taskId);

  // Planification → implementation auto-chain for non-technical users.
  // Technical users keep the current manual-Run gate. The decision tracks
  // the user who triggered planification (carried on StreamingContext),
  // not the task creator — fall back to the task owner only when the
  // context has no userId.
  if (agentType === 'planification') {
    // Driver policy 2: an automation-driven planification never auto-chains —
    // its driver reviews the plan first and starts implementation itself.
    if (driver === 'automation') {
      console.log(
        `[ConversationAdapter] Task ${taskId} planification is automation-driven — its driver reviews the plan, no auto-chain`,
      );
      return;
    }

    // The planning agent blocked its own workflow — the non-technical
    // sensitive-areas guardrail escalating to a technical user. Announce it
    // like any agent block (board badge, supervisor event) and never chain:
    // whoever the actor is, the task now waits for a human to press Resume.
    if (task?.workflow_blocked) {
      announceAgentBlock(taskId, task.workflow_blocked_reason, broadcastToTaskSubscribersFn);
      return;
    }

    const actorUserId = userId ?? tasksDb.getWithProject(taskId)?.user_id ?? null;
    const actor = actorUserId ? userDb.getUserById(actorUserId) : null;
    const actorIsNonTechnical = actor?.is_technical === 0;

    if (!actorIsNonTechnical) {
      return;
    }
    if ((task?.workflow_run_count ?? 0) >= MAX_WORKFLOW_RUNS) {
      console.log(`[ConversationAdapter] Task ${taskId} hit max iterations, skipping planification auto-chain`);
      return;
    }

    console.log(
      `[ConversationAdapter] Auto-starting implementation after planification for non-technical owner (task ${taskId})`,
    );
    const { startAgentRun } = await import('../agentRunner.js');
    setTimeout(async () => {
      try {
        await startAgentRun(taskId, 'implementation', { broadcastFn, broadcastToTaskSubscribersFn, userId, driver });
      } catch (err) {
        console.error(`[ConversationAdapter] Failed to auto-start implementation after planification:`, err);
      }
    }, 1000);
    return;
  }

  // workflow_complete → run refinement → PR pipeline
  if (task?.workflow_complete) {
    if (agentType === 'refinement') {
      tasksDb.markRefinementComplete(taskId);
      // Fall through to PR check
    } else if (!task?.refinement_complete) {
      console.log(`[ConversationAdapter] Starting refinement agent for task ${taskId}`);
      const { startAgentRun } = await import('../agentRunner.js');
      setTimeout(async () => {
        try {
          await startAgentRun(taskId, 'refinement', { broadcastFn, broadcastToTaskSubscribersFn, userId, driver });
        } catch (err) {
          console.error(`[ConversationAdapter] Failed to start refinement agent:`, err);
        }
      }, 1000);
      return;
    }

    if (!task?.pr_agent_complete) {
      const taskWithProject = tasksDb.getWithProject(taskId);
      if (!taskWithProject) {
        console.log(`[ConversationAdapter] Task ${taskId} not found, skipping PR agent`);
        return;
      }
      const hasWorktree = await worktreeExists(taskWithProject.repo_folder_path, taskId);

      if (hasWorktree) {
        console.log(`[ConversationAdapter] Starting PR agent for task ${taskId}`);
        const { startAgentRun } = await import('../agentRunner.js');
        setTimeout(async () => {
          try {
            await startAgentRun(taskId, 'pr', { broadcastFn, broadcastToTaskSubscribersFn, userId, driver });
          } catch (err) {
            console.error(`[ConversationAdapter] Failed to start PR agent:`, err);
          }
        }, 1000);
        return;
      }
    }

    console.log(`[ConversationAdapter] Task ${taskId} workflow complete, stopping loop`);
    return;
  }

  if (task?.workflow_blocked) {
    announceAgentBlock(taskId, task.workflow_blocked_reason, broadcastToTaskSubscribersFn);
    return;
  }

  if ((task?.workflow_run_count ?? 0) >= MAX_WORKFLOW_RUNS) {
    console.log(
      `[ConversationAdapter] Task ${taskId} reached max iterations (${MAX_WORKFLOW_RUNS}), auto-blocking`,
    );
    tasksDb.blockWorkflow(taskId);

    if (broadcastToTaskSubscribersFn) {
      // broadcastToTaskSubscribers splices `taskId` in itself; passing it
      // again here would be redundant.
      broadcastToTaskSubscribersFn(taskId, {
        type: 'task-blocked',
        reason: 'max_iterations',
      });
    }

    emitTaskEvent('workflow-blocked', {
      taskId,
      reason: 'max-iterations',
      detail: `The ticket hit the ${MAX_WORKFLOW_RUNS}-iteration cap and was blocked. It will not move again on its own.`,
    });
    return;
  }

  const nextType: AgentType = agentType === 'implementation' ? 'review' : 'implementation';
  console.log(`[ConversationAdapter] Chaining ${agentType} -> ${nextType} for task ${taskId}`);

  const { startAgentRun, getRunningAgentForTask } = await import('../agentRunner.js');

  setTimeout(async () => {
    try {
      const freshTask = tasksDb.getById(taskId);
      if (freshTask?.workflow_complete) {
        console.log(`[ConversationAdapter] Task ${taskId} workflow complete (re-check), stopping loop`);
        return;
      }
      if (freshTask?.workflow_blocked) {
        announceAgentBlock(
          taskId,
          freshTask.workflow_blocked_reason,
          broadcastToTaskSubscribersFn,
        );
        return;
      }

      if (getRunningAgentForTask(taskId)) {
        console.log(`[ConversationAdapter] Task ${taskId} is busy, skipping chain`);
        return;
      }

      await startAgentRun(taskId, nextType, { broadcastFn, broadcastToTaskSubscribersFn, userId, driver });
    } catch (err) {
      // Loud log and stop. We used to also INSERT a placeholder 'failed' run
      // for the agent type we couldn't start — but that creates a sibling
      // row out of nowhere and confuses the dashboard. The parent run is
      // already marked 'completed'; the loop simply pauses here until the
      // user retries or the next loop trigger fires.
      console.error(`[ConversationAdapter] Failed to chain to ${nextType}:`, err);

      // Nobody is watching a chain that never started — except a subscriber
      // that is (the epic orchestrator): for it, this silence would look like
      // the autonomous stretch.
      emitTaskEvent('chain-start-failed', {
        taskId,
        nextAgentType: nextType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, 1000);
}

export const taskOwnerAdapter: ConversationOwnerAdapter = {
  kind: 'task',

  resolveScope,

  resolveOwner(conversation: ConversationRow) {
    if (conversation.task_id == null) return null;
    const task = tasksDb.getById(conversation.task_id);
    if (!task) return null;
    return { taskId: task.id, epicId: null, projectId: task.project_id };
  },

  linkedRun(conversationId: number) {
    return taskAgentRunsDb.getByConversationId(conversationId) ?? null;
  },

  assertTurnCanStart() {
    // A task conversation is already protected by the conversation-busy
    // guard; task-agent creation has its own one-running-run invariant.
  },

  // Task Stop semantics are unchanged: a stopped task run is terminal and
  // does not chain. Epics override this operation with a resumable block.
  interruptLinkedRun(conversationId: number) {
    return failLinkedRunIfRunning(conversationId);
  },

  failLinkedRunIfRunning,

  onTurnStarted() {
    // Task run rows retain their existing one-turn lifecycle.
  },

  onTurnEnded,

  onQuestionParked(conversation: ConversationRow, questions: unknown[]) {
    if (conversation.task_id == null) return;
    emitTaskEvent('question-parked', {
      taskId: conversation.task_id,
      conversationId: conversation.id,
      questions,
    });
  },

  sweepOrphans() {
    const orphaned = taskAgentRunsDb.getByStatus('running');
    for (const run of orphaned) {
      if (run.conversation_id != null && conversationQuestionsDb.active(run.conversation_id)) continue;
      taskAgentRunsDb.updateStatus(run.id, 'failed');
    }
    const failed = orphaned.filter(
      (run) => run.conversation_id == null || !conversationQuestionsDb.active(run.conversation_id),
    );
    if (failed.length > 0) {
      console.log(
        `[RECOVERY] Marked ${failed.length} orphaned task agent run(s) as failed: ${failed
          .map((run) => `#${run.id} (${run.agent_type} for task ${run.task_id})`)
          .join(', ')}`,
      );
    }
  },

  augmentMcpServers(mcpServers, args) {
    // Explore/atlas tools are task-scoped; an epic conversation never carries
    // them (its row can't have atlas_enabled set).
    return withAtlasMcpServer(mcpServers, {
      conversationId: args.conversationId,
      taskId: args.ownerId,
      userId: args.userId,
    });
  },

  portableTools() {
    // Explore/code-atlas remains Claude-only; ordinary task conversations do
    // not carry an owner-specific MCP catalog.
    return [];
  },

  extraDisallowedTools() {
    return [];
  },

  extraPreToolUseHooks() {
    return [];
  },

  assertProviderAllowed() {
    // Task conversations run on any connected provider.
  },
};

/** Wire the task domain into the conversation runtime. Idempotent. */
export function initTasks(): void {
  registerOwnerAdapter(taskOwnerAdapter);
}
