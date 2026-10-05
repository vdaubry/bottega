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

import type { TaskRow, TaskStatus, AgentRunStatus } from '../types/db';
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
  // Attach the ticket to an epic of the same project. The worktree then forks
  // off the epic's feature branch instead of the repo default.
  epic_id?: number;
  // Position inside the epic; omitted appends after the epic's last ticket.
  epic_order?: number;
}

// The created row — its `worktree_state` is 'provisioning' while the worktree
// is set up in the background — and, for an epic ticket, the branch it forked
// from and any non-fatal branch warning (e.g. the feature branch could not be
// pushed to origin).
export type CreateTaskResponse = TaskRow & {
  base_branch?: string;
  warning?: string;
};

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
  /**
   * Tasks left alone because their worktree still held uncommitted or unpushed
   * work. A sweep never forces — the user deletes those individually, with the
   * usual three-way prompt.
   */
  skipped: Array<{ taskId: number; reason: string }>;
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

// ---- Phases --------------------------------------------------------------
//
// `GET /api/tasks/:id/phases` — the agent-phase breakdown of a task, one entry
// per `AgentType` workflow phase (the single-pass `yolo` type is excluded).
// Each phase reports the status of its most recent `task_agent_runs` row (or a
// workflow-flag-derived `completed`, else `not_started`) plus the conversation
// ids of every run of that phase, newest-first to mirror the web-UI sidebar.

export type PhaseName =
  | 'planification'
  | 'implementation'
  | 'review'
  | 'refinement'
  | 'pr';

// The run status union plus a `not_started` extension for "no run yet".
export type PhaseStatusValue = 'not_started' | AgentRunStatus;

export interface PhaseStatus {
  phase: PhaseName;
  // Human-readable label mapping the user's vocabulary onto the phase key
  // (e.g. 'Classification' for `planification`, 'Pull Request' for `pr`).
  label: string;
  status: PhaseStatusValue;
  // Conversation ids of this phase's runs, ordered newest-first (the
  // `conversations.created_at DESC` sidebar order).
  conversation_ids: number[];
}

export interface GetTaskPhasesResponse {
  phases: PhaseStatus[];
}

// ---- Plan ----------------------------------------------------------------
//
// `GET /api/tasks/:id/plan` — the generated markdown plan, gated on
// `planification_complete`. `200 { status:'not_ready', content:null }` while
// planification hasn't finished; `200 { status:'ready', content }` once it has.
// A genuine `404` is still returned when the ticket doesn't exist / no access.

export interface GetTaskPlanResponse {
  status: 'ready' | 'not_ready';
  content: string | null;
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
      // Branch the ahead/behind counts are measured against: the repo default
      // for a standalone ticket, the epic's feature branch for an epic ticket.
      baseBranch: string;
      /** @deprecated Alias of `baseBranch`. */
      mainBranch: string;
      worktreePath: string;
      // Unsaved-work snapshot. `ahead`/`behind` measure against the *base*
      // branch and so cannot distinguish "pushed to the PR" from "only here";
      // these two can.
      dirtyPaths: string[];
      dirtyFiles: number;
      unpushed: number;
    }
  | { success: false; error: string };

export type SyncWorktreeResponse =
  | { success: true; baseBranch: string }
  | { success: false; baseBranch: string; error: string };

export interface PushChangesRequest {
  // Falls back to the task title (or `Task #<id>`) server-side.
  commitMessage?: string | undefined;
}

export type PushChangesResponse =
  | { success: true; message?: string }
  | { success: false; error: string };

export interface DiscardWorktreeQuery {
  // `'true'` to delete despite uncommitted/unpushed work (409 otherwise).
  force?: 'true';
}

// `DELETE /api/tasks/:id/worktree` — same as `removeWorktree`, plus the
// 409 conflict body when unsaved work blocks deletion.
// POST /api/tasks/:id/worktree/retry — the task row, back to 'provisioning'.
// The outcome arrives as a `task-worktree-updated` WebSocket event.
export type RetryWorktreeSetupResponse = TaskRow;

export type DiscardWorktreeResponse =
  | { success: true }
  | { success: false; error: string };

/**
 * The uniform 409 every worktree-destroying endpoint returns when the worktree
 * still holds work: `DELETE /tasks/:id/worktree`, `POST /tasks/:id/merge-cleanup`
 * and `DELETE /tasks/:id`. One shape so the client has one modal.
 *
 * `prNumber`/`prUrl` decide the wording of the "save my work" option: pushing
 * updates an existing PR, or just publishes the branch when there is none.
 */
export const UNSAVED_WORKTREE_WORK = 'worktree-has-unsaved-work';

export interface UnsavedWorktreeWorkResponse {
  error: typeof UNSAVED_WORKTREE_WORK;
  /** Human-readable summary, e.g. "4 uncommitted files and 2 unpushed commits". */
  summary: string;
  taskId: number;
  branch: string | null;
  dirtyPaths: string[];
  dirtyFiles: number;
  unpushedCommits: number;
  prUrl: string | null;
  prNumber: number | null;
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

// `POST /api/tasks/:id/merge-cleanup` — completes from GitHub's authoritative
// merge fact; local cleanup may continue independently.
export type MergeAndCleanupResponse =
  | {
      success: true;
      merged?: boolean;
      cleanupPending?: boolean;
      cleanupError?: string;
      cleanupRequiresManualReview?: boolean;
      warning?: string;
      serverSwitched?: boolean;
      serverSwitchMessage?: string;
      serverSwitchWarning?: string;
      serverSwitchError?: string;
    }
  | { success: false; error: string };

// ---- Type-level smoke checks ---------------------------------------------

expectType<TaskRow['status']>('pending');
expectType<UpdateTaskRequest['status']>(undefined as TaskStatus | undefined);
