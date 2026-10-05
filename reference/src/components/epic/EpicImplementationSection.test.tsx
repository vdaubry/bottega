import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import EpicImplementationSection from './EpicImplementationSection';
import type { EpicAgentRunRow, EpicRow, EpicTicketWithTask } from '@shared/types/db';

function ticket(id: number, overrides: Partial<EpicTicketWithTask> = {}): EpicTicketWithTask {
  return {
    id,
    project_id: 3,
    position: id,
    title: `Ticket ${id}`,
    status: 'pending',
    workflow_blocked: 0,
    ...overrides,
  } as EpicTicketWithTask;
}

function epicRow(overrides: Partial<EpicRow> = {}): EpicRow {
  return {
    id: 7,
    project_id: 3,
    name: 'Nimbus Pricing',
    status: 'active',
    architecture_complete: 1,
    specs_complete: 1,
    stories_complete: 1,
    review_complete: 1,
    orchestration_active: 0,
    orchestration_blocked: 0,
    orchestration_blocked_reason: null,
    ...overrides,
  } as EpicRow;
}

function renderSection(
  tickets: EpicTicketWithTask[],
  runs: Partial<EpicAgentRunRow>[] = [],
  epic: EpicRow = epicRow(),
  opts: { isTaskLive?: (taskId: number) => boolean; isEpicBusy?: boolean } = {},
) {
  const onOpenConversation = vi.fn();
  const onAction = vi.fn();
  const onOpenTicket = vi.fn();
  render(
    <EpicImplementationSection
      epic={epic}
      tickets={tickets}
      agentRuns={runs as EpicAgentRunRow[]}
      isTaskLive={opts.isTaskLive}
      isEpicBusy={opts.isEpicBusy ?? false}
      pendingAction={null}
      onAction={onAction}
      onOpenConversation={onOpenConversation}
      onOpenTicket={onOpenTicket}
    />,
  );
  return { onOpenConversation, onAction, onOpenTicket };
}

/** The row for one ticket — assertions are scoped to it, not the whole list. */
function row(ticketId: number): HTMLElement {
  return screen.getByTestId(`epic-ticket-${ticketId}`);
}

function expand(ticketId: number) {
  fireEvent.click(within(row(ticketId)).getByRole('button', { expanded: false }));
}

