// Explore (code-atlas) routes — read-only workspace access for the IDE view.
// Same authorization as the other task routes: task → project membership,
// 404 on both missing and foreign tasks so existence never leaks.

import express, { type Request, type Response } from 'express';
import {
  tasksDb,
  conversationsDb,
  taskArtifactsDb,
  TaskWorktreeNotReadyError,
} from '../database/db.js';
import { hasProjectAccess } from '../services/projectService.js';
import { getWorkspaceForTask, WorkspaceError } from '../services/atlas/workspace.js';
import { validateClaudeCredentials } from '../services/claudeCredentials.js';
import {
  loadAgentModelSettings,
  MissingUserAgentSettingsError,
} from '../services/agentModelSettings.js';
import {
  startConversation,
  getOngoingAtlasGenerationConversationId,
} from '../services/conversationAdapter.js';
import { buildContextPrompt, getTaskDocPath } from '../services/documentation.js';
import { renderPrompt, getAtlasStyleRefsDir } from '../services/promptRenderer.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { IdParamsSchema, type IdParams } from '../../shared/schemas/_common.js';
import {
  AtlasTreeQuerySchema,
  type AtlasTreeQuery,
  AtlasFileQuerySchema,
  type AtlasFileQuery,
  GenerateArtifactBodySchema,
  type GenerateArtifactBody,
  ArtifactKindParamsSchema,
  type ArtifactKindParams,
} from '../../shared/schemas/atlas.js';
import type { ApiError } from '../../shared/api/_common.js';
import type {
  AtlasFileResponse,
  AtlasTreeResponse,
  GetTaskArtifactsResponse,
  GetTaskArtifactResponse,
} from '../../shared/api/atlas.js';
import type { ArtifactKind, TaskArtifactSummary } from '../../shared/types/atlas.js';
import type { TaskWithProject } from '../database/db.js';
import type {
  BroadcastFn,
  BroadcastToTaskSubscribersFn,
} from '../../shared/websocket/messages.js';

const router = express.Router();

/** Resolve the task and enforce membership; null means a 404 was sent. */
function requireTask(req: Request, res: Response): TaskWithProject | null {
  const userId = req.user!.id;
  const { id: taskId } = req.validated!.params as IdParams;
  const taskWithProject = tasksDb.getWithProject(taskId);
  if (!taskWithProject || !hasProjectAccess(taskWithProject.project_id, userId)) {
    res.status(404).json({ error: 'Task not found' } satisfies ApiError);
    return null;
  }
  return taskWithProject;
}

function sendWorkspaceError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof WorkspaceError) {
    const status = error.message.startsWith('File not found') ? 404 : 400;
    res.status(status).json({ error: error.message } satisfies ApiError);
    return;
  }
  console.error(fallback, error);
  res.status(500).json({ error: fallback } satisfies ApiError);
}

router.get(
  '/tasks/:id/atlas/tree',
  validateParams(IdParamsSchema),
  validateQuery(AtlasTreeQuerySchema),
  async (req: Request, res: Response<unknown>) => {
    const task = requireTask(req, res);
    if (!task) return;
    const { path: relPath } = req.validated!.query as AtlasTreeQuery;
    try {
      const workspace = await getWorkspaceForTask(task);
      const entries: AtlasTreeResponse = await workspace.listDir(relPath);
      res.json(entries);
    } catch (error) {
      sendWorkspaceError(res, error, 'Failed to list directory');
    }
  },
);

router.get(
  '/tasks/:id/atlas/file',
  validateParams(IdParamsSchema),
  validateQuery(AtlasFileQuerySchema),
  async (req: Request, res: Response<unknown>) => {
    const task = requireTask(req, res);
    if (!task) return;
    const { path: relPath } = req.validated!.query as AtlasFileQuery;
    try {
      const workspace = await getWorkspaceForTask(task);
      const file = await workspace.readFile(relPath);
      // Never leak the server's absolute path to the client.
      const payload: AtlasFileResponse = {
        path: file.path,
        content: file.content,
        lineCount: file.lineCount,
      };
      res.json(payload);
    } catch (error) {
      sendWorkspaceError(res, error, 'Failed to read file');
    }
  },
);

// List the per-kind artifact summaries (no html) the task currently has —
// feeds the Schema-tab kind switcher.
router.get(
  '/tasks/:id/atlas/artifacts',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<unknown>) => {
    const task = requireTask(req, res);
    if (!task) return;
    try {
      const artifacts: TaskArtifactSummary[] = taskArtifactsDb.list(task.id).map((row) => ({
        taskId: row.task_id,
        kind: row.kind as ArtifactKind,
        title: row.title,
        updatedAt: row.updated_at,
      }));
      res.json({ artifacts } satisfies GetTaskArtifactsResponse);
    } catch (error) {
      console.error('Error listing task artifacts:', error);
      res.status(500).json({ error: 'Failed to list task artifacts' } satisfies ApiError);
    }
  },
);

