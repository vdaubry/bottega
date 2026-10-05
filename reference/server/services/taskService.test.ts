import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database module before importing the service. `db` is here because
// the service reaches conversationContentStore -> sqliteSessionStore, which
// grabs the default handle at import time.
vi.mock('../database/db.js', () => ({
  db: {},
  tasksDb: {
    getAll: vi.fn(),
    getWithProject: vi.fn(),
    getById: vi.fn(),
    getByEpic: vi.fn(() => []),
    create: vi.fn(),
    delete: vi.fn(),
    setEpicOrder: vi.fn(),
  },
  conversationsDb: {
    getByTask: vi.fn(() => []),
    delete: vi.fn(),
  },
}));

// Mock the projectService for hasProjectAccess
vi.mock('./projectService.js', () => ({
  hasProjectAccess: vi.fn()
}));

vi.mock('./conversationContentStore.js', () => ({
  purgeConversationMessages: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./documentation.js', () => ({
  writeTaskDoc: vi.fn(),
  deleteTaskArchive: vi.fn(),
}));

vi.mock('./worktree.js', () => ({
  isGitRepository: vi.fn(),
  removeWorktree: vi.fn(),
  worktreeExists: vi.fn(),
}));

// The background setup is covered by tasks/worktreeSetup.test.ts; here we
// only check that creation starts it and deletion cancels it.
vi.mock('./tasks/worktreeSetup.js', () => ({
  startWorktreeSetup: vi.fn().mockResolvedValue(undefined),
  cancelWorktreeSetup: vi.fn().mockResolvedValue(undefined),
}));

