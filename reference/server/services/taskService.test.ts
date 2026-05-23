import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database module before importing the service
vi.mock('../database/db.js', () => ({
  tasksDb: {
    getAll: vi.fn(),
    getWithProject: vi.fn()
  }
}));

// Mock the projectService for hasProjectAccess
vi.mock('./projectService.js', () => ({
  hasProjectAccess: vi.fn()
}));

import { getAllTasks, getTask, hasTaskAccess } from './taskService.js';
import { tasksDb } from '../database/db.js';
import { hasProjectAccess } from './projectService.js';

describe('taskService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getAllTasks', () => {
    it('should return only the tasks in projects the user is a member of', () => {
      const userTasks = [{ id: 1, title: 'User Task', project_id: 1 }];
      vi.mocked(tasksDb.getAll).mockReturnValue(userTasks as never);

      const result = getAllTasks(2);

      expect(result).toEqual(userTasks);
      expect(tasksDb.getAll).toHaveBeenCalledWith(2, null);
    });

    it('should pass the status filter through to the membership query', () => {
      const userTasks = [{ id: 1, title: 'User Task', project_id: 1 }];
      vi.mocked(tasksDb.getAll).mockReturnValue(userTasks as never);

      const result = getAllTasks(2, 'in_progress');

      expect(result).toEqual(userTasks);
      expect(tasksDb.getAll).toHaveBeenCalledWith(2, 'in_progress');
    });
  });

  describe('getTask', () => {
    const mockTask = { id: 1, title: 'Test Task', project_id: 1 };

    it('should return task for user with project access', () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTask as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);

      const result = getTask(1, 2);

      expect(result).toEqual(mockTask);
      expect(tasksDb.getWithProject).toHaveBeenCalledWith(1);
      expect(hasProjectAccess).toHaveBeenCalledWith(1, 2);
    });

    it('should return null for non-existent task', () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(null as never);

      const result = getTask(999, 2);

      expect(result).toBeNull();
      expect(hasProjectAccess).not.toHaveBeenCalled();
    });

    it('should return null for user without project access', () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTask as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const result = getTask(1, 3);

      expect(result).toBeNull();
    });
  });

  describe('hasTaskAccess', () => {
    const mockTask = { id: 1, title: 'Test Task', project_id: 1 };

    it('should return true for user with project access', () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTask as never);
      vi.mocked(hasProjectAccess).mockReturnValue(true);

      const result = hasTaskAccess(1, 2);

      expect(result).toBe(true);
      expect(tasksDb.getWithProject).toHaveBeenCalledWith(1);
      expect(hasProjectAccess).toHaveBeenCalledWith(1, 2);
    });

    it('should return false for non-existent task', () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(null as never);

      const result = hasTaskAccess(999, 2);

      expect(result).toBe(false);
      expect(hasProjectAccess).not.toHaveBeenCalled();
    });

    it('should return false for user without project access', () => {
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTask as never);
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const result = hasTaskAccess(1, 3);

      expect(result).toBe(false);
    });
  });
});
