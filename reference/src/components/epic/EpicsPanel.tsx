/**
 * EpicsPanel — the project board's Epics tab: one card per epic with how far
 * along the pipeline it is and how many tickets it has produced.
 *
 * The six dots are the stage flags, not agent runs: they say what the user has
 * approved (or, for the review, what the gate let through), which is what "how
 * far along is this epic" actually means. A stage that ran and produced output
 * nobody signed off is not progress yet.
 */

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { parseSqliteUtc } from './epicTime';
import { api } from '../../utils/api';
import type { EpicRow } from '@shared/types/db';

/**
 * The stage flags, in pipeline order. Implementation has no flag (it is done
 * when every ticket merged) — its permanently not-done dot is also what keeps
 * `currentStageLabel` from ever reaching the QA dot behind it.
 */
function stageDots(epic: EpicRow): Array<{ label: string; done: boolean }> {
  return [
    { label: 'Architecture', done: !!epic.architecture_complete },
    { label: 'Technical specification', done: !!epic.specs_complete },
    { label: 'Stories', done: !!epic.stories_complete },
    { label: 'Specification review', done: !!epic.review_complete },
    { label: 'Implementation', done: false },
    { label: 'QA', done: !!epic.qa_complete },
  ];
}

/** The stage the epic is waiting on — the first one not signed off. */
export function currentStageLabel(epic: EpicRow): string {
  return stageDots(epic).find((d) => !d.done)?.label ?? 'Implementation';
}

export interface EpicsPanelProps {
  projectId: number;
  onOpenEpic: (epicId: number) => void;
  onNewEpic: () => void;
  className?: string;
}

function EpicsPanel({ projectId, onOpenEpic, onNewEpic, className }: EpicsPanelProps) {
  const [epics, setEpics] = useState<EpicRow[] | null>(null);
  const [ticketCounts, setTicketCounts] = useState<Record<number, number>>({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const response = await api.epics.list(projectId);
      if (!response.ok) return;
      const rows = await response.json();
      if (cancelled) return;
      setEpics(rows);

      // Ticket counts come from the per-epic endpoint; the epic row does not
      // carry one and inventing a denormalized column for a card would be a
      // schema change to save a request.
      const counts = await Promise.all(
        rows.map(async (epic) => {
          const res = await api.epics.listTasks(epic.id);
          return [epic.id, res.ok ? (await res.json()).length : 0] as const;
        }),
      );
      if (!cancelled) setTicketCounts(Object.fromEntries(counts));
    };
    void load().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className={cn('p-4 lg:p-6', className)}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Epics
        </h2>
        <Button size="sm" onClick={onNewEpic}>
          <Plus className="mr-1.5 h-4 w-4" />
          New Epic
        </Button>
      </div>

      {epics === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : epics.length === 0 ? (
        <p className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
          No epics yet. An epic takes a functional specification through an architecture document,
          a technical specification and a ticket split — start one with “New Epic”.
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {epics.map((epic) => (
            <li key={epic.id}>
              <button
                type="button"
                onClick={() => onOpenEpic(epic.id)}
                data-testid={`epic-card-${epic.id}`}
                className="flex w-full flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-all hover:border-primary/30 hover:shadow-md"
              >
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{epic.name}</span>
                  {epic.status !== 'active' ? (
                    <span className="flex-shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {epic.status}
                    </span>
                  ) : null}
                </div>

                <div className="flex items-center gap-1.5">
                  {stageDots(epic).map((dot) => (
                    <span
                      key={dot.label}
                      title={`${dot.label}: ${dot.done ? 'signed off' : 'not yet'}`}
                      className={cn(
                        'h-2 w-2 rounded-full',
                        dot.done ? 'bg-green-500' : 'bg-muted-foreground/30',
                      )}
                    />
                  ))}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {currentStageLabel(epic)}
                  </span>
                </div>

                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    {ticketCounts[epic.id] ?? 0} ticket
                    {(ticketCounts[epic.id] ?? 0) === 1 ? '' : 's'}
                  </span>
                  <span>{new Date(parseSqliteUtc(epic.updated_at)).toLocaleDateString()}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default EpicsPanel;
