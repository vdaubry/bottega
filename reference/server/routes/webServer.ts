import express, { type Request, type Response } from 'express';
import {
  switchWorktree,
  getActiveWorktree,
  verifySymlink,
  updateWebServerConfig,
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

interface SwitchWorktreeBody {
  taskId?: number | string | null;
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

      const { taskId } = req.body;

      let parsedTaskId: number | null = null;
      if (taskId !== null && taskId !== undefined) {
        parsedTaskId = parseInt(String(taskId), 10);
        if (isNaN(parsedTaskId)) {
          return res.status(400).json({ error: 'Invalid task ID' } satisfies ApiError);
        }
      }

      const result = await switchWorktree(projectId, parsedTaskId, userId);

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
