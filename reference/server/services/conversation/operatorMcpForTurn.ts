// Reading the operator's MCP config for one turn.
//
// Split from `operatorMcpServers.ts` — which the provider modules import and
// must therefore stay import-free — because this side needs the conversation
// runtime (`sdkOptions`, `mcpReadiness`). Only the `start*Conversation` files
// call it, and they already carry those imports.

import { loadMcpConfig } from './sdkOptions.js';
import { injectVideoRecording } from './mcpReadiness.js';
import {
  normalizeOperatorMcpServers,
  type OperatorMcpServer,
} from '@shared/providers/operatorMcpServers';
import type { VideoConfig } from './types.js';

/**
 * The operator's MCP servers for one turn, normalized: the `~/.claude.json`
 * entries with the review agent's video-recording flags already injected into
 * Playwright's args, exactly as the Claude path does it.
 */
export async function loadOperatorMcpServers(
  projectPath: string | null | undefined,
  videoConfig: VideoConfig | null | undefined,
): Promise<OperatorMcpServer[]> {
  const raw = await loadMcpConfig(projectPath);
  if (!raw) return [];
  const withVideo = videoConfig
    ? (injectVideoRecording(raw as never, videoConfig) as Record<string, unknown> | null)
    : raw;
  return normalizeOperatorMcpServers(withVideo);
}
