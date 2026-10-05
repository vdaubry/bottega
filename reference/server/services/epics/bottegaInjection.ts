// Decides whether a conversation gets the in-process 'bottega' MCP server and
// merges it into the mcpServers config passed to the SDK — the epic-side twin
// of `atlasInjection.ts`.
//
// The DB rows are the source of truth (conversation → epic, linked agent run →
// agent type), never the caller's arguments: a WS resume, a follow-up message
// and the 401-retry path all re-derive the same catalog without knowing how the
// conversation was started. Every task conversation is a no-op.

import { conversationsDb } from '../../database/conversations.js';
import { epicsDb, epicAgentRunsDb } from '../../database/epics.js';
import { buildBottegaMcpServer, toolsFor } from './bottega/mcpServer.js';
import { EPIC_AGENT_TYPES } from '../../../shared/schemas/epics.js';
import type { EpicAgentType } from '@shared/types/db';
import type {
  BroadcastFn,
  BroadcastToEpicSubscribersFn,
  BroadcastToTaskSubscribersFn,
} from '@shared/websocket/messages';

function asEpicAgentType(value: string | null | undefined): EpicAgentType | null {
  return (EPIC_AGENT_TYPES as readonly string[]).includes(value ?? '')
    ? (value as EpicAgentType)
    : null;
}

export function withBottegaMcpServer(
  mcpServers: Record<string, unknown> | null,
  args: {
    conversationId: number;
    userId?: number | undefined;
    broadcastFn?: BroadcastFn | undefined;
    broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
    broadcastToEpicSubscribersFn?: BroadcastToEpicSubscribersFn | undefined;
  },
): Record<string, unknown> | null {
  const ctx = getBottegaToolContext(args);
  if (!ctx || toolsFor(ctx).length === 0) return mcpServers;

  return {
    ...(mcpServers ?? {}),
    bottega: buildBottegaMcpServer(ctx),
  };
}

type InjectionArgs = Parameters<typeof withBottegaMcpServer>[1];

function getBottegaToolContext(args: InjectionArgs) {
  const conversation = conversationsDb.getById(args.conversationId);
  const epicId = conversation?.epic_id;
  if (epicId == null) return null;
  const epic = epicsDb.getById(epicId);
  if (!epic) return null;

  // A manually-created epic conversation (the user chatting about the epic
  // outside any stage) has no linked run and therefore no stage to act on.
  const linkedRun = epicAgentRunsDb.getByConversationId(args.conversationId);
  const agentType = asEpicAgentType(linkedRun?.agent_type);
  if (!agentType) return null;

  return {
    projectId: epic.project_id,
    epicId,
    agentType,
    conversationId: args.conversationId,
    userId: args.userId,
    // Which ticket an orchestrator run supervises is recorded on the run row,
    // so a resume weeks later re-derives it exactly like the first turn.
    ticketTaskId: linkedRun?.ticket_task_id ?? null,
    broadcastFn: args.broadcastFn,
    broadcastToTaskSubscribersFn: args.broadcastToTaskSubscribersFn,
    broadcastToEpicSubscribersFn: args.broadcastToEpicSubscribersFn,
  };
}

/** Same catalog as the Claude in-process adapter, for remote MCP transports. */
export function portableBottegaTools(args: InjectionArgs) {
  const ctx = getBottegaToolContext(args);
  return ctx ? toolsFor(ctx) : [];
}
