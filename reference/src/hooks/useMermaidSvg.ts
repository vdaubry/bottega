/**
 * useMermaidSvg — renders one mermaid source string to an SVG string and
 * reports the intrinsic canvas size the layout engine chose for it.
 *
 * The size comes from the SVG's own `viewBox`: mermaid lays the graph out at a
 * natural size (measured text, dagre node placement) and publishes it there.
 * Nothing downstream has to guess a canvas size — `size` IS the canvas, and
 * scale 1 is the magnification mermaid sized its labels to be read at.
 *
 * The sources are LLM-generated, so invalid syntax is a NORMAL input: failures
 * surface as `error`, never a throw.
 *
 * Not every failure is the source's fault, though. Mermaid loads its per-type
 * renderers with a runtime `import()`, so a stale build serves a chunk URL that
 * no longer exists and the import rejects — nothing to do with the diagram.
 * `errorKind` separates the two so the UI can stop blaming the source for it.
 */

import { useEffect, useState } from 'react';
import mermaid from 'mermaid';
import { useTheme } from '../contexts/ThemeContext';

export interface MermaidSize {
  width: number;
  height: number;
}

/**
 * `syntax` — mermaid rejected the source; showing it is the useful thing to do.
 * `stale-build` — the renderer chunk failed to load; the source is irrelevant
 * and the fix is a page reload.
 */
export type MermaidErrorKind = 'syntax' | 'stale-build';

export interface MermaidRender {
  svg: string | null;
  size: MermaidSize | null;
  error: string | null;
  errorKind: MermaidErrorKind | null;
}

// How the three engines word a failed dynamic import. Mermaid's own parse
// errors ("Parse error on line 2: …") never match any of these.
const MODULE_LOAD_FAILURE = [
  /failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // Safari
];

export function classifyMermaidError(message: string): MermaidErrorKind {
  return MODULE_LOAD_FAILURE.some((re) => re.test(message)) ? 'stale-build' : 'syntax';
}

// Unique render ids: mermaid.render mounts a temp element per call, and
// StrictMode double-invokes effects — a reused id would collide.
let renderCounter = 0;

/**
 * Reads the intrinsic canvas size out of a rendered mermaid SVG. Mermaid always
 * emits `viewBox="0 0 W H"`; the width/height attributes are the shrink-to-fit
 * ones (`width="100%"` + `style="max-width:…"`) and say nothing about the
 * natural size.
 */
export function parseViewBoxSize(svg: string): MermaidSize | null {
  const match = /viewBox\s*=\s*["']([^"']+)["']/.exec(svg);
  if (!match?.[1]) return null;
  const parts = match[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const width = parts[2]!;
  const height = parts[3]!;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

export function useMermaidSvg(source: string | null): MermaidRender {
  const { isDarkMode } = useTheme();
  const [state, setState] = useState<MermaidRender>({
    svg: null,
    size: null,
    error: null,
    errorKind: null,
  });

  useEffect(() => {
    if (source === null) {
      setState({ svg: null, size: null, error: null, errorKind: null });
      return;
    }

    let cancelled = false;
    const id = `mermaid-render-${++renderCounter}`;
    setState({ svg: null, size: null, error: null, errorKind: null });

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: isDarkMode ? 'dark' : 'default',
    });
    mermaid
      .render(id, source)
      .then((result) => {
        if (!cancelled) {
          setState({
            svg: result.svg,
            size: parseViewBoxSize(result.svg),
            error: null,
            errorKind: null,
          });
        }
      })
      .catch((err: unknown) => {
        // Mermaid can leave its temp node in the DOM on a parse failure.
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setState({
            svg: null,
            size: null,
            error: message,
            errorKind: classifyMermaidError(message),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [source, isDarkMode]);

  return state;
}
