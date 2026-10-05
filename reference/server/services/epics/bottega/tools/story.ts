// The stories stage's tools — how an epic's tickets get created.
//
// Every one of them delegates to the same services the REST routes call, so an
// agent-created ticket is byte-for-byte a human-created one: the row, the
// worktree forked off the epic's feature branch, the task doc on disk. That
// equivalence is the whole point — ticket-level agents must never be able to
// tell whether a human or the stories agent wrote their ticket.
//
// The ticket list is the source of truth for the story split. There is no
// `stories.md` in the epic's docs: a second copy would drift on every
// update/delete, and an implementing agent pointed at one specification
// document must never find an epic-wide ticket list sitting next to it.

import { z } from 'zod';
import { definePortableTool as tool } from '../../../conversation/portableTool.js';
import { epicsDb, epicTicketsDb } from '../../../../database/epics.js';
import { ok, okJson, fail, errText } from '../toolResult.js';
import {
  isUnsavedWorktreeWorkError,
  describeUnsavedWork,
} from '../../../worktreeSafety.js';
import type { EpicTicketWithTask, TaskRow } from '@shared/types/db';

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 20_000;

/**
 * Loaded on demand so this module stays a leaf: `taskService` reaches the
 * transcript store through `deleteTaskCompletely`'s message purge, and pulling
 * that into the tool catalog would make every consumer of the catalog — and
 * every test that touches it — stand the store up. Same reason
 * `agentRunLifecycle` defers the orchestrator bridge. `ticketService` (the
 * epic layer's own creation/ordering service) is deferred for the same
 * import-graph reason: it reaches taskService.
 */
const taskApi = () => import('../../../tasks/index.js');
const ticketService = () => import('../../ticketService.js');

export interface StoryToolContext {
  epicId: number;
  /** Acting user; falls back to the epic's creator, as `startEpicAgentRun` does. */
  userId?: number | undefined;
}

/**
 * Has any ticket of this epic left the drawing board? Once one has, the list is
 * closed: tickets are executed in order, and inserting into a sequence that is
 * already being worked is re-planning, which v1 deliberately does not support
 * (the user escalates instead).
 *
 * Kept alongside the durable `orchestration_active` flag rather than replaced by
 * it: this catches a ticket a human started by hand, which the flag does not.
 */
async function firstStartedTicket(epicId: number): Promise<TaskRow | null> {
  const { taskHasAgentRuns } = await taskApi();
  return (
    epicTicketsDb
      .listTickets(epicId)
      .find((t) => t.status !== 'pending' || taskHasAgentRuns(t.id)) ?? null
  );
}

/**
 * Why this ticket can no longer be revised, or null while it still can.
 * Deliberately strict: rewriting the description of a ticket an agent is
 * already implementing would change the brief underneath it.
 */
async function revisionBlocker(task: TaskRow): Promise<string | null> {
  if (task.status !== 'pending') {
    return `Task ${task.id} is '${task.status}' — work on it has already started`;
  }
  const { taskHasAgentRuns } = await taskApi();
  if (taskHasAgentRuns(task.id)) {
    return `Task ${task.id} already has agent runs`;
  }
  return null;
}

const CLOSED_HINT =
  'Revisions are closed for it. Create a follow-up ticket for the extra work instead, or ask the user to handle it manually.';

/** One row of `list_epic_tasks`. */
async function summarize(task: EpicTicketWithTask, index: number, description: string | null) {
  return {
    taskId: task.id,
    position: task.position ?? index + 1,
    title: task.title,
    status: task.status,
    revisable: (await revisionBlocker(task)) === null,
    ...(description === null ? {} : { description }),
  };
}

