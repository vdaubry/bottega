// Runtime validation schemas for the `/api/tasks/*` and
// `/api/projects/:projectId/tasks/*` routes (`server/routes/tasks.ts`).

import { z } from 'zod';

// ---- Status enum used both in body and query --------------------------

export const TaskStatusSchema = z.enum([
  'pending',
  'in_progress',
  'in_review',
  'completed',
]);
export type TaskStatusValue = z.infer<typeof TaskStatusSchema>;

// ---- Query schemas ----------------------------------------------------

export const ListTasksQuerySchema = z.object({
  status: TaskStatusSchema.optional(),
});
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>;

export const CleanupOldCompletedQuerySchema = z.object({
  // The pre-zod handler did `parseInt(req.query.keep ?? '', 10) || 20`.
  // Coerce to a positive int and default to 20 to keep that behaviour.
  keep: z.coerce.number().int().positive().default(20),
});
export type CleanupOldCompletedQuery = z.infer<typeof CleanupOldCompletedQuerySchema>;

/**
 * `?force=true` — proceed even though the worktree holds uncommitted or
 * unpushed work. Shared by every worktree-destroying route (discard,
 * merge-cleanup, delete task) so they take the same escape hatch.
 *
 * The handlers treat `force === 'true'` as a boolean — preserve that
 * string-typed contract instead of coercing.
 */
export const ForceQuerySchema = z.object({
  force: z.string().optional(),
});
export type ForceQuery = z.infer<typeof ForceQuerySchema>;

/** @deprecated Alias of `ForceQuerySchema`, kept for existing call sites. */
export const DiscardWorktreeQuerySchema = ForceQuerySchema;
export type DiscardWorktreeQuery = ForceQuery;

// ---- Param schemas ----------------------------------------------------

// `/tasks/:id/attachments/:filename` — `filename` is a string, not a
// number. Keep `id` numeric for parity with the rest of the routes.
export const TaskAttachmentParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  filename: z.string().min(1),
});
export type TaskAttachmentParams = z.infer<typeof TaskAttachmentParamsSchema>;

// ---- Body schemas -----------------------------------------------------

// Epic membership fields were removed in architecture-v2 step 3 — tickets are
// created through POST /epics/:id/tasks instead.
export const CreateTaskBodySchema = z.object({
  title: z.string().nullable().optional(),
  description: z.string().optional(),
  yolo_mode: z.boolean().optional(),
});
export type CreateTaskBody = z.infer<typeof CreateTaskBodySchema>;

export const UpdateTaskBodySchema = z.object({
  title: z.string().nullable().optional(),
  status: TaskStatusSchema.optional(),
  // Existing route accepted boolean | 0 | 1.
  workflow_complete: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
});
export type UpdateTaskBody = z.infer<typeof UpdateTaskBodySchema>;

export const UpdateTaskDocBodySchema = z.object({
  content: z.string(),
});
export type UpdateTaskDocBody = z.infer<typeof UpdateTaskDocBodySchema>;

export const WorkflowCompleteBodySchema = z.object({
  complete: z.boolean(),
});
export type WorkflowCompleteBody = z.infer<typeof WorkflowCompleteBodySchema>;

export const ResumeTaskBodySchema = z.object({
  restart_agent: z.boolean().optional(),
});
export type ResumeTaskBody = z.infer<typeof ResumeTaskBodySchema>;

export const CreatePullRequestBodySchema = z.object({
  title: z.string().min(1, 'PR title is required'),
  body: z.string().optional(),
});
export type CreatePullRequestBody = z.infer<typeof CreatePullRequestBodySchema>;

export const PushChangesBodySchema = z.object({
  commitMessage: z.string().optional(),
});
export type PushChangesBody = z.infer<typeof PushChangesBodySchema>;
