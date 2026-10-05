// Runtime validation schemas for the `/api/tasks/:id/atlas/*` routes
// (`server/routes/atlas.ts`).

import { z } from 'zod';
import { ARTIFACT_KINDS } from '../types/atlas.js';

// Directory to list, workspace-relative ('' / '.' = the root). Containment
// (no escaping the workspace) is enforced by the Workspace service, not here.
export const AtlasTreeQuerySchema = z.object({
  path: z.string().default(''),
});
export type AtlasTreeQuery = z.infer<typeof AtlasTreeQuerySchema>;

export const AtlasFileQuerySchema = z.object({
  path: z.string().min(1),
});
export type AtlasFileQuery = z.infer<typeof AtlasFileQuerySchema>;

// Artifact generation runs on the Claude Agent SDK (the in-process code-atlas
// MCP server can't attach to other providers). The model is no longer carried
// in the request body — the route resolves it from the user's Anthropic-only
// `schema` model setting (Settings → Agent Models → Schema). `kind` is either a
// concrete artifact kind or `auto` (let the model pick the best-fit kind).
export const GenerateArtifactBodySchema = z.object({
  kind: z.enum(['auto', ...ARTIFACT_KINDS]),
});
export type GenerateArtifactBody = z.infer<typeof GenerateArtifactBodySchema>;

// `:kind` route param for GET /atlas/artifact/:kind — must be a concrete kind
// (the iframe srcdoc fetch always asks for a specific stored kind).
export const ArtifactKindParamsSchema = z.object({
  kind: z.enum(ARTIFACT_KINDS),
});
export type ArtifactKindParams = z.infer<typeof ArtifactKindParamsSchema>;
