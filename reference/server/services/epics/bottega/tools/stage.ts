// `mark_stage_complete` — how an epic agent signs its own stage off.
//
// Every gated stage of the epic pipeline ends with the user approving the work
// in chat. The agent then records that approval itself by flipping the stage
// flag. That is all the tool does: the stage's OUTPUT — the architecture
// document, the specification documents, the tickets, and for the review the
// corrected state of all three — is the whole hand-off to the next stage, and
// the tool carries nothing beside it.
//
// There used to be a `summary` argument, a prose note written "for the next
// stage's agent" into `summaries/{stage}.md`. It was dropped on 2026-08-23: it
// created a second level of information next to the documents, capped at a
// size the prompts' own instructions overflowed, and — worse — gave the agent
// somewhere to put what it had left out of the documents. Whatever the next
// stage needs must be in the stage's output, and the stage prompts say so.
//
// Why a tool and not a CLI script: it works for every stage whatever its tool
// surface, the arguments are typed and validated, the guards are enforced
// server-side, and the effect broadcasts in-process to the epic page.
// Why not only a UI button: the transcript stays self-documenting — the
// approval lives in the conversation that produced it. The human "Mark stage
// complete" button (Phase 6) remains as a backstop.

import { z } from 'zod';
import { definePortableTool as tool } from '../../../conversation/portableTool.js';
import { epicsDb } from '../../../../database/epics.js';
import { broadcastEpicUpdated } from '../../epicEvents.js';
import {
  EPIC_STAGE_NAMES,
  FLAG_BY_STAGE,
  FLAG_COLUMN,
  STAGE_BY_AGENT_TYPE,
} from '../../epicStages.js';
import { ok, fail, errText } from '../toolResult.js';
import type { EpicAgentType } from '@shared/types/db';
import type { BroadcastToEpicSubscribersFn } from '@shared/websocket/messages';

export interface StageToolContext {
  epicId: number;
  agentType: EpicAgentType;
  broadcastToEpicSubscribersFn?: BroadcastToEpicSubscribersFn | undefined;
}

export function buildStageTools(ctx: StageToolContext) {
  const { epicId, agentType, broadcastToEpicSubscribersFn } = ctx;
  const ownStage = STAGE_BY_AGENT_TYPE[agentType];
  // Only the four framing stages get this tool (`toolsFor`); an agent that owns
  // no stage — delivery — has nothing to sign off, and a tool built without a
  // stage would describe itself as completing 'undefined'.
  if (!ownStage) {
    throw new Error(`Agent type '${agentType}' owns no stage and cannot be given stage tools`);
  }

  // The review stage's wording differs in one respect: its sign-off also
  // asserts that every finding the user approved has been applied to the
  // documents and tickets — the approval is of a clean state, not of a report.
  const description =
    ownStage === 'review'
      ? `Record that the '${ownStage}' stage of this epic is finished and approved by the user: ` +
        'the review was discussed, every finding the user approved has been applied to the ' +
        'functional specification, the architecture document, the technical specification or ' +
        'the tickets, every finding the ' +
        'user discarded is recorded as such in the report, and the user has explicitly said the ' +
        'epic is ready for implementation. Call this ONLY on that explicit approval — never on ' +
        'your own judgement that the review is done, and never while an approved fix is still ' +
        'unapplied. It opens autonomous implementation, which nobody re-checks.'
      : ownStage === 'qa'
        ? `Record that the '${ownStage}' stage of this epic is finished: the user has explicitly ` +
          'approved the scenario book, with every revision they asked for already applied to the ' +
          'CSV. Call this ONLY on that explicit approval — never on your own judgement that ' +
          'coverage looks complete, and a message with no feedback is not approval. It opens QA ' +
          'execution, which runs the book exactly as written.'
        : `Record that the '${ownStage}' stage of this epic is finished and approved by the user. ` +
          'Call this ONLY after the user has explicitly approved the work in this conversation — ' +
          'never on your own judgement that the output looks done. ' +
          'It takes no summary: what this stage produced (its documents, its tickets) is the ' +
          'only thing the next stage receives, so anything worth carrying forward must already ' +
          'be in that output before you call this.';

  const markStageComplete = tool(
    'mark_stage_complete',
    description,
    {
      stage: z
        .enum(EPIC_STAGE_NAMES)
        .describe(`The stage being completed. You may only complete '${ownStage}'.`),
    },
    async ({ stage }) => {
      try {
        if (stage !== ownStage) {
          return fail(
            `This conversation runs the '${ownStage}' stage and can only complete that stage ` +
              `(you asked for '${stage}'). Each stage is signed off by its own agent.`,
          );
        }

        // Only the four gated stages carry this tool, so the flag is always
        // there in practice; the guard mirrors the human backstop route.
        const flag = FLAG_BY_STAGE[stage];
        if (!flag) {
          return fail(`The '${stage}' stage has no completion flag to set.`);
        }

        // Re-read: the flag may have been flipped by the human backstop button
        // or by an earlier turn of this same conversation.
        const epic = epicsDb.getById(epicId);
        if (!epic) {
          return fail(`Epic ${epicId} no longer exists.`);
        }

        if (epic[FLAG_COLUMN[flag]]) {
          return fail(
            `The '${stage}' stage is already marked complete for epic ${epicId}. ` +
              'Nothing to do — tell the user it is already signed off.',
          );
        }

        const updated = epicsDb.setStageComplete(epicId, flag);
        if (updated) {
          broadcastEpicUpdated(broadcastToEpicSubscribersFn, updated);
        }

        console.log(`[bottega] Epic ${epicId}: stage '${stage}' marked complete by ${agentType}`);
        return ok(`Stage '${stage}' marked complete for epic ${epicId}.`);
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  return [markStageComplete];
}

export const _internal = { STAGE_BY_AGENT_TYPE, FLAG_BY_STAGE };
