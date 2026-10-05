// The shared ticket-supervision verbs — how a dormant supervising agent (the
// orchestrator, the QA fix agent) drives one ticket from planification to the
// pull request.
//
// Every verb here wraps the exact service the human UI calls: `startAgentRun`
// (the Run buttons), `resolveAskUserQuestion` (the question widget's WS
// handler) and `sendMessage` (typing into a planification conversation). That
// equivalence is load-bearing: a ticket-level agent must never be able to tell
// whether a human or a supervisor is on the other side.
//
// Two guards run on every taskId the model passes: the task exists, and it
// belongs to THIS epic. A supervisor can only ever touch its own tickets.
//
// What differs between supervisors is injected through the options: what runs
// before every state-changing act (the orchestrator resumes a blocked epic;
// the QA fix agent needs nothing), and what `resume_ticket(pr)` promises
// happens once the pull request is open (the server-started reviewer vs "you
// will be woken to review it yourself").

import { z } from 'zod';
import { definePortableTool as tool } from '../../../conversation/portableTool.js';
import { epicsDb, epicAgentRunsDb, epicTicketsDb } from '../../../../database/epics.js';
import { ok, okJson, fail, errText } from '../toolResult.js';
import { buildTranscriptTool } from './transcript.js';
import type { EpicAgentRunRow } from '@shared/types/db';
import type {
  BroadcastFn,
  BroadcastToEpicSubscribersFn,
  BroadcastToTaskSubscribersFn,
} from '@shared/websocket/messages';

/**
 * The task domain's public facade — every act on a ticket goes through it
 * (the MCP rule, architecture-v2): the same functions the human routes call.
 * Loaded on demand: the facade reaches `startConversation`, which imports the
 * injection layer that builds THIS catalog — a static import would be a
 * load-time cycle. Same reason as the lazy `taskService` in `story.ts`.
 */
const taskApi = () => import('../../../tasks/index.js');
const conversationAdapter = () => import('../../../conversation/startConversation.js');
const askUserQuestion = () => import('../../../conversation/askUserQuestion.js');
/** Also lazy: `notifications` pulls `taskService`, and with it the transcript store. */
const notifications = () => import('../../../notifications.js');

export const FEEDBACK_MAX = 20_000;

export interface TicketSupervisionContext {
  epicId: number;
  /** The ticket this conversation supervises; null on a manual epic chat. */
  ticketTaskId?: number | null | undefined;
  userId?: number | undefined;
  broadcastFn?: BroadcastFn | undefined;
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
  broadcastToEpicSubscribersFn?: BroadcastToEpicSubscribersFn | undefined;
}

export interface TicketSupervisionOptions {
  /**
   * Runs right before every state-changing act; returns a sentence to append
   * to the tool result, or ''. The orchestrator passes its resume-if-blocked
   * hook here — a run started under a blocked epic would be a stranded one.
   */
  beforeAct?: () => string;
  /** What `resume_ticket(pr)`'s success text promises once the PR is open. */
  prResumeSuffix: string;
}

/**
 * The supervision verbs, in the order the orchestrator has always listed them
 * — `notify_user` last, so a caller can splice its own tools in front of it.
 */
