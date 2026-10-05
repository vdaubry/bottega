// Decides whether a conversation gets the in-process 'code-atlas' MCP server
// and merges it into the mcpServers config passed to the SDK. The conversation
// row is the source of truth (atlas_enabled, stamped at creation by the
// Explore flow) so WS resume and the 401-retry path re-inject the tools
// without the caller knowing how the conversation was created.

import { conversationsDb } from '../../database/conversations.js';
import { buildAtlasMcpServer } from '../atlas/mcpServer.js';

export function withAtlasMcpServer(
  mcpServers: Record<string, unknown> | null,
  args: { conversationId: number; taskId: number; userId?: number | undefined },
): Record<string, unknown> | null {
  const row = conversationsDb.getById(args.conversationId);
  if (row?.atlas_enabled !== 1) return mcpServers;
  return {
    ...(mcpServers ?? {}),
    'code-atlas': buildAtlasMcpServer({ taskId: args.taskId, userId: args.userId }),
  };
}
