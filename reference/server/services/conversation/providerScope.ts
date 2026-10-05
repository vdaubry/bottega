import { tasksDb } from '../../database/db.js';
import { getWorktreeProjectPath, worktreeExists } from '../worktree.js';
import {
  resolveConversationScope,
  targetFromConversation,
  type ConversationScope,
  type ConversationTarget,
} from './conversationScope.js';
import type { ConversationRow } from '@shared/types/db';

async function legacyTaskScope(taskId: number): Promise<ConversationScope> {
  const task = tasksDb.getWithProject(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  let cwd = task.repo_folder_path;
  if (await worktreeExists(cwd, taskId)) {
    cwd = getWorktreeProjectPath(cwd, taskId, task.subproject_path);
  }
  return {
    kind: 'task',
    taskId,
    epicId: null,
    projectId: task.project_id,
    repoFolderPath: task.repo_folder_path,
    subprojectPath: task.subproject_path,
    cwd,
  };
}

/** Numeric task ids are retained for direct provider-runner compatibility. */
export async function resolveProviderStartScope(
  targetOrTaskId: ConversationTarget | number,
): Promise<{ target: ConversationTarget; scope: ConversationScope }> {
  if (typeof targetOrTaskId === 'number') {
    return {
      target: { kind: 'task', taskId: targetOrTaskId },
      scope: await legacyTaskScope(targetOrTaskId),
    };
  }
  return { target: targetOrTaskId, scope: await resolveConversationScope(targetOrTaskId) };
}

export async function resolveProviderResumeScope(
  conversation: ConversationRow,
): Promise<ConversationScope> {
  if (conversation.task_id != null) return legacyTaskScope(conversation.task_id);
  return resolveConversationScope(targetFromConversation(conversation));
}
