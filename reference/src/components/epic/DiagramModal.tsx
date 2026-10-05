/**
 * DiagramModal — the full-screen viewer for ONE mermaid diagram.
 *
 * Diagrams inside the epic's documents are overviews: `MermaidDiagram` shrinks
 * the SVG to the document column, and a real architecture diagram lays out
 * around 2000px wide — unreadable at that size. This takes the same source
 * full-screen, fitted and centred, on a drag-to-pan / wheel-to-zoom viewport
 * (`DiagramPanZoomPane`), with Fit / 100% / ± on the toolbar and the keyboard.
 *
 * It portals to `document.body`: the affordance that opens it sits inside the
 * markdown browser's `prose-sm` wrapper, and `@tailwindcss/typography`'s
 * descendant rules would otherwise restyle the viewer's own heading, footer
 * and buttons. Focus moves into the panel on mount — so the shortcuts work
 * immediately — and back to whatever had it on unmount, so closing lands the
 * reader where they were in the document.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '../ui/button';
import DiagramPanZoomPane from './DiagramPanZoomPane';
import MermaidErrorCard from '../MermaidErrorCard';
import { useMermaidSvg } from '../../hooks/useMermaidSvg';
import {
  FITTED_CAMERA,
  cameraScale,
  clampScale,
  fitScale,
  ZOOM_STEP,
  type Camera,
  type Size,
} from './panZoom';

export interface DiagramModalProps {
  source: string;
  /** Names the dialog and its heading; without one the viewer is generic. */
  title?: string | undefined;
  onClose: () => void;
}

const NO_VIEWPORT: Size = { width: 0, height: 0 };

function DiagramModal({ source, title, onClose }: DiagramModalProps) {
  const diagram = useMermaidSvg(source);
  const size = diagram.size ?? NO_VIEWPORT;

  // FITTED_CAMERA already means "whole diagram, centred" — where the viewer
  // opens, and what Fit / `0` return to.
  const [camera, setCamera] = useState<Camera>(FITTED_CAMERA);
  const [viewport, setViewport] = useState<Size>(NO_VIEWPORT);

  const zoomBy = useCallback((factor: number) => {
    setCamera((prev) => ({ ...prev, zoom: Math.max(0.01, prev.zoom * factor) }));
  }, []);

  const actualSize = useCallback(() => {
    const fit = fitScale(size, viewport);
    setCamera((prev) => ({ ...prev, zoom: fit > 0 ? 1 / fit : 1 }));
  }, [size, viewport]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === '+' || event.key === '=') zoomBy(ZOOM_STEP);
      else if (event.key === '-' || event.key === '_') zoomBy(1 / ZOOM_STEP);
      else if (event.key === '0') setCamera(FITTED_CAMERA);
      else if (event.key === '1') actualSize();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, zoomBy, actualSize]);

  // Nothing inside the viewer scrolls, so swallow every wheel event on it —
  // backdrop and chrome included: the page behind is its own scroll container,
  // and it would otherwise creep whenever the pointer sat off the diagram.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const swallow = (event: WheelEvent) => event.preventDefault();
    el.addEventListener('wheel', swallow, { passive: false });
    return () => el.removeEventListener('wheel', swallow);
  }, []);

  // Focus in on open, back on close.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  const zoomPercent = Math.round(clampScale(cameraScale(camera, size, viewport)) * 100);
  const label = title ?? 'Diagram';

  return createPortal(
    <div ref={rootRef} className="fixed inset-0 z-50">
      <div
        data-testid="diagram-backdrop"
        className="fixed inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        className="absolute inset-2 flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl outline-none sm:inset-4"
        role="dialog"
        aria-modal="true"
        aria-label={title ? `Diagram: ${title}` : 'Diagram viewer'}
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="min-w-0 truncate text-sm font-semibold">{label}</h2>

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => zoomBy(1 / ZOOM_STEP)}
              title="Zoom out (−)"
              aria-label="Zoom out"
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
            <span
              data-testid="zoom-level"
              className="w-14 text-center text-xs tabular-nums text-muted-foreground"
            >
              {zoomPercent}%
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => zoomBy(ZOOM_STEP)}
              title="Zoom in (+)"
              aria-label="Zoom in"
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => setCamera(FITTED_CAMERA)}
              title="Fit the whole diagram (0)"
            >
              <Maximize2 className="mr-1.5 h-3.5 w-3.5" />
              Fit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={actualSize}
              title="Actual size (1)"
            >
              100%
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          {diagram.svg && diagram.size ? (
            <DiagramPanZoomPane
              label={label}
              svg={diagram.svg}
              size={diagram.size}
              camera={camera}
              onCameraChange={setCamera}
              onViewportChange={setViewport}
              isActive
            />
          ) : null}

          {diagram.error ? (
            <div className="absolute inset-0 flex items-center justify-center p-4">
              {/* No source dump here: the modal is the reading surface, and the
                  raw mermaid would bury the message. The inline diagram behind
                  it already shows the source. */}
              <MermaidErrorCard
                error={diagram.error}
                errorKind={diagram.errorKind ?? 'syntax'}
                className="max-w-md"
              />
            </div>
          ) : null}

          {!diagram.svg && !diagram.error ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              Rendering diagram…
            </div>
          ) : null}
        </div>

        <p className="shrink-0 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          drag to pan · scroll to zoom · <kbd className="font-sans font-semibold">0</kbd> fit ·{' '}
          <kbd className="font-sans font-semibold">1</kbd> actual size ·{' '}
          <kbd className="font-sans font-semibold">Esc</kbd> close
        </p>
      </div>
    </div>,
    document.body,
  );
}

export default DiagramModal;
