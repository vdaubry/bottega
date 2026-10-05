/**
 * EpicStageStatusBadge — the status pill for one epic stage, driven by that
 * stage's latest agent run (or its absence) — or, for the implementation
 * stage, by the orchestration state (`orchestrationAction.ts`), which is where
 * `paused` comes from: an orchestration halted by an escalation or by the user.
 */

import { cn } from '../../lib/utils';
import type { AgentRunStatus } from '@shared/types/db';

export type EpicStageStatus = AgentRunStatus | 'not_started' | 'paused';

const STATUS_STYLES: Record<EpicStageStatus, { label: string; className: string }> = {
  not_started: { label: 'Not started', className: 'bg-muted text-muted-foreground' },
  pending: { label: 'Pending', className: 'bg-muted text-muted-foreground' },
  running: { label: 'Running', className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  completed: { label: 'Completed', className: 'bg-green-500/15 text-green-600 dark:text-green-400' },
  failed: { label: 'Failed', className: 'bg-destructive/15 text-destructive' },
  blocked: { label: 'Blocked', className: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400' },
  // Same colour as the orchestration panel's chip: a paused orchestration is
  // waiting on the user, and that is the urgent state.
  paused: { label: 'Paused', className: 'bg-destructive/15 text-destructive' },
};

function EpicStageStatusBadge({
  status,
  className,
}: {
  status: EpicStageStatus;
  className?: string;
}) {
  const style = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        style.className,
        className,
      )}
    >
      {style.label}
    </span>
  );
}

export default EpicStageStatusBadge;
