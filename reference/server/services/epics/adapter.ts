// The EPIC domain's conversation-owner adapter (architecture-v2 step 5). The
// turn-end path is the historical epic branch of the completion handler:
// mark the run completed, broadcast on the epic channel — and never chain
// (epic stages are started deliberately, by the user, and by the
// orchestrator for its own per-ticket runs). The exceptions are the post-turn
// hooks below: the orchestrator/PR-review bridge, and QA execution's
// deterministic continuation (`qaLoop.ts` re-reads the scenario CSV and keeps
// running the book until every row has a result). Stage flags are never
// flipped here: every stage signs itself off through `mark_stage_complete`.
//
// The bridge hooks are dynamic imports: the bridge pulls in the whole
// orchestration chain, and the runtime dispatches back into this adapter.

import { epicsDb, epicAgentRunsDb, epicTicketsDb } from '../../database/epics.js';
import { conversationQuestionsDb } from '../../database/conversationQuestions.js';
import { getWorktreeProjectPath, worktreeExists } from '../worktree.js';
import { ensureEpicDeliveryWorktree } from './epicBranch.js';
import { getTask } from '../tasks/index.js';
import { portableBottegaTools, withBottegaMcpServer } from './bottegaInjection.js';
import {
  epicDocsWriteGateForConversation,
  epicDisallowedToolsForConversation,
} from './epicDocsWriteGate.js';
import {
  registerOwnerAdapter,
  type ConversationOwnerAdapter,
} from '../conversation/ownerAdapters.js';
import { broadcastEpicUpdated } from './epicEvents.js';
import type { ConversationScope, ConversationTarget } from '../conversation/conversationScope.js';
import type { StreamingContext } from '../conversation/types.js';
import type { ConversationRow, EpicAgentRunRow } from '@shared/types/db';

async function resolveScope(target: ConversationTarget): Promise<ConversationScope> {
  if (target.kind !== 'epic') {
    throw new Error(`Epic owner adapter cannot resolve a '${target.kind}' target`);
  }
  const epic = epicsDb.getWithProject(target.epicId);
  if (!epic) {
    throw new Error(`Epic ${target.epicId} not found`);
  }
  // The main checkout is the cwd for every framing stage — subproject_path only
  // ever adjusted worktree paths — with two exceptions, both of which need a
  // branch checked out somewhere: the PR reviewer works in the ticket's
  // worktree (reviewer concurrency belongs to epic_agent_runs, not the task
  // row), and the delivery agent works in the epic's own delivery worktree.
  let cwd = epic.repo_folder_path;
  if (target.deliveryWorktree) {
    // Ensured here rather than only at run start so a delivery conversation
    // resumed after the directory went missing recreates it instead of failing
    // in the provider subprocess. Idempotent: an `fs.access` when it exists.
    cwd = await ensureEpicDeliveryWorktree(epic);
  } else if (target.worktreeTaskId != null) {
    const ticket = getTask(target.worktreeTaskId);
    if (!ticket || epicTicketsDb.epicOf(target.worktreeTaskId) !== epic.id) {
      throw new Error(`Task ${target.worktreeTaskId} is not a ticket of epic ${epic.id}`);
    }
    if (!(await worktreeExists(ticket.repo_folder_path, ticket.id))) {
      throw new Error(`Task ${ticket.id} has no worktree to run the conversation in`);
    }
    cwd = getWorktreeProjectPath(ticket.repo_folder_path, ticket.id, ticket.subproject_path);
  }
  return {
    kind: 'epic',
    taskId: null,
    epicId: epic.id,
    projectId: epic.project_id,
    repoFolderPath: epic.repo_folder_path,
    subprojectPath: epic.subproject_path,
    cwd,
  };
}

