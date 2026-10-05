/**
 * ExpandableMermaidDiagram — a diagram inside a document, plus the way out to
 * a reading surface.
 *
 * `MermaidDiagram` shrinks the SVG to the document column, which makes an
 * architecture diagram an overview at best. Every ```mermaid fence rendered in
 * the epic's documents therefore gets an "Open full size" affordance that
 * opens `DiagramModal` on the same source. `MermaidDiagram` itself stays pure.
 *
 * The `open` state lives here, per diagram: `docsMarkdownComponents` is a
 * module constant, and lifting the state into a per-render components table
 * would remount every diagram in the document on each render.
 */

import { useState } from 'react';
import { Maximize2 } from 'lucide-react';
import MermaidDiagram from '../MermaidDiagram';
import DiagramModal from './DiagramModal';
import { cn } from '../../lib/utils';

export interface ExpandableMermaidDiagramProps {
  source: string;
  className?: string | undefined;
}

function ExpandableMermaidDiagram({ source, className }: ExpandableMermaidDiagramProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* The overlay button is what makes the whole diagram clickable; keeping
          it a sibling (rather than wrapping the diagram) avoids nesting block
          content — the error fallback renders a <pre> — inside a <button>. */}
      <div className={cn('group relative', className)}>
        <MermaidDiagram source={source} />
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open the diagram in the full-screen viewer"
          title="Open the full-screen viewer"
          className="absolute inset-0 flex cursor-zoom-in items-end justify-center rounded transition-colors hover:bg-primary/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <span className="mb-1 flex items-center gap-1.5 rounded-full border border-border bg-background/95 px-2.5 py-1 text-xs font-medium opacity-70 shadow-sm transition-opacity group-hover:opacity-100">
            <Maximize2 className="h-3.5 w-3.5" />
            Open full size
          </span>
        </button>
      </div>

      {open ? <DiagramModal source={source} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export default ExpandableMermaidDiagram;
