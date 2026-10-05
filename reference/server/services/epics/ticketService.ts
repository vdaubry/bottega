// Ticket creation and ordering — the epic layer's own service (architecture-v2
// step 3). A ticket is an ordinary task whose base branch is the epic's
// feature branch; everything epic-specific about making one (validating the
// epic, ensuring the feature branch FIRST, recording membership and position)
// happens here, and the task itself is created through the task domain's
// public `createTaskWithWorktree` — the same function the human route calls.
//
// Membership and position live in the epic layer's own `epic_tickets` table
// (architecture-v2 step 5) — position renumbering is a plain epic-layer
// update, never a rewrite of task rows.

import { epicsDb, epicTicketsDb } from '../../database/epics.js';
import { getProject } from '../projectService.js';
import {
  createTaskWithWorktree,
  type CreateTaskResult,
  type CreatedTaskWithWorktree,
} from '../tasks/index.js';
import { isGitRepository } from '../worktree.js';
import { ensureEpicFeatureBranch } from './epicBranch.js';
import type { EpicTicketWithTask } from '@shared/types/db';

/** The requested epic does not exist or belongs to a different project. */
export class EpicNotInProjectError extends Error {
  constructor(public readonly epicId: number) {
    super(`Epic ${epicId} not found in this project`);
    this.name = 'EpicNotInProjectError';
  }
}

export interface CreateEpicTicketInput {
  title?: string | null | undefined;
  description?: string | undefined;
  /** Position in the epic. Omitted = appended after the epic's last ticket. */
  epicOrder?: number | null | undefined;
}

export interface CreateEpicTicketResult extends CreateTaskResult {
  task?: CreatedTaskWithWorktree & { position?: number };
  /** Branch the worktree forked from (the epic's feature branch). */
  baseBranch?: string;
  /** Non-fatal problem worth surfacing (e.g. the feature branch is local-only). */
  warning?: string;
}

/** Next free position in the epic — tickets are appended in creation order. */
function nextEpicOrder(epicId: number): number {
  const positions = epicTicketsDb.listTickets(epicId).map((t) => t.position);
  return positions.length === 0 ? 1 : Math.max(...positions) + 1;
}

/**
 * Create one ticket for an epic: validate the epic, ensure its feature branch
 * exists (FIRST — a ticket must never exist without the branch it forks
 * from), create the task with that branch as its base, then record epic
 * membership and position.
 */
export async function createEpicTicket(
  epicId: number,
  input: CreateEpicTicketInput,
  userId: number,
): Promise<CreateEpicTicketResult> {
  const epic = epicsDb.getById(epicId);
  if (!epic) {
    throw new EpicNotInProjectError(epicId);
  }
  const project = getProject(epic.project_id, userId);
  if (!project) {
    throw new EpicNotInProjectError(epicId);
  }

  let baseBranch: string | undefined;
  let warning: string | undefined;

  if (await isGitRepository(project.repo_folder_path)) {
    try {
      const ensured = await ensureEpicFeatureBranch(project.repo_folder_path, epicId);
      baseBranch = ensured.branch;
      warning = ensured.warning;
    } catch (error) {
      return {
        success: false,
        error: `Failed to prepare the epic branch: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  const result = await createTaskWithWorktree(
    project,
    {
      title: input.title,
      description: input.description,
      baseBranch: baseBranch ?? null,
    },
    userId,
  );
  if (!result.success || !result.task) {
    return { ...result, ...(warning ? { warning } : {}) };
  }

  const epicOrder = input.epicOrder ?? nextEpicOrder(epicId);
  epicTicketsDb.attach(epicId, result.task.id, epicOrder);

  return {
    ...result,
    task: { ...result.task, position: epicOrder },
    ...(baseBranch ? { baseBranch } : {}),
    ...(warning ? { warning } : {}),
  };
}

/**
 * Move a ticket to `position` (1-based) inside its epic and renumber the whole
 * sequence 1..N.
 *
 * Normalization is the point: `epic_order` has no unique index, and rows can
 * arrive with gaps, duplicates or NULLs — from an explicit `epicOrder` at
 * creation, or from a deletion in the middle. Rewriting every position after
 * each move keeps the orchestrator's `ORDER BY epic_order` deterministic
 * without a constraint.
 *
 * Out-of-range positions clamp to the ends rather than failing: an agent
 * asking for "position 99" of a 5-ticket epic means "last".
 */
export function moveTicket(
  epicId: number,
  taskId: number,
  position: number,
): EpicTicketWithTask[] {
  const ordered = epicTicketsDb.listTickets(epicId);
  const from = ordered.findIndex((t) => t.id === taskId);
  if (from === -1) return ordered;

  const [moved] = ordered.splice(from, 1);
  const target = Math.min(Math.max(1, Math.trunc(position)), ordered.length + 1);
  ordered.splice(target - 1, 0, moved!);

  ordered.forEach((ticket, index) => {
    if (ticket.position !== index + 1) epicTicketsDb.setPosition(ticket.id, index + 1);
  });

  return epicTicketsDb.listTickets(epicId);
}

/** Close the gap a deletion left, so positions stay 1..N. */
export function renumberTickets(epicId: number): EpicTicketWithTask[] {
  const remaining = epicTicketsDb.listTickets(epicId);
  remaining.forEach((ticket, index) => {
    if (ticket.position !== index + 1) epicTicketsDb.setPosition(ticket.id, index + 1);
  });
  return remaining;
}
