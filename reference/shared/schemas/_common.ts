// Shared zod building blocks for the API boundary.
//
// Reusable param and query schemas keep the route files concise and
// guarantee that the same kind of input (e.g. `:id` URL segments) is
// validated identically everywhere.

import { z } from 'zod';

// `:id` URL segment — Express delivers it as a string, we coerce to a
// positive integer because every numeric ID in this codebase is a
// positive int (SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`).
export const IdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});
export type IdParams = z.infer<typeof IdParamsSchema>;

// Same shape but the param name is `projectId` (used on routes nested
// under `/projects/:projectId/...`).
export const ProjectIdParamsSchema = z.object({
  projectId: z.coerce.number().int().positive(),
});
export type ProjectIdParams = z.infer<typeof ProjectIdParamsSchema>;
