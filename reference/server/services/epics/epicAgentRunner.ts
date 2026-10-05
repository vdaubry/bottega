// Starting an EPIC stage's agent run — the epic-scoped counterpart of the
// task layer's `startAgentRun`, moved into the epic domain in architecture-v2
// step 5. The differences from the task path are deliberate and few: the run
// and the conversation are epic-scoped, the cwd is the project's main
// checkout for framing (the PR reviewer targets a ticket's worktree, delivery
// the epic's own — see docs/epics/delivery.md), there
// is no workflow run counter and no task status to flip, and nothing chains
// afterwards — a stage is started on purpose, by the user and by the
// orchestrator for its own per-ticket runs. (QA execution is the one
// exception: `qaLoop.ts` restarts it until the scenario book is filled.)

import { conversationsDb } from '../../database/conversations.js';
import { epicsDb, epicAgentRunsDb, epicTicketsDb } from '../../database/epics.js';
import { startConversation } from '../conversationAdapter.js';
import { ensureEpicDirs } from './epicArchive.js';
import { buildEpicContextPrompt } from './epicArchive.js';
import {
  getWorktreeProjectPath,
  worktreeExists,
  getPullRequestStatus,
  getDefaultBranch,
} from '../worktree.js';
import { ensureEpicDeliveryWorktree, findEpicCompletionPR } from './epicBranch.js';
import { getEpicDevServerPort } from '../documentation.js';
import { resolveBaseBranch, getTask } from '../tasks/index.js';
import { getCredentialStore } from '../credentials/registry.js';
import { ProviderCredentialsMissingError } from '../credentials/types.js';
import {
  generateEpicArchitectureMessage,
  generateEpicSpecificationMessage,
  generateEpicStoriesMessage,
  generateEpicSpecReviewMessage,
  generateEpicOrchestratorMessage,
  generateEpicPrReviewMessage,
  generateEpicDeliveryMessage,
  generateEpicQaScenariosMessage,
  generateEpicQaExecutionMessage,
  generateEpicQaFixMessage,
} from './epicAgentPrompts.js';
import type { EpicDeliveryTrigger } from './epicAgentPrompts.js';
import { EPIC_DISALLOWED_TOOLS_BY_STAGE } from './epicAgents.js';
import { loadAgentModelSettings } from '../agentModelSettings.js';
import type { CreatedConversation } from '../../database/conversations.js';
import type { EpicAgentRunRow, EpicAgentType } from '../../../shared/types/db.js';
import type {
  BroadcastFn,
  BroadcastToTaskSubscribersFn,
  BroadcastToEpicSubscribersFn,
} from '@shared/websocket/messages';

export interface StartEpicAgentRunResult {
  agentRun: EpicAgentRunRow;
  conversation: CreatedConversation;
  claudeSessionId: string;
}

export interface StartEpicAgentRunOptions {
  broadcastFn?: BroadcastFn | undefined;
  broadcastToEpicSubscribersFn?: BroadcastToEpicSubscribersFn | undefined;
  /**
   * The orchestrator drives TASK agents, so its own run needs the task channel
   * too — otherwise an open ticket page goes quiet while it works. Unused by
   * the other three stages.
   */
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
  userId?: number | undefined;
  /**
   * Which ticket an `epic-orchestrator` run supervises, or an `epic-pr-review`
   * run reviews. Required for those two stages (one run + conversation per
   * ticket) and meaningless for the others.
   */
  ticketTaskId?: number | undefined;
  /**
   * What opened an `epic-delivery` run: the user from the epic page, or a
   * GitHub comment/review on the final pull request. Defaults to manual.
   * Meaningless for every other agent type.
   */
  deliveryTrigger?: EpicDeliveryTrigger | undefined;
}

/** One epic may own at most one resumable PR-review conversation at a time. */
export function getActivePrReviewerForEpic(epicId: number): EpicAgentRunRow | null {
  return (
    epicAgentRunsDb
      .getByEpic(epicId)
      .find(
        (run) =>
          run.agent_type === 'epic-pr-review' &&
          (run.status === 'running' || run.status === 'blocked'),
      ) ?? null
  );
}

export class EpicPrReviewerConflictError extends Error {
  constructor(
    public readonly epicId: number,
    public readonly reviewer: EpicAgentRunRow,
  ) {
    super(
      `Epic ${epicId} already has an active PR reviewer (run ${reviewer.id}, ` +
        `status ${reviewer.status})`,
    );
    this.name = 'EpicPrReviewerConflictError';
  }
}

/** One epic may own at most one resumable QA fix conversation at a time. */
export function getActiveQaFixForEpic(epicId: number): EpicAgentRunRow | null {
  return (
    epicAgentRunsDb
      .getByEpic(epicId)
      .find(
        (run) =>
          run.agent_type === 'epic-qa-fix' &&
          (run.status === 'running' || run.status === 'blocked'),
      ) ?? null
  );
}

