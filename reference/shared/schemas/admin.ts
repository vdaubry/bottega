// Runtime validation schemas for the `/api/admin/*` routes
// (`server/routes/admin.ts`).

import { z } from 'zod';

// ---- Users ---------------------------------------------------------------

export const CreateAdminUserBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  is_admin: z.boolean().optional(),
});
export type CreateAdminUserBody = z.infer<typeof CreateAdminUserBodySchema>;

export const UpdateAdminUserBodySchema = z.object({
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  is_active: z.boolean().optional(),
  is_admin: z.boolean().optional(),
});
export type UpdateAdminUserBody = z.infer<typeof UpdateAdminUserBodySchema>;

// ---- Project membership --------------------------------------------------

export const AddProjectMemberBodySchema = z.object({
  userId: z.coerce.number().int().positive(),
});
export type AddProjectMemberBody = z.infer<typeof AddProjectMemberBodySchema>;

// `:projectId/:userId` route — both segments are coerced to positive
// integers. A separate schema (rather than reusing IdParams) keeps the
// param name aligned with the URL.
export const ProjectUserIdParamsSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  userId: z.coerce.number().int().positive(),
});
export type ProjectUserIdParams = z.infer<typeof ProjectUserIdParamsSchema>;