export function buildTicketSupervisionTools(
  ctx: TicketSupervisionContext,
  options: TicketSupervisionOptions,
) {
  const { epicId } = ctx;
  const beforeAct = options.beforeAct ?? (() => '');

  /** Options every `startAgentRun` / `sendMessage` call from here shares. */
  function runOptions() {
    return {
      broadcastFn: ctx.broadcastFn,
      broadcastToTaskSubscribersFn: ctx.broadcastToTaskSubscribersFn,
      userId: ctx.userId,
    };
  }

  /** A ticket of THIS epic (flags via the task facade), or the refusal to hand back. */
  async function requireOwnTaskFlags(taskId: number) {
    const { taskFlags } = await taskApi();
    const flags = taskFlags(taskId);
    if (!flags) return `Task ${taskId} does not exist.`;
    if (epicTicketsDb.epicOf(taskId) !== epicId) {
      return `Task ${taskId} does not belong to this epic. Use get_epic_state to see the tickets you may act on.`;
    }
    return flags;
  }

  /**
   * Why this ticket cannot take another agent right now, or null. One agent
   * at a time, as in the UI. This is deliberately task-local; reviewer
   * ownership and concurrency are enforced separately by the epic layer.
   */
  async function busyReasonFor(taskId: number): Promise<string | null> {
    const { getRunningAgentForTask, taskFlags } = await taskApi();
    // Woken by `worktree-setup-ended` (the task event subscriber).
    if (taskFlags(taskId)?.worktreeState === 'provisioning') {
      return 'its worktree is still being set up';
    }
    const run = getRunningAgentForTask(taskId);
    return run
      ? `a ${run.agent_type} agent (run ${run.id}) is running on this task`
      : null;
  }

  /** The newest PR-review run of this ticket, or null. Epic-scoped, keyed by `ticket_task_id`. */
  function latestPrReviewRun(taskId: number): EpicAgentRunRow | null {
    return (
      epicAgentRunsDb
        .getByEpic(epicId)
        .filter((r) => r.agent_type === 'epic-pr-review' && r.ticket_task_id === taskId)
        .sort((a, b) => b.id - a.id)[0] ?? null
    );
  }

  /** The same ownership guard, reduced to what a read-only tool needs. */
  async function refuseForeignTask(taskId: number): Promise<string | null> {
    const flags = await requireOwnTaskFlags(taskId);
    return typeof flags === 'string' ? flags : null;
  }

  const getEpicState = tool(
    'get_epic_state',
    "The epic's current state, read fresh from the database: its stage flags, its orchestration " +
      'status, and every ticket in execution order with the flags that say where it stands. ' +
      'Call this whenever you need to know where you are — never rely on what an earlier turn told you.',
    {},
    async () => {
      try {
        const epic = epicsDb.getById(epicId);
        if (!epic) return fail(`Epic ${epicId} no longer exists.`);
        const { taskFlags } = await taskApi();
        const tickets = epicTicketsDb.listTickets(epicId);
        return okJson({
          epicId,
          name: epic.name,
          status: epic.status,
          featureBranch: epic.feature_branch,
          orchestrationActive: !!epic.orchestration_active,
          orchestrationBlocked: !!epic.orchestration_blocked,
          orchestrationBlockedReason: epic.orchestration_blocked_reason,
          currentTicketId: ctx.ticketTaskId ?? null,
          tickets: tickets.map((t, index) => ({
            taskId: t.id,
            position: t.position ?? index + 1,
            title: t.title,
            ...taskFlags(t.id),
          })),
        });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const startPlanification = tool(
    'start_planification',
    'Start the planification agent on a ticket — the same thing a human clicking "Run planification" ' +
      'does. It reads the ticket document and writes a plan, asking you questions along the way. ' +
      'END YOUR TURN after this: you will be woken when it needs you.',
    {
      taskId: z.number().int().positive().describe('Ticket to plan, from get_epic_state.'),
    },
    async ({ taskId }) => {
      try {
        const flags = await requireOwnTaskFlags(taskId);
        if (typeof flags === 'string') return fail(flags);
        if (flags.planificationComplete) {
          return fail(
            `Task ${taskId} already has a finished plan. Read it with read_task_plan and decide ` +
              'whether to approve it or send feedback.',
          );
        }
        const busyReason = await busyReasonFor(taskId);
        if (busyReason) {
          return fail(
            `Task ${taskId} is busy: ${busyReason}. End your turn — you will be woken with the ` +
              'result.',
          );
        }

        const resumedNote = beforeAct();
        const { startAgentRun } = await taskApi();
        const { agentRun } = await startAgentRun(taskId, 'planification', {
          ...runOptions(),
          // The run is automation-driven: technical prompt variant, no
          // auto-chain out of planification, no push on turn end — the
          // supervisor reviews the plan itself.
          driver: 'automation',
        });
        return ok(
          `Planification started on task ${taskId} (run ${agentRun.id}).${resumedNote} End your ` +
            'turn now — you will be woken when it asks a question or finishes.',
        );
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const getPendingQuestion = tool(
    'get_pending_question',
    'The questions a ticket agent is currently parked on, if any. Use it after a question-pending ' +
      'event to read exactly what is being asked before you answer.',
    {
      taskId: z.number().int().positive(),
    },
    async ({ taskId }) => {
      try {
        const flags = await requireOwnTaskFlags(taskId);
        if (typeof flags === 'string') return fail(flags);

        const { pendingQuestion } = await taskApi();
        const pending = pendingQuestion(taskId);
        if (pending) {
          return okJson({
            taskId,
            agentType: pending.agentType,
            conversationId: pending.conversationId,
            questions: pending.questions,
          });
        }
        return ok(
          `No agent on task ${taskId} is waiting for an answer right now. If you were told one was, ` +
            'the server may have restarted while it waited — answer_question still works in that ' +
            'case, using the question text from the event that woke you.',
        );
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const answerQuestion = tool(
    'answer_question',
    "Answer a ticket agent's questions. This is the same call the human answer widget makes, so " +
      'the agent cannot tell you apart from a person — answer from the specification documents and ' +
      'the epic context you hold, never with "up to you". END YOUR TURN after answering.',
    {
      taskId: z.number().int().positive(),
      answers: z
        .record(z.string(), z.string())
        .describe(
          'One entry per question, keyed by the exact question text from get_pending_question, ' +
            'valued with your chosen answer.',
        ),
    },
    async ({ taskId, answers }) => {
      try {
        const flags = await requireOwnTaskFlags(taskId);
        if (typeof flags === 'string') return fail(flags);

        // Prefer the conversation that is actually parked; fall back to the
        // newest run so the restart path (no in-memory entry) still resolves.
        const { pendingQuestion, latestRunWithConversation } = await taskApi();
        const conversationId =
          pendingQuestion(taskId)?.conversationId ??
          latestRunWithConversation(taskId)?.conversation_id ??
          null;
        if (conversationId == null) {
          return fail(`Task ${taskId} has no agent conversation to answer.`);
        }

        const resumedNote = beforeAct();
        const { resolveAskUserQuestion } = await askUserQuestion();
        const result = await resolveAskUserQuestion(conversationId, answers, {
          ...runOptions(),
          permissionMode: 'bypassPermissions',
        });
        return ok(
          `Answered (${result.kind}) on task ${taskId}.${resumedNote} The agent is running ` +
            'again — end your turn.',
        );
      } catch (e) {
        return fail(
          `${errText(e)}. If nothing is waiting for an answer, use get_task_progress to see where ` +
            'the ticket actually stands.',
        );
      }
    },
  );

  const readTaskPlan = tool(
    'read_task_plan',
    "A ticket's document as it stands — the brief plus the plan the planification agent appended " +
      'to it. This is exactly what the implementing agent will read, so review it as such.',
    {
      taskId: z.number().int().positive(),
    },
    async ({ taskId }) => {
      try {
        const flags = await requireOwnTaskFlags(taskId);
        if (typeof flags === 'string') return fail(flags);
        if (!flags.planificationComplete) {
          return fail(
            `Task ${taskId} has no finished plan yet. Wait for the planification-turn-ended event.`,
          );
        }
        const { getTask, readTaskDoc } = await taskApi();
        const task = getTask(taskId);
        if (!task) return fail(`Task ${taskId} does not exist.`);
        const doc = readTaskDoc(task.project_id, taskId);
        if (!doc.trim()) {
          return fail(
            `Task ${taskId} is marked planned but its document is empty. Escalate — there is ` +
              'nothing to review.',
          );
        }
        return ok(doc);
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const sendFeedbackToPlanification = tool(
    'send_feedback_to_planification',
    'Send a revision request into the planification conversation, as a plain message — exactly what ' +
      'a human would type. Be specific about what is wrong and what the plan must say instead. ' +
      'END YOUR TURN: the agent revises and you are woken again.',
    {
      taskId: z.number().int().positive(),
      message: z
        .string()
        .trim()
        .min(1)
        .max(FEEDBACK_MAX)
        .describe('Your feedback, written for the planification agent to act on directly.'),
    },
    async ({ taskId, message }) => {
      try {
        const flags = await requireOwnTaskFlags(taskId);
        if (typeof flags === 'string') return fail(flags);

        const busyReason = await busyReasonFor(taskId);
        if (busyReason) {
          return fail(`Task ${taskId} is busy: ${busyReason}. Wait to be woken.`);
        }
        const { latestRunWithConversation } = await taskApi();
        const run = latestRunWithConversation(taskId, 'planification');
        if (!run?.conversation_id) {
          return fail(
            `Task ${taskId} has no planification conversation. Start one with start_planification.`,
          );
        }

        const resumedNote = beforeAct();
        const { sendMessage } = await conversationAdapter();
        // Fire-and-forget, like the REST 202 bridge: the reply streams into the
        // conversation and the turn-end hook wakes us.
        void sendMessage(run.conversation_id, message, {
          ...runOptions(),
          permissionMode: 'bypassPermissions',
        }).catch((err: unknown) => {
          console.error(`[bottega] Feedback to planification of task ${taskId} failed:`, err);
        });
        return ok(
          `Feedback sent to the planification agent of task ${taskId}.${resumedNote} End your ` +
            'turn — you will be woken when it has revised the plan.',
        );
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const approvePlan = tool(
    'approve_plan_and_start_implementation',
    'Approve the plan and start implementation. From here the ticket runs itself — implementation, ' +
      'review, refinement and the PR agent chain automatically — and you hear nothing until the PR ' +
      'agent finishes or something fails. END YOUR TURN.',
    {
      taskId: z.number().int().positive(),
    },
    async ({ taskId }) => {
      try {
        const flags = await requireOwnTaskFlags(taskId);
        if (typeof flags === 'string') return fail(flags);
        if (!flags.planificationComplete) {
          return fail(
            `Task ${taskId} has no finished plan to approve. Start planification first.`,
          );
        }
        const busyReason = await busyReasonFor(taskId);
        if (busyReason) {
          return fail(`Task ${taskId} is busy: ${busyReason}. Wait to be woken.`);
        }

        const resumedNote = beforeAct();
        const { startAgentRun } = await taskApi();
        // 'automation' is inherited down the implementation → review →
        // refinement → pr chain, so the whole autonomous stretch keeps the
        // driver policies (no per-turn pushes; the supervisor supervises).
        const { agentRun } = await startAgentRun(taskId, 'implementation', {
          ...runOptions(),
          driver: 'automation',
        });
        return ok(
          `Implementation started on task ${taskId} (run ${agentRun.id}).${resumedNote} The ` +
            'implementation -> review -> refinement -> PR chain now runs on its own. End your turn.',
        );
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const resumeTicket = tool(
    'resume_ticket',
    'Unblock a ticket and restart one of its agents — what a human clicking "Resume" or a Run ' +
      'button does, plus the correction they would have typed. This is how you restart ANY ' +
      'stage that stopped, whether it blocked itself or died on a provider error. Call it once ' +
      'you have diagnosed the stop and dealt with it. `review` re-verifies and can finish the ' +
      'ticket (usual after a review agent blocked); `implementation` reopens the code when the ' +
      'work itself is wrong; `pr` re-runs the pull-request agent on a ticket whose code is done ' +
      'but whose pull request was never opened. The chain runs on from there. END YOUR TURN.',
    {
      taskId: z.number().int().positive(),
      agentType: z
        .enum(['implementation', 'review', 'pr'])
        .describe('Which agent picks the ticket back up.'),
      note: z
        .string()
        .trim()
        .min(1)
        .max(FEEDBACK_MAX)
        .optional()
        .describe(
          'What you fixed, verified, or are overruling — written for the agent to act on.',
        ),
    },
    async ({ taskId, agentType, note }) => {
      try {
        const flags = await requireOwnTaskFlags(taskId);
        if (typeof flags === 'string') return fail(flags);
        // `workflowComplete` alone does NOT mean the ticket is finished: it is
        // set the moment review passes, and stays set for the whole refinement
        // → PR stretch. A ticket sitting there with `prAgentComplete` false is
        // exactly the one that needs resuming (a PR agent that died leaves the
        // work uncommitted and no pull request). Only both flags together mean
        // there is nothing left to do.
        if (flags.workflowComplete && flags.prAgentComplete) {
          return fail(
            `Task ${taskId} has already completed its workflow and opened its pull request — ` +
              'there is nothing to resume.',
          );
        }
        const busyReason = await busyReasonFor(taskId);
        if (busyReason) {
          return fail(`Task ${taskId} is busy: ${busyReason}. Wait to be woken.`);
        }

        const { unblockTask, startAgentRun } = await taskApi();
        const blockedReason = flags.workflowBlockedReason;
        if (flags.workflowBlocked && !unblockTask(taskId)) {
          return fail(`Task ${taskId} disappeared while unblocking it.`);
        }

        const resumedNote = beforeAct();
        const { agentRun } = await startAgentRun(taskId, agentType, {
          ...runOptions(),
          driver: 'automation',
          ...(note ? { extraContext: note } : {}),
        });
        return ok(
          `Task ${taskId} unblocked${blockedReason ? ` (was: ${blockedReason})` : ''} and the ` +
            `${agentType} agent restarted (run ${agentRun.id}).${resumedNote} The chain runs on ` +
            'its own from here' +
            (agentType === 'pr' ? options.prResumeSuffix : '') +
            '. End your turn.',
        );
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const getTaskProgress = tool(
    'get_task_progress',
    'Where one ticket stands: its flags, its agent runs, its pull request and CI, and the absolute ' +
      'path of its worktree so you can Read the code it produced.',
    {
      taskId: z.number().int().positive(),
    },
    async ({ taskId }) => {
      try {
        const flags = await requireOwnTaskFlags(taskId);
        if (typeof flags === 'string') return fail(flags);

        const { taskProgress } = await taskApi();
        const progress = await taskProgress(taskId);
        if (!progress) return fail(`Task ${taskId} does not exist.`);

        // The PR reviewer is an EPIC run bound to this ticket, not a task run.
        const prReview = latestPrReviewRun(taskId);

        return okJson({
          ...progress,
          prReview: prReview
            ? { runId: prReview.id, status: prReview.status, conversationId: prReview.conversation_id }
            : null,
        });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  const notifyUser = tool(
    'notify_user',
    'Send the user a one-line notification without stopping. For things worth knowing but not ' +
      'worth waiting on — a ticket merged, the epic finished, a decision you took on their behalf.',
    {
      message: z.string().trim().min(1).max(500),
    },
    async ({ message }) => {
      try {
        const epic = epicsDb.getById(epicId);
        if (!epic) return fail(`Epic ${epicId} no longer exists.`);
        const notifyUserId = ctx.userId ?? epic.user_id;
        if (!notifyUserId) {
          return fail('There is no user to notify for this epic.');
        }
        const { sendBannerNotification } = await notifications();
        void sendBannerNotification(notifyUserId, `Epic: ${epic.name}`, message, {
          type: 'epic_update',
          projectId: String(epic.project_id),
        }).catch(() => {});
        return ok('Notification sent.');
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  return [
    getEpicState,
    startPlanification,
    getPendingQuestion,
    answerQuestion,
    readTaskPlan,
    sendFeedbackToPlanification,
    approvePlan,
    getTaskProgress,
    buildTranscriptTool(ctx, refuseForeignTask),
    resumeTicket,
    notifyUser,
  ];
}
