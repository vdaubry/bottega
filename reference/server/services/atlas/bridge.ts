// Atlas bridge — server-side analog of CodeAtlas's UiBridge. The code-atlas
// MCP tools push UI commands to Explore-view subscribers over the WebSocket
// and wait for the view to acknowledge that the command was actually applied,
// so tool results are only reported as successful once the UI visibly
// updated. Dispatch owns the subscription map and routes `atlas-ack` messages
// back here; the broadcaster and subscriber counter are injected at boot to
// avoid a dispatch ↔ bridge import cycle.

import { randomUUID } from 'crypto';
import type {
  ServerMessageOf,
  TaskId,
  TaskScopedBroadcastPayload,
} from '@shared/websocket/messages';

export const ATLAS_ACK_TIMEOUT_MS = 5000;
// Artifact renders ship a full HTML document over the WS and wait for the
// sandboxed iframe to mount it — generous to cover a cold iframe load.
export const ATLAS_ARTIFACT_ACK_TIMEOUT_MS = 15000;

/** A UI command minus the routing fields the bridge fills in itself. */
export type AtlasUiCommand =
  | Omit<ServerMessageOf<'atlas-open-file'>, 'taskId' | 'requestId'>
  | Omit<ServerMessageOf<'atlas-highlight'>, 'taskId' | 'requestId'>
  | Omit<ServerMessageOf<'atlas-render-artifact'>, 'taskId' | 'requestId'>;

export interface AtlasBridgeDeps {
  broadcast: (taskId: TaskId, message: TaskScopedBroadcastPayload) => void;
  getSubscriberCount: (taskId: TaskId) => number;
}

interface PendingAck {
  taskId: TaskId;
  resolve: (detail?: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

let deps: AtlasBridgeDeps | null = null;
const pending = new Map<string, PendingAck>();

export function initAtlasBridge(d: AtlasBridgeDeps): void {
  deps = d;
}

/** How many open Explore views are subscribed to this task right now. */
export function getAtlasSubscriberCount(taskId: TaskId): number {
  if (!deps) return 0;
  return deps.getSubscriberCount(taskId);
}

/**
 * Broadcast a UI command to the task's Explore subscribers and resolve with
 * the first ack's `detail` (a short JSON payload). Rejects with the
 * client-reported error or on timeout.
 */
export function sendAtlasEvent(
  taskId: TaskId,
  command: AtlasUiCommand,
  timeoutMs: number = ATLAS_ACK_TIMEOUT_MS,
): Promise<string | undefined> {
  if (!deps) {
    return Promise.reject(new Error('Atlas bridge is not initialized'));
  }
  if (deps.getSubscriberCount(taskId) === 0) {
    return Promise.reject(new Error('No Explore view is open for this task'));
  }
  const broadcast = deps.broadcast;
  const requestId = randomUUID();
  const done = new Promise<string | undefined>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(requestId)) {
        reject(new Error(`UI did not acknowledge ${command.type} within ${timeoutMs}ms`));
      }
    }, timeoutMs);
    pending.set(requestId, { taskId, resolve, reject, timer });
  });
  broadcast(taskId, { ...command, requestId });
  return done;
}

/**
 * Resolve a pending command from a client `atlas-ack`. The dispatch layer has
 * already verified the sending socket is atlas-subscribed to `taskId`; the
 * bridge additionally requires the ack's task to match the one the command
 * was issued for, so a socket can never resolve another task's commands.
 * First ack wins — later acks (other Explore tabs) are dropped.
 */
export function resolveAtlasAck(
  requestId: string,
  ack: { taskId: TaskId; error?: string | undefined; detail?: string | undefined },
): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  if (entry.taskId !== ack.taskId) {
    console.warn(
      `[atlas] dropped ack for request ${requestId}: task mismatch (${ack.taskId} != ${entry.taskId})`,
    );
    return;
  }
  pending.delete(requestId);
  clearTimeout(entry.timer);
  if (ack.error) entry.reject(new Error(ack.error));
  else entry.resolve(ack.detail);
}

// ---- Test-only helpers ----

export function __resetAtlasBridgeForTesting(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  deps = null;
}

export function __getPendingAckCountForTesting(): number {
  return pending.size;
}
