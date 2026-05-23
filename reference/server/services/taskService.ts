import { tasksDb } from '../database/db.js';
import { hasProjectAccess } from './projectService.js';
import type { TaskRow, TaskWithProject, TaskStatus } from '../database/db.js';

/**
 * Get all tasks the user has access to (across projects they are a member of)
 */
export function getAllTasks(userId: number, status: TaskStatus | null = null): TaskRow[] {
  return tasksDb.getAll(userId, status);
}

/**
 * Get task if user has access to its project
 */
export function getTask(taskId: number, userId: number): TaskWithProject | null {
  const task = tasksDb.getWithProject(taskId);
  if (!task) return null;

  if (!hasProjectAccess(task.project_id, userId)) {
    return null;
  }
  return task;
}

/**
 * Check if user has access to task's project
 */
export function hasTaskAccess(taskId: number, userId: number): boolean {
  const task = tasksDb.getWithProject(taskId);
  if (!task) return false;
  return hasProjectAccess(task.project_id, userId);
}
