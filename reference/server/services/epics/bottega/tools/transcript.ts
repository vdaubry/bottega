// `read_agent_transcript` — the orchestrator's debugger.
//
// Every other channel between a ticket agent and its supervisor is a summary
// somebody chose to write: the "Review Findings" section, a block reason, a
// bridge event. Those carry a verdict, not the evidence for it, and the wake
// events for a failed run carry no detail at all. Diagnosis needs the turn
// itself — text, reasoning, every tool call with its arguments, every result
// with its errors, down into subagent transcripts.
//
// Orchestrator-only: it is the only agent whose job is diagnosing another
// agent's turn, and `mcpServer.ts` hands this catalog to `epic-orchestrator`
// and nothing else. Two guards still apply on every call: the task must exist,
// and it must be a ticket of THIS epic.

import { z } from 'zod';
import { definePortableTool as tool } from '../../../conversation/portableTool.js';
import { epicAgentRunsDb } from '../../../../database/epics.js';
import {
  readConversationTranscript,
  renderTranscript,
  TranscriptUnavailableError,
  DEFAULT_WINDOW,
  DEFAULT_BLOCK_CHARS,
} from '../../../conversation/transcriptReader.js';
import { ok, okJson, fail, errText } from '../toolResult.js';

const taskApi = () => import('../../../tasks/index.js');

/** The ticket-level stages, plus the epic-level reviewer bound to the ticket. */
const AGENT_TYPES = [
  'planification',
  'implementation',
  'review',
  'refinement',
  'pr',
  'yolo',
  'pr-review',
] as const;

export const MAX_TRANSCRIPT_WINDOW = 200;

export interface TranscriptToolContext {
  epicId: number;
}

interface RunRef {
  runId: number;
  agentType: string;
  status: string;
  conversationId: number | null;
  startedAt: string;
  endedAt: string | null;
}

/**
 * Build the ticket's run index: its task runs plus the epic-level PR reviews
 * bound to it, oldest first. This is what the tool answers with when the
 * caller names no run — a ticket that has been reviewed twice has two review
 * transcripts, and guessing which one it meant is exactly the failure mode
 * this tool exists to end.
 */
async function runsForTicket(epicId: number, taskId: number): Promise<RunRef[]> {
  const { taskAgentRuns } = await taskApi();
  const taskRuns: RunRef[] = taskAgentRuns(taskId).map((run) => ({
    runId: run.id,
    agentType: run.agent_type,
    status: run.status,
    conversationId: run.conversation_id,
    startedAt: run.created_at,
    endedAt: run.completed_at,
  }));
  const reviewRuns: RunRef[] = epicAgentRunsDb
    .getByEpic(epicId)
    .filter((run) => run.agent_type === 'epic-pr-review' && run.ticket_task_id === taskId)
    .map((run) => ({
      runId: run.id,
      agentType: 'pr-review',
      status: run.status,
      conversationId: run.conversation_id,
      startedAt: run.created_at,
      endedAt: run.completed_at,
    }));
  // Task and epic run ids come from different sequences, so order by time.
  return [...taskRuns, ...reviewRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function buildTranscriptTool(
  ctx: TranscriptToolContext,
  /** The epic's ownership guard: a refusal to hand back, or null when allowed. */
  requireOwnTask: (taskId: number) => Promise<string | null>,
) {
  return tool(
    'read_agent_transcript',
    "Read what an agent actually did on one of your tickets: its messages, its reasoning, every " +
      'tool call with its arguments and every result that came back, errors included. This is ' +
      'your debugger — when a ticket blocks, fails, or ends somewhere you did not expect, the ' +
      'explanation is in here, not in the flags. Read it BEFORE you diagnose, and never guess at ' +
      'a cause you could have read.\n\n' +
      'Call it with just `taskId` to list the ticket\'s runs, then again with `agentType` (or ' +
      '`runId`) to read one. Long runs are windowed: you get the last ' +
      `${DEFAULT_WINDOW} entries by default, page back with \`before\`, jump with \`search\`, and ` +
      'open a truncated tool result in full with `expand`.',
    {
      taskId: z.number().int().positive().describe('The ticket, from get_epic_state.'),
      agentType: z
        .enum(AGENT_TYPES)
        .optional()
        .describe(
          'Which stage to read; the newest run of that type wins. Omit (with runId) to list ' +
            "the ticket's runs. 'pr-review' is the epic-level reviewer of this ticket's PR.",
        ),
      runId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('A specific run from the listing — use it to read an earlier run of a stage.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_TRANSCRIPT_WINDOW)
        .optional()
        .describe(`Entries to return, ending at the newest. Default ${DEFAULT_WINDOW}.`),
      before: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Return the window ending just before this entry index — how you page back.'),
      search: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Keep only entries containing this text (case-insensitive) — the fast way to find an ' +
            'error, a tool name, or a filename in a long run.',
        ),
      expand: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Render one truncated block in full: pass the tool_use id shown next to it, or ' +
            '"#<entryIndex>".',
        ),
      subagent: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Read a subagent transcript instead of the main one, by the key listed in the header. ' +
            'The main transcript shows a subagent as one Task call with a summarized result; ' +
            'this is the turn it really ran.',
        ),
    },
    async ({ taskId, agentType, runId, limit, before, search, expand, subagent }) => {
      try {
        const refusal = await requireOwnTask(taskId);
        if (refusal) return fail(refusal);

        const runs = await runsForTicket(ctx.epicId, taskId);
        if (runs.length === 0) {
          return fail(
            `Ticket ${taskId} has never run an agent — there is no transcript. Start with ` +
              'start_planification.',
          );
        }

        // No selector: hand back the index rather than pick for them.
        if (agentType === undefined && runId === undefined) {
          return okJson({
            taskId,
            runs,
            next: 'Call again with agentType (newest run of that stage) or runId (a specific one).',
          });
        }

        const candidates = runs.filter(
          (run) =>
            (runId === undefined || run.runId === runId) &&
            (agentType === undefined || run.agentType === agentType),
        );
        const run = candidates[candidates.length - 1];
        if (!run) {
          return fail(
            `Ticket ${taskId} has no ${agentType ?? 'matching'} run` +
              `${runId === undefined ? '' : ` with id ${runId}`}. Call with just taskId to see ` +
              'what it does have.',
          );
        }
        if (run.conversationId == null) {
          return fail(
            `Run ${run.runId} (${run.agentType}, ${run.status}) has no conversation — it failed ` +
              'before starting one. There is nothing to read.',
          );
        }

        const window = await readConversationTranscript(run.conversationId, {
          ...(limit === undefined ? {} : { limit }),
          ...(before === undefined ? {} : { before }),
          ...(search === undefined ? {} : { search }),
          ...(subagent === undefined ? {} : { subagent }),
        });
        const header =
          `run ${run.runId} · ${run.agentType} · ${run.status} · started ${run.startedAt}` +
          `${run.endedAt ? ` · ended ${run.endedAt}` : ''}`;
        return ok(
          `${header}\n${renderTranscript(window, {
            ...(expand === undefined ? {} : { expand }),
            maxBlockChars: DEFAULT_BLOCK_CHARS,
          })}`,
        );
      } catch (e) {
        if (e instanceof TranscriptUnavailableError) return fail(e.message);
        return fail(errText(e));
      }
    },
  );
}
