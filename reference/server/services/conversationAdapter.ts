/**
 * Conversation Adapter — public facade.
 *
 * Re-exports the conversation lifecycle API from `./conversation/`. Existing
 * callers (`server/index.js`, `server/routes/conversations.ts`,
 * `services/agentRunner.ts`, tests) keep importing from this path; the
 * implementation now lives in focused submodules under `./conversation/`.
 *
 * See `./conversation/` for the modular implementation:
 * - `startConversation.ts` — `startConversation`, `sendMessage`
 * - `runStreamingLoop.ts`  — unified for-await SDK iterator consumer
 * - `streamingLifecycle.ts` + `agentRunLifecycle.ts` — composed onComplete hooks
 * - `sessionControl.ts`    — `abortSession`, `isSessionActive`, getters
 * - `sessionState.ts`      — singleton in-memory state (Maps/Sets)
 * - `askUserQuestion.ts`   — `resolveAskUserQuestion`, canUseTool plumbing
 * - `sdkOptions.ts`        — option validation + SDK option mapping + MCP config
 * - `mcpReadiness.ts`      — MCP server polling, video flag injection
 * - `media.ts`             — video remux, image extraction, temp cleanup
 * - `slashCommands.ts`     — custom command .md expansion
 * - `thinkingPatcher.ts`   — thinking-delta accumulator + SQLite patch
 * - `types.ts`             — TypeScript boundary types
 */

export { startConversation, sendMessage } from './conversation/startConversation.js';
export {
  abortSession,
  isSessionActive,
  getActiveSessions,
  getActiveStreamingByConversation,
  getAllActiveStreamingSessions,
} from './conversation/sessionControl.js';
export { resolveAskUserQuestion } from './conversation/askUserQuestion.js';

// Test-only re-exports — preserve the historical underscore aliases.
export { injectVideoRecording as _injectVideoRecording } from './conversation/mcpReadiness.js';
export { handleVideoRecording as _handleVideoRecording } from './conversation/media.js';
export { resolveSlashCommand as _resolveSlashCommand } from './conversation/slashCommands.js';
