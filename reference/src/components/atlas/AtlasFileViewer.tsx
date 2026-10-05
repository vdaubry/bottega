/**
 * Read-only CodeMirror viewer for the Explore view. Replaces CodeAtlas's
 * Monaco preview pane: language by extension, agent highlight decorations,
 * scroll-to-line-centered, hand-rolled per-file scroll restore. Search and
 * go-to-line come from CodeMirror's basicSetup keymaps (Mod-F / Alt-G).
 */

import React, { useEffect, useRef } from 'react';
import CodeMirror, { EditorView, type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { languageFor, languageNameFor } from './languages';
import {
  atlasHighlightField,
  setAtlasHighlights,
  type AtlasHighlight,
} from './highlightExtension';

interface AtlasFileViewerProps {
  path: string;
  content: string;
  lineCount: number;
  highlight: AtlasHighlight | null;
  /** Pending scroll request; `nonce` re-fires the effect for repeat requests. */
  reveal: { line: number; nonce: number } | null;
  /** Scroll restore across tab switches (the viewer remounts per file). */
  getScrollTop: (path: string) => number | undefined;
  onScrollTop: (path: string, scrollTop: number) => void;
}

function scrollLineToCenter(view: EditorView, line: number): void {
  const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
  view.dispatch({
    effects: EditorView.scrollIntoView(view.state.doc.line(clamped).from, { y: 'center' }),
  });
}

function AtlasFileViewer({
  path,
  content,
  lineCount,
  highlight,
  reveal,
  getScrollTop,
  onScrollTop,
}: AtlasFileViewerProps) {
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  // Snapshot the mount-time scroll/reveal intent; later changes flow through
  // the effects below.
  const initialRef = useRef({ path, reveal, getScrollTop });

  // Apply (or clear) highlight decorations whenever they change.
  useEffect(() => {
    const view = editorRef.current?.view;
    if (view) view.dispatch({ effects: setAtlasHighlights.of(highlight) });
  }, [highlight]);

  // Honor reveal requests issued while mounted.
  useEffect(() => {
    const view = editorRef.current?.view;
    if (view && reveal) scrollLineToCenter(view, reveal.line);
  }, [reveal]);

  // Persist the scroll position for tab-switch restore.
  useEffect(() => {
    return () => {
      const view = editorRef.current?.view;
      if (view) onScrollTop(path, view.scrollDOM.scrollTop);
    };
  }, [path, onScrollTop]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeMirror
          ref={editorRef}
          value={content}
          height="100%"
          theme={oneDark}
          readOnly
          editable={false}
          extensions={[...languageFor(path), atlasHighlightField, EditorView.lineWrapping]}
          basicSetup={{ highlightActiveLine: false, highlightActiveLineGutter: false }}
          className="h-full text-[12.5px] [&_.cm-editor]:h-full"
          onCreateEditor={(view) => {
            const initial = initialRef.current;
            // requestAnimationFrame: the scroller needs a layout pass before
            // scrollTop/scrollIntoView take effect.
            requestAnimationFrame(() => {
              if (initial.reveal) {
                scrollLineToCenter(view, initial.reveal.line);
              } else {
                const saved = initial.getScrollTop(initial.path);
                if (saved !== undefined) view.scrollDOM.scrollTop = saved;
              }
              if (highlight) view.dispatch({ effects: setAtlasHighlights.of(highlight) });
            });
          }}
        />
      </div>
      <div className="flex flex-shrink-0 items-center gap-3 border-t border-border bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
        <span>{languageNameFor(path)}</span>
        <span className="ml-auto">⌘F find · ⌥G go to line</span>
        <span>{lineCount} lines</span>
      </div>
    </div>
  );
}

export default AtlasFileViewer;
