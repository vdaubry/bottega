import express, { type Request, type Response } from 'express';
import {
  switchServedTarget,
  getActiveWorktree,
  verifySymlink,
  updateWebServerConfig,
  type ServeTarget,
} from '../services/webServerManager.js';
import type { ApiError } from '../../shared/api/_common.js';

const router = express.Router();

interface ProjectIdParam {
  id: string;
}

interface UpdateWebServerConfigBody {
  serveSymlinkPath?: string | null;
  systemdServiceName?: string | null;
  appUrl?: string | null;
}

/**
 * `{taskId}` serves a ticket worktree, `{epicId}` an epic's delivery worktree,
 * neither (or both null) resets to the main checkout. Passing both is a 400 —
 * the symlink points at exactly one thing.
 */
interface SwitchWorktreeBody {
  taskId?: number | string | null;
  epicId?: number | string | null;
}

/** Parse an optional id from the body; `undefined` = not supplied. */
function parseOptionalId(raw: number | string | null | undefined): number | null | undefined {
  if (raw === null || raw === undefined) return null;
  const parsed = parseInt(String(raw), 10);
  return isNaN(parsed) ? undefined : parsed;
}

router.get(
  '/projects/:id/web-server',
  async (req: Request<ProjectIdParam>, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const projectId = parseInt(req.params.id, 10);

      if (isNaN(projectId)) {
        return res.status(400).json({ error: 'Invalid project ID' } satisfies ApiError);
      }

      const result = await getActiveWorktree(projectId, userId);

      if (!result.success) {
        return res
          .status(404)
          .json({ error: result.error ?? 'Unknown error' } satisfies ApiError);
      }

      res.json(result);
    } catch (error) {
      console.error('Error getting web server status:', error);
      res.status(500).json({ error: 'Failed to get web server status' } satisfies ApiError);
    }
  },
);

router.put(
  '/projects/:id/web-server/config',
  (
    req: Request<ProjectIdParam, unknown, UpdateWebServerConfigBody>,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const projectId = parseInt(req.params.id, 10);

      if (isNaN(projectId)) {
        return res.status(400).json({ error: 'Invalid project ID' } satisfies ApiError);
      }

      const { serveSymlinkPath, systemdServiceName, appUrl } = req.body;

      const result = updateWebServerConfig(projectId, userId, {
        serveSymlinkPath,
        systemdServiceName,
        appUrl,
      });

      if (!result.success) {
        return res
          .status(400)
          .json({ error: result.error ?? 'Unknown error' } satisfies ApiError);
      }

      res.json(result);
    } catch (error) {
      console.error('Error updating web server config:', error);
      res
        .status(500)
        .json({ error: 'Failed to update web server config' } satisfies ApiError);
    }
  },
);

router.post(
  '/projects/:id/web-server/switch',
  async (
    req: Request<ProjectIdParam, unknown, SwitchWorktreeBody>,
    res: Response<unknown>,
  ) => {
    try {
      const userId = req.user!.id;
      const projectId = parseInt(req.params.id, 10);

      if (isNaN(projectId)) {
        return res.status(400).json({ error: 'Invalid project ID' } satisfies ApiError);
      }

      const { taskId, epicId } = req.body;

      const parsedTaskId = parseOptionalId(taskId);
      if (parsedTaskId === undefined) {
        return res.status(400).json({ error: 'Invalid task ID' } satisfies ApiError);
      }
      const parsedEpicId = parseOptionalId(epicId);
      if (parsedEpicId === undefined) {
        return res.status(400).json({ error: 'Invalid epic ID' } satisfies ApiError);
      }
      if (parsedTaskId !== null && parsedEpicId !== null) {
        return res
          .status(400)
          .json({ error: 'Serve a task or an epic, not both' } satisfies ApiError);
      }

      const target: ServeTarget =
        parsedTaskId !== null
          ? { kind: 'task', taskId: parsedTaskId }
          : parsedEpicId !== null
            ? { kind: 'epic', epicId: parsedEpicId }
            : { kind: 'main' };

      const result = await switchServedTarget(projectId, target, userId);

      if (!result.success) {
        return res
          .status(400)
          .json({ error: result.error ?? 'Unknown error' } satisfies ApiError);
      }

      res.json(result);
    } catch (error) {
      console.error('Error switching worktree:', error);
      res.status(500).json({ error: 'Failed to switch worktree' } satisfies ApiError);
    }
  },
);

router.get(
  '/projects/:id/web-server/verify',
  async (req: Request<ProjectIdParam>, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const projectId = parseInt(req.params.id, 10);

      if (isNaN(projectId)) {
        return res.status(400).json({ error: 'Invalid project ID' } satisfies ApiError);
      }

      const result = await verifySymlink(projectId, userId);

      if (!result.success && !result.symlinkExists) {
        return res.json(result);
      }

      if (!result.success) {
        return res
          .status(400)
          .json({ error: result.error ?? 'Unknown error' } satisfies ApiError);
      }

      res.json(result);
    } catch (error) {
      console.error('Error verifying symlink:', error);
      res.status(500).json({ error: 'Failed to verify symlink' } satisfies ApiError);
    }
  },
);

export default router;
