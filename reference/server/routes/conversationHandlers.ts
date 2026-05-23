// Shared REST handler factory for "create conversation" endpoints. The
// adapter pattern lets `tasks.js`/`projects.js` reuse the same plumbing
// (membership check, optional pre-create, Claude credential validation,
// streaming start) while plugging in entity-specific lookups and prompt
// builders.

import type { Request, Response } from 'express';
import { getWorktreeProjectPath, worktreeExists } from '../services/worktree.js';
import { hasProjectAccess } from '../services/projectService.js';
import { validateClaudeCredentials } from '../services/claudeCredentials.js';
import type {
  ServerToClientMessage,
  ConversationId,
  PermissionMode,
} from '../../shared/websocket/messages.js';
import type { Provider } from '../../shared/providers/types.js';

// Loose shapes — the adapter pattern intentionally lets each caller plug in
// its own row type without spreading them through the handler's internals.
interface EntityWithProject {
  project_id: number;
  repo_folder_path: string;
  subproject_path?: string | null;
}

interface ConversationRecord {
  id: number;
}

interface StartSessionResult {
  conversationId: ConversationId;
  claudeSessionId: string | null;
}

interface StartSessionOptions {
  broadcastFn: (conversationId: ConversationId, msg: ServerToClientMessage) => void;
  userId: number;
  customSystemPrompt?: string | undefined;
  permissionMode: PermissionMode;
  conversationId?: number | undefined;
  provider: Provider;
  model: string;
  effort?: string | null | undefined;
}

interface CreateConversationBody {
  message?: string;
  projectPath?: string;
  permissionMode?: string;
  // Backend + model are always explicit (validated by
  // `CreateConversationBodySchema`); manual conversations pick both in the modal.
  provider: Provider;
  model: string;
}

// The `Request` generic accepts any param dictionary so the adapter can
// pluck whatever URL key it owns (e.g. `req.params.taskId`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRequest = Request<any, any, any, any>;

export interface ConversationAdapter {
  getId(req: AnyRequest): number;
  invalidIdMessage: string;
  notFoundMessage: string;
  getEntityWithProject(entityId: number): EntityWithProject | undefined;
  precreateConversation?: boolean;
  createConversation(
    entityId: number,
    provider: Provider,
    model: string,
    effort: string | null,
  ): ConversationRecord;
  onConversationCreated?: (args: {
    userId: number;
    entityId: number;
    conversation: ConversationRecord;
    entityWithProject: EntityWithProject;
  }) => void;
  getWorktreeTaskId?: (entityId: number) => number;
  buildSystemPrompt?: (
    effectivePath: string,
    entityId: number,
    projectPath: string | undefined,
    entityWithProject: EntityWithProject,
  ) => string | null;
  startSession(
    entityId: number,
    message: string,
    options: StartSessionOptions,
  ): Promise<StartSessionResult>;
  getConversationById(conversationId: ConversationId): ConversationRecord;
  cleanupConversationOnSessionError?: boolean;
  deleteConversation(conversationId: number): void;
  sessionErrorLogPrefix: string;
  generalErrorLogPrefix: string;
  generalErrorMessage: string;
}

function createBroadcastFn(
  req: Request,
): (convId: ConversationId, msg: ServerToClientMessage) => void {
  // Per-conversation fanout: only WebSockets that have subscribed to this
  // conversation (via `subscribe-conversation`) receive the message. Falls
  // back to a no-op if the factory isn't wired (e.g. in early-boot or test
  // contexts) so the conversation creation request itself doesn't fail.
  const broadcastToConversationSubscribers =
    req.app.locals.broadcastToConversationSubscribers as
      | ((convId: ConversationId, msg: ServerToClientMessage) => void)
      | undefined;
  if (!broadcastToConversationSubscribers) {
    return () => {
      /* no-op */
    };
  }
  return (convId, msg) => broadcastToConversationSubscribers(convId, msg);
}

