// Runtime validation schemas for the `/api/projects/*` routes
// (`server/routes/projects.ts`).

import { z } from 'zod';

export const CreateProjectBodySchema = z.object({
  name: z.string().trim().min(1, 'Project name is required'),
  repoFolderPath: z
    .string()
    .trim()
    .min(1, 'Repository folder path is required'),
  subprojectPath: z.string().optional(),
  // The non-technical planning guardrail list; blank = off.
  sensitiveAreas: z.string().max(20_000).optional(),
});
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;

export const UpdateProjectBodySchema = z.object({
  name: z.string().optional(),
  repoFolderPath: z.string().optional(),
  // The DB layer accepts `null` to clear the column, and the existing
  // type `UpdateProjectRequest` allows `undefined`. Be permissive here.
  subprojectPath: z.string().nullable().optional(),
  // Blank or null clears the list — the guardrail is then off for the project.
  sensitiveAreas: z.string().max(20_000).nullable().optional(),
});
export type UpdateProjectBody = z.infer<typeof UpdateProjectBodySchema>;
