/**
 * OrchestrationActionButton — the implementation stage's one primary action
 * (Start orchestration / Pause / Resume).
 *
 * Which action it is, and whether it can be taken, comes from
 * `primaryOrchestrationAction` — this component only draws it, and renders
 * nothing at all once orchestration is over (the epic's remaining action is
 * the Delivery section's, not this stage's).
 */

import { CircleDot, Pause, Play } from 'lucide-react';
import { Button } from '../ui/button';
import { primaryOrchestrationAction, type OrchestrationAction } from './orchestrationAction';
import type { EpicRow, TaskRow } from '@shared/types/db';

const ACTION_ICONS: Record<OrchestrationAction, typeof Play> = {
  start: CircleDot,
  pause: Pause,
  resume: Play,
};

const ACTION_VARIANTS: Record<OrchestrationAction, 'default' | 'outline'> = {
  start: 'default',
  pause: 'outline',
  resume: 'default',
};

const ACTION_TITLES: Record<OrchestrationAction, string> = {
  start:
    'Hand the epic to the orchestrator: it drives every ticket end-to-end and escalates to you only when it needs a decision',
  pause: 'Interrupt the current orchestrator or PR-review turn and wait for you',
  resume: 'Resume the interrupted epic conversation from the current state',
};

export interface OrchestrationActionButtonProps {
  epic: EpicRow;
  tickets: TaskRow[];
  /** Which action is in flight, so the button can say so. */
  pendingAction: OrchestrationAction | null;
  onAction: (action: OrchestrationAction) => void;
  /**
   * A reason the surface itself has for refusing a *start* — the rail passes
   * "another stage is still running", which the server would refuse too.
   * Ignored for the other actions: pausing an orchestration whose own turn is
   * mid-flight is exactly what Pause is for.
   */
  startBlockedReason?: string | null;
}

function OrchestrationActionButton({
  epic,
  tickets,
  pendingAction,
  onAction,
  startBlockedReason = null,
}: OrchestrationActionButtonProps) {
  const primary = primaryOrchestrationAction(epic, tickets);
  if (!primary) return null;
  const disabledReason =
    primary.disabledReason ?? (primary.action === 'start' ? startBlockedReason : null);
  const Icon = ACTION_ICONS[primary.action];

  return (
    <Button
      variant={ACTION_VARIANTS[primary.action]}
      size="sm"
      onClick={() => onAction(primary.action)}
      disabled={pendingAction !== null || disabledReason !== null}
      title={disabledReason ?? ACTION_TITLES[primary.action]}
    >
      <Icon className="mr-1.5 h-4 w-4" />
      {pendingAction === primary.action ? primary.pendingLabel : primary.label}
    </Button>
  );
}

export default OrchestrationActionButton;