import {
  createTaskWithWorktree,
  deleteTaskCompletely,
  getAllTasks,
  getTask,
  hasTaskAccess,
} from './taskService.js';
import { tasksDb, conversationsDb } from '../database/db.js';
import { hasProjectAccess } from './projectService.js';
import { purgeConversationMessages } from './conversationContentStore.js';
import { deleteTaskArchive, writeTaskDoc } from './documentation.js';
import { isGitRepository, removeWorktree, worktreeExists } from './worktree.js';
import { cancelWorktreeSetup, startWorktreeSetup } from './tasks/worktreeSetup.js';
import type { ProjectRow, TaskWithProject } from '../database/db.js';

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

  // -------------------------------------------------------------------------
  // createTaskWithWorktree — the single creation path (REST route today, the
  // stories agent's MCP tool later).
  // -------------------------------------------------------------------------
  describe('createTaskWithWorktree', () => {
    const project = {
      id: 7,
      repo_folder_path: '/repo',
      subproject_path: null,
    } as ProjectRow;

    beforeEach(() => {
      vi.mocked(isGitRepository).mockResolvedValue(true);
      vi.mocked(tasksDb.create).mockImplementation(((
        projectId: number,
        title: string | null,
        _yolo: boolean,
        userId: number | null,
        baseBranch: string | null,
        worktreeState: string,
      ) => ({
        id: 5,
        projectId,
        title,
        user_id: userId,
        base_branch: baseBranch,
        worktree_state: worktreeState,
      })) as never);
      vi.mocked(tasksDb.getById).mockImplementation(
        ((id: number) => ({ id, project_id: 7, worktree_state: 'provisioning' })) as never,
      );
    });

    it('creates the row as provisioning, writes the doc and starts the setup in the background', async () => {
      const result = await createTaskWithWorktree(project, { title: 'Ticket', description: 'Do it' }, 3);

      expect(result.success).toBe(true);
      expect(tasksDb.create).toHaveBeenCalledWith(7, 'Ticket', false, 3, null, 'provisioning');
      expect(writeTaskDoc).toHaveBeenCalledWith(7, 5, 'Do it');
      expect(startWorktreeSetup).toHaveBeenCalledWith(5);
      // The reply is the full row, so the caller sees the setup state.
      expect(result.task).toEqual({ id: 5, project_id: 7, worktree_state: 'provisioning' });
    });

    it('returns without waiting for the setup to finish', async () => {
      vi.mocked(startWorktreeSetup).mockReturnValueOnce(new Promise(() => {}));

      const result = await createTaskWithWorktree(project, { title: 'Ticket' }, 3);

      expect(result.success).toBe(true);
    });

    it('stamps an explicit baseBranch on the row', async () => {
      const result = await createTaskWithWorktree(
        project,
        { title: 'Ticket', baseBranch: 'epic/8-nimbus' },
        3,
      );

      expect(result.success).toBe(true);
      expect(tasksDb.create).toHaveBeenCalledWith(
        7,
        'Ticket',
        false,
        3,
        'epic/8-nimbus',
        'provisioning',
      );
    });

    it('never rolls the row back', async () => {
      await createTaskWithWorktree(project, { title: 'Ticket' }, 3);

      expect(tasksDb.delete).not.toHaveBeenCalled();
    });

    it('creates a ready task with no setup (and never stores a base) for a non-git project', async () => {
      vi.mocked(isGitRepository).mockResolvedValue(false);

      const result = await createTaskWithWorktree(
        project,
        { title: 'Ticket', baseBranch: 'epic/8-nimbus' },
        3,
      );

      expect(result.success).toBe(true);
      expect(startWorktreeSetup).not.toHaveBeenCalled();
      expect(tasksDb.create).toHaveBeenCalledWith(7, 'Ticket', false, 3, null, 'ready');
      expect(writeTaskDoc).toHaveBeenCalled();
    });
  });

  describe('deleteTaskCompletely', () => {
    const task = {
      id: 5,
      project_id: 7,
      repo_folder_path: '/repo',
      worktree_state: 'ready',
    } as TaskWithProject;

    beforeEach(() => {
      vi.mocked(tasksDb.delete).mockReturnValue(true);
      vi.mocked(worktreeExists).mockResolvedValue(false);
      vi.mocked(conversationsDb.getByTask).mockReturnValue([] as never);
    });

    it('removes the worktree, purges transcripts and deletes the archive', async () => {
      vi.mocked(worktreeExists).mockResolvedValue(true);
      vi.mocked(removeWorktree).mockResolvedValue({ success: true });
      vi.mocked(conversationsDb.getByTask).mockReturnValue([
        { id: 11, claude_conversation_id: 'sess-1' },
      ] as never);

      await expect(deleteTaskCompletely(task)).resolves.toBe(true);

      // `force` stays unset — a plain delete still has to clear the
      // unsaved-work guard inside `removeWorktree`.
      expect(removeWorktree).toHaveBeenCalledWith('/repo', 5, { force: undefined });
      expect(purgeConversationMessages).toHaveBeenCalledWith(
        expect.objectContaining({ id: 11 }),
        '/repo',
      );
      expect(deleteTaskArchive).toHaveBeenCalledWith(7, 5);
    });

    it('cancels a running worktree setup before removing anything', async () => {
      const order: string[] = [];
      vi.mocked(cancelWorktreeSetup).mockImplementationOnce(async () => {
        order.push('cancel');
      });
      vi.mocked(worktreeExists).mockImplementationOnce(async () => {
        order.push('exists');
        return false;
      });

      await deleteTaskCompletely(task);

      expect(cancelWorktreeSetup).toHaveBeenCalledWith(5);
      expect(order).toEqual(['cancel', 'exists']);
    });

    it('force-removes a worktree whose setup never finished — no one worked in it', async () => {
      vi.mocked(worktreeExists).mockResolvedValue(true);
      vi.mocked(removeWorktree).mockResolvedValue({ success: true });

      await deleteTaskCompletely({ ...task, worktree_state: 'failed' });

      expect(removeWorktree).toHaveBeenCalledWith('/repo', 5, { force: true });
    });

    it('still deletes when the worktree removal and the purge fail', async () => {
      vi.mocked(worktreeExists).mockResolvedValue(true);
      vi.mocked(removeWorktree).mockResolvedValue({ success: false, error: 'locked' });
      vi.mocked(conversationsDb.getByTask).mockReturnValue([{ id: 11 }] as never);
      vi.mocked(purgeConversationMessages).mockRejectedValueOnce(new Error('boom'));

      await expect(deleteTaskCompletely(task)).resolves.toBe(true);
      expect(tasksDb.delete).toHaveBeenCalledWith(5);
    });

    it('reports false and leaves the archive alone when the row was already gone', async () => {
      vi.mocked(tasksDb.delete).mockReturnValue(false);

      await expect(deleteTaskCompletely(task)).resolves.toBe(false);
      expect(deleteTaskArchive).not.toHaveBeenCalled();
    });
  });
});
