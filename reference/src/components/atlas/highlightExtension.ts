/**
 * Whole-line highlight decorations for the Explore file viewer — the
 * CodeMirror analog of CodeAtlas's Monaco `applyDecorations`. The agent's
 * `highlight` tool paints colored line ranges; each `setAtlasHighlights`
 * effect replaces the previous set for the file.
 */

import {
  Decoration,
  EditorView,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type DecorationSet,
  type Text,
} from '@uiw/react-codemirror';
import type { HighlightColor, HighlightRange } from '@shared/types/atlas';

export interface AtlasHighlight {
  ranges: HighlightRange[];
  color: HighlightColor;
}

export const setAtlasHighlights = StateEffect.define<AtlasHighlight | null>();

function buildDecorations(doc: Text, highlight: AtlasHighlight | null): DecorationSet {
  if (!highlight || highlight.ranges.length === 0) return Decoration.none;
  // Ranges are validated server-side, but clamp defensively and dedupe lines
  // (overlapping ranges must not double-decorate a line).
  const lines = new Set<number>();
  for (const range of highlight.ranges) {
    const start = Math.max(1, Math.min(range.start, doc.lines));
    const end = Math.max(start, Math.min(range.end, doc.lines));
    for (let line = start; line <= end; line++) lines.add(line);
  }
  const decoration = Decoration.line({ class: `cm-atlas-hl-${highlight.color}` });
  const builder = new RangeSetBuilder<Decoration>();
  for (const line of [...lines].sort((a, b) => a - b)) {
    const from = doc.line(line).from;
    builder.add(from, from, decoration);
  }
  return builder.finish();
}

export const atlasHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setAtlasHighlights)) {
        next = buildDecorations(tr.state.doc, effect.value);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
