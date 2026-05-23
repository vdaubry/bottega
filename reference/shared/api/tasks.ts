// Request/response shapes for the task endpoints:
//  - /api/tasks*                     (CRUD + worktree + PR + workflow)
//  - /api/projects/:id/tasks         (list + create scoped to project)
//  - /api/tasks/:id/documentation
//  - /api/tasks/:id/attachments*
//  - /api/projects/:id/tasks/cleanup-old-completed
//
// Worktree/PR helper return types are reused from `server/services/worktree.js`
// and `server/services/prService.js`. The route layer either passes those
// through verbatim or wraps with a `serverSwitched*` envelope (delete,
// merge-cleanup) when the active web-server target is implicated.

import type { TaskRow, TaskStatus } from '../types/db';
import { expectType } from './_common';

// ---- Task list / get -----------------------------------------------------

// `GET /api/tasks` — list-all-across-projects endpoint, wrapped in `{ tasks }`.
// `?status=` narrows by `TaskStatus`.
export interface ListAllTasksQuery {
  status?: TaskStatus;
}

export interface ListAllTasksResponse {
  tasks: TaskRow[];
}

// `GET /api/projects/:projectId/tasks` — list-by-project, returns raw array.
export type ListProjectTasksResponse = TaskRow[];

export type GetTaskResponse = TaskRow;

// ---- Task create / update / delete ---------------------------------------

export interface CreateTaskRequest {
  title?: string;
  description?: string;
  // When true, the agent runs as the single-agent YOLO workflow rather than
  // the staged 5-step pipeline.
  yolo_mode?: boolean;
}

export type CreateTaskResponse = TaskRow;

// `PUT /api/tasks/:id` accepts a subset; CHECK columns must match the union.
export interface UpdateTaskRequest {
  title?: string;
  status?: TaskStatus;
  // Persisted as 0 | 1; the route accepts a boolean and converts.
  workflow_complete?: boolean;
}

export type UpdateTaskResponse = TaskRow;

// `DELETE /api/tasks/:id` returns `{ success: true }` plus optional
// server-switch fields when this task's worktree was the active web-server
// target and the symlink had to swing back to main.
export interface DeleteTaskResponse {
  success: true;
  serverSwitched?: boolean;
  serverSwitchMessage?: string;
  serverSwitchWarning?: string;
  serverSwitchError?: string;
}

// `DELETE /api/projects/:projectId/tasks/cleanup-old-completed`
export interface CleanupOldCompletedTasksQuery {
  // Defaults to 20 server-side; query string is parsed via `parseInt`.
  keep?: number;
}

export interface CleanupOldCompletedTasksResponse {
  deletedCount: number;
  message: string;
}

// ---- Documentation -------------------------------------------------------

export interface GetTaskDocResponse {
  content: string;
}

export interface UpdateTaskDocRequest {
  content: string;
}

export interface UpdateTaskDocResponse {
  success: true;
}

// ---- Attachments ---------------------------------------------------------

export interface TaskAttachment {
  name: string;
  path: string;
  size: number;
  uploadedAt: string;
}

export type ListTaskAttachmentsResponse = TaskAttachment[];

// Multipart upload — the JSON body returned mirrors `saveConversationUpload`'s
// shape under `file`.
export interface UploadTaskAttachmentResponse {
  success: true;
  file: {
    name: string;
    absolutePath: string;
    relativePath: string;
    size: number;
    mimeType: string;
  };
}

export interface DeleteTaskAttachmentResponse {
  success: true;
}

// ---- Workflow lifecycle --------------------------------------------------

export interface SetWorkflowCompleteRequest {
  complete: boolean;
}

export type SetWorkflowCompleteResponse = TaskRow;

export interface ResumeTaskRequest {
  // Default `false`. When true, restarts the implementation agent inline.
  restart_agent?: boolean;
}

export interface ResumeTaskResponse {
  success: true;
  workflow_blocked: false;
  workflow_run_count: 0;
  agent_restarted?: true;
  agent_restart_error?: string;
}

// ---- Worktree / git ------------------------------------------------------
//
// Direct passthrough of `server/services/worktree.js` return shapes —
// keeping the discriminant `success` so consumers branch on it.

export type WorktreeStatusResponse =
  | {
      success: true;
      branch: string | null;
      ahead: number;
      behind: number;
      mainBranch: string;
      worktreePath: string;
    }
  | { success: false; error: string };

export type SyncWorktreeResponse =
  | { success: true }
  | { success: false; error: string };

export interface PushChangesRequest {
  // Falls back to the task title (or `Task #<id>`) server-side.
  commitMessage?: string | undefined;
}

export type PushChangesResponse =
  | { success: true; message?: string }
  | { success: false; error: string };

export interface DiscardWorktreeQuery {
  // `'true'` to delete with uncommitted changes (responds 409 otherwise).
  force?: 'true';
}

// `DELETE /api/tasks/:id/worktree` — same as `removeWorktree`, plus the
// 409 conflict body when uncommitted changes block deletion.
export type DiscardWorktreeResponse =
  | { success: true }
  | { success: false; error: string };

export interface DiscardWorktreeConflictResponse {
  error: 'Worktree has uncommitted changes';
  hasChanges: true;
}

// ---- Pull request --------------------------------------------------------

export interface CreatePRRequest {
  title: string;
  body?: string;
}

export type CreatePRResponse =
  | { success: true; url: string }
  | { success: false; error: string };

export type CIStatus = 'none' | 'passed' | 'failed' | 'pending' | 'unknown';

export interface CICheck {
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | string;
  name: string;
  state: string;
  link: string;
}

export interface CIStatusDetails {
  status: CIStatus;
  checks: CICheck[];
}

// `GET /api/tasks/:id/pull-request` — `exists: false` when no PR, otherwise
// full PR + CI snapshot.
export type GetPRResponse =
  | {
      success: true;
      exists: true;
      url: string;
      state: string;
      mergeable: string;
      ciStatus: CIStatusDetails;
    }
  | { success: true; exists: false }
  | { success: false; error: string };

// `POST /api/tasks/:id/merge-cleanup` — wraps `mergeAndCleanup` plus
// optional server-switch fields (same envelope as DeleteTaskResponse).
export type MergeAndCleanupResponse =
  | {
      success: true;
      serverSwitched?: boolean;
      serverSwitchMessage?: string;
      serverSwitchWarning?: string;
      serverSwitchError?: string;
    }
  | { success: false; error: string };

// ---- Type-level smoke checks ---------------------------------------------

expectType<TaskRow['status']>('pending');
expectType<UpdateTaskRequest['status']>(undefined as TaskStatus | undefined);
