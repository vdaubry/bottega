import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EpicDeliverySection from './EpicDeliverySection';
import type { WebServerStatusSuccess } from '@shared/api/projects';
import type { ConversationRow, EpicAgentRunRow, EpicRow, TaskRow } from '@shared/types/db';

function webServer(overrides: Partial<WebServerStatusSuccess> = {}): WebServerStatusSuccess {
  return {
    success: true,
    activeTaskId: null,
    activeEpicId: null,
    activeName: null,
    worktreeProvisioning: 'hook',
    serveSymlinkPath: '/var/www/nimbus',
    systemdServiceName: 'nimbus',
    appUrl: 'https://nimbus.example.com',
    isConfigured: true,
    ...overrides,
  };
}

function epicRow(overrides: Partial<EpicRow> = {}): EpicRow {
  return {
    id: 7,
    project_id: 3,
    name: 'Nimbus Pricing',
    slug: 'nimbus-pricing',
    status: 'active',
    feature_branch: 'epic/7-nimbus-pricing',
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

function ticket(id: number, status: TaskRow['status'] = 'completed'): TaskRow {
  return { id, project_id: 3, title: `Ticket ${id}`, status } as TaskRow;
}

function run(overrides: Partial<EpicAgentRunRow> = {}): EpicAgentRunRow {
  return {
    id: 1,
    epic_id: 7,
    agent_type: 'epic-delivery',
    status: 'completed',
    conversation_id: 100,
    ticket_task_id: null,
    ...overrides,
  } as EpicAgentRunRow;
}

function conversation(id: number, name: string | null): ConversationRow {
  return { id, owner_kind: 'epic', task_id: null, epic_id: 7, name } as ConversationRow;
}

function renderSection(
  opts: {
    epic?: EpicRow;
    tickets?: TaskRow[];
    runs?: EpicAgentRunRow[];
    conversations?: ConversationRow[];
    isEpicBusy?: boolean;
    webServerStatus?: WebServerStatusSuccess | null;
  } = {},
) {
  const onStartConversation = vi.fn();
  const onOpenPR = vi.fn();
  const onOpenConversation = vi.fn();
  const onSwitchServer = vi.fn();
  const onOpenApp = vi.fn();
  const onResetServer = vi.fn();
  render(
    <EpicDeliverySection
      epic={opts.epic ?? epicRow()}
      tickets={opts.tickets ?? [ticket(41)]}
      agentRuns={opts.runs ?? []}
      conversations={opts.conversations ?? []}
      isEpicBusy={opts.isEpicBusy ?? false}
      isStartingConversation={false}
      isOpeningPR={false}
      onStartConversation={onStartConversation}
      onOpenPR={onOpenPR}
      onOpenConversation={onOpenConversation}
      webServerStatus={opts.webServerStatus ?? null}
      isSwitchingServer={false}
      onSwitchServer={onSwitchServer}
      onOpenApp={onOpenApp}
      onResetServer={onResetServer}
    />,
  );
  return {
    onStartConversation,
    onOpenPR,
    onOpenConversation,
    onSwitchServer,
    onOpenApp,
    onResetServer,
  };
}

describe('the final pull request', () => {
  it('opens it once every ticket has merged', () => {
    const { onOpenPR } = renderSection();

    const button = screen.getByRole('button', { name: /open final pr/i });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onOpenPR).toHaveBeenCalled();
  });

  // The server refuses the same case (`createEpicCompletionPR`); saying so
  // before the click is what stops the user meeting a bare error.
  it('holds it while a ticket is still unmerged, and counts them', () => {
    renderSection({ tickets: [ticket(41), ticket(42, 'in_review'), ticket(43, 'pending')] });

    const button = screen.getByRole('button', { name: /open final pr/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringMatching(/2 tickets are not merged yet/));
  });

  it('holds it when the epic has no tickets at all', () => {
    renderSection({ tickets: [] });

    expect(screen.getByRole('button', { name: /open final pr/i })).toBeDisabled();
  });
});

describe('delivery conversations', () => {
  it('starts one — the entry point a merge conflict needs', () => {
    const { onStartConversation } = renderSection();

    fireEvent.click(screen.getByRole('button', { name: /new conversation/i }));
    expect(onStartConversation).toHaveBeenCalled();
  });

  // The feature branch is the delivery worktree's checkout; the server refuses
  // the run for the same reason (`checkStageGate`).
  it('cannot start one before the epic has a feature branch', () => {
    renderSection({ epic: epicRow({ feature_branch: null }) });

    const button = screen.getByRole('button', { name: /new conversation/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringMatching(/no feature branch yet/i));
  });

  it('holds the start while another epic conversation is running', () => {
    renderSection({ isEpicBusy: true });

    const button = screen.getByRole('button', { name: /new conversation/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringMatching(/running conversation/i));
  });

  it('says so when there is none yet', () => {
    renderSection();

    expect(screen.getByText(/No delivery conversation yet/)).toBeInTheDocument();
  });

  // Newest first: a webhook comment that just landed is what the user came for.
  it('lists them newest first, by their conversation name', () => {
    renderSection({
      runs: [
        run({ id: 1, conversation_id: 100 }),
        run({ id: 2, conversation_id: 101, status: 'running' }),
      ],
      conversations: [
        conversation(100, 'Resolve conflicts with main'),
        conversation(101, 'Address review feedback on pricing'),
      ],
    });

    const names = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(names[0]).toContain('Address review feedback on pricing');
    expect(names[0]).toContain('Running');
    expect(names[1]).toContain('Resolve conflicts with main');
  });

  // An unnamed one is a conversation whose AI title has not landed yet.
  it('falls back to a numbered label before the title lands', () => {
    renderSection({ runs: [run({ id: 3, conversation_id: 102 })] });

    expect(screen.getByText('Delivery conversation #1')).toBeInTheDocument();
  });

  it('opens one', () => {
    const { onOpenConversation } = renderSection({
      runs: [run({ id: 1, conversation_id: 100 })],
      conversations: [conversation(100, 'Resolve conflicts with main')],
    });

    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));
    expect(onOpenConversation).toHaveBeenCalledWith(100);
  });

  // Orchestration and PR-review runs belong to the Implementation section;
  // this list is the epic's OWN pull request, so it must not pick them up.
  it('ignores every other epic agent run', () => {
    renderSection({
      runs: [
        run({ id: 1, agent_type: 'epic-orchestrator', conversation_id: 90, ticket_task_id: 41 }),
        run({ id: 2, agent_type: 'epic-pr-review', conversation_id: 91, ticket_task_id: 41 }),
        run({ id: 3, agent_type: 'epic-architecture', conversation_id: 92 }),
      ],
    });

    expect(screen.getByText(/No delivery conversation yet/)).toBeInTheDocument();
  });
});


/**
 * Previewing the epic at the project's real URL — the same "switch server"
 * mechanism a ticket has, pointed at the epic's feature branch.
 */
describe('switch server', () => {
  it('is absent when the project has no serving symlink configured', () => {
    renderSection();

    expect(screen.queryByRole('button', { name: /switch server/i })).not.toBeInTheDocument();
  });

  it('offers to serve the epic once the project is configured', () => {
    const { onSwitchServer } = renderSection({ webServerStatus: webServer() });

    fireEvent.click(screen.getByRole('button', { name: /switch server/i }));
    expect(onSwitchServer).toHaveBeenCalled();
  });

  // Nothing to check out before the epic's first ticket creates the branch —
  // the same refusal the server gives.
  it('cannot serve an epic with no feature branch', () => {
    renderSection({
      epic: epicRow({ feature_branch: null }),
      webServerStatus: webServer(),
    });

    const button = screen.getByRole('button', { name: /switch server/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringMatching(/no feature branch yet/i));
  });

  // Green split button: open the app, or hand serving back to the main checkout.
  it('shows the active state when this epic is what is being served', () => {
    const { onOpenApp, onResetServer } = renderSection({
      webServerStatus: webServer({ activeEpicId: 7, activeName: 'Nimbus Pricing' }),
    });

    expect(screen.queryByRole('button', { name: /switch server/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /active server/i }));
    expect(onOpenApp).toHaveBeenCalled();

    fireEvent.click(screen.getByTitle(/back to the main repo/i));
    expect(onResetServer).toHaveBeenCalled();
  });

  // A different epic — or a ticket — being served must not light this one up.
  it('stays inactive while something else is being served', () => {
    renderSection({
      webServerStatus: webServer({ activeEpicId: 99, activeName: 'Another epic' }),
    });

    expect(screen.getByRole('button', { name: /switch server/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /active server/i })).not.toBeInTheDocument();
  });
});
