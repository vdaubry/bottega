import express, { type Request, type Response } from 'express';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import { tasksDb, conversationsDb } from '../database/db.js';
import { purgeConversationMessages } from '../services/conversationContentStore.js';
import { hasProjectAccess, getProject } from '../services/projectService.js';
import { getAllTasks } from '../services/taskService.js';
import {
  readTaskDoc,
  writeTaskDoc,
  deleteTaskArchive,
  listTaskInputFiles,
  saveTaskInputFile,
  deleteTaskInputFile,
  getRecordingPath,
} from '../services/documentation.js';
import { upload } from '../middleware/upload.js';
import { notifyTaskStatusChange } from '../services/notifications.js';
import { forceCompleteRunningAgents } from '../services/agentRunner.js';
import {
  isGitRepository,
  createWorktree,
  removeWorktree,
  worktreeExists,
  getWorktreeStatus,
  syncWithMain,
  getPullRequestStatus,
  mergeAndCleanup,
  hasUncommittedChanges,
  pushChanges,
} from '../services/worktree.js';
import { createOrUpdatePR } from '../services/prService.js';
import { switchWorktree } from '../services/webServerManager.js';
import type { TaskUpdates } from '../database/db.js';
import type { ApiError } from '../../shared/api/_common.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import {
  IdParamsSchema,
  type IdParams,
  ProjectIdParamsSchema,
  type ProjectIdParams,
} from '../../shared/schemas/_common.js';
import {
  CleanupOldCompletedQuerySchema,
  type CleanupOldCompletedQuery,
  CreatePullRequestBodySchema,
  type CreatePullRequestBody,
  CreateTaskBodySchema,
  type CreateTaskBody,
  DiscardWorktreeQuerySchema,
  type DiscardWorktreeQuery,
  ListTasksQuerySchema,
  type ListTasksQuery,
  PushChangesBodySchema,
  type PushChangesBody,
  ResumeTaskBodySchema,
  type ResumeTaskBody,
  TaskAttachmentParamsSchema,
  type TaskAttachmentParams,
  UpdateTaskBodySchema,
  type UpdateTaskBody,
  UpdateTaskDocBodySchema,
  type UpdateTaskDocBody,
  WorkflowCompleteBodySchema,
  type WorkflowCompleteBody,
} from '../../shared/schemas/tasks.js';

const router = express.Router();

router.get(
  '/tasks',
  validateQuery(ListTasksQuerySchema),
  (
    req: Request,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const { status } = req.validated!.query as ListTasksQuery;

      const tasks = getAllTasks(userId, status ?? null);
      res.json({ tasks });
    } catch (error) {
      console.error('Error listing all tasks:', error);
      res.status(500).json({ error: 'Failed to list tasks' } satisfies ApiError);
    }
  },
);

router.get(
  '/projects/:projectId/tasks',
  validateParams(ProjectIdParamsSchema),
  (req: Request, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const { projectId } = req.validated!.params as ProjectIdParams;

      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' } satisfies ApiError);
      }

      const tasks = tasksDb.getByProject(projectId);
      res.json(tasks);
    } catch (error) {
      console.error('Error listing tasks:', error);
      res.status(500).json({ error: 'Failed to list tasks' } satisfies ApiError);
    }
  },
);

router.post(
  '/projects/:projectId/tasks',
  validateParams(ProjectIdParamsSchema),
  validateBody(CreateTaskBodySchema),
  async (
    req: Request,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const { projectId } = req.validated!.params as ProjectIdParams;

      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' } satisfies ApiError);
      }

      const { title, description, yolo_mode } = req.validated!.body as CreateTaskBody;

      const isGit = await isGitRepository(project.repo_folder_path);

      const task = tasksDb.create(
        projectId,
        title?.trim() || null,
        !!yolo_mode,
        userId,
      ) as unknown as { id: number; [k: string]: unknown };

      if (isGit) {
        const result = await createWorktree(
          project.repo_folder_path,
          task.id,
          title,
          project.subproject_path,
        );

        if (!result.success) {
          tasksDb.delete(task.id);
          return res.status(500).json({
            error: `Failed to create worktree: ${result.error}`,
          } satisfies ApiError);
        }

        task.worktree_path = result.worktreePath;
        task.worktree_branch = result.branch;
      }

      try {
        writeTaskDoc(projectId, task.id, description?.trim() || '');
      } catch (fileError) {
        console.error('Failed to create task documentation file:', fileError);
      }

      res.status(201).json(task);
    } catch (error) {
      console.error('Error creating task:', error);
      res.status(500).json({ error: 'Failed to create task' } satisfies ApiError);
    }
  },
);

