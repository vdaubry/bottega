import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database module before importing the service
vi.mock('../database/db.js', () => ({
  projectsDb: {
    getAll: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  },
  projectMembersDb: {
    isMember: vi.fn()
  }
}));

import {
  hasProjectAccess,
  getAllProjects,
  getProject,
  updateProject,
  deleteProject
} from './projectService.js';
import { projectsDb, projectMembersDb } from '../database/db.js';

describe('projectService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('hasProjectAccess', () => {
    it('should return true for project members', () => {
      vi.mocked(projectMembersDb.isMember).mockReturnValue(true);

      const result = hasProjectAccess(1, 2);

      expect(result).toBe(true);
      expect(projectMembersDb.isMember).toHaveBeenCalledWith(1, 2);
    });

    it('should return false for non-members', () => {
      vi.mocked(projectMembersDb.isMember).mockReturnValue(false);

      const result = hasProjectAccess(1, 3);

      expect(result).toBe(false);
      expect(projectMembersDb.isMember).toHaveBeenCalledWith(1, 3);
    });

    it('should return false when userId is undefined', () => {
      const result = hasProjectAccess(1, undefined);

      expect(result).toBe(false);
      expect(projectMembersDb.isMember).not.toHaveBeenCalled();
    });
  });

  describe('getAllProjects', () => {
    it('should return only the projects the user is a member of', () => {
      const userProjects = [{ id: 1, name: 'User Project' }];
      vi.mocked(projectsDb.getAll).mockReturnValue(userProjects as never);

      const result = getAllProjects(2);

      expect(result).toEqual(userProjects);
      expect(projectsDb.getAll).toHaveBeenCalledWith(2);
    });
  });

  describe('getProject', () => {
    const mockProject = { id: 1, name: 'Test Project' };

    it('should return the project for a member', () => {
      vi.mocked(projectsDb.getById).mockReturnValue(mockProject as never);

      const result = getProject(1, 2);

      expect(result).toEqual(mockProject);
      expect(projectsDb.getById).toHaveBeenCalledWith(1, 2);
    });

    it('should return undefined for a non-member', () => {
      vi.mocked(projectsDb.getById).mockReturnValue(undefined);

      const result = getProject(1, 3);

      expect(result).toBeUndefined();
      expect(projectsDb.getById).toHaveBeenCalledWith(1, 3);
    });
  });

  describe('updateProject', () => {
    const updatedProject = { id: 1, name: 'Updated Project' };
    const updates = { name: 'Updated Project' };

    it('should update the project for a member', () => {
      vi.mocked(projectsDb.update).mockReturnValue(updatedProject as never);

      const result = updateProject(1, 2, updates);

      expect(result).toEqual(updatedProject);
      expect(projectsDb.update).toHaveBeenCalledWith(1, 2, updates);
    });

    it('should return null when the user is not a member', () => {
      vi.mocked(projectsDb.update).mockReturnValue(null);

      const result = updateProject(1, 3, updates);

      expect(result).toBeNull();
      expect(projectsDb.update).toHaveBeenCalledWith(1, 3, updates);
    });
  });

  describe('deleteProject', () => {
    it('should delete the project for a member', () => {
      vi.mocked(projectsDb.delete).mockReturnValue(true);

      const result = deleteProject(1, 2);

      expect(result).toBe(true);
      expect(projectsDb.delete).toHaveBeenCalledWith(1, 2);
    });

    it('should return false when the user is not a member', () => {
      vi.mocked(projectsDb.delete).mockReturnValue(false);

      const result = deleteProject(1, 3);

      expect(result).toBe(false);
      expect(projectsDb.delete).toHaveBeenCalledWith(1, 3);
    });
  });
});
