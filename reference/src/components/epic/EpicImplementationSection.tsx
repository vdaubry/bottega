/**
 * EpicImplementationSection — the autonomous implementation stage: the
 * orchestration controls, and the epic's tickets as one expandable row each.
 *
 * The orchestrator is dormant almost all of the time: it wakes on an event,
 * takes one decision, and its subprocess exits. So there is deliberately no
 * "live feed" here — a spinner would be lying for hours at a stretch. What this
 * shows instead is the state the decisions leave behind: each ticket row's
 * background is its state (green merged, blue being worked, red blocked,
 * plain not started — the same palette as the task page's agent list), a
 * segmented bar summarizes the sequence, and the one urgent thing (an
 * escalation) arrives as a push notification and as the blocked banner.
 *
 * The section ends where the last ticket merges. The epic's own pull request —
 * opening it, and the conversations that land it — belongs to
 * `EpicDeliverySection`, so the button here is only ever
 * Start/Pause/Resume and disappears once the sequence is done.
 *
 * The tickets are listed in **execution order**, never split into kanban
 * columns: an epic's tickets are a sequence — the orchestrator runs them in
 * `position` order, each assuming the previous merged — and grouping by status
 * would scatter it. Expanding a row shows the conversations attached to that
 * ticket: **one orchestration conversation** (one per ticket, by design — see
 * docs/epics/orchestrator.md) and the **PR review conversations, plural** (a
 * retry or a post-review GitHub comment starts a fresh reviewer, so a ticket
 * can accumulate several). Ticket-level agent detail stays on the task page,
 * reached from the row.
 */

import { useState } from 'react';
import {
  ArrowUpRight,
  Bot,
  ChevronRight,
  GitPullRequest,
  MessageSquare,
} from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import EpicStageStatusBadge from './EpicStageStatusBadge';
import OrchestrationActionButton from './OrchestrationActionButton';
import { orchestrationStatus, type OrchestrationAction } from './orchestrationAction';
import type {
  EpicAgentRunRow,
  EpicRow,
  EpicTicketWithTask,
  TaskRow,
  TaskStatus,
} from '@shared/types/db';

/**
 * A ticket's visual state — its row background and its segment in the progress
 * bar. `blocked` outranks the status: a blocked in-progress ticket is a
 * problem first.
 */
type TicketTone = 'merged' | 'blocked' | 'active' | 'pending';

function ticketTone(ticket: EpicTicketWithTask): TicketTone {
  if (ticket.status === 'completed') return 'merged';
  if (ticket.workflow_blocked) return 'blocked';
  if (ticket.status === 'in_progress' || ticket.status === 'in_review') return 'active';
  return 'pending';
}

/** The task-page agent-list palette, so state reads the same across the app. */
const TONE_ROW_STYLES: Record<TicketTone, string> = {
  merged: 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20',
  blocked: 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20',
  active: 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/20',
  pending: 'border-border bg-card hover:border-primary/50',
};

const TONE_SEGMENT_STYLES: Record<TicketTone, string> = {
  merged: 'bg-green-500',
  blocked: 'bg-red-500',
  active: 'bg-blue-500',
  pending: 'bg-muted-foreground/25',
};

const TICKET_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  in_review: 'In review',
  completed: 'Merged',
};

const TICKET_STATUS_PILLS: Record<TaskStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  in_progress: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  in_review: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400',
  completed: 'bg-green-500/15 text-green-600 dark:text-green-400',
};

/** The status pill on a ticket row; a block outranks the status here too. */
function TicketStatusPill({ ticket }: { ticket: EpicTicketWithTask }) {
  const blocked = !!ticket.workflow_blocked && ticket.status !== 'completed';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
        blocked ? 'bg-destructive/15 text-destructive' : TICKET_STATUS_PILLS[ticket.status],
      )}
    >
      {blocked ? 'Blocked' : TICKET_STATUS_LABELS[ticket.status]}
    </span>
  );
}