router.get(
  '/tasks/:id',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const task = tasksDb.getById(taskId);
      res.json(task);
    } catch (error) {
      console.error('Error getting task:', error);
      res.status(500).json({ error: 'Failed to get task' } satisfies ApiError);
    }
  },
);

router.put(
  '/tasks/:id',
  validateParams(IdParamsSchema),
  validateBody(UpdateTaskBodySchema),
  async (
    req: Request,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;
      const body = req.validated!.body as UpdateTaskBody;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const oldStatus = taskWithProject.status;

      const updates: TaskUpdates = {};
      if (body.title !== undefined) {
        updates.title = body.title?.trim() || null;
      }
      if (body.status !== undefined) {
        updates.status = body.status;
      }
      if (body.workflow_complete !== undefined) {
        updates.workflow_complete = body.workflow_complete ? 1 : 0;
      }

      const task = tasksDb.update(taskId, updates);

      if (updates.status && updates.status !== oldStatus) {
        notifyTaskStatusChange(userId, oldStatus, updates.status).catch(
          (err: unknown) => {
            console.error(
              '[Notifications] Failed to send task status notification:',
              err,
            );
          },
        );
      }

      res.json(task);
    } catch (error) {
      console.error('Error updating task:', error);
      res.status(500).json({ error: 'Failed to update task' } satisfies ApiError);
    }
  },
);

router.delete(
  '/tasks/:id',
  validateParams(IdParamsSchema),
  async (req: Request, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const project = getProject(taskWithProject.project_id, userId);
      const wasActiveServer = project?.active_worktree_task_id === taskId;

      if (await worktreeExists(taskWithProject.repo_folder_path, taskId)) {
        const result = await removeWorktree(taskWithProject.repo_folder_path, taskId);
        if (!result.success) {
          console.error(`Failed to remove worktree for task ${taskId}:`, result.error);
        }
      }

      const conversationsForTask = conversationsDb.getByTask(taskId);
      for (const conv of conversationsForTask) {
        try {
          await purgeConversationMessages(conv, taskWithProject.repo_folder_path);
        } catch (purgeError) {
          console.error(
            `Failed to purge messages for conversation ${conv.id}:`,
            purgeError,
          );
        }
      }

      const deleted = tasksDb.delete(taskId);

      if (!deleted) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      try {
        deleteTaskArchive(taskWithProject.project_id, taskId);
      } catch (fileError) {
        console.error('Failed to delete task archive:', fileError);
      }

      const response: {
        success: true;
        serverSwitched?: boolean;
        serverSwitchWarning?: string;
        serverSwitchMessage?: string;
        serverSwitchError?: string;
      } = { success: true };

      if (wasActiveServer && project?.serve_symlink_path) {
        const switchResult = await switchWorktree(taskWithProject.project_id, null, userId);
        if (switchResult.success) {
          response.serverSwitched = true;
          if (switchResult.warning) {
            response.serverSwitchWarning = switchResult.warning;
          } else {
            response.serverSwitchMessage = 'Server switched back to main repository';
          }
        } else {
          if (switchResult.error !== undefined) {
            response.serverSwitchError = switchResult.error;
          }
        }
      }

      res.json(response);
    } catch (error) {
      console.error('Error deleting task:', error);
      res.status(500).json({ error: 'Failed to delete task' } satisfies ApiError);
    }
  },
);

router.get(
  '/tasks/:id/documentation',
  validateParams(IdParamsSchema),
  async (req: Request, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const content = readTaskDoc(taskWithProject.project_id, taskId);
      res.json({ content });
    } catch (error) {
      console.error('Error reading task documentation:', error);
      res
        .status(500)
        .json({ error: 'Failed to read task documentation' } satisfies ApiError);
    }
  },
);

