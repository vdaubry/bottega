import { describe, it, expect } from 'vitest';
import {
  atlasViewReducer,
  initialAtlasViewState,
  fileTabId,
  pathOfTabId,
  SCHEMA_TAB_ID,
  type AtlasViewState,
} from './atlasTabsReducer';

const open = (state: AtlasViewState, path: string, line?: number): AtlasViewState =>
  atlasViewReducer(state, {
    type: 'open-file',
    path,
    content: `content of ${path}`,
    lineCount: 10,
    line,
  });

const preview = (state: AtlasViewState, path: string, line?: number): AtlasViewState =>
  atlasViewReducer(state, {
    type: 'open-file',
    path,
    content: `content of ${path}`,
    lineCount: 10,
    line,
    preview: true,
  });

describe('atlasViewReducer', () => {
  it('starts on the Schema tab with no files (Plan tab removed)', () => {
    expect(initialAtlasViewState.activeTabId).toBe(SCHEMA_TAB_ID);
    expect(initialAtlasViewState.filePaths).toEqual([]);
  });

  describe('open-file', () => {
    it('adds a tab, stores the content, and activates it', () => {
      const state = open(initialAtlasViewState, 'src/a.ts');
      expect(state.filePaths).toEqual(['src/a.ts']);
      expect(state.activeTabId).toBe(fileTabId('src/a.ts'));
      expect(state.files['src/a.ts']).toEqual({ content: 'content of src/a.ts', lineCount: 10 });
      expect(state.reveal).toBeNull();
    });

    it('dedupes by path and refreshes the content', () => {
      let state = open(initialAtlasViewState, 'src/a.ts');
      state = atlasViewReducer(state, {
        type: 'open-file',
        path: 'src/a.ts',
        content: 'fresh content',
        lineCount: 2,
      });
      expect(state.filePaths).toEqual(['src/a.ts']);
      expect(state.files['src/a.ts']!.content).toBe('fresh content');
    });

    it('records a reveal request with a bumping nonce', () => {
      let state = open(initialAtlasViewState, 'src/a.ts', 5);
      expect(state.reveal).toEqual({ path: 'src/a.ts', line: 5, nonce: 1 });
      state = open(state, 'src/a.ts', 5);
      expect(state.reveal).toEqual({ path: 'src/a.ts', line: 5, nonce: 2 });
    });

    it('clears a stale reveal when opening another file without a line', () => {
      let state = open(initialAtlasViewState, 'src/a.ts', 5);
      state = open(state, 'src/b.ts');
      expect(state.reveal).toBeNull();
    });
  });

  describe('preview tabs', () => {
    it('a pinned open (default) sets no preview', () => {
      const state = open(initialAtlasViewState, 'src/a.ts');
      expect(state.previewPath).toBeNull();
    });

    it('a single click opens a preview tab', () => {
      const state = preview(initialAtlasViewState, 'src/a.ts');
      expect(state.filePaths).toEqual(['src/a.ts']);
      expect(state.previewPath).toBe('src/a.ts');
      expect(state.activeTabId).toBe(fileTabId('src/a.ts'));
    });

    it('the next single click reuses the preview slot instead of stacking', () => {
      let state = preview(initialAtlasViewState, 'src/a.ts');
      state = preview(state, 'src/b.ts');
      state = preview(state, 'src/c.ts');
      // Still one preview tab, last file wins; earlier previews fully closed.
      expect(state.filePaths).toEqual(['src/c.ts']);
      expect(state.previewPath).toBe('src/c.ts');
      expect(state.files['src/a.ts']).toBeUndefined();
      expect(state.files['src/b.ts']).toBeUndefined();
      expect(state.files['src/c.ts']).toBeDefined();
    });

    it('keeps the preview slot at its position next to pinned tabs', () => {
      let state = open(initialAtlasViewState, 'src/a.ts'); // pinned
      state = preview(state, 'src/b.ts'); // preview after it
      state = preview(state, 'src/c.ts'); // reuses b's slot
      expect(state.filePaths).toEqual(['src/a.ts', 'src/c.ts']);
      expect(state.previewPath).toBe('src/c.ts');
    });

    it('pin-file promotes the preview to a permanent tab in place', () => {
      let state = open(initialAtlasViewState, 'src/a.ts'); // pinned
      state = preview(state, 'src/b.ts');
      state = atlasViewReducer(state, { type: 'pin-file', path: 'src/b.ts' });
      expect(state.previewPath).toBeNull();
      expect(state.filePaths).toEqual(['src/a.ts', 'src/b.ts']);
      // A subsequent preview now opens a NEW slot rather than reusing b.
      state = preview(state, 'src/c.ts');
      expect(state.filePaths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
      expect(state.previewPath).toBe('src/c.ts');
    });

    it('pin-file is a no-op for a non-preview path', () => {
      let state = preview(initialAtlasViewState, 'src/a.ts');
      state = atlasViewReducer(state, { type: 'pin-file', path: 'src/other.ts' });
      expect(state.previewPath).toBe('src/a.ts');
    });

    it('a pinned open of the current preview pins it (double-click on tree)', () => {
      let state = preview(initialAtlasViewState, 'src/a.ts');
      state = open(state, 'src/a.ts'); // double-click → pinned open of same file
      expect(state.previewPath).toBeNull();
      expect(state.filePaths).toEqual(['src/a.ts']);
    });

    it('previewing an already-open pinned file does not demote it', () => {
      let state = open(initialAtlasViewState, 'src/a.ts'); // pinned
      state = preview(state, 'src/b.ts'); // preview b
      state = preview(state, 'src/a.ts'); // single-click the pinned a
      expect(state.previewPath).toBe('src/b.ts'); // a stays pinned, b stays preview
      expect(state.activeTabId).toBe(fileTabId('src/a.ts'));
    });

    it('is order-independent: a pinned open wins even if a stale preview follows', () => {
      // Mirrors the click/click/dblclick race where fetches resolve out of order.
      let state = open(initialAtlasViewState, 'src/a.ts'); // pinned (dblclick) lands first
      state = preview(state, 'src/a.ts'); // a late preview open of the same path
      expect(state.previewPath).toBeNull(); // still pinned
    });

    it('closing the preview file clears the preview slot', () => {
      let state = preview(initialAtlasViewState, 'src/a.ts');
      state = atlasViewReducer(state, { type: 'close-file', path: 'src/a.ts' });
      expect(state.previewPath).toBeNull();
    });
  });

  describe('highlight-file', () => {
    it('opens the file, replaces its highlights, and reveals the first range', () => {
      let state = atlasViewReducer(initialAtlasViewState, {
        type: 'highlight-file',
        path: 'src/a.ts',
        content: 'x',
        lineCount: 10,
        ranges: [{ start: 3, end: 5 }],
        color: 'green',
      });
      expect(state.activeTabId).toBe(fileTabId('src/a.ts'));
      expect(state.highlights['src/a.ts']).toEqual({
        ranges: [{ start: 3, end: 5 }],
        color: 'green',
      });
      expect(state.reveal).toMatchObject({ path: 'src/a.ts', line: 3 });

      // A second call replaces (not merges) the previous highlight set.
      state = atlasViewReducer(state, {
        type: 'highlight-file',
        path: 'src/a.ts',
        content: 'x',
        lineCount: 10,
        ranges: [{ start: 8, end: 8 }],
        color: 'red',
      });
      expect(state.highlights['src/a.ts']).toEqual({
        ranges: [{ start: 8, end: 8 }],
        color: 'red',
      });
    });

    it('pins the highlighted file so preview navigation cannot discard it', () => {
      let state = preview(initialAtlasViewState, 'src/a.ts'); // a is the preview slot
      state = atlasViewReducer(state, {
        type: 'highlight-file',
        path: 'src/b.ts',
        content: 'x',
        lineCount: 10,
        ranges: [{ start: 1, end: 2 }],
        color: 'green',
      });
      // b is pinned (not the preview), a remains the preview tab.
      expect(state.previewPath).toBe('src/a.ts');
      expect(state.filePaths).toEqual(['src/a.ts', 'src/b.ts']);
    });
  });

  describe('select-tab', () => {
    it('activates the pinned Schema tab and file tabs, ignores unknown file tabs', () => {
      let state = open(initialAtlasViewState, 'src/a.ts');
      state = atlasViewReducer(state, { type: 'select-tab', id: SCHEMA_TAB_ID });
      expect(state.activeTabId).toBe(SCHEMA_TAB_ID);
      state = atlasViewReducer(state, { type: 'select-tab', id: fileTabId('nope.ts') });
      expect(state.activeTabId).toBe(SCHEMA_TAB_ID);
      state = atlasViewReducer(state, { type: 'select-tab', id: fileTabId('src/a.ts') });
      expect(state.activeTabId).toBe(fileTabId('src/a.ts'));
    });
  });

  describe('close-file', () => {
    it('drops the file state and activates the next neighbor', () => {
      let state = open(initialAtlasViewState, 'src/a.ts');
      state = open(state, 'src/b.ts');
      state = open(state, 'src/c.ts');
      state = atlasViewReducer(state, { type: 'select-tab', id: fileTabId('src/b.ts') });

      state = atlasViewReducer(state, { type: 'close-file', path: 'src/b.ts' });

      expect(state.filePaths).toEqual(['src/a.ts', 'src/c.ts']);
      expect(state.files['src/b.ts']).toBeUndefined();
      expect(state.activeTabId).toBe(fileTabId('src/c.ts'));
    });

    it('falls back to the previous neighbor, then the Schema tab', () => {
      let state = open(initialAtlasViewState, 'src/a.ts');
      state = open(state, 'src/b.ts');

      state = atlasViewReducer(state, { type: 'close-file', path: 'src/b.ts' });
      expect(state.activeTabId).toBe(fileTabId('src/a.ts'));

      state = atlasViewReducer(state, { type: 'close-file', path: 'src/a.ts' });
      expect(state.activeTabId).toBe(SCHEMA_TAB_ID);
    });

    it('keeps the active tab when closing a background file', () => {
      let state = open(initialAtlasViewState, 'src/a.ts');
      state = open(state, 'src/b.ts');

      state = atlasViewReducer(state, { type: 'close-file', path: 'src/a.ts' });

      expect(state.activeTabId).toBe(fileTabId('src/b.ts'));
    });

    it('clears a pending reveal for the closed file', () => {
      let state = open(initialAtlasViewState, 'src/a.ts', 5);
      state = atlasViewReducer(state, { type: 'close-file', path: 'src/a.ts' });
      expect(state.reveal).toBeNull();
    });
  });

  it('show-schema activates the Schema tab', () => {
    const state = atlasViewReducer(initialAtlasViewState, { type: 'show-schema' });
    expect(state.activeTabId).toBe(SCHEMA_TAB_ID);
  });

  it('pathOfTabId round-trips file tab ids', () => {
    expect(pathOfTabId(fileTabId('src/a.ts'))).toBe('src/a.ts');
    expect(pathOfTabId(SCHEMA_TAB_ID)).toBeNull();
  });
});
