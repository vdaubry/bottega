import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { buildPortableQuestionTool } from './portableQuestionTool.js';
import type { BroadcastFn } from '@shared/websocket/messages';

export function buildInteractionMcpServer(
  conversationId: number,
  broadcastFn?: BroadcastFn,
): unknown {
  const definition = buildPortableQuestionTool(conversationId, broadcastFn);
  return createSdkMcpServer({
    name: 'bottega_interaction',
    version: '0.1.0',
    tools: [
      tool(
        definition.name,
        definition.description,
        definition.inputSchema,
        definition.handler,
      ),
    ] as never,
  });
}
