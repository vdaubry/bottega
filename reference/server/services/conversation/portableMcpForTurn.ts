import { getOwnerAdapter } from './ownerAdapters.js';
import { startPortableMcpGateway } from './mcpGateway.js';
import type { ConversationScope } from './conversationScope.js';
import type { ConversationOptions } from './types.js';
import { buildPortableQuestionTool } from './portableQuestionTool.js';
import type { OperatorMcpServer } from '@shared/providers/operatorMcpServers';

export async function startOwnerMcpGateway(
  scope: ConversationScope,
  conversationId: number,
  options: ConversationOptions,
) {
  let adapter;
  try {
    adapter = getOwnerAdapter(scope.kind);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('No conversation owner adapter')) {
      return null;
    }
    throw error;
  }
  const args = {
    conversationId,
    ownerId: (scope.taskId ?? scope.epicId)!,
    userId: options.userId,
    broadcastFn: options.broadcastFn,
    broadcastToTaskSubscribersFn: options.broadcastToTaskSubscribersFn,
    broadcastToEpicSubscribersFn: options.broadcastToEpicSubscribersFn,
  };
  const tools = adapter.portableTools?.(args) ?? [];
  if (!adapter.extraDisallowedTools(conversationId).includes('AskUserQuestion')) {
    tools.push(buildPortableQuestionTool(conversationId, options.broadcastFn));
  }
  return startPortableMcpGateway(conversationId, tools);
}

/**
 * The `extras` a non-Anthropic provider needs to build its MCP config: this
 * turn's Bottega gateway, plus the operator's own servers (Playwright,
 * context7, ...). The Claude path passes the latter through `sdkOptions
 * .mcpServers`; Codex and OpenCode have no such field, so they receive them
 * here and translate — see `operatorMcpServers.ts`.
 */
export function mcpGatewayExtras(
  gateway: Awaited<ReturnType<typeof startOwnerMcpGateway>>,
  operatorMcpServers: OperatorMcpServer[] = [],
): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {};
  if (gateway) {
    extras['mcpGateway'] = {
      name: gateway.name,
      url: gateway.url,
      token: gateway.token,
      toolNames: gateway.toolNames,
    };
  }
  if (operatorMcpServers.length > 0) {
    extras['operatorMcpServers'] = operatorMcpServers;
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

export function ownerDisallowedTools(scope: ConversationScope, conversationId: number): string[] {
  try {
    return getOwnerAdapter(scope.kind).extraDisallowedTools(conversationId);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('No conversation owner adapter')) return [];
    throw error;
  }
}
