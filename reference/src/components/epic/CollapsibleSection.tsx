/**
 * CollapsibleSection — a titled block that starts folded and expands on click.
 *
 * The artifacts tab lists every document set this way, so the page opens as an
 * index rather than a single scroll of rendered markdown. Children are only
 * MOUNTED while open: the file browsers inside auto-load their first file on
 * mount, and folding must mean "no bytes fetched", not just "hidden".
 */

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface CollapsibleSectionProps {
  title: string;
  /** Shown next to the title — how many files the section holds. */
  count?: number | undefined;
  children: React.ReactNode;
}

function CollapsibleSection({ title, count, children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(false);

  return (
    <section className="mb-3 rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 p-4 text-left"
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {count !== undefined ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {count} file{count === 1 ? '' : 's'}
          </span>
        ) : null}
      </button>
      {open ? <div className="border-t border-border p-4">{children}</div> : null}
    </section>
  );
}

export default CollapsibleSection;
