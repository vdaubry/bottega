/**
 * The inbound GitHub half of the delivery agent: a comment or a review on the
 * epic's FINAL pull request starts an `epic-delivery` run.
 *
 * The epic twin of `webhookService.ts`'s `triggerPrAgentFrom{Comment,Review}`,
 * and deliberately the same shape — same pre-checks, same "already running"
 * refusal, same `TriggerResult` — because the route treats the two identically:
 * parse the branch, find its owner, hand the feedback over. What differs is
 * only the owner: a ticket branch (`task/{id}-…`) resolves to a task and its
 * `pr` agent, the epic feature branch (`epic/{id}-…`) resolves to an epic and
 * its delivery agent.
 *
 * Lives in the epic layer, not in `webhookService.ts`, because it reads epic
 * rows and starts an epic run (architecture-v2 rule 1). The webhook route is
 * the second REST adapter into this layer, alongside `routes/epics.ts`.
 */

import { epicsDb } from '../../database/epics.js';
import { userDb } from '../../database/db.js';
import { startEpicAgentRun, getRunningAgentForEpic } from './epicAgentRunner.js';
import type {
  CommentWebhookContext,
  ReviewWebhookContext,
} from '../../constants/prFeedback.js';
import type {
  BroadcastFn,
  BroadcastToConversationSubscribersFn,
  BroadcastToEpicSubscribersFn,
} from '@shared/websocket/messages';

export interface EpicDeliveryTriggerResult {
  conversationId: number;
  agentRunId: number;
}

interface TriggerArgsBase {
  epicId: number;
  broadcastToConversationSubscribers?: BroadcastToConversationSubscribersFn | undefined;
  broadcastToEpicSubscribers?: BroadcastToEpicSubscribersFn | undefined;
}

export interface TriggerEpicDeliveryFromCommentArgs extends TriggerArgsBase {
  commentBody: string;
  commentAuthor: string;
  fileContext?: CommentWebhookContext['fileContext'];
}

export interface TriggerEpicDeliveryFromReviewArgs extends TriggerArgsBase {
  reviewBody: string | null;
  reviewAuthor: string;
  comments: NonNullable<ReviewWebhookContext['comments']>;
}

/**
 * Wrap the dispatch-owned per-conversation broadcast helper as the
 * `BroadcastFn(conversationId, message)` shape the conversation lifecycle
 * expects — the same adaptation `webhookService.ts` performs for tasks.
 */
function createBroadcastFn(
  broadcastToConversationSubscribers: BroadcastToConversationSubscribersFn | null | undefined,
): BroadcastFn | null {
  if (!broadcastToConversationSubscribers) return null;
  return (convId, msg) => broadcastToConversationSubscribers(convId, msg);
}

/**
 * Everything both triggers check before a run row exists. Throws with the
 * messages the webhook route downgrades to `200 ignored` — a webhook must never
 * make GitHub retry into a state that will refuse it again.
 */
function resolveEpicForDelivery(epicId: number) {
  const epic = epicsDb.getWithProject(epicId);
  if (!epic) {
    throw new Error(`Epic ${epicId} not found`);
  }
  if (!epic.feature_branch) {
    throw new Error(`Epic ${epicId} has no feature branch`);
  }

  // One conversation at a time per epic, exactly like the task path: a second
  // comment arriving mid-turn is refused rather than queued. The user can reply
  // in the running conversation, which is where the first comment already is.
  const running = getRunningAgentForEpic(epicId);
  if (running) {
    throw new Error(
      `Epic ${epicId} is already running: a ${running.agent_type} agent ` +
        `(run ${running.id}) is running on this epic`,
    );
  }

  if (!epic.user_id) {
    throw new Error(`Epic ${epicId} has no owning user`);
  }
  const owner = userDb.getUserById(epic.user_id);
  if (!owner) {
    throw new Error(`Epic ${epicId} owner (user ${epic.user_id}) not found or inactive`);
  }

  return { epic, owner };
}

/** A comment on the epic's final pull request. */
export async function triggerEpicDeliveryFromComment({
  epicId,
  commentBody,
  commentAuthor,
  fileContext,
  broadcastToConversationSubscribers,
  broadcastToEpicSubscribers,
}: TriggerEpicDeliveryFromCommentArgs): Promise<EpicDeliveryTriggerResult> {
  const { owner } = resolveEpicForDelivery(epicId);
  const broadcastFn = createBroadcastFn(broadcastToConversationSubscribers);

  const { agentRun, conversation } = await startEpicAgentRun(epicId, 'epic-delivery', {
    broadcastFn: broadcastFn ?? undefined,
    broadcastToEpicSubscribersFn: broadcastToEpicSubscribers,
    userId: owner.id,
    deliveryTrigger: {
      kind: 'comment',
      webhookContext: { commentBody, commentAuthor, fileContext: fileContext ?? null },
    },
  });

  console.log(
    `[Webhook] Triggered epic delivery for epic ${epicId}, conversation ${conversation.id}`,
  );
  return { conversationId: conversation.id, agentRunId: agentRun.id };
}

/** A submitted review on the epic's final pull request. */
export async function triggerEpicDeliveryFromReview({
  epicId,
  reviewBody,
  reviewAuthor,
  comments,
  broadcastToConversationSubscribers,
  broadcastToEpicSubscribers,
}: TriggerEpicDeliveryFromReviewArgs): Promise<EpicDeliveryTriggerResult> {
  const { owner } = resolveEpicForDelivery(epicId);
  const broadcastFn = createBroadcastFn(broadcastToConversationSubscribers);

  const { agentRun, conversation } = await startEpicAgentRun(epicId, 'epic-delivery', {
    broadcastFn: broadcastFn ?? undefined,
    broadcastToEpicSubscribersFn: broadcastToEpicSubscribers,
    userId: owner.id,
    deliveryTrigger: {
      kind: 'review',
      webhookContext: { reviewBody, reviewAuthor, comments },
    },
  });

  console.log(
    `[Webhook] Triggered epic delivery for epic ${epicId} from review, ` +
      `conversation ${conversation.id}`,
  );
  return { conversationId: conversation.id, agentRunId: agentRun.id };
}
