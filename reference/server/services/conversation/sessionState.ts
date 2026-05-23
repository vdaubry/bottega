// Module-level singletons for the conversation lifecycle.
//
// ESM module bindings are live singletons — every importer sees the same Map
// instances. Multiple modules close over these directly (the streaming loop
// writes, sessionControl reads, askUserQuestion mutates pendingAskUserQuestions).
// **Do not wrap these in factories or lazy initializers** — the closure
// assumptions across modules depend on stable identities at import time.

export interface ActiveSession {
  instance: unknown;
  abortController: AbortController;
  startTime: number;
  status: 'active' | 'aborted';
  tempImagePaths: string[];
  tempDir: string | null;
  // Ownership metadata used by WS handlers (`abort-session`,
  // `check-session-status`, `get-active-sessions`) and the filtered
  // `/api/streaming-sessions` REST endpoint to verify project membership
  // without re-querying the DB for every check.
  conversationId: number;
  taskId: number | null;
  projectId: number | null;
  userId: number | null;
}

export interface ActiveStreamingSession {
  taskId?: number | null | undefined;
  conversationId: number;
}

export interface PendingAskUserQuestion {
  resolve: (value: { behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string }) => void;
  reject: (reason?: unknown) => void;
  questions: unknown[];
  toolUseId: string | null;
  signalCleanup?: (() => void) | undefined;
}

// claudeSessionId -> session metadata
export const activeSessions = new Map<string, ActiveSession>();

// claudeSessionId -> { taskId, conversationId }
export const activeStreamingSessions = new Map<string, ActiveStreamingSession>();

// conversationId -> pending question entry
// Keyed by conversationId rather than claudeSessionId because the session id
// isn't yet captured the very first time canUseTool fires (the SDK iterator
// and the control-request channel are independent in the SDK bridge). Only
// one AskUserQuestion can be pending per conversation — the SDK pauses
// execution at a single callback per query.
export const pendingAskUserQuestions = new Map<number, PendingAskUserQuestion>();
