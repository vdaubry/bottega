// Conversation scope resolution: a conversation belongs to a task OR to an
// epic (`owner_kind` + the link tables), and everything the streaming
// machinery needs — the project it lives in, the working directory the
// provider runs in, and which WS channel carries its lifecycle events — is
// resolved by the OWNER'S adapter (architecture-v2 step 5): each domain
// resolves its own cwd and hands the runtime a resolved scope.

import { getOwnerAdapter, ownerAdapterFor } from './ownerAdapters.js';
import type { ConversationRow } from '../../../shared/types/db.js';

export type ConversationTarget =
  | { kind: 'task'; taskId: number }
  | {
      kind: 'epic';
      epicId: number;
      /**
       * Run the conversation in this ticket's worktree instead of the main
       * checkout. Only the PR reviewer sets it; the ticket must belong to the
       * epic and its worktree must exist (the epic adapter validates).
       */
      worktreeTaskId?: number;
      /**
       * Run the conversation in the epic's DELIVERY worktree — the feature
       * branch checked out at `{repo}-worktrees/epic-{id}` — instead of the
       * main checkout. Only `epic-delivery` runs set it; the epic adapter
       * creates the worktree on demand. Mutually exclusive with
       * `worktreeTaskId`.
       */
      deliveryWorktree?: boolean;
    };

export interface ConversationScope {
  kind: 'task' | 'epic';
  /** Set for task conversations, null for epic ones (and vice versa). */
  taskId: number | null;
  epicId: number | null;
  projectId: number;
  repoFolderPath: string;
  subprojectPath: string | null;
  /** Working directory the provider subprocess runs in. */
  cwd: string;
}

/** Owner of an existing conversation row, as a target. Throws when neither is set. */
export function targetFromConversation(conversation: ConversationRow): ConversationTarget {
  if (conversation.task_id != null) return { kind: 'task', taskId: conversation.task_id };
  if (conversation.epic_id != null) return { kind: 'epic', epicId: conversation.epic_id };
  throw new Error(`Conversation ${conversation.id} has neither task_id nor epic_id`);
}

/**
 * Resolve the full scope of a conversation target through its owner's
 * adapter. Async because the task branch probes the filesystem for a worktree.
 */
export async function resolveConversationScope(
  target: ConversationTarget,
): Promise<ConversationScope> {
  return getOwnerAdapter(target.kind).resolveScope(target);
}

/**
 * Synchronous, filesystem-free variant for authorization paths: they only need
 * the owning project (404-not-403 membership checks), never a working
 * directory. Returns null when the owner row has gone missing.
 */
export function resolveScopeFromConversation(
  conversation: ConversationRow,
): { taskId: number | null; epicId: number | null; projectId: number } | null {
  return ownerAdapterFor(conversation).resolveOwner(conversation);
}
