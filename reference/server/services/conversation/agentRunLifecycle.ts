// Agent-run-specific completion handling: status updates, broadcasts,
// chaining (implementation ↔ review loop, refinement → PR pipeline,
// planification auto-chain for non-technical users), and the push
// notification fired for any task conversation.
//
// Built as a hook factory matching the createContextUsageTracker pattern:
// `buildAgentRunCompletionHandler(ctx)` returns `(isError) => Promise<void>`
// suitable for composition into a streaming loop's `onComplete` hook.
//
// `handleAgentChaining` uses dynamic `await import('../agentRunner.js')` —
// agentRunner imports startConversation, which transitively imports this
// module, so a static import would create a load-time cycle. Keep it
// dynamic.

import { tasksDb, agentRunsDb, userDb } from '../../database/db.js';
import { worktreeExists } from '../worktree.js';
import { notifyClaudeComplete } from '../notifications.js';
import type { StreamingContext } from './types.js';
import type { AgentType } from '@shared/websocket/messages';

// Maximum number of agent iterations before auto-blocking (prevents infinite loops).
// Only affects automatic agent chaining, not manual conversations.
export const MAX_WORKFLOW_RUNS = 25;

/**
 * Build an `onComplete` handler for a streaming session. The returned
 * function:
 * 1. Looks up any linked agent run for this conversation.
 *    - If `status === 'running'`: the loop exited normally → mark
 *      `'completed'`, broadcast, and chain to the next agent.
 *    - If `status === 'failed'`: the user already clicked Stop (which writes
 *      this synchronously in `abortSession`) → no-op. Don't chain.
 *    - Any other status: shouldn't happen at runtime; log and stop.
 * 2. Fires a push notification for any task conversation (whether or not
 *    there's a linked agent run).
 *
 * **There is intentionally no `isError` parameter.** Failure is determined
 * by what's already in the DB (set deterministically by `abortSession` on
 * user-Stop or by the orphan-recovery sweep on server restart), not by a
 * boolean derived from how the streaming loop exited. Catastrophic SDK
 * errors land here as "status was still 'running' → mark 'completed' →
 * chain", and the next agent in the loop reads the synthetic error
 * message left in the conversation transcript and decides whether to retry.
 *
 * No-op if `ctx.taskId` is not set.
 */
export function buildAgentRunCompletionHandler(
  ctx: StreamingContext,
): () => Promise<void> {
  return async function onAgentRunComplete(): Promise<void> {
    const { conversationId, taskId, userId, broadcastToTaskSubscribersFn } = ctx;
    if (!taskId) return;

    const agentRuns = agentRunsDb.getByTask(taskId);
    const linkedAgentRun = agentRuns.find((r) => r.conversation_id === conversationId);

    let shouldChain = false;

    if (linkedAgentRun) {
      const { id: agentRunId, agent_type: agentType, status } = linkedAgentRun;

      if (status === 'running') {
        agentRunsDb.updateStatus(agentRunId, 'completed');
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
        // status='failed' (user aborted) is the expected non-running case.
        // Anything else is a state we didn't model — log so it's visible.
        console.log(
          `[ConversationAdapter] Agent run ${agentRunId} (${agentType}) status='${status}' on stream end — no chain`,
        );
      }
    }

    if (shouldChain && linkedAgentRun) {
      await handleAgentChaining(taskId, linkedAgentRun.agent_type, ctx);
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
      }).catch((err: unknown) => {
        console.error('[ConversationAdapter] Failed to send notification:', err);
      });
    }
  };
}

/**
 * Handle agent chaining (implementation ↔ review loop, and PR agent triggering).
 */
async function handleAgentChaining(
  taskId: number,
  agentType: AgentType,
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
    const actorUserId = userId ?? tasksDb.getWithProject(taskId)?.user_id ?? null;
    const actor = actorUserId ? userDb.getUserById(actorUserId) : null;
    const actorIsNonTechnical = actor?.is_technical === 0;

    if (!actorIsNonTechnical) {
      return;
    }
    if (task?.workflow_blocked) {
      console.log(`[ConversationAdapter] Task ${taskId} workflow blocked, skipping planification auto-chain`);
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
        await startAgentRun(taskId, 'implementation', { broadcastFn, broadcastToTaskSubscribersFn, userId });
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
          await startAgentRun(taskId, 'refinement', { broadcastFn, broadcastToTaskSubscribersFn, userId });
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
            await startAgentRun(taskId, 'pr', { broadcastFn, broadcastToTaskSubscribersFn, userId });
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
    console.log(`[ConversationAdapter] Task ${taskId} workflow blocked, stopping loop`);
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
        console.log(`[ConversationAdapter] Task ${taskId} workflow blocked (re-check), stopping loop`);
        return;
      }

      const runningAgent = getRunningAgentForTask(taskId);
      if (runningAgent) {
        console.log(`[ConversationAdapter] Another agent already running, skipping chain`);
        return;
      }

      await startAgentRun(taskId, nextType, { broadcastFn, broadcastToTaskSubscribersFn, userId });
    } catch (err) {
      // Loud log and stop. We used to also INSERT a placeholder 'failed' run
      // for the agent type we couldn't start — but that creates a sibling
      // row out of nowhere and confuses the dashboard. The parent run is
      // already marked 'completed'; the loop simply pauses here until the
      // user retries or the next loop trigger fires.
      console.error(`[ConversationAdapter] Failed to chain to ${nextType}:`, err);
    }
  }, 1000);
}
