// Shared shapes for the Explore (code-atlas) view: REST payloads and the
// atlas-* WebSocket events. Server-only details (absolute paths) stay out.

export interface AtlasTreeEntry {
  name: string;
  path: string; // workspace-relative, posix separators
  type: 'file' | 'dir';
}

/** Client-facing file payload — never leaks the server's absolute path. */
export interface AtlasFilePayload {
  path: string; // workspace-relative
  content: string;
  lineCount: number;
}

export interface HighlightRange {
  start: number; // 1-based, inclusive
  end: number; // 1-based, inclusive
}

export const HIGHLIGHT_COLORS = ['yellow', 'green', 'red', 'blue'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/**
 * The kinds of self-contained HTML artifact the Explore view can generate:
 *  - `plan`         — the task's markdown plan rendered as a beautiful HTML page
 *  - `flowchart`    — a request/logic flow (hand-authored SVG + flow chips)
 *  - `architecture` — a module/feature map (full-screen interactive SVG diagram)
 *
 * A task can hold one of each simultaneously (one row per (task, kind)).
 */
export const ARTIFACT_KINDS = ['plan', 'flowchart', 'architecture'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Latest persisted artifact for a (task, kind) — a task_artifacts row. */
export interface TaskArtifact {
  taskId: number;
  kind: ArtifactKind;
  title: string | null;
  html: string;
  updatedAt: string;
}

/** Metadata-only view of an artifact (no html blob) — feeds the kind switcher. */
export interface TaskArtifactSummary {
  taskId: number;
  kind: ArtifactKind;
  title: string | null;
  updatedAt: string;
}