router.put(
  '/tasks/:id/documentation',
  validateParams(IdParamsSchema),
  validateBody(UpdateTaskDocBodySchema),
  async (
    req: Request,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const { content } = req.validated!.body as UpdateTaskDocBody;

      writeTaskDoc(taskWithProject.project_id, taskId, content);
      res.json({ success: true });
    } catch (error) {
      console.error('Error writing task documentation:', error);
      res
        .status(500)
        .json({ error: 'Failed to write task documentation' } satisfies ApiError);
    }
  },
);

router.get(
  '/tasks/:id/attachments',
  validateParams(IdParamsSchema),
  async (req: Request, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const files = listTaskInputFiles(taskWithProject.project_id, taskId);
      res.json(files);
    } catch (error) {
      console.error('Error listing task attachments:', error);
      res.status(500).json({ error: 'Failed to list attachments' } satisfies ApiError);
    }
  },
);

router.post(
  '/tasks/:id/attachments',
  validateParams(IdParamsSchema),
  async (req: Request, res: Response<unknown>) => {
    const userId = req.user!.id;
    const { id: taskId } = req.validated!.params as IdParams;

    const taskWithProject = tasksDb.getWithProject(taskId);

    if (!taskWithProject) {
      return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
    }

    if (!hasProjectAccess(taskWithProject.project_id, userId)) {
      return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
    }

    upload.single('file')(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        return res.status(400).json({ error: message } satisfies ApiError);
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        return res.status(400).json({ error: 'No file provided' } satisfies ApiError);
      }

      try {
        const fileInfo = saveTaskInputFile(
          taskWithProject.project_id,
          taskId,
          file.originalname,
          file.buffer,
        );
        res.status(201).json({ success: true, file: fileInfo });
      } catch (saveError) {
        console.error('Error saving task attachment:', saveError);
        res.status(500).json({ error: 'Failed to save attachment' } satisfies ApiError);
      }
    });
  },
);

router.delete(
  '/tasks/:id/attachments/:filename',
  validateParams(TaskAttachmentParamsSchema),
  async (
    req: Request,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const { id: taskId, filename } = req.validated!.params as TaskAttachmentParams;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const deleted = deleteTaskInputFile(taskWithProject.project_id, taskId, filename);

      if (!deleted) {
        return res
          .status(404)
          .json({ error: 'Attachment not found' } satisfies ApiError);
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting task attachment:', error);
      res
        .status(500)
        .json({ error: 'Failed to delete attachment' } satisfies ApiError);
    }
  },
);

router.delete(
  '/projects/:projectId/tasks/cleanup-old-completed',
  validateParams(ProjectIdParamsSchema),
  validateQuery(CleanupOldCompletedQuerySchema),
  async (
    req: Request,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const { projectId } = req.validated!.params as ProjectIdParams;
      const { keep: keepCount } = req.validated!.query as CleanupOldCompletedQuery;

      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' } satisfies ApiError);
      }

      const taskIdsToDelete = tasksDb.getOldCompletedTasks(projectId, keepCount);

      if (taskIdsToDelete.length === 0) {
        return res.json({ deletedCount: 0, message: 'No old completed tasks to delete' });
      }

      let deletedCount = 0;
      for (const taskId of taskIdsToDelete) {
        if (await worktreeExists(project.repo_folder_path, taskId)) {
          const result = await removeWorktree(project.repo_folder_path, taskId);
          if (!result.success) {
            console.error(`Failed to remove worktree for task ${taskId}:`, result.error);
          }
        }

        const conversationsForTask = conversationsDb.getByTask(taskId);
        for (const conv of conversationsForTask) {
          try {
            await purgeConversationMessages(conv, project.repo_folder_path);
          } catch (purgeError) {
            console.error(
              `Failed to purge messages for conversation ${conv.id}:`,
              purgeError,
            );
          }
        }

        const deleted = tasksDb.delete(taskId);

        if (deleted) {
          deletedCount++;
          try {
            deleteTaskArchive(projectId, taskId);
          } catch (fileError) {
            console.error(`Failed to delete archive for task ${taskId}:`, fileError);
          }
        }
      }

      res.json({
        deletedCount,
        message: `Deleted ${deletedCount} old completed task(s), kept the ${keepCount} most recent`,
      });
    } catch (error) {
      console.error('Error cleaning up old completed tasks:', error);
      res
        .status(500)
        .json({ error: 'Failed to cleanup old completed tasks' } satisfies ApiError);
    }
  },
);