async function onTurnEnded(ctx: StreamingContext): Promise<void> {
  const { conversationId, epicId, broadcastToEpicSubscribersFn } = ctx;
  if (epicId == null) return;

  const linkedAgentRun = epicAgentRunsDb.getByConversationId(conversationId);

  // A user Stop is a resumable interruption, not a failed review. The run and
  // epic were blocked before the provider abort landed, so completion must be
  // inert: no queue flush, sequencing hop, or replacement reviewer.
  if (linkedAgentRun?.status === 'blocked') {
    console.log(
      `[ConversationAdapter] Epic agent run ${linkedAgentRun.id} ` +
        `(${linkedAgentRun.agent_type}) is blocked by the user — waiting for a message`,
    );
    return;
  }

  if (linkedAgentRun && linkedAgentRun.status === 'running') {
    epicAgentRunsDb.updateStatus(linkedAgentRun.id, 'completed');
    console.log(
      `[ConversationAdapter] Epic agent run ${linkedAgentRun.id} (${linkedAgentRun.agent_type}) completed`,
    );
    if (broadcastToEpicSubscribersFn) {
      broadcastToEpicSubscribersFn(epicId, {
        type: 'agent-run-updated',
        agentRun: {
          id: linkedAgentRun.id,
          status: 'completed',
          agent_type: linkedAgentRun.agent_type,
          conversation_id: conversationId,
        },
      });
    }
  }

  // The orchestrator's own turn ended: deliver whatever arrived while it
  // was thinking, then let the sequencer decide if the next ticket is due.
  // A PR reviewer's turn ended: merged → the same hop; not merged → the
  // orchestrator is woken to retry or escalate.
  if (linkedAgentRun?.agent_type === 'epic-orchestrator') {
    const { onOrchestratorTurnEnded } = await import('./orchestrator/bridge.js');
    await onOrchestratorTurnEnded(epicId);
  } else if (linkedAgentRun?.agent_type === 'epic-pr-review') {
    const { onPrReviewTurnEnded } = await import('./orchestrator/bridge.js');
    await onPrReviewTurnEnded(epicId, linkedAgentRun);
  } else if (
    linkedAgentRun?.agent_type === 'epic-qa-execution' &&
    linkedAgentRun.status === 'running'
  ) {
    // 'running' at read time = this turn ended normally (marked completed just
    // above). A failed run must not respawn — the task adapter's "failed → no
    // chain" rule — and a blocked (user Stop) run never reaches here.
    const { onQaExecutionTurnEnded } = await import('./qaLoop.js');
    onQaExecutionTurnEnded(epicId);
  } else if (linkedAgentRun?.agent_type === 'epic-qa-fix') {
    // The fix supervisor's own turn ended: deliver whatever queued while it
    // was thinking. No sequencing hop — it supervises exactly one ticket.
    const { flush } = await import('./orchestrator/bridge.js');
    await flush(epicId);
  }
}

function broadcastRunStatus(
  broadcastToEpicSubscribersFn: StreamingContext['broadcastToEpicSubscribersFn'],
  epicId: number,
  run: Pick<EpicAgentRunRow, 'id' | 'agent_type' | 'conversation_id'>,
  status: 'running' | 'blocked',
): void {
  broadcastToEpicSubscribersFn?.(epicId, {
    type: 'agent-run-updated',
    agentRun: {
      id: run.id,
      status,
      agent_type: run.agent_type,
      conversation_id: run.conversation_id,
    },
  });
}

