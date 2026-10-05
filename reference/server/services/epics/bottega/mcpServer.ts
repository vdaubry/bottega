// In-process 'bottega' MCP server — how the epic pipeline's agents act on
// Bottega itself. Tools surface to the model as `mcp__bottega__<name>`.
//
// The catalog is per agent type, not per conversation: an agent is handed
// exactly the verbs its stage is allowed to use, so the specification agent
// cannot create tickets and the stories agent cannot merge PRs. It grows by
// phase — Phase 4 shipped `mark_stage_complete`, Phase 5 the story tools,
// Phase 7 brings the orchestrator catalog.
//
// Same precedent (and the same shape) as the code-atlas server in
// `atlas/mcpServer.ts`: `createSdkMcpServer` runs the handlers inside this
// process, so they act as the acting user with no API key, no HTTP hop and no
// extra auth surface. Handlers re-read DB state per call — a conversation can
// span many turns and hours.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { buildStageTools } from './tools/stage.js';
import { buildStoryTools } from './tools/story.js';
import { buildOrchestratorTools } from './tools/orchestrator.js';
import { buildPrReviewTools } from './tools/prReview.js';
import { buildQaFixTools } from './tools/qaFix.js';
import { buildTicketSupervisionTools } from './tools/ticketSupervision.js';
import { buildDocumentTools, buildDocumentReadTools } from './tools/documents.js';
import { buildQaScenarioTools, buildQaExecutionTools } from './tools/qa.js';
import type { EpicAgentType } from '@shared/types/db';
import type {
  BroadcastFn,
  BroadcastToEpicSubscribersFn,
  BroadcastToTaskSubscribersFn,
} from '@shared/websocket/messages';
import type { PortableTool } from '../../conversation/portableTool.js';

export interface BottegaMcpContext {
  projectId?: number;
  epicId: number;
  agentType: EpicAgentType;
  conversationId: number;
  userId?: number | undefined;
  /**
   * The ticket an orchestrator conversation supervises, or a PR-review
   * conversation reviews — read off the linked agent run. Null for every other
   * stage.
   */
  ticketTaskId?: number | null | undefined;
  broadcastFn?: BroadcastFn | undefined;
  /**
   * The orchestrator starts TASK agent runs, so it needs the task channel as
   * well as the epic one — otherwise an open ticket page would go quiet while
   * the orchestrator drives it.
   */
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
  broadcastToEpicSubscribersFn?: BroadcastToEpicSubscribersFn | undefined;
}

/**
 * The tool catalog for one agent type. Each of the four gated stages ends with
 * the user approving its output in chat, so each carries its own
 * `mark_stage_complete`; the two document-writing stages (architecture,
 * specification) carry nothing else — their output is the files they write, not
 * a report to Bottega. The two implementation-stage agents have no sign-off:
 * the `implementation` stage has no flag, and its completion semantics live in
 * their own tools (`merge_task` on the PR reviewer, `open_epic_pr`/`notify_user`
 * on the orchestrator).
 */
export function toolsFor(ctx: BottegaMcpContext): PortableTool[] {
  switch (ctx.agentType) {
    case 'epic-architecture':
    case 'epic-specification':
      return [
        ...(ctx.projectId == null ? [] : buildDocumentTools({ ...ctx, projectId: ctx.projectId })),
        ...buildStageTools(ctx),
      ];
    case 'epic-stories':
      // The ticket verbs plus its own sign-off. This stage writes no files at
      // all — everything it produces flows through these tools.
      return [...buildStoryTools(ctx), ...buildStageTools(ctx)];
    case 'epic-spec-review':
      // The stories catalog plus its own sign-off: the reviewer revises the
      // tickets the user agrees need it (the documents it edits with its
      // writers), under the same revision-window guards as the stories stage.
      return [
        ...(ctx.projectId == null ? [] : buildDocumentTools({ ...ctx, projectId: ctx.projectId })),
        ...buildStoryTools(ctx),
        ...buildStageTools(ctx),
      ];
    case 'epic-orchestrator':
      // The drive-a-ticket catalog, up to the pull request. No
      // `mark_stage_complete`: the 'implementation' stage has no flag to flip.
      return buildOrchestratorTools(ctx);
    case 'epic-pr-review':
      // Merge and block — everything else the reviewer does with its shell.
      return buildPrReviewTools(ctx);
    case 'epic-delivery':
      // No Bottega tools at all. Delivery acts on GitHub and on the epic's
      // feature branch, both of which it reaches with `git` and `gh` from its
      // own worktree — there is no Bottega row for it to change. It signs no
      // stage off (delivery has no flag), creates no ticket, merges no task:
      // merging the final pull request stays a human act.
      return [];
    case 'epic-qa-scenarios':
      // Reads the whole archive, but writes the scenario book only through its
      // own structured tools — the handlers own the CSV serialization, so a
      // malformed book is impossible. Plus its sign-off: the user approving
      // the book is what flips `qa_complete` and opens execution's gate.
      return ctx.projectId == null
        ? []
        : [
            ...buildDocumentReadTools({ ...ctx, projectId: ctx.projectId }),
            ...buildQaScenarioTools({ ...ctx, projectId: ctx.projectId }),
            ...buildStageTools(ctx),
          ];
    case 'epic-qa-execution':
      // Results only. No `buildStageTools`: execution owns no stage (it would
      // throw for a null-stage agent, like delivery), and no scenario writers —
      // the executor may not reword the book it is executing.
      return ctx.projectId == null
        ? []
        : [
            ...buildDocumentReadTools({ ...ctx, projectId: ctx.projectId }),
            ...buildQaExecutionTools({ ...ctx, projectId: ctx.projectId }),
          ];
    case 'epic-qa-fix':
      // The supervision verbs the orchestrator uses (minus its
      // orchestration-only three: start_pr_review, open_epic_pr, block_epic —
      // the fix agent reviews and merges the PR itself and escalates through
      // notify_user), its own fix-ticket verbs + merge, the archive readers,
      // and the executor's `record_qa_results` for the self-run re-test.
      return ctx.projectId == null
        ? []
        : [
            ...buildTicketSupervisionTools(ctx, {
              prResumeSuffix:
                ' — when the pull request is open you will be woken to review and merge it yourself',
            }),
            ...buildQaFixTools({ ...ctx, projectId: ctx.projectId }),
            ...buildDocumentReadTools({ ...ctx, projectId: ctx.projectId }),
            ...buildQaExecutionTools({ ...ctx, projectId: ctx.projectId }),
          ];
  }
}

/**
 * Build the per-conversation server config. A fresh instance is created for
 * every turn (each `query()` call), closing over the epic and agent type the
 * conversation's linked agent run recorded.
 */
export function buildBottegaMcpServer(ctx: BottegaMcpContext): unknown {
  const tools = toolsFor(ctx);
  console.log(
    `[bottega] MCP server attached (epic=${ctx.epicId}, agent=${ctx.agentType}, ` +
      `conversation=${ctx.conversationId}, user=${ctx.userId ?? '?'}, tools=${tools.length})`,
  );
  return createSdkMcpServer({
    name: 'bottega',
    version: '0.1.0',
    tools: tools.map((definition) =>
      tool(
        definition.name,
        definition.description,
        definition.inputSchema,
        definition.handler,
      ),
    ) as never,
  });
}