export class EpicQaFixConflictError extends Error {
  constructor(
    public readonly epicId: number,
    public readonly fixRun: EpicAgentRunRow,
  ) {
    super(
      `Epic ${epicId} already has an active QA fix mission (run ${fixRun.id}, ` +
        `status ${fixRun.status})`,
    );
    this.name = 'EpicQaFixConflictError';
  }
}

/**
 * Start an agent run for an EPIC stage — the epic-scoped counterpart of
 * `startAgentRun`, and the single entry point every later stage
 * (specification, stories, specification review, orchestrator) plugs into.
 *
 * The differences from the task path are deliberate and few: the run and the
 * conversation are epic-scoped, the cwd is the project's main checkout for
 * framing (the two branch-changing agents get a worktree: the reviewer its
 * ticket's, delivery the epic's own), there is no workflow run counter and no
 * task status to flip, and nothing chains afterwards — a stage is started on
 * purpose, by the user here and by the orchestrator later. (QA execution is
 * the one exception: `qaLoop.ts` restarts it until the book is filled.)
 *
 * Epic stages resolve the selected provider/model from the acting user's
 * settings; portable tools make every stage available on every harness.
 */
export async function startEpicAgentRun(
  epicId: number,
  agentType: EpicAgentType,
  options: StartEpicAgentRunOptions = {},
): Promise<StartEpicAgentRunResult> {
  const {
    broadcastFn,
    broadcastToEpicSubscribersFn,
    broadcastToTaskSubscribersFn,
    userId,
    ticketTaskId,
    deliveryTrigger,
  } = options;

  const epic = epicsDb.getWithProject(epicId);
  if (!epic) {
    throw new Error(`Epic ${epicId} not found`);
  }
  // Idempotent; also gives epics created before a directory existed (e.g.
  // `architecture/`) the full layout the stage prompts point at.
  ensureEpicDirs(epic.project_id, epicId);
  const effectiveUserId = userId ?? epic.user_id ?? undefined;
  if (effectiveUserId == null) {
    throw new Error(
      `Cannot start epic agent run for epic ${epicId}: no acting user to resolve agent model settings`,
    );
  }

  let message: string;
  switch (agentType) {
    case 'epic-architecture':
      message = generateEpicArchitectureMessage(epic);
      break;
    case 'epic-specification':
      message = generateEpicSpecificationMessage(epic);
      break;
    case 'epic-stories':
      message = generateEpicStoriesMessage(epic);
      break;
    case 'epic-spec-review':
      message = generateEpicSpecReviewMessage(epic);
      break;
    case 'epic-orchestrator': {
      if (ticketTaskId == null) {
        throw new Error('An orchestrator run must be started for a specific ticket');
      }
      const ticket = getTask(ticketTaskId);
      if (!ticket || epicTicketsDb.epicOf(ticketTaskId) !== epicId) {
        throw new Error(`Task ${ticketTaskId} is not a ticket of epic ${epicId}`);
      }
      message = generateEpicOrchestratorMessage(epic, ticket);
      break;
    }
    case 'epic-pr-review': {
      // The reviewer works inside the ticket's worktree on an open pull
      // request, so both must exist before a row is created — a reviewer
      // with nothing to review would only ever block the epic.
      if (ticketTaskId == null) {
        throw new Error('A PR review run must be started for a specific ticket');
      }
      const ticket = getTask(ticketTaskId);
      if (!ticket || epicTicketsDb.epicOf(ticketTaskId) !== epicId) {
        throw new Error(`Task ${ticketTaskId} is not a ticket of epic ${epicId}`);
      }
      if (!(await worktreeExists(ticket.repo_folder_path, ticket.id))) {
        throw new Error(`Task ${ticketTaskId} has no worktree to review in`);
      }
      const pr = await getPullRequestStatus(ticket.repo_folder_path, ticket.id);
      if (!pr.exists || !pr.url || pr.state !== 'OPEN') {
        throw new Error(`Task ${ticketTaskId} has no open pull request to review`);
      }
      message = generateEpicPrReviewMessage(epic, ticket, {
        worktreePath: getWorktreeProjectPath(
          ticket.repo_folder_path,
          ticket.id,
          ticket.subproject_path,
        ),
        prUrl: pr.url,
        baseBranch: await resolveBaseBranch(ticket, ticket.repo_folder_path),
      });
      break;
    }
    case 'epic-delivery': {
      // Delivery works ON the feature branch, so the worktree has to exist
      // before the first message can even name it. Created here rather than
      // lazily in `resolveScope` so a repo with no feature branch fails loudly
      // at start — with a run row that never gets created — instead of half-way
      // through a turn.
      const worktreePath = await ensureEpicDeliveryWorktree(epic);
      message = generateEpicDeliveryMessage(epic, {
        worktreePath,
        featureBranch: epic.feature_branch!,
        defaultBranch: await getDefaultBranch(epic.repo_folder_path),
        prUrl: await findEpicCompletionPR(epic),
        trigger: deliveryTrigger ?? { kind: 'manual' },
      });
      break;
    }
    case 'epic-qa-scenarios':
      message = generateEpicQaScenariosMessage(epic);
      break;
    case 'epic-qa-execution': {
      // QA runs the delivered feature branch, so like delivery the worktree is
      // ensured BEFORE a run row exists — an epic with no feature branch fails
      // loudly at start rather than half-way through a turn.
      const worktreePath = await ensureEpicDeliveryWorktree(epic);
      message = generateEpicQaExecutionMessage(epic, {
        worktreePath,
        featureBranch: epic.feature_branch!,
        devServerPort: getEpicDevServerPort(epicId),
      });
      break;
    }
    case 'epic-qa-fix': {
      // Same pre-flight as execution: the re-test needs the delivery worktree,
      // and a missing feature branch must fail loudly at start. The mission's
      // cwd stays the MAIN checkout (its fix ticket does not exist yet).
      const worktreePath = await ensureEpicDeliveryWorktree(epic);
      message = generateEpicQaFixMessage(epic, {
        worktreePath,
        featureBranch: epic.feature_branch!,
        devServerPort: getEpicDevServerPort(epicId),
      });
      break;
    }
  }

  const setting = loadAgentModelSettings(effectiveUserId)[agentType];
  const { provider, model, effort } = setting;
  try {
    getCredentialStore(provider).read(effectiveUserId);
  } catch (err) {
    throw new ProviderCredentialsMissingError(
      provider,
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }

  // Authoritative reviewer singleton. Keep this synchronous check adjacent to
  // the insert: every async PR/worktree/model check has already completed.
  if (agentType === 'epic-pr-review') {
    const reviewer = getActivePrReviewerForEpic(epicId);
    if (reviewer) throw new EpicPrReviewerConflictError(epicId, reviewer);
  }
  // Same for the QA fix mission: one supervising conversation per epic.
  if (agentType === 'epic-qa-fix') {
    const fixRun = getActiveQaFixForEpic(epicId);
    if (fixRun) throw new EpicQaFixConflictError(epicId, fixRun);
  }

  const agentRun = epicAgentRunsDb.create(epicId, agentType, null, provider, ticketTaskId ?? null);
  console.log(
    `[AgentRunner] Created epic agent run ${agentRun.id} (${agentType}) for epic ${epicId}` +
      `${ticketTaskId != null ? ` (ticket ${ticketTaskId})` : ''} (model=${model})`,
  );

  const conversation = conversationsDb.createForEpic(epicId, provider, model, effort);
  epicAgentRunsDb.linkConversation(agentRun.id, conversation.id);
  console.log(
    `[AgentRunner] Linked conversation ${conversation.id} to epic agent run ${agentRun.id}`,
  );

  if (broadcastToEpicSubscribersFn) {
    broadcastToEpicSubscribersFn(epicId, {
      type: 'agent-run-updated',
      agentRun: {
        id: agentRun.id,
        status: 'running',
        agent_type: agentType,
        conversation_id: conversation.id,
      },
    });
  }

  // Per-stage tool surface. The bottega MCP tools and the docs write gate are
  // attached inside startConversation, from this run's own row — so a follow-up
  // message in the same conversation gets them too.
  const disallowedTools = EPIC_DISALLOWED_TOOLS_BY_STAGE[agentType];

  // The reviewer runs in the ticket's worktree, delivery and QA execution in
  // the epic's own delivery worktree, every framing stage in the project's
  // main checkout (see `conversationScope.ts`).
  const target =
    agentType === 'epic-pr-review' && ticketTaskId != null
      ? { kind: 'epic' as const, epicId, worktreeTaskId: ticketTaskId }
      : agentType === 'epic-delivery' || agentType === 'epic-qa-execution'
        ? { kind: 'epic' as const, epicId, deliveryWorktree: true }
        : { kind: 'epic' as const, epicId };
  const { claudeSessionId } = await startConversation(target, message, {
    broadcastFn,
    broadcastToEpicSubscribersFn,
    broadcastToTaskSubscribersFn,
    userId: effectiveUserId,
    customSystemPrompt: buildEpicContextPrompt(epic.project_id, epicId, agentType),
    permissionMode: 'bypassPermissions',
    conversationId: conversation.id,
    provider,
    model,
    ...(effort !== null ? { effort } : {}),
    disallowedTools,
  });

  return { agentRun, conversation, claudeSessionId };
}

/**
 * Check if an agent currently owns execution for an epic. A manually stopped
 * run remains active as `blocked` because it is resumable in place.
 */
export function getRunningAgentForEpic(epicId: number): EpicAgentRunRow | null {
  return (
    epicAgentRunsDb
      .getByEpic(epicId)
      .find((run) => run.status === 'running' || run.status === 'blocked') ?? null
  );
}