export const epicOwnerAdapter: ConversationOwnerAdapter = {
  kind: 'epic',

  resolveScope,

  resolveOwner(conversation: ConversationRow) {
    if (conversation.epic_id == null) return null;
    const epic = epicsDb.getById(conversation.epic_id);
    if (!epic) return null;
    return { taskId: null, epicId: epic.id, projectId: epic.project_id };
  },

  linkedRun(conversationId: number) {
    return epicAgentRunsDb.getByConversationId(conversationId) ?? null;
  },

  assertTurnCanStart(conversationId: number) {
    const linked = epicAgentRunsDb.getByConversationId(conversationId);
    // Per-type singletons: one active PR reviewer / QA fix mission per epic —
    // resuming an older conversation while a newer one is active would fork
    // the supervision.
    if (linked?.agent_type !== 'epic-pr-review' && linked?.agent_type !== 'epic-qa-fix') return;
    const other = epicAgentRunsDb
      .getByEpic(linked.epic_id)
      .find(
        (run) =>
          run.id !== linked.id &&
          run.agent_type === linked.agent_type &&
          (run.status === 'running' || run.status === 'blocked'),
      );
    if (other) {
      const role = linked.agent_type === 'epic-pr-review' ? 'PR reviewer' : 'QA fix mission';
      throw new Error(
        `Epic ${linked.epic_id} already has an active ${role} ` +
          `(run ${other.id}, status ${other.status})`,
      );
    }
  },

  async interruptLinkedRun(conversationId: number) {
    const linked = epicAgentRunsDb.getByConversationId(conversationId);
    if (!linked) return null;
    const role =
      linked.agent_type === 'epic-pr-review' ? 'PR reviewer' : 'epic agent';
    const result = epicAgentRunsDb.interruptConversation(
      conversationId,
      `The ${role} was stopped by the user. Send a message in conversation ${conversationId} ` +
        'to resume that exact run.',
    );
    if (!result) return null;

    // Stop has no request-scoped epic broadcaster, so use the bridge's boot-
    // registered channel closures. This is presentation only; the transaction
    // above is the durable source of truth.
    const { getBridgeBroadcasters } = await import('./orchestrator/bridge.js');
    const broadcast = getBridgeBroadcasters().broadcastToEpicSubscribersFn;
    broadcastRunStatus(broadcast, linked.epic_id, result.run, 'blocked');
    if (result.epic) broadcastEpicUpdated(broadcast, result.epic);
    return result.run;
  },

  failLinkedRunIfRunning(conversationId: number) {
    const linked = epicAgentRunsDb.getByConversationId(conversationId);
    if (linked && linked.status === 'running') {
      epicAgentRunsDb.updateStatus(linked.id, 'failed');
      return linked;
    }
    return null;
  },

  async onTurnStarted(ctx: StreamingContext) {
    if (ctx.epicId == null) return;
    const result = epicAgentRunsDb.beginConversationTurn(ctx.conversationId);
    if (!result) return;

    broadcastRunStatus(
      ctx.broadcastToEpicSubscribersFn,
      ctx.epicId,
      result.run,
      'running',
    );
    if (result.epic) {
      broadcastEpicUpdated(ctx.broadcastToEpicSubscribersFn, result.epic);
    }
    if (result.resumed) {
      const { resetBridgeCounters } = await import('./orchestrator/bridge.js');
      resetBridgeCounters(ctx.epicId);
    }
  },

  onTurnEnded,

  async onQuestionParked(conversation: ConversationRow, _questions: unknown[]) {
    // The orchestrator itself is asking — this is its escalation path, and
    // the user answers it in the widget like any other question. Other epic
    // conversations' questions reach the user through the widget broadcast
    // alone.
    if (conversation.epic_id == null) return;
    const { currentOrchestratorRun } = await import('./orchestrator/bridge.js');
    const run = currentOrchestratorRun(conversation.epic_id);
    if (run?.conversation_id !== conversation.id) return;
    const epic = epicsDb.getWithProject(conversation.epic_id);
    if (!epic?.user_id) return;
    const { sendBannerNotification } = await import('../notifications.js');
    await sendBannerNotification(
      epic.user_id,
      'The epic orchestrator needs you',
      `${epic.name}: it is waiting for an answer before it can carry on.`,
      { type: 'epic_question', projectId: String(epic.project_id) },
    );
  },

  sweepOrphans() {
    const orphaned = epicAgentRunsDb.getByStatus('running');
    for (const run of orphaned) {
      if (run.conversation_id != null && conversationQuestionsDb.active(run.conversation_id)) continue;
      epicAgentRunsDb.updateStatus(run.id, 'failed');
    }
    const failed = orphaned.filter(
      (run) => run.conversation_id == null || !conversationQuestionsDb.active(run.conversation_id),
    );
    if (failed.length > 0) {
      console.log(
        `[RECOVERY] Marked ${failed.length} orphaned epic agent run(s) as failed: ${failed
          .map((run) => `#${run.id} (${run.agent_type} for epic ${run.epic_id})`)
          .join(', ')}`,
      );
    }
  },

  augmentMcpServers(mcpServers, args) {
    // The bottega tools are epic-scoped: the catalog is derived from the
    // conversation's linked run row inside the injection, so a resume gets
    // the identical surface.
    return withBottegaMcpServer(mcpServers, {
      conversationId: args.conversationId,
      userId: args.userId,
      broadcastFn: args.broadcastFn,
      broadcastToTaskSubscribersFn: args.broadcastToTaskSubscribersFn,
      broadcastToEpicSubscribersFn: args.broadcastToEpicSubscribersFn,
    });
  },

  portableTools(args) {
    return portableBottegaTools({
      conversationId: args.conversationId,
      userId: args.userId,
      broadcastFn: args.broadcastFn,
      broadcastToTaskSubscribersFn: args.broadcastToTaskSubscribersFn,
      broadcastToEpicSubscribersFn: args.broadcastToEpicSubscribersFn,
    });
  },

  extraDisallowedTools(conversationId: number) {
    return epicDisallowedToolsForConversation(conversationId) ?? [];
  },

  extraPreToolUseHooks(conversationId: number) {
    const gate = epicDocsWriteGateForConversation(conversationId);
    return gate ? [gate] : [];
  },

  assertProviderAllowed() {
    // Epic conversations use provider-neutral tools and run on every harness.
  },
};

/** Wire the epic domain into the conversation runtime. Idempotent. */
export function registerEpicOwnerAdapter(): void {
  registerOwnerAdapter(epicOwnerAdapter);
}