describe('orchestration header', () => {
  it('offers to start once the tickets exist', () => {
    const { onAction } = renderSection([ticket(41)]);

    expect(screen.getByText('Not started')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /start orchestration/i }));
    expect(onAction).toHaveBeenCalledWith('start');
  });

  it('waits for the stories stage when there are no tickets', () => {
    renderSection([]);

    expect(screen.getByText(/Run the stories stage/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start orchestration/i })).toBeDisabled();
  });

  it('waits for the specification review even once the tickets exist', () => {
    renderSection([ticket(41)], [], epicRow({ review_complete: 0 }));

    const start = screen.getByRole('button', { name: /start orchestration/i });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('title', expect.stringMatching(/specification review first/i));
  });

  it('holds the Start while a framing stage is running — one stage at a time', () => {
    renderSection([ticket(41)], [], epicRow(), { isEpicBusy: true });

    const start = screen.getByRole('button', { name: /start orchestration/i });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('title', expect.stringMatching(/running stage/i));
  });

  it('counts merged tickets and names the one in flight', () => {
    renderSection([
      ticket(41, { position: 1, status: 'completed' }),
      ticket(42, { position: 2, status: 'in_progress' }),
      ticket(43, { position: 3 }),
    ]);

    expect(screen.getByText('1/3 merged')).toBeInTheDocument();
    expect(screen.getByText(/Currently on #2 — Ticket 42/)).toBeInTheDocument();
  });

  // The sequence is over: this section offers no action at all, and points at
  // Delivery — which owns the final pull request and its conversations.
  it('announces the end of the sequence and hands over to Delivery', () => {
    renderSection([ticket(41, { status: 'completed' })]);

    expect(screen.getByText(/Every ticket is done/)).toBeInTheDocument();
    expect(screen.getByText(/finishes in Delivery below/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open final pr/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start orchestration/i })).not.toBeInTheDocument();
  });

  it('offers Pause while it is running, reading the flag — not the dormant run', () => {
    const { onAction } = renderSection(
      [ticket(41)],
      [{ id: 1, agent_type: 'epic-orchestrator', status: 'completed', ticket_task_id: 41 }],
      epicRow({ orchestration_active: 1 }),
    );

    expect(screen.getByText('Running')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    expect(onAction).toHaveBeenCalledWith('pause');
  });

  it('shows why it stopped and offers Resume', () => {
    const { onAction } = renderSection(
      [ticket(41)],
      [],
      epicRow({
        orchestration_active: 1,
        orchestration_blocked: 1,
        orchestration_blocked_reason: 'The Enterprise contact email needs the product owner.',
      }),
    );

    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(
      screen.getByText(/The Enterprise contact email needs the product owner/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    expect(onAction).toHaveBeenCalledWith('resume');
  });

  it('raises blocked tickets by position', () => {
    renderSection([ticket(41, { position: 1 }), ticket(42, { position: 2, workflow_blocked: 1 })]);

    expect(screen.getByText(/1 ticket is blocked/)).toBeInTheDocument();
    expect(screen.getByText(/#2/)).toBeInTheDocument();
  });

  it('says when the current ticket’s pull request is being landed', () => {
    renderSection(
      [ticket(41, { position: 1, status: 'completed' }), ticket(42, { position: 2, status: 'in_review' })],
      [{ id: 6, agent_type: 'epic-pr-review', conversation_id: 96, ticket_task_id: 42, status: 'running' }],
      epicRow({ orchestration_active: 1 }),
    );

    expect(
      screen.getByText(/Ticket 42 \(in_review\) — its pull request is being reviewed and merged/),
    ).toBeInTheDocument();
  });

  it('keeps a stopped PR review in flight while it waits to resume', () => {
    renderSection(
      [ticket(42, { position: 2, status: 'in_review' })],
      [
        {
          id: 6,
          agent_type: 'epic-pr-review',
          conversation_id: 96,
          ticket_task_id: 42,
          status: 'blocked',
        },
      ],
      epicRow({ orchestration_active: 1, orchestration_blocked: 1 }),
    );

    expect(
      screen.getByText(/Ticket 42 \(in_review\) — its pull request is being reviewed and merged/),
    ).toBeInTheDocument();
  });

  it('summarizes the sequence as one bar segment per ticket', () => {
    renderSection([
      ticket(41, { status: 'completed' }),
      ticket(42, { status: 'in_progress' }),
      ticket(43),
    ]);

    expect(screen.getByRole('img', { name: '1 of 3 tickets merged' })).toBeInTheDocument();
  });
});

describe('ticket rows', () => {
  it('keeps execution order — the sequence the orchestrator will follow', () => {
    renderSection([
      ticket(41, { position: 1, status: 'completed' }),
      ticket(42, { position: 2, status: 'in_progress' }),
      ticket(43, { position: 3 }),
    ]);

    const rows = screen.getAllByTestId(/epic-ticket-\d+/).map((el) => el.textContent);
    expect(rows.join(' ')).toMatch(/Ticket 41[\s\S]*Ticket 42[\s\S]*Ticket 43/);
  });

  it('shows each ticket position, not its row id', () => {
    renderSection([ticket(41, { position: 2 })]);

    expect(screen.getByTitle(/Position 2 in the execution order/)).toHaveTextContent('2');
  });

  it('colors each row by state: merged green, worked blue, blocked red, pending plain', () => {
    renderSection([
      ticket(41, { status: 'completed' }),
      ticket(42, { status: 'in_progress' }),
      ticket(43, { status: 'in_review', workflow_blocked: 1 }),
      ticket(44),
    ]);

    expect(row(41).className).toMatch(/bg-green-50/);
    expect(row(42).className).toMatch(/bg-blue-50/);
    expect(row(43).className).toMatch(/bg-red-50/);
    expect(row(44).className).toMatch(/bg-card/);
    expect(within(row(43)).getByText('Blocked')).toBeInTheDocument();
    expect(within(row(41)).getByText('Merged')).toBeInTheDocument();
  });

  it('lights the LIVE dot from the task channel, except on a finished ticket', () => {
    renderSection(
      [ticket(41, { status: 'in_progress' }), ticket(42, { status: 'completed' })],
      [],
      epicRow(),
      { isTaskLive: () => true },
    );

    expect(within(row(41)).getByTitle(/streaming on this ticket/)).toBeInTheDocument();
    expect(within(row(42)).queryByTitle(/streaming on this ticket/)).toBeNull();
  });

  it('opens the ticket page from the row’s quick action without expanding', () => {
    const { onOpenTicket } = renderSection([ticket(41)]);

    fireEvent.click(within(row(41)).getByRole('button', { name: 'Open ticket' }));

    expect(onOpenTicket).toHaveBeenCalledWith(expect.objectContaining({ id: 41 }));
    expect(within(row(41)).getByRole('button', { expanded: false })).toBeInTheDocument();
  });
});

describe('expanded ticket', () => {
  const RUNS: Partial<EpicAgentRunRow>[] = [
    { id: 8, agent_type: 'epic-orchestrator', status: 'completed', conversation_id: 80, ticket_task_id: 41 },
    { id: 9, agent_type: 'epic-pr-review', status: 'failed', conversation_id: 91, ticket_task_id: 41 },
    { id: 10, agent_type: 'epic-pr-review', status: 'running', conversation_id: 92, ticket_task_id: 41 },
    { id: 11, agent_type: 'epic-orchestrator', status: 'completed', conversation_id: 85, ticket_task_id: 42 },
  ];

  it('unfolds on click and shows the ticket’s own conversations, not another ticket’s', () => {
    renderSection([ticket(41), ticket(42)], RUNS);

    expand(41);

    const detail = row(41);
    expect(within(detail).getByText('Orchestration')).toBeInTheDocument();
    expect(within(detail).getAllByText(/PR review #\d/)).toHaveLength(2);
    // Ticket 42's orchestration stays with ticket 42.
    expect(within(row(42)).queryByText('Orchestration')).toBeNull();
  });

  it('offers ONE orchestration conversation — one per ticket by design', () => {
    const { onOpenConversation } = renderSection([ticket(41)], RUNS);

    expand(41);
    const orchestration = within(row(41)).getByText('Orchestration').closest('li')!;
    fireEvent.click(within(orchestration).getByRole('button', { name: /open/i }));

    expect(onOpenConversation).toHaveBeenCalledWith(80);
  });

  it('lists every PR review, newest first with its status — retries make several', () => {
    const { onOpenConversation } = renderSection([ticket(41)], RUNS);

    expand(41);
    const detail = row(41);
    const labels = within(detail)
      .getAllByText(/PR review #\d/)
      .map((el) => el.textContent);
    expect(labels).toEqual(['PR review #2', 'PR review #1']);

    const latest = within(detail).getByText('PR review #2').closest('li')!;
    expect(within(latest).getByText('Running')).toBeInTheDocument();
    fireEvent.click(within(latest).getByRole('button', { name: /open/i }));
    expect(onOpenConversation).toHaveBeenCalledWith(92);

    const first = within(detail).getByText('PR review #1').closest('li')!;
    expect(within(first).getByText('Failed')).toBeInTheDocument();
  });

  it('says what is still to come on a ticket with no conversations yet', () => {
    renderSection([ticket(41)]);

    expand(41);

    expect(screen.getByText(/No orchestration conversation yet/)).toBeInTheDocument();
    expect(screen.getByText(/No PR review yet/)).toBeInTheDocument();
  });

  it('opens the ticket page from the expanded panel', () => {
    const { onOpenTicket } = renderSection([ticket(41)], RUNS);

    expand(41);
    fireEvent.click(screen.getByRole('button', { name: /open the ticket page/i }));

    expect(onOpenTicket).toHaveBeenCalledWith(expect.objectContaining({ id: 41 }));
  });

  it('folds back on a second click', () => {
    renderSection([ticket(41)], RUNS);

    expand(41);
    expect(within(row(41)).getByText('Orchestration')).toBeInTheDocument();

    fireEvent.click(within(row(41)).getByRole('button', { expanded: true }));
    expect(within(row(41)).queryByText('Orchestration')).toBeNull();
  });

  it('counts the attached conversations on the collapsed row', () => {
    renderSection([ticket(41), ticket(43)], RUNS);

    expect(within(row(41)).getByTitle(/3 conversations attached/)).toBeInTheDocument();
    expect(within(row(43)).queryByTitle(/attached/)).toBeNull();
  });
});
