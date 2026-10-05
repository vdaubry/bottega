// The owner-adapter registry (architecture-v2 step 5).
//
// The conversation runtime streams turns, stores sessions, aborts and
// resumes — and dispatches every OWNERSHIP question ("whose conversation is
// this, what is its cwd, whom do I call at turn end, which tools does it
// carry") to the adapter its owner domain registered at boot. The runtime
// imports neither domain; each domain imports this registry and plugs itself
// in (`initTasks()` / `initEpics()`), so the dependency arrows all point
// down.

import type { ConversationRow } from '@shared/types/db';
import type { PortableTool } from './portableTool.js';
import type { ConversationScope, ConversationTarget } from './conversationScope.js';
import type { StreamingContext } from './types.js';
import type {
  BroadcastFn,
  BroadcastToEpicSubscribersFn,
  BroadcastToTaskSubscribersFn,
} from '@shared/websocket/messages';

export type OwnerKind = 'task' | 'epic';

/** The linked agent run, if any — each domain owns its runs table. */
export interface LinkedOwnerRun {
  id: number;
  agent_type: string;
  status: string;
  conversation_id: number | null;
}

export interface OwnerRef {
  taskId: number | null;
  epicId: number | null;
  projectId: number;
}

export interface McpAugmentArgs {
  conversationId: number;
  /** The owning task or epic id, matching the adapter's kind. */
  ownerId: number;
  userId?: number | undefined;
  broadcastFn?: BroadcastFn | undefined;
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn | undefined;
  broadcastToEpicSubscribersFn?: BroadcastToEpicSubscribersFn | undefined;
}

export interface ConversationOwnerAdapter {
  kind: OwnerKind;
  /** cwd + project of a conversation target of this kind. */
  resolveScope(target: ConversationTarget): Promise<ConversationScope>;
  /** Owner + project of a conversation, for authz and channel routing. Sync, no filesystem. */
  resolveOwner(conversation: ConversationRow): OwnerRef | null;
  /** The linked agent run in this domain's own runs table. */
  linkedRun(conversationId: number): LinkedOwnerRun | null;
  /** Refuse a resume that would violate an owner-domain concurrency rule. */
  assertTurnCanStart(conversationId: number): void;
  /** Persist an explicit user interruption before the provider abort lands. */
  interruptLinkedRun(
    conversationId: number,
  ): LinkedOwnerRun | null | Promise<LinkedOwnerRun | null>;
  /** Pre-mark a still-running linked run 'failed' (terminal provider error). */
  failLinkedRunIfRunning(conversationId: number): LinkedOwnerRun | null;
  /** A provider turn has registered its active session and is about to stream. */
  onTurnStarted(ctx: StreamingContext): void | Promise<void>;
  /** Turn-end hook: run-status write, broadcasts, chaining/sequencing, notifications. */
  onTurnEnded(ctx: StreamingContext): Promise<void>;
  /** A parked AskUserQuestion on one of this domain's conversations. */
  onQuestionParked(conversation: ConversationRow, questions: unknown[]): void | Promise<void>;
  /** Boot: fail orphaned running runs, clear domain-specific stale state. */
  sweepOrphans(): void;
  /** Merge this domain's in-process MCP servers into the SDK config. */
  augmentMcpServers(
    mcpServers: Record<string, unknown> | null,
    args: McpAugmentArgs,
  ): Record<string, unknown> | null;
  /** Provider-neutral owner tools exposed through remote MCP transports. */
  portableTools?(args: McpAugmentArgs): PortableTool[];
  /** Domain-imposed tool denials for a conversation (merged, never replaced). */
  extraDisallowedTools(conversationId: number): string[];
  /** Domain-imposed PreToolUse hooks (e.g. the epic docs write gate). */
  extraPreToolUseHooks(conversationId: number): Array<(input: never) => unknown>;
  /** Throw when this domain does not allow a provider. */
  assertProviderAllowed(provider: string): void;
}

const registry = new Map<OwnerKind, ConversationOwnerAdapter>();

export function registerOwnerAdapter(adapter: ConversationOwnerAdapter): void {
  registry.set(adapter.kind, adapter);
}

export function getOwnerAdapter(kind: OwnerKind): ConversationOwnerAdapter {
  const adapter = registry.get(kind);
  if (!adapter) {
    throw new Error(
      `No conversation owner adapter registered for kind '${kind}' — was initTasks()/initEpics() called?`,
    );
  }
  return adapter;
}

/** The adapter for an existing conversation row, off its dispatch tag. */
export function ownerAdapterFor(conversation: ConversationRow): ConversationOwnerAdapter {
  return getOwnerAdapter(conversation.owner_kind);
}

/** Boot: every registered domain sweeps its own orphans. */
export function sweepAllOwnerOrphans(): void {
  for (const adapter of registry.values()) {
    adapter.sweepOrphans();
  }
}
