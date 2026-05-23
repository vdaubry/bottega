import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import adminRoutes from './admin.js';

// Mock bcrypt
vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed_password'),
    compare: vi.fn()
  }
}));

// Mock the database module
vi.mock('../database/db.js', () => ({
  userDb: {
    getAllUsers: vi.fn(),
    createUser: vi.fn(),
    getUserById: vi.fn(),
    getUserByUsername: vi.fn(),
    updateUser: vi.fn(),
    updatePassword: vi.fn(),
    deleteUser: vi.fn(),
    isAdmin: vi.fn()
  },
  projectsDb: {
    getAllAdmin: vi.fn(),
    getByIdAdmin: vi.fn()
  },
  projectMembersDb: {
    getProjectMembers: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    getMemberCount: vi.fn()
  }
}));

import { userDb, projectsDb, projectMembersDb } from '../database/db.js';

describe('Admin Routes', () => {
  let app: import("express").Application;
  const adminUser = { id: 1, username: 'admin', is_admin: 1 };

  beforeEach(() => {
    vi.clearAllMocks();

    app = express();
    app.use(express.json());

    // Mock authentication - add user to request
    app.use((req, res, next) => {
      req.user = adminUser as never;
      next();
    });

    app.use('/api/admin', adminRoutes);
  });

  describe('GET /api/admin/users', () => {
    it('should return all users', async () => {
      const mockUsers = [
        { id: 1, username: 'admin', is_admin: 1 },
        { id: 2, username: 'user2', is_admin: 0 }
      ];
      vi.mocked(userDb.getAllUsers).mockReturnValue(mockUsers as never);

      const res = await request(app).get('/api/admin/users');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockUsers);
      expect(userDb.getAllUsers).toHaveBeenCalled();
    });
  });

  describe('POST /api/admin/users', () => {
    it('should create a new user', async () => {
      const newUser = { id: 3, username: 'newuser' };
      vi.mocked(userDb.getUserByUsername).mockReturnValue(undefined);
      vi.mocked(userDb.createUser).mockReturnValue(newUser);

      const res = await request(app)
        .post('/api/admin/users')
        .send({ username: 'newuser', password: 'password123', is_admin: false });

      expect(res.status).toBe(201);
      expect(res.body.username).toBe('newuser');
      expect(userDb.createUser).toHaveBeenCalled();
    });

    it('should return 400 for missing username', async () => {
      const res = await request(app)
        .post('/api/admin/users')
        .send({ password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(Array.isArray(res.body.issues)).toBe(true);
    });

    it('should return 400 for missing password', async () => {
      const res = await request(app)
        .post('/api/admin/users')
        .send({ username: 'newuser' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(Array.isArray(res.body.issues)).toBe(true);
    });

    it('should return 409 for duplicate username', async () => {
      vi.mocked(userDb.getUserByUsername).mockReturnValue({ id: 2, username: 'existing' } as never);

      const res = await request(app)
        .post('/api/admin/users')
        .send({ username: 'existing', password: 'password123' });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already exists');
    });
  });

  describe('PUT /api/admin/users/:id', () => {
    it('should update a user', async () => {
      const updatedUser = { id: 2, username: 'updated', is_admin: 1 };
      vi.mocked(userDb.getUserById).mockReturnValue({ id: 2, username: 'oldname' } as never);
      vi.mocked(userDb.updateUser).mockReturnValue(updatedUser as never);

      const res = await request(app)
        .put('/api/admin/users/2')
        .send({ username: 'updated', is_admin: true });

      expect(res.status).toBe(200);
      expect(res.body.username).toBe('updated');
    });

    it('should return 404 for non-existent user', async () => {
      vi.mocked(userDb.getUserById).mockReturnValue(undefined);

      const res = await request(app)
        .put('/api/admin/users/999')
        .send({ username: 'updated' });

      expect(res.status).toBe(404);
    });

    it('should update password if provided', async () => {
      vi.mocked(userDb.getUserById).mockReturnValue({ id: 2, username: 'user2' } as never);
      vi.mocked(userDb.updateUser).mockReturnValue({ id: 2, username: 'user2' } as never);
      vi.mocked(userDb.updatePassword).mockReturnValue(true);

      const res = await request(app)
        .put('/api/admin/users/2')
        .send({ password: 'newpassword' });

      expect(res.status).toBe(200);
      expect(userDb.updatePassword).toHaveBeenCalled();
    });
  });

  describe('DELETE /api/admin/users/:id', () => {
    it('should delete a user', async () => {
      vi.mocked(userDb.getUserById).mockReturnValue({ id: 2, username: 'user2' } as never);
      vi.mocked(userDb.deleteUser).mockReturnValue(true);

      const res = await request(app).delete('/api/admin/users/2');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 404 for non-existent user', async () => {
      vi.mocked(userDb.getUserById).mockReturnValue(undefined);

      const res = await request(app).delete('/api/admin/users/999');

      expect(res.status).toBe(404);
    });

    it('should prevent self-deletion', async () => {
      vi.mocked(userDb.getUserById).mockReturnValue(adminUser as never);

      const res = await request(app).delete('/api/admin/users/1');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot delete your own account');
    });
  });

  describe('GET /api/admin/projects', () => {
    it('should return all projects with member counts', async () => {
      const mockProjects = [
        { id: 1, name: 'Project 1' },
        { id: 2, name: 'Project 2' }
      ];
      vi.mocked(projectsDb.getAllAdmin).mockReturnValue(mockProjects as never);
      vi.mocked(projectMembersDb.getMemberCount).mockReturnValue(2);

      const res = await request(app).get('/api/admin/projects');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].memberCount).toBe(2);
    });
  });

  describe('GET /api/admin/projects/:id/members', () => {
    it('should return project members', async () => {
      const mockMembers = [
        { id: 1, username: 'user1' },
        { id: 2, username: 'user2' }
      ];
      vi.mocked(projectsDb.getByIdAdmin).mockReturnValue({ id: 1, name: 'Project' } as never);
      vi.mocked(projectMembersDb.getProjectMembers).mockReturnValue(mockMembers as never);

      const res = await request(app).get('/api/admin/projects/1/members');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockMembers);
    });

    it('should return 404 for non-existent project', async () => {
      vi.mocked(projectsDb.getByIdAdmin).mockReturnValue(undefined);

      const res = await request(app).get('/api/admin/projects/999/members');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/admin/projects/:id/members', () => {
    it('should add a member to a project', async () => {
      vi.mocked(projectsDb.getByIdAdmin).mockReturnValue({ id: 1, name: 'Project' } as never);
      vi.mocked(userDb.getUserById).mockReturnValue({ id: 2, username: 'user2' } as never);
      vi.mocked(projectMembersDb.addMember).mockReturnValue(true);

      const res = await request(app)
        .post('/api/admin/projects/1/members')
        .send({ userId: 2 });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('should return 400 for missing userId', async () => {
      vi.mocked(projectsDb.getByIdAdmin).mockReturnValue({ id: 1, name: 'Project' } as never);

      const res = await request(app)
        .post('/api/admin/projects/1/members')
        .send({});

      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent user', async () => {
      vi.mocked(projectsDb.getByIdAdmin).mockReturnValue({ id: 1, name: 'Project' } as never);
      vi.mocked(userDb.getUserById).mockReturnValue(undefined);

      const res = await request(app)
        .post('/api/admin/projects/1/members')
        .send({ userId: 999 });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('User not found');
    });

    it('should return 409 for duplicate member', async () => {
      vi.mocked(projectsDb.getByIdAdmin).mockReturnValue({ id: 1, name: 'Project' } as never);
      vi.mocked(userDb.getUserById).mockReturnValue({ id: 2, username: 'user2' } as never);
      vi.mocked(projectMembersDb.addMember).mockReturnValue(false);

      const res = await request(app)
        .post('/api/admin/projects/1/members')
        .send({ userId: 2 });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already a member');
    });
  });

  describe('DELETE /api/admin/projects/:projectId/members/:userId', () => {
    it('should remove a member from a project', async () => {
      vi.mocked(projectsDb.getByIdAdmin).mockReturnValue({ id: 1, name: 'Project' } as never);
      vi.mocked(projectMembersDb.getMemberCount).mockReturnValue(2);
      vi.mocked(projectMembersDb.removeMember).mockReturnValue(true);

      const res = await request(app).delete('/api/admin/projects/1/members/2');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should prevent removing last member', async () => {
      vi.mocked(projectsDb.getByIdAdmin).mockReturnValue({ id: 1, name: 'Project' } as never);
      vi.mocked(projectMembersDb.getMemberCount).mockReturnValue(1);

      const res = await request(app).delete('/api/admin/projects/1/members/2');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot remove the last member');
    });

    it('should return 404 for non-existent project', async () => {
      vi.mocked(projectsDb.getByIdAdmin).mockReturnValue(undefined);

      const res = await request(app).delete('/api/admin/projects/999/members/2');

      expect(res.status).toBe(404);
    });

    it('should return 404 for non-member', async () => {
      vi.mocked(projectsDb.getByIdAdmin).mockReturnValue({ id: 1, name: 'Project' } as never);
      vi.mocked(projectMembersDb.getMemberCount).mockReturnValue(2);
      vi.mocked(projectMembersDb.removeMember).mockReturnValue(false);

      const res = await request(app).delete('/api/admin/projects/1/members/999');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not a member');
    });
  });
});