router.put(
  '/tasks/:id/workflow-complete',
  validateParams(IdParamsSchema),
  validateBody(WorkflowCompleteBodySchema),
  (
    req: Request,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;
      const { complete } = req.validated!.body as WorkflowCompleteBody;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      tasksDb.update(taskId, { workflow_complete: complete ? 1 : 0 });

      let forceCompletedCount = 0;
      if (complete) {
        forceCompletedCount = forceCompleteRunningAgents(taskId);
        if (forceCompletedCount > 0) {
          console.log(
            `[Recovery] Force-completed ${forceCompletedCount} stuck agent run(s) for task ${taskId}`,
          );
        }
        tasksDb.markRefinementComplete(taskId);
        tasksDb.markPrAgentComplete(taskId);
      } else {
        tasksDb.resetRefinementComplete(taskId);
      }

      const updatedTask = tasksDb.getById(taskId);
      res.json(updatedTask);
    } catch (error) {
      console.error('Error updating workflow complete:', error);
      res
        .status(500)
        .json({ error: 'Failed to update workflow complete' } satisfies ApiError);
    }
  },
);

router.post(
  '/tasks/:id/resume',
  validateParams(IdParamsSchema),
  validateBody(ResumeTaskBodySchema),
  async (
    req: Request,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;
      const { restart_agent = false } = req.validated!.body as ResumeTaskBody;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!taskWithProject.workflow_blocked) {
        return res
          .status(400)
          .json({ error: 'Task workflow is not blocked' } satisfies ApiError);
      }

      tasksDb.unblockWorkflow(taskId);
      tasksDb.resetRunCount(taskId);

      const response: {
        success: true;
        workflow_blocked: false;
        workflow_run_count: 0;
        agent_restarted?: boolean;
        agent_restart_error?: string;
      } = {
        success: true,
        workflow_blocked: false,
        workflow_run_count: 0,
      };

      if (restart_agent) {
        try {
          const { startAgentRun } = await import('../services/agentRunner.js');
          const broadcastFn = (req.app.locals as { broadcastFn?: unknown }).broadcastFn;
          await startAgentRun(taskId, 'implementation', {
            broadcastFn: broadcastFn as never,
            userId,
          });
          response.agent_restarted = true;
        } catch (agentError) {
          console.error('Failed to restart agent:', agentError);
          response.agent_restart_error =
            agentError instanceof Error ? agentError.message : String(agentError);
        }
      }

      res.json(response);
    } catch (error) {
      console.error('Error resuming workflow:', error);
      res.status(500).json({ error: 'Failed to resume workflow' } satisfies ApiError);
    }
  },
);

router.get(
  '/tasks/:id/review-recording',
  validateParams(IdParamsSchema),
  async (req: Request, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const videoPath = getRecordingPath(taskWithProject.project_id, taskId);

      try {
        await fs.access(videoPath);
      } catch {
        return res
          .status(404)
          .json({ error: 'No review recording found' } satisfies ApiError);
      }

      const stat = await fs.stat(videoPath);
      const fileSize = stat.size;

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0] ?? '0', 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'video/webm',
        });

        const stream = fsSync.createReadStream(videoPath, { start, end });
        stream.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'video/webm',
          'Accept-Ranges': 'bytes',
        });

        const stream = fsSync.createReadStream(videoPath);
        stream.pipe(res);
      }
    } catch (error) {
      console.error('Error serving review recording:', error);
      res
        .status(500)
        .json({ error: 'Failed to serve review recording' } satisfies ApiError);
    }
  },
);

// ============================================================================
// Worktree Endpoints
// ============================================================================

router.get(
  '/tasks/:id/worktree',
  validateParams(IdParamsSchema),
  async (req: Request, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const status = await getWorktreeStatus(taskWithProject.repo_folder_path, taskId);
      res.json(status);
    } catch (error) {
      console.error('Error getting worktree status:', error);
      res
        .status(500)
        .json({ error: 'Failed to get worktree status' } satisfies ApiError);
    }
  },
);

router.post(
  '/tasks/:id/sync',
  validateParams(IdParamsSchema),
  async (req: Request, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const result = await syncWithMain(taskWithProject.repo_folder_path, taskId);
      res.json(result);
    } catch (error) {
      console.error('Error syncing with main:', error);
      res.status(500).json({ error: 'Failed to sync with main' } satisfies ApiError);
    }
  },
);

