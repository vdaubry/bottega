import { tasksDb, conversationsDb } from '../database/db.js';
import { hasProjectAccess } from './projectService.js';
import { purgeConversationMessages } from './conversationContentStore.js';
import { emitTaskEvent } from './tasks/events.js';
import { cancelWorktreeSetup, startWorktreeSetup } from './tasks/worktreeSetup.js';
import { deleteTaskArchive, writeTaskDoc } from './documentation.js';
import {
  isGitRepository,
  removeWorktree,
  worktreeExists,
} from './worktree.js';
import type { TaskRow, TaskWithProject, TaskStatus } from '../database/db.js';
import type { ProjectRow } from '../../shared/types/db.js';

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

// ---------------------------------------------------------------------------
// Task creation / deletion
//
// These two functions are the single implementation of "make a task" and
// "destroy a task", used by the REST routes and by the epic layer's ticket
// service. Everything a task needs to exist — the row, the worktree forked
// off the right base, the task doc on disk — happens here, in that order, so
// a programmatically-created task is byte-for-byte a human-created one. The
// task layer knows nothing about epics: an epic ticket is just a task whose
// caller passed a `baseBranch`.
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  title?: string | null | undefined;
  description?: string | undefined;
  yoloMode?: boolean | undefined;
  /**
   * The branch this task forks from and merges into. Omitted = the repo's
   * default branch (resolved at use, never stored). The epic layer passes its
   * feature branch here.
   */
  baseBranch?: string | null | undefined;
}

/**
 * The created task's full row. For a git project its `worktree_state` is
 * 'provisioning': the worktree is being set up in the background.
 */
export type CreatedTaskWithWorktree = TaskRow;

export interface CreateTaskResult {
  success: boolean;
  task?: CreatedTaskWithWorktree;
  error?: string;
}

/**
 * Create a task and its task doc, and start setting up its worktree.
 *
 * Returns as soon as the row and the doc exist. The worktree — `git worktree
 * add` plus the project's post-checkout hook, which can take minutes — is set
 * up in the background (`tasks/worktreeSetup.ts`); until it is ready the task
 * is 'provisioning' and no conversation can start on it. A failed setup keeps
 * the task as 'failed', for a retry or a delete — it is never rolled back.
 */
export async function createTaskWithWorktree(
  project: ProjectRow,
  input: CreateTaskInput,
  userId: number | null,
): Promise<CreateTaskResult> {
  const { title, description, yoloMode, baseBranch } = input;

  const isGit = await isGitRepository(project.repo_folder_path);

  const created = tasksDb.create(
    project.id,
    title?.trim() || null,
    !!yoloMode,
    userId,
    isGit ? (baseBranch ?? null) : null,
    isGit ? 'provisioning' : 'ready',
  );

  try {
    writeTaskDoc(project.id, created.id, description?.trim() || '');
  } catch (fileError) {
    console.error('Failed to create task documentation file:', fileError);
  }

  if (isGit) void startWorktreeSetup(created.id);

  const task = tasksDb.getById(created.id);
  if (!task) return { success: false, error: 'Task disappeared right after creation' };
  return { success: true, task };
}

/**
 * Remove a task and everything attached to it: worktree, transcript rows, DB
 * row, archive directory. Returns false when the row was already gone.
 *
 * The server-switch side effects stay in the route — they are about the
 * project's serving symlink, not about the task.
 *
 * **Throws `UnsavedWorktreeWorkError` when the worktree holds uncommitted or
 * unpushed work and `force` is not set.** The worktree is removed first, so the
 * throw happens before anything else has been destroyed — the task, its
 * transcripts and its archive are all still intact when a caller catches it.
 */
export async function deleteTaskCompletely(
  task: TaskWithProject,
  options: { force?: boolean | undefined } = {},
): Promise<boolean> {
  // A setup still running is stopped first; it removes its own half-made
  // worktree and branch on the way out.
  await cancelWorktreeSetup(task.id);

  if (await worktreeExists(task.repo_folder_path, task.id)) {
    // A worktree that never reached 'ready' holds no one's work — no
    // conversation can have run in it — so the unsaved-work check is moot.
    const removeOptions = task.worktree_state === 'ready' ? options : { force: true };
    const result = await removeWorktree(task.repo_folder_path, task.id, removeOptions);
    if (!result.success) {
      console.error(`Failed to remove worktree for task ${task.id}:`, result.error);
    }
  }

  // Explicit-delete semantics (architecture-v2 step 5): the base conversation
  // rows are infrastructure with no owner FK, so deleting the task removes
  // only the ownership links — the owning domain removes the rows itself.
  for (const conv of conversationsDb.getByTask(task.id)) {
    try {
      await purgeConversationMessages(conv, task.repo_folder_path);
    } catch (purgeError) {
      console.error(`Failed to purge messages for conversation ${conv.id}:`, purgeError);
    }
    conversationsDb.delete(conv.id);
  }

  const deleted = tasksDb.delete(task.id);
  if (!deleted) return false;

  try {
    deleteTaskArchive(task.project_id, task.id);
  } catch (fileError) {
    console.error('Failed to delete task archive:', fileError);
  }

  // The row is gone; anyone supervising this task (an epic orchestrator)
  // finds out through the event rather than by staring at a hole.
  emitTaskEvent('task-deleted', { taskId: task.id });

  return true;
}
