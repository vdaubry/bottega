// Request/response shapes for the Explore (code-atlas) endpoints:
//  - GET  /api/tasks/:id/atlas/tree?path=          lazy directory listing
//  - GET  /api/tasks/:id/atlas/file?path=          read-only file payload
//  - GET  /api/tasks/:id/atlas/artifacts           per-kind artifact summaries
//  - GET  /api/tasks/:id/atlas/artifact/:kind      one artifact incl. html
//  - POST /api/tasks/:id/atlas/generate-artifact   start a generation conversation

import type { ConversationRow } from '../types/db';
import type {
  ArtifactKind,
  AtlasFilePayload,
  AtlasTreeEntry,
  TaskArtifact,
  TaskArtifactSummary,
} from '../types/atlas';

export type AtlasTreeResponse = AtlasTreeEntry[];

export type AtlasFileResponse = AtlasFilePayload;

// Metadata for every artifact kind the task currently has (no html) — feeds
// the kind switcher.
export interface GetTaskArtifactsResponse {
  artifacts: TaskArtifactSummary[];
}

// One artifact including its html document — lazily fetched by the iframe
// srcdoc when a kind becomes active. `null` when the kind has no artifact.
export interface GetTaskArtifactResponse {
  artifact: TaskArtifact | null;
}

export interface GenerateArtifactRequest {
  // A concrete artifact kind, or `auto` to let the model choose the best fit.
  // The model is no longer sent — the route resolves it from the user's
  // Anthropic-only `schema` model setting (Settings → Agent Models → Schema).
  kind: 'auto' | ArtifactKind;
}

// The freshly created atlas-flagged conversation, streaming its first turn.
export type GenerateArtifactResponse = ConversationRow;