router.post(
  '/tasks/:id/pull-request',
  validateParams(IdParamsSchema),
  validateBody(CreatePullRequestBodySchema),
  async (
    req: Request,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const { title, body } = req.validated!.body as CreatePullRequestBody;

      const result = await createOrUpdatePR(
        taskWithProject.repo_folder_path,
        taskId,
        title,
        body || '',
      );
      res.json(result);
    } catch (error) {
      console.error('Error creating pull request:', error);
      res
        .status(500)
        .json({ error: 'Failed to create pull request' } satisfies ApiError);
    }
  },
);

router.get(
  '/tasks/:id/pull-request',
  validateParams(IdParamsSchema),
  async (req: Request, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const status = await getPullRequestStatus(taskWithProject.repo_folder_path, taskId);
      res.json(status);
    } catch (error) {
      console.error('Error getting pull request status:', error);
      res
        .status(500)
        .json({ error: 'Failed to get pull request status' } satisfies ApiError);
    }
  },
);

router.post(
  '/tasks/:id/merge-cleanup',
  validateParams(IdParamsSchema),
  async (req: Request, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const project = getProject(taskWithProject.project_id, userId);
      const wasActiveServer = project?.active_worktree_task_id === taskId;

      const result = (await mergeAndCleanup(
        taskWithProject.repo_folder_path,
        taskId,
      )) as {
        success: boolean;
        serverSwitched?: boolean;
        serverSwitchWarning?: string;
        serverSwitchMessage?: string;
        serverSwitchError?: string;
        [k: string]: unknown;
      };

      if (result.success && wasActiveServer && project?.serve_symlink_path) {
        const switchResult = await switchWorktree(taskWithProject.project_id, null, userId);
        if (switchResult.success) {
          result.serverSwitched = true;
          if (switchResult.warning) {
            result.serverSwitchWarning = switchResult.warning;
          } else {
            result.serverSwitchMessage = 'Server switched back to main repository';
          }
        } else {
          if (switchResult.error !== undefined) {
            result.serverSwitchError = switchResult.error;
          }
        }
      }

      res.json(result);
    } catch (error) {
      console.error('Error merging and cleaning up:', error);
      res.status(500).json({ error: 'Failed to merge and cleanup' } satisfies ApiError);
    }
  },
);

router.post(
  '/tasks/:id/push-changes',
  validateParams(IdParamsSchema),
  validateBody(PushChangesBodySchema),
  async (
    req: Request,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const { commitMessage } = req.validated!.body as PushChangesBody;
      const message = commitMessage || taskWithProject.title || `Task #${taskId}`;

      const result = await pushChanges(taskWithProject.repo_folder_path, taskId, message);
      res.json(result);
    } catch (error) {
      console.error('Error pushing changes:', error);
      res.status(500).json({ error: 'Failed to push changes' } satisfies ApiError);
    }
  },
);

router.delete(
  '/tasks/:id/worktree',
  validateParams(IdParamsSchema),
  validateQuery(DiscardWorktreeQuerySchema),
  async (
    req: Request,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const { id: taskId } = req.validated!.params as IdParams;
      const { force } = req.validated!.query as DiscardWorktreeQuery;

      const taskWithProject = tasksDb.getWithProject(taskId);

      if (!taskWithProject) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      if (!hasProjectAccess(taskWithProject.project_id, userId)) {
        return res.status(404).json({ error: 'Task not found' } satisfies ApiError);
      }

      const exists = await worktreeExists(taskWithProject.repo_folder_path, taskId);
      if (!exists) {
        return res.status(404).json({ error: 'Worktree not found' } satisfies ApiError);
      }

      const changesResult = await hasUncommittedChanges(
        taskWithProject.repo_folder_path,
        taskId,
      );
      const forceDelete = force === 'true';

      if (changesResult.success && changesResult.hasChanges && !forceDelete) {
        return res.status(409).json({
          error: 'Worktree has uncommitted changes',
          hasChanges: true,
        });
      }

      const result = await removeWorktree(taskWithProject.repo_folder_path, taskId);
      res.json(result);
    } catch (error) {
      console.error('Error discarding worktree:', error);
      res.status(500).json({ error: 'Failed to discard worktree' } satisfies ApiError);
    }
  },
);

export default router;
