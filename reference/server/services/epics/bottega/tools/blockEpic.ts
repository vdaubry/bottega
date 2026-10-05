// `block_epic` — the one way an epic agent hands the epic back to the user.
//
// Shared by the orchestrator (stuck on a decision, repeated failures) and the
// pull-request reviewer (CI it cannot get green). Both go through
// `blockOrchestration`, the same path the event bridge takes when a runaway
// counter trips: from the user's side an escalation and a runaway are the
// same event — the epic stopped and it needs them.

import { z } from 'zod';
import { definePortableTool as tool } from '../../../conversation/portableTool.js';
import { blockOrchestration } from '../../orchestrator/blocking.js';
import { ok, fail, errText } from '../toolResult.js';
import type { BroadcastToEpicSubscribersFn } from '@shared/websocket/messages';

export interface BlockEpicToolContext {
  epicId: number;
  userId?: number | undefined;
  broadcastToEpicSubscribersFn?: BroadcastToEpicSubscribersFn | undefined;
}

export function buildBlockEpicTool(ctx: BlockEpicToolContext, description: string) {
  return tool(
    'block_epic',
    description,
    {
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe('What is blocking, what you already tried, and what you need from the user.'),
    },
    async ({ reason }) => {
      try {
        const updated = blockOrchestration(ctx.epicId, reason, {
          broadcastToEpicSubscribersFn: ctx.broadcastToEpicSubscribersFn,
          userId: ctx.userId,
        });
        if (!updated) return fail(`Epic ${ctx.epicId} no longer exists.`);
        return ok(
          'Orchestration paused and the user notified. Nothing else will start until they resume. ' +
            'End your turn.',
        );
      } catch (e) {
        return fail(errText(e));
      }
    },
  );
}
