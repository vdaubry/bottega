import express, { type Request, type Response } from 'express';
import { projectsDb } from '../database/db.js';
import {
  getAllProjects,
  getProject,
  updateProject,
  deleteProject,
} from '../services/projectService.js';
import { saveConversationUpload } from '../services/documentation.js';
import { upload } from '../middleware/upload.js';
import type { ApiError } from '../../shared/api/_common.js';
import type {
  CreateProjectResponse,
  DeleteProjectResponse,
  GetProjectResponse,
  ListProjectsResponse,
  UpdateProjectResponse,
  UploadProjectFileResponse,
} from '../../shared/api/projects.js';
import type { ProjectUpdates } from '../database/db.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  IdParamsSchema,
  type IdParams,
} from '../../shared/schemas/_common.js';
import {
  CreateProjectBodySchema,
  type CreateProjectBody,
  UpdateProjectBodySchema,
  type UpdateProjectBody,
} from '../../shared/schemas/projects.js';

const router = express.Router();

router.get('/', (req: Request, res: Response<ListProjectsResponse | ApiError>) => {
  try {
    const userId = req.user!.id;
    const projects = getAllProjects(userId);
    res.json(projects);
  } catch (error) {
    console.error('Error listing projects:', error);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

router.post(
  '/',
  validateBody(CreateProjectBodySchema),
  (
    req: Request,
    res: Response<CreateProjectResponse | ApiError>,
  ) => {
    try {
      const userId = req.user!.id;
      const { name, repoFolderPath, subprojectPath } = req.validated!.body as CreateProjectBody;

      const project = projectsDb.create(
        userId,
        name.trim(),
        repoFolderPath.trim(),
        subprojectPath?.trim() || null,
      );

      // The pre-TS handler returned the `projectsDb.create` summary
      // directly (camelCase keys, no created_at). Preserving that exact
      // shape on the wire avoids breaking existing clients; the
      // CreateProjectResponse type is wider than what we actually return.
      res.status(201).json(project as unknown as CreateProjectResponse);
    } catch (error) {
      console.error('Error creating project:', error);
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE')) {
        return res
          .status(409)
          .json({ error: 'A project with this repository path already exists' });
      }
      res.status(500).json({ error: 'Failed to create project' });
    }
  },
);

router.get(
  '/:id',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<GetProjectResponse | ApiError>) => {
    try {
      const userId = req.user!.id;
      const { id: projectId } = req.validated!.params as IdParams;

      const project = getProject(projectId, userId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      res.json(project);
    } catch (error) {
      console.error('Error getting project:', error);
      res.status(500).json({ error: 'Failed to get project' });
    }
  },
);

router.put(
  '/:id',
  validateParams(IdParamsSchema),
  validateBody(UpdateProjectBodySchema),
  (
    req: Request,
    res: Response<UpdateProjectResponse | ApiError>,
  ) => {
    try {
      const userId = req.user!.id;
      const { id: projectId } = req.validated!.params as IdParams;
      const body = req.validated!.body as UpdateProjectBody;

      const updates: ProjectUpdates = {};
      if (body.name !== undefined) {
        updates.name = body.name.trim();
      }
      if (body.repoFolderPath !== undefined) {
        updates.repo_folder_path = body.repoFolderPath.trim();
      }
      if (body.subprojectPath !== undefined) {
        updates.subproject_path = body.subprojectPath?.trim() || null;
      }

      const project = updateProject(projectId, userId, updates);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      res.json(project);
    } catch (error) {
      console.error('Error updating project:', error);
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE')) {
        return res
          .status(409)
          .json({ error: 'A project with this repository path already exists' });
      }
      res.status(500).json({ error: 'Failed to update project' });
    }
  },
);

router.delete(
  '/:id',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<DeleteProjectResponse | ApiError>) => {
    try {
      const userId = req.user!.id;
      const { id: projectId } = req.validated!.params as IdParams;

      const deleted = deleteProject(projectId, userId);
      if (!deleted) {
        return res.status(404).json({ error: 'Project not found' });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting project:', error);
      res.status(500).json({ error: 'Failed to delete project' });
    }
  },
);

router.post(
  '/:id/upload',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<UploadProjectFileResponse | ApiError>) => {
    const userId = req.user!.id;
    const { id: projectId } = req.validated!.params as IdParams;

    const project = getProject(projectId, userId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    upload.single('file')(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        return res.status(400).json({ error: message });
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        return res.status(400).json({ error: 'No file provided' });
      }

      try {
        const fileInfo = saveConversationUpload(
          project.repo_folder_path,
          file.originalname,
          file.buffer,
        );
        res.status(201).json({ success: true, file: fileInfo });
      } catch (saveError) {
        console.error('Error saving upload:', saveError);
        res.status(500).json({ error: 'Failed to save file' });
      }
    });
  },
);

export default router;