export function buildStoryTools(ctx: StoryToolContext) {
  const { epicId } = ctx;

  /** Epic + acting user, or the reason neither could be resolved. */
  function resolve(): { userId: number } | string {
    const epic = epicsDb.getById(epicId);
    if (!epic) return `Epic ${epicId} no longer exists.`;
    const userId = ctx.userId ?? epic.user_id;
    if (userId == null) {
      return `Epic ${epicId} has no owning user, so tickets cannot be created for it.`;
    }
    return { userId };
  }

  /** A ticket of THIS epic, or the refusal to hand back to the model. */
  async function requireOwnTask(taskId: number): Promise<TaskRow | string> {
    const { getTask } = await taskApi();
    const task = getTask(taskId);
    if (!task) return `Task ${taskId} does not exist.`;
    if (epicTicketsDb.epicOf(taskId) !== epicId) {
      return `Task ${taskId} does not belong to this epic. Use list_epic_tasks to see the tickets you may act on.`;
    }
    return task;
  }

  const createTask = tool(
    'create_task',
    'Create one ticket for this epic. Tickets are executed in creation order, so create them in the ' +
      'order they must be implemented. The description becomes the ticket document and is the ONLY ' +
      'thing the implementing agent will ever see about this epic — write it self-contained. ' +
      'Call this only after the user has agreed to a concrete list of tickets.',
    {
      title: z
        .string()
        .trim()
        .min(1)
        .max(TITLE_MAX)
        .describe('Short imperative title, e.g. "Add the pricing_tier table and its migration".'),
      description: z
        .string()
        .min(1)
        .max(DESCRIPTION_MAX)
        .describe(
          'The full ticket document in markdown: goal, context (extracts and/or absolute paths to ' +
            'the specification documents), scope, out of scope, dependencies, acceptance criteria.',
        ),
    },
    async ({ title, description }) => {
      try {
        const resolved = resolve();
        if (typeof resolved === 'string') return fail(resolved);

        // Two ways the sequence can already be under way: the orchestrator is
        // executing it (durable flag, true even before ticket 1 starts), or a
        // ticket left `pending` on its own (a human pressed Run).
        if (epicsDb.getById(epicId)?.orchestration_active) {
          return fail(
            'This epic is being implemented by its orchestrator, so the ticket list is closed to ' +
              'new tickets. Tell the user what you wanted to add and let them decide.',
          );
        }
        const started = await firstStartedTicket(epicId);
        if (started) {
          return fail(
            `Task ${started.id} of this epic has already started, so the ticket list is closed to new tickets. ` +
              'Tell the user what you wanted to add and let them decide.',
          );
        }

        const { createEpicTicket } = await ticketService();
        const result = await createEpicTicket(
          epicId,
          { title, description },
          resolved.userId,
        );
        if (!result.success || !result.task) {
          return fail(
            `Failed to create the ticket: ${result.error ?? 'unknown error'}. ` +
              'Report this to the user — it usually means the repository or its feature branch needs attention.',
          );
        }

        const task = result.task;
        console.log(`[bottega] Epic ${epicId}: created task ${task.id} ("${title}")`);
        return okJson({
          taskId: task.id,
          position: task.position ?? null,
          title: task.title,
          ...(result.baseBranch ? { baseBranch: result.baseBranch } : {}),
          ...(result.warning ? { warning: result.warning } : {}),
        });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const listEpicTasks = tool(
    'list_epic_tasks',
    "List this epic's tickets in execution order. `revisable` tells you whether a ticket can still " +
      'be updated or deleted — once work has started on one, it is frozen.',
    {
      includeDescriptions: z
        .boolean()
        .optional()
        .describe(
          'Include each ticket document in full. Use when reviewing or revising tickets written ' +
            'in an earlier session; leave it off to keep the list short.',
        ),
    },
    async ({ includeDescriptions }) => {
      try {
        const { readTaskDoc } = await taskApi();
        const tasks = epicTicketsDb.listTickets(epicId);
        return okJson({
          epicId,
          tasks: await Promise.all(
            tasks.map((task, index) =>
              summarize(
                task,
                index,
                includeDescriptions ? readTaskDoc(task.project_id, task.id) : null,
              ),
            ),
          ),
        });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const updateTask = tool(
    'update_task',
    'Revise a ticket you created: its title, its description (replaced in full), or its position in ' +
      'the execution order. Only tickets that have not started yet can be revised.',
    {
      taskId: z.number().int().positive().describe('Ticket to revise, from list_epic_tasks.'),
      title: z.string().trim().min(1).max(TITLE_MAX).optional(),
      description: z
        .string()
        .min(1)
        .max(DESCRIPTION_MAX)
        .optional()
        .describe('Replaces the ticket document entirely — pass the whole document, not a patch.'),
      position: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('New 1-based position in the execution order; the other tickets shift around it.'),
    },
    async ({ taskId, title, description, position }) => {
      try {
        if (title === undefined && description === undefined && position === undefined) {
          return fail('Nothing to update. Pass at least one of title, description or position.');
        }

        const task = await requireOwnTask(taskId);
        if (typeof task === 'string') return fail(task);

        const blocker = await revisionBlocker(task);
        if (blocker) return fail(`${blocker}. ${CLOSED_HINT}`);

        const { getTask, updateTaskTitle, writeTaskDoc } = await taskApi();
        const changed: string[] = [];
        if (title !== undefined) {
          updateTaskTitle(taskId, title);
          changed.push('title');
        }
        if (description !== undefined) {
          writeTaskDoc(task.project_id, taskId, description);
          changed.push('description');
        }
        if (position !== undefined) {
          const { moveTicket } = await ticketService();
          moveTicket(epicId, taskId, position);
          changed.push('position');
        }

        const updated = getTask(taskId);
        console.log(`[bottega] Epic ${epicId}: updated task ${taskId} (${changed.join(', ')})`);
        return okJson({
          taskId,
          updated: changed,
          position: epicTicketsDb.get(taskId)?.position ?? null,
          title: updated?.title ?? null,
        });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const deleteTask = tool(
    'delete_task',
    'Delete a ticket of this epic, with its worktree and its document. Only tickets that have not ' +
      'started yet can be deleted. The remaining tickets keep their relative order.',
    {
      taskId: z.number().int().positive().describe('Ticket to delete, from list_epic_tasks.'),
    },
    async ({ taskId }) => {
      try {
        const task = await requireOwnTask(taskId);
        if (typeof task === 'string') return fail(task);

        const blocker = await revisionBlocker(task);
        if (blocker) return fail(`${blocker}. ${CLOSED_HINT}`);

        const { getTask, deleteTaskCompletely } = await taskApi();
        const withProject = getTask(taskId);
        if (!withProject) return fail(`Task ${taskId} does not exist.`);

        // Never force: a ticket whose worktree already holds work is not a
        // ticket the stories agent should be silently throwing away.
        const deleted = await deleteTaskCompletely(withProject);
        if (!deleted) return fail(`Task ${taskId} could not be deleted; it may already be gone.`);

        // Close the gap the deletion left, so positions stay 1..N.
        const { renumberTickets } = await ticketService();
        const remaining = renumberTickets(epicId);

        console.log(`[bottega] Epic ${epicId}: deleted task ${taskId}`);
        return ok(`Task ${taskId} deleted. ${remaining.length} ticket(s) remain in this epic.`);
      } catch (e) {
        if (isUnsavedWorktreeWorkError(e)) {
          return fail(
            `Task ${taskId} has ${describeUnsavedWork(e.safety)} in its worktree, so deleting it ` +
              'would destroy work. Leave the ticket in place and tell the user what is in it — ' +
              'only they can decide whether to keep or discard it.',
          );
        }
        return fail(errText(e));
      }
    },
  );

  return [createTask, listEpicTasks, updateTask, deleteTask];
}
