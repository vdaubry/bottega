import { projectsDb, projectMembersDb } from '../database/db.js';
import type { ProjectRow, ProjectUpdates } from '../database/db.js';

/**
 * Check if user is a member of a project
 */
export function hasProjectAccess(projectId: number, userId: number | undefined): boolean {
  if (userId === undefined) return false;
  return projectMembersDb.isMember(projectId, userId);
}

/**
 * Get all projects the user is a member of
 */
export function getAllProjects(userId: number): ProjectRow[] {
  return projectsDb.getAll(userId);
}

/**
 * Get project by ID if user is a member
 */
export function getProject(projectId: number, userId: number): ProjectRow | undefined {
  return projectsDb.getById(projectId, userId);
}

/**
 * Update project if user is a member
 */
export function updateProject(
  projectId: number,
  userId: number,
  updates: ProjectUpdates,
): ProjectRow | undefined | null {
  return projectsDb.update(projectId, userId, updates);
}

/**
 * Delete project if user is a member
 */
export function deleteProject(projectId: number, userId: number): boolean {
  return projectsDb.delete(projectId, userId);
}