export function createConversationHandler(adapter: ConversationAdapter) {
  return async (
    req: Request<Record<string, string>, unknown, CreateConversationBody>,
    res: Response,
  ) => {
    try {
      const userId = req.user!.id;
      const entityId = adapter.getId(req);
      const { message, projectPath, permissionMode, provider, model } = req.body || {};
      // Backend + model are always explicit and zod-validated upstream
      // (provider ∈ anthropic|openai|opencode, model matches provider). Manual
      // conversations don't pick an effort, so it's null.
      const resolvedProvider: Provider = provider;
      const resolvedEffort: string | null = null;

      if (isNaN(entityId)) {
        return res.status(400).json({ error: adapter.invalidIdMessage });
      }

      const entityWithProject = adapter.getEntityWithProject(entityId);
      if (!entityWithProject) {
        return res.status(404).json({ error: adapter.notFoundMessage });
      }

      if (!hasProjectAccess(entityWithProject.project_id, userId)) {
        return res.status(404).json({ error: adapter.notFoundMessage });
      }

      // Only the Claude path is gated here. OpenAI/OpenCode validate their
      // own per-user credentials inside their start* branch (and surface a
      // typed error if missing) — running the Claude check for them would
      // wrongly block users who only configured a non-Claude backend.
      if (message && resolvedProvider === 'anthropic') {
        try {
          validateClaudeCredentials(userId);
        } catch (credentialError) {
          const credMessage =
            credentialError instanceof Error
              ? credentialError.message
              : String(credentialError);
          return res
            .status(500)
            .json({ error: 'Session creation failed: ' + credMessage });
        }
      }

      let conversation: ConversationRecord | null = null;
      if (adapter.precreateConversation) {
        // Stamp the chosen (provider, model, effort) on the row up-front so the
        // conversation is fully determined from creation (resume reads all three
        // back off the row).
        conversation = adapter.createConversation(entityId, resolvedProvider, model, resolvedEffort);
        if (adapter.onConversationCreated) {
          adapter.onConversationCreated({ userId, entityId, conversation, entityWithProject });
        }
      }

      if (!message) {
        if (!conversation) {
          conversation = adapter.createConversation(entityId, resolvedProvider, model, resolvedEffort);
          if (adapter.onConversationCreated) {
            adapter.onConversationCreated({ userId, entityId, conversation, entityWithProject });
          }
        }
        return res.status(201).json(conversation);
      }

      let effectivePath = entityWithProject.repo_folder_path;
      if (adapter.getWorktreeTaskId) {
        const taskId = adapter.getWorktreeTaskId(entityId);
        if (await worktreeExists(effectivePath, taskId)) {
          effectivePath = getWorktreeProjectPath(
            effectivePath,
            taskId,
            entityWithProject.subproject_path ?? null,
          );
        }
      }

      const customSystemPrompt = adapter.buildSystemPrompt
        ? adapter.buildSystemPrompt(effectivePath, entityId, projectPath, entityWithProject)
        : null;

      const broadcastFn = createBroadcastFn(req);

      try {
        const { conversationId, claudeSessionId } = await adapter.startSession(
          entityId,
          message.trim(),
          {
            broadcastFn,
            userId,
            customSystemPrompt: customSystemPrompt ?? undefined,
            permissionMode: (permissionMode || 'bypassPermissions') as PermissionMode,
            conversationId: conversation?.id,
            provider: resolvedProvider,
            model,
            effort: resolvedEffort,
          },
        );

        const responseConversation =
          conversation || adapter.getConversationById(conversationId);
        return res.status(201).json({
          ...responseConversation,
          claude_conversation_id: claudeSessionId,
        });
      } catch (sessionError) {
        if (adapter.cleanupConversationOnSessionError && conversation?.id) {
          adapter.deleteConversation(conversation.id);
        }
        console.error(adapter.sessionErrorLogPrefix, sessionError);
        const sessionMessage =
          sessionError instanceof Error
            ? sessionError.message
            : String(sessionError);
        return res
          .status(500)
          .json({ error: 'Session creation failed: ' + sessionMessage });
      }
    } catch (error) {
      console.error(adapter.generalErrorLogPrefix, error);
      res.status(500).json({ error: adapter.generalErrorMessage });
    }
  };
}
