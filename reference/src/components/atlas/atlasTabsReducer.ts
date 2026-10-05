/**
 * Tab/file/highlight state for the Explore view — a pure reducer so the open/
 * select/close/pin/highlight semantics are unit-testable.
 *
 * One pinned tab always exists: Schema (the interactive diagram), which is the
 * landing tab. (The Plan tab was removed — the markdown plan already lives on
 * the task-detail page; Explore goes straight to schema generation.) File tabs
 * are closable. Following the standard IDE model, a file opened by a single
 * click lands in a *preview* tab (rendered italic): there is at most one preview
 * tab, and the next single click reuses that slot instead of stacking up a tab
 * per click. Double-clicking the file or its tab — or any agent-driven
 * open/highlight — pins it as a permanent tab.
 */

import type { HighlightColor, HighlightRange } from '@shared/types/atlas';

export const SCHEMA_TAB_ID = 'schema';

export const fileTabId = (path: string): string => `file:${path}`;
export const pathOfTabId = (id: string): string | null =>
  id.startsWith('file:') ? id.slice('file:'.length) : null;

export interface AtlasFileState {
  content: string;
  lineCount: number;
}

export interface AtlasHighlightState {
  ranges: HighlightRange[];
  color: HighlightColor;
}

export interface AtlasViewState {
  /** Open file paths, in tab order (Schema is implicit, pinned first). */
  filePaths: string[];
  activeTabId: string;
  /** The single unpinned (preview) file, or null. Always within filePaths. */
  previewPath: string | null;
  files: Record<string, AtlasFileState>;
  highlights: Record<string, AtlasHighlightState>;
  /**
   * Pending scroll request for the active file. `nonce` forces the viewer
   * effect to re-fire when the same line is requested twice.
   */
  reveal: { path: string; line: number; nonce: number } | null;
}

export const initialAtlasViewState: AtlasViewState = {
  filePaths: [],
  activeTabId: SCHEMA_TAB_ID,
  previewPath: null,
  files: {},
  highlights: {},
  reveal: null,
};

export type AtlasViewAction =
  | {
      type: 'open-file';
      path: string;
      content: string;
      lineCount: number;
      line?: number | undefined;
      /** Open as a reusable preview tab. Defaults to a pinned tab. */
      preview?: boolean | undefined;
    }
  | {
      type: 'highlight-file';
      path: string;
      content: string;
      lineCount: number;
      ranges: HighlightRange[];
      color: HighlightColor;
    }
  | { type: 'select-tab'; id: string }
  | { type: 'pin-file'; path: string }
  | { type: 'close-file'; path: string }
  | { type: 'show-schema' };

function openFile(
  state: AtlasViewState,
  path: string,
  content: string,
  lineCount: number,
  line: number | undefined,
  preview: boolean,
): AtlasViewState {
  const already = state.filePaths.includes(path);
  let filePaths = state.filePaths;
  let previewPath = state.previewPath;
  let files = state.files;
  let highlights = state.highlights;

  if (!already) {
    const reuse =
      preview && previewPath !== null && state.filePaths.includes(previewPath);
    if (reuse) {
      // Replace the existing preview file in place — it is fully closed.
      const replaced = previewPath as string;
      filePaths = state.filePaths.map((p) => (p === replaced ? path : p));
      files = { ...state.files };
      delete files[replaced];
      highlights = { ...state.highlights };
      delete highlights[replaced];
    } else {
      filePaths = [...state.filePaths, path];
    }
    // Only a brand-new preview file becomes THE preview tab; a pinned open
    // leaves whatever preview already existed untouched.
    if (preview) previewPath = path;
  } else if (!preview && previewPath === path) {
    // Re-opening an already-open file never disturbs other tabs; the one case
    // that changes state is pinning the current preview (double-click / agent).
    previewPath = null;
  }

  return {
    ...state,
    filePaths,
    previewPath,
    activeTabId: fileTabId(path),
    // Refresh content on every open — the file may have changed on disk.
    files: { ...files, [path]: { content, lineCount } },
    highlights,
    reveal:
      line !== undefined
        ? { path, line, nonce: (state.reveal?.nonce ?? 0) + 1 }
        : state.reveal?.path === path
          ? state.reveal
          : null,
  };
}

export function atlasViewReducer(
  state: AtlasViewState,
  action: AtlasViewAction,
): AtlasViewState {
  switch (action.type) {
    case 'open-file':
      return openFile(
        state,
        action.path,
        action.content,
        action.lineCount,
        action.line,
        action.preview ?? false,
      );

    case 'highlight-file': {
      // Each call replaces the file's previous highlights (CodeAtlas
      // semantics) and reveals the first range. Highlights pin the tab so a
      // later preview navigation can't silently discard them.
      const opened = openFile(
        state,
        action.path,
        action.content,
        action.lineCount,
        action.ranges[0]?.start,
        false,
      );
      return {
        ...opened,
        highlights: {
          ...opened.highlights,
          [action.path]: { ranges: action.ranges, color: action.color },
        },
      };
    }

    case 'select-tab': {
      const path = pathOfTabId(action.id);
      if (path !== null && !state.filePaths.includes(path)) return state;
      return { ...state, activeTabId: action.id };
    }

    case 'pin-file':
      return state.previewPath === action.path
        ? { ...state, previewPath: null }
        : state;

    case 'show-schema':
      return { ...state, activeTabId: SCHEMA_TAB_ID };

    case 'close-file': {
      const index = state.filePaths.indexOf(action.path);
      if (index === -1) return state;
      const filePaths = state.filePaths.filter((p) => p !== action.path);
      const files = { ...state.files };
      delete files[action.path];
      const highlights = { ...state.highlights };
      delete highlights[action.path];

      let activeTabId = state.activeTabId;
      if (activeTabId === fileTabId(action.path)) {
        // Prefer the next file tab, then the previous one, then the Schema tab.
        const neighbor = filePaths[index] ?? filePaths[index - 1];
        activeTabId = neighbor !== undefined ? fileTabId(neighbor) : SCHEMA_TAB_ID;
      }

      return {
        ...state,
        filePaths,
        files,
        highlights,
        activeTabId,
        previewPath: state.previewPath === action.path ? null : state.previewPath,
        reveal: state.reveal?.path === action.path ? null : state.reveal,
      };
    }

    default:
      return state;
  }
}