// One artifact including its html document — lazily fetched by the iframe
// srcdoc when a kind becomes active (authenticated Bearer; the html never
// travels in a URL).
router.get(
  '/tasks/:id/atlas/artifact/:kind',
  validateParams(IdParamsSchema.merge(ArtifactKindParamsSchema)),
  (req: Request, res: Response<unknown>) => {
    const task = requireTask(req, res);
    if (!task) return;
    const { kind } = req.validated!.params as IdParams & ArtifactKindParams;
    try {
      const row = taskArtifactsDb.get(task.id, kind);
      const artifact = row
        ? {
            taskId: row.task_id,
            kind: row.kind as ArtifactKind,
            title: row.title,
            html: row.html,
            updatedAt: row.updated_at,
          }
        : null;
      res.json({ artifact } satisfies GetTaskArtifactResponse);
    } catch (error) {
      console.error('Error reading task artifact:', error);
      res.status(500).json({ error: 'Failed to read task artifact' } satisfies ApiError);
    }
  },
);

// Start an artifact-generation conversation: a normal task conversation seeded
// with the atlas-artifact prompt and flagged atlas_enabled, so the agent gets
// the code-atlas tools and the user can keep refining in the same thread.
router.post(
  '/tasks/:id/atlas/generate-artifact',
  validateParams(IdParamsSchema),
  validateBody(GenerateArtifactBodySchema),
  async (req: Request, res: Response<unknown>) => {
    const task = requireTask(req, res);
    if (!task) return;
    const userId = req.user!.id;
    const { kind } = req.validated!.body as GenerateArtifactBody;

    // Idempotency: a task has a single ongoing artifact generation. If one is
    // already streaming — the user re-opened the Explore view (a fresh mount
    // re-runs the auto-generate effect) or double-clicked Generate while the
    // ~5-min plan turn is still running — bind to it instead of spawning a
    // duplicate. The frontend treats the returned conversation the same whether
    // it was just created or already running.
    const ongoingConversationId = getOngoingAtlasGenerationConversationId(task.id);
    if (ongoingConversationId !== null) {
      return res.status(200).json(conversationsDb.getById(ongoingConversationId));
    }

    if (task.worktree_state === 'provisioning' || task.worktree_state === 'failed') {
      return res.status(409).json({
        error: new TaskWorktreeNotReadyError(task.id, task.worktree_state).message,
      } satisfies ApiError);
    }

    try {
      validateClaudeCredentials(userId);
    } catch (credentialError) {
      const credMessage =
        credentialError instanceof Error ? credentialError.message : String(credentialError);
      return res
        .status(500)
        .json({ error: 'Session creation failed: ' + credMessage } satisfies ApiError);
    }

    // Resolve the schema-generation model from the user's Anthropic-only
    // `schema` setting (Settings → Agent Models → Schema). No fallback: if the
    // user has no valid settings, fail loud so the Schema tab surfaces it rather
    // than silently picking a model.
    let model: string;
    let effort: string | null;
    try {
      const schemaSetting = loadAgentModelSettings(userId).schema;
      model = schemaSetting.model;
      effort = schemaSetting.effort;
    } catch (settingsError) {
      if (settingsError instanceof MissingUserAgentSettingsError) {
        return res.status(409).json({
          error: 'Configure a Schema model under Settings → Agent Models',
        } satisfies ApiError);
      }
      throw settingsError;
    }

    const conversation = conversationsDb.create(task.id, 'anthropic', model, effort);
    conversationsDb.setAtlasEnabled(conversation.id);

    const prompt = renderPrompt('atlas-artifact', {
      taskDocPath: getTaskDocPath(task.project_id, task.id),
      taskId: task.id,
      kind,
      styleRefsDir: getAtlasStyleRefsDir(),
    });

    const broadcastFn = req.app.locals.broadcastToConversationSubscribers as
      | BroadcastFn
      | undefined;
    const broadcastToTaskSubscribersFn = req.app.locals.broadcastToTaskSubscribers as
      | BroadcastToTaskSubscribersFn
      | undefined;

    try {
      const { claudeSessionId } = await startConversation({ kind: 'task', taskId: task.id }, prompt, {
        broadcastFn,
        broadcastToTaskSubscribersFn,
        userId,
        customSystemPrompt: buildContextPrompt(task.project_id, task.id) ?? undefined,
        permissionMode: 'bypassPermissions',
        conversationId: conversation.id,
        provider: 'anthropic',
        model,
        effort,
      });

      return res.status(201).json({
        ...conversationsDb.getById(conversation.id),
        claude_conversation_id: claudeSessionId,
      });
    } catch (sessionError) {
      conversationsDb.delete(conversation.id);
      console.error('[atlas] Failed to start artifact generation:', sessionError);
      const sessionMessage =
        sessionError instanceof Error ? sessionError.message : String(sessionError);
      return res
        .status(500)
        .json({ error: 'Session creation failed: ' + sessionMessage } satisfies ApiError);
    }
  },
);

export default router;
