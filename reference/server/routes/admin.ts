import express, { type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import { userDb, projectsDb, projectMembersDb } from '../database/db.js';
import type { ApiError } from '../../shared/api/_common.js';
import type {
  AddProjectMemberResponse,
  AdminProjectListItem,
  CreateAdminUserResponse,
  DeleteAdminUserResponse,
  GetProjectMembersResponse,
  ListAdminProjectsResponse,
  ListAdminUsersResponse,
  RemoveProjectMemberResponse,
  UpdateAdminUserResponse,
} from '../../shared/api/admin.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  AddProjectMemberBodySchema,
  type AddProjectMemberBody,
  CreateAdminUserBodySchema,
  type CreateAdminUserBody,
  ProjectUserIdParamsSchema,
  type ProjectUserIdParams,
  UpdateAdminUserBodySchema,
  type UpdateAdminUserBody,
} from '../../shared/schemas/admin.js';
import {
  IdParamsSchema,
  type IdParams,
} from '../../shared/schemas/_common.js';

const router = express.Router();

// ============ User Management ============

router.get(
  '/users',
  (_req: Request, res: Response<ListAdminUsersResponse | ApiError>) => {
    try {
      const users = userDb.getAllUsers();
      res.json(users);
    } catch (error) {
      console.error('Error listing users:', error);
      res.status(500).json({ error: 'Failed to list users' });
    }
  },
);

router.post(
  '/users',
  validateBody(CreateAdminUserBodySchema),
  async (
    req: Request,
    res: Response<CreateAdminUserResponse | ApiError>,
  ) => {
    try {
      const { username, password, is_admin } = req.validated!.body as CreateAdminUserBody;

      const existingUser = userDb.getUserByUsername(username);
      if (existingUser) {
        return res.status(409).json({ error: 'Username already exists' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = userDb.createUser(username, passwordHash);

      if (is_admin) {
        userDb.setAdmin(user.id, true);
      }

      res.status(201).json({
        id: user.id,
        username: user.username,
        is_admin: !!is_admin,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE')) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      console.error('Error creating user:', error);
      res.status(500).json({ error: 'Failed to create user' });
    }
  },
);

router.put(
  '/users/:id',
  validateParams(IdParamsSchema),
  validateBody(UpdateAdminUserBodySchema),
  async (
    req: Request,
    res: Response<UpdateAdminUserResponse | ApiError>,
  ) => {
    try {
      const { id: userId } = req.validated!.params as IdParams;

      const existingUser = userDb.getUserById(userId);
      if (!existingUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { username, password, is_active, is_admin } = req.validated!.body as UpdateAdminUserBody;
      const updates: { username?: string; is_active?: 0 | 1; is_admin?: 0 | 1 } = {};

      if (username !== undefined) updates.username = username;
      if (is_active !== undefined) updates.is_active = is_active ? 1 : 0;
      if (is_admin !== undefined) updates.is_admin = is_admin ? 1 : 0;

      if (password) {
        const passwordHash = await bcrypt.hash(password, 10);
        userDb.updatePassword(userId, passwordHash);
      }

      const user = userDb.updateUser(userId, updates);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      // userDb.updateUser returns SafeUserRow which is structurally
      // compatible with UpdateAdminUserResponse (Omit password_hash, api_key_hash).
      res.json(user as unknown as UpdateAdminUserResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE')) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      console.error('Error updating user:', error);
      res.status(500).json({ error: 'Failed to update user' });
    }
  },
);

router.delete(
  '/users/:id',
  validateParams(IdParamsSchema),
  (
    req: Request,
    res: Response<DeleteAdminUserResponse | ApiError>,
  ) => {
    try {
      const { id: userId } = req.validated!.params as IdParams;

      const existingUser = userDb.getUserById(userId);
      if (!existingUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (userId === req.user!.id) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
      }

      userDb.deleteUser(userId);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting user:', error);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  },
);

// ============ Project Membership Management ============

router.get(
  '/projects',
  (_req: Request, res: Response<ListAdminProjectsResponse | ApiError>) => {
    try {
      const projects = projectsDb.getAllAdmin();
      const projectsWithCounts: AdminProjectListItem[] = projects.map((p) => ({
        ...p,
        memberCount: projectMembersDb.getMemberCount(p.id),
      }));
      res.json(projectsWithCounts);
    } catch (error) {
      console.error('Error listing projects:', error);
      res.status(500).json({ error: 'Failed to list projects' });
    }
  },
);

router.get(
  '/projects/:id/members',
  validateParams(IdParamsSchema),
  (
    req: Request,
    res: Response<GetProjectMembersResponse | ApiError>,
  ) => {
    try {
      const { id: projectId } = req.validated!.params as IdParams;

      const project = projectsDb.getByIdAdmin(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const members = projectMembersDb.getProjectMembers(projectId);
      res.json(members);
    } catch (error) {
      console.error('Error getting project members:', error);
      res.status(500).json({ error: 'Failed to get project members' });
    }
  },
);

router.post(
  '/projects/:id/members',
  validateParams(IdParamsSchema),
  validateBody(AddProjectMemberBodySchema),
  (
    req: Request,
    res: Response<AddProjectMemberResponse | ApiError>,
  ) => {
    try {
      const { id: projectId } = req.validated!.params as IdParams;
      const { userId } = req.validated!.body as AddProjectMemberBody;

      const project = projectsDb.getByIdAdmin(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const user = userDb.getUserById(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const added = projectMembersDb.addMember(projectId, userId);
      if (!added) {
        return res.status(409).json({ error: 'User is already a member of this project' });
      }

      res.status(201).json({ success: true });
    } catch (error) {
      console.error('Error adding project member:', error);
      res.status(500).json({ error: 'Failed to add project member' });
    }
  },
);

router.delete(
  '/projects/:projectId/members/:userId',
  validateParams(ProjectUserIdParamsSchema),
  (
    req: Request,
    res: Response<RemoveProjectMemberResponse | ApiError>,
  ) => {
    try {
      const { projectId, userId } = req.validated!.params as ProjectUserIdParams;

      const project = projectsDb.getByIdAdmin(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const memberCount = projectMembersDb.getMemberCount(projectId);
      if (memberCount <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last member of a project' });
      }

      const removed = projectMembersDb.removeMember(projectId, userId);
      if (!removed) {
        return res.status(404).json({ error: 'User is not a member of this project' });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Error removing project member:', error);
      res.status(500).json({ error: 'Failed to remove project member' });
    }
  },
);

export default router;