/** One conversation attached to a ticket, as a row in the expanded panel. */
function TicketConversationRow({
  icon: Icon,
  label,
  description,
  run,
  showStatus,
  onOpen,
}: {
  icon: typeof Bot;
  label: string;
  description: string;
  run: EpicAgentRunRow;
  /**
   * The orchestrator's run status is `completed` for most of an active
   * orchestration (it is dormant between events), so showing it would lie;
   * the reviewer's status is a real fact worth a chip.
   */
  showStatus: boolean;
  onOpen: (conversationId: number) => void;
}) {
  return (
    <li
      className="flex items-center justify-between gap-2 rounded-md border border-border bg-card p-2"
      title={description}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm">{label}</span>
        {showStatus ? <EpicStageStatusBadge status={run.status} /> : null}
      </div>
      {run.conversation_id != null ? (
        <Button variant="outline" size="sm" onClick={() => onOpen(run.conversation_id!)}>
          <MessageSquare className="mr-1.5 h-4 w-4" />
          Open
        </Button>
      ) : null}
    </li>
  );
}

function TicketRow({
  ticket,
  index,
  agentRuns,
  isLive,
  onOpenConversation,
  onOpenTicket,
}: {
  ticket: EpicTicketWithTask;
  index: number;
  agentRuns: EpicAgentRunRow[];
  isLive: boolean;
  onOpenConversation: (conversationId: number) => void;
  onOpenTicket: (task: TaskRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const tone = ticketTone(ticket);
  const position = ticket.position ?? index + 1;
  const title = ticket.title || `Task #${ticket.id}`;

  // One orchestration conversation per ticket by design; several PR reviews
  // are possible (retries, re-reviews after GitHub feedback) — newest first.
  const orchestratorRun =
    agentRuns
      .filter((r) => r.agent_type === 'epic-orchestrator' && r.ticket_task_id === ticket.id)
      .sort((a, b) => b.id - a.id)[0] ?? null;
  const reviewRuns = agentRuns
    .filter((r) => r.agent_type === 'epic-pr-review' && r.ticket_task_id === ticket.id)
    .sort((a, b) => b.id - a.id);

  const conversationCount =
    (orchestratorRun?.conversation_id != null ? 1 : 0) +
    reviewRuns.filter((r) => r.conversation_id != null).length;

  const detailId = `epic-ticket-detail-${ticket.id}`;

  return (
    <li
      data-testid={`epic-ticket-${ticket.id}`}
      className={cn('rounded-lg border transition-colors', TONE_ROW_STYLES[tone])}
    >
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={detailId}
          className="flex min-w-0 flex-1 items-center gap-2 p-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
        >
          <ChevronRight
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90',
            )}
          />
          <span
            className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
            title={`Position ${position} in the execution order`}
          >
            {position}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>

          {isLive ? (
            <span className="relative flex h-2.5 w-2.5 shrink-0" title="An agent is streaming on this ticket right now">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
          ) : null}

          {conversationCount > 0 ? (
            <span
              className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
              title={`${conversationCount} conversation${conversationCount === 1 ? '' : 's'} attached to this ticket`}
            >
              <MessageSquare className="h-3 w-3" />
              {conversationCount}
            </span>
          ) : null}

          <TicketStatusPill ticket={ticket} />
        </button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => onOpenTicket(ticket)}
          className="mr-2 h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground"
          title="Open ticket"
        >
          <ArrowUpRight className="h-4 w-4" />
        </Button>
      </div>

      {expanded ? (
        <div id={detailId} className="border-t border-inherit px-3 pb-3 pt-2">
          <ul className="space-y-1.5">
            {orchestratorRun ? (
              <TicketConversationRow
                icon={Bot}
                label="Orchestration"
                description="The orchestrator's supervision log for this ticket — one conversation per ticket, resumed at every wake"
                run={orchestratorRun}
                showStatus={false}
                onOpen={onOpenConversation}
              />
            ) : (
              <li className="text-xs text-muted-foreground">
                No orchestration conversation yet — the orchestrator opens one when it reaches
                this ticket.
              </li>
            )}

            {reviewRuns.length > 0 ? (
              reviewRuns.map((run, i) => (
                <TicketConversationRow
                  key={run.id}
                  icon={GitPullRequest}
                  label={reviewRuns.length > 1 ? `PR review #${reviewRuns.length - i}` : 'PR review'}
                  description="Reviews the ticket's pull request against the specification, fixes what it finds, drives CI and merges"
                  run={run}
                  showStatus
                  onOpen={onOpenConversation}
                />
              ))
            ) : (
              <li className="text-xs text-muted-foreground">
                No PR review yet — a reviewer starts once this ticket&apos;s pull request opens.
              </li>
            )}
          </ul>

          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenTicket(ticket)}
            className="mt-2"
          >
            <ArrowUpRight className="mr-1.5 h-4 w-4" />
            Open the ticket page
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export interface EpicImplementationSectionProps {
  epic: EpicRow;
  tickets: EpicTicketWithTask[];
  /** All the epic's agent runs — the per-ticket ones are filtered out here. */
  agentRuns: EpicAgentRunRow[];
  isTaskLive?: ((taskId: number) => boolean) | undefined;
  /** True while a framing stage is running: its Start waits, like every other Start. */
  isEpicBusy: boolean;
  /** Which orchestration action is in flight, so its button can say so. */
  pendingAction: OrchestrationAction | null;
  onAction: (action: OrchestrationAction) => void;
  onOpenConversation: (conversationId: number) => void;
  onOpenTicket: (task: TaskRow) => void;
}

function EpicImplementationSection({
  epic,
  tickets,
  agentRuns,
  isTaskLive,
  isEpicBusy,
  pendingAction,
  onAction,
  onOpenConversation,
  onOpenTicket,
}: EpicImplementationSectionProps) {
  const blocked = !!epic.orchestration_blocked;
  const completed = tickets.filter((t) => t.status === 'completed').length;
  const allMerged = tickets.length > 0 && completed === tickets.length;
  const current = tickets.find((t) => t.status !== 'completed') ?? null;
  const blockedTickets = tickets.filter((t) => t.workflow_blocked && t.status !== 'completed');
  const reviewInFlight = agentRuns.some(
    (r) =>
      r.agent_type === 'epic-pr-review' &&
      (r.status === 'running' || r.status === 'blocked') &&
      r.ticket_task_id === current?.id,
  );

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="border-b border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Orchestration</h3>
          {/* Read from the epic flags + ticket rows, never from the dormant
              orchestrator run — see orchestrationAction.ts. */}
          <EpicStageStatusBadge status={orchestrationStatus(epic, tickets)} />
          {tickets.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              {completed}/{tickets.length} merged
            </span>
          ) : null}

          <div className="flex-1" />

          <OrchestrationActionButton
            epic={epic}
            tickets={tickets}
            pendingAction={pendingAction}
            onAction={onAction}
            startBlockedReason={isEpicBusy ? 'Wait for the running stage to finish first.' : null}
          />
        </div>

        {tickets.length > 0 ? (
          <>
            <div
              className="mt-3 flex h-1.5 gap-px overflow-hidden rounded-full"
              role="img"
              aria-label={`${completed} of ${tickets.length} tickets merged`}
            >
              {tickets.map((ticket, index) => (
                <div
                  key={ticket.id}
                  className={cn('flex-1', TONE_SEGMENT_STYLES[ticketTone(ticket)])}
                  title={`${ticket.position ?? index + 1}. ${ticket.title || `Task #${ticket.id}`} — ${
                    ticket.workflow_blocked && ticket.status !== 'completed'
                      ? 'blocked'
                      : TICKET_STATUS_LABELS[ticket.status].toLowerCase()
                  }`}
                />
              ))}
            </div>

            <p className="mt-2 text-sm text-muted-foreground">
              {allMerged
                ? 'Every ticket is done. The epic finishes in Delivery below: one pull request from its feature branch, which you merge — not the orchestrator.'
                : current
                  ? `Currently on #${current.position ?? '?'} — ${current.title || `Task #${current.id}`} (${current.status})` +
                    (reviewInFlight ? ' — its pull request is being reviewed and merged.' : '.')
                  : 'No ticket has started yet.'}
            </p>

            {blocked ? (
              <p className="mt-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
                {epic.orchestration_blocked_reason ||
                  'Orchestration is paused. Resume it when the ticket is unstuck.'}
              </p>
            ) : null}

            {blockedTickets.length > 0 ? (
              <p className="mt-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
                {blockedTickets.length} ticket{blockedTickets.length === 1 ? ' is' : 's are'} blocked
                and need{blockedTickets.length === 1 ? 's' : ''} you:{' '}
                {blockedTickets.map((t) => `#${t.position ?? t.id}`).join(', ')}.
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="p-4">
        {tickets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tickets yet. Run the stories stage — it agrees the split with you, then creates
            them.
          </p>
        ) : (
          <ol className="space-y-2">
            {tickets.map((ticket, index) => (
              <TicketRow
                key={ticket.id}
                ticket={ticket}
                index={index}
                agentRuns={agentRuns}
                isLive={(isTaskLive?.(ticket.id) ?? false) && ticket.status !== 'completed'}
                onOpenConversation={onOpenConversation}
                onOpenTicket={onOpenTicket}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

export default EpicImplementationSection;
