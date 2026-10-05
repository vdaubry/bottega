import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EpicQaSection from './EpicQaSection';
import type { ConversationRow, EpicAgentRunRow, EpicRow, TaskRow } from '@shared/types/db';

const EPIC = {
  id: 7,
  project_id: 3,
  name: 'Nimbus Pricing',
  status: 'active',
  architecture_complete: 1,
  specs_complete: 1,
  stories_complete: 1,
  review_complete: 1,
  qa_complete: 0,
  feature_branch: 'epic/7-nimbus-pricing',
  orchestration_active: 0,
  orchestration_blocked: 0,
  orchestration_blocked_reason: null,
} as EpicRow;

const MERGED = [
  { id: 101, status: 'completed' },
  { id: 102, status: 'completed' },
] as TaskRow[];

const handlers = {
  onStartScenarios: vi.fn(),
  onStartExecution: vi.fn(),
  onStartFixes: vi.fn(),
  onMarkQaComplete: vi.fn(),
  onOpenConversation: vi.fn(),
};

function renderSection({
  epic = {},
  tickets = MERGED,
  agentRuns = [] as Partial<EpicAgentRunRow>[],
  conversations = [] as Partial<ConversationRow>[],
  isEpicBusy = false,
  qaFailCount = null as number | null,
} = {}) {
  return render(
    <EpicQaSection
      epic={{ ...EPIC, ...epic }}
      tickets={tickets}
      agentRuns={agentRuns as EpicAgentRunRow[]}
      conversations={conversations as ConversationRow[]}
      isEpicBusy={isEpicBusy}
      isStartingScenarios={false}
      isStartingExecution={false}
      isStartingFixes={false}
      isMarkingComplete={false}
      qaFailCount={qaFailCount}
      {...handlers}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('the scenarios row', () => {
  it('starts the writer once the review is signed off', () => {
    renderSection();

    const start = screen.getByRole('button', { name: 'Start' });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(handlers.onStartScenarios).toHaveBeenCalled();
  });

  it('blocks the writer until the review is signed off, saying why', () => {
    renderSection({ epic: { review_complete: 0 } });

    const start = screen.getByRole('button', { name: 'Start' });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('title', expect.stringMatching(/specification review/i));
  });

  it('says "Run again" once the writer has run, and offers the backstop', () => {
    renderSection({
      agentRuns: [
        { id: 1, agent_type: 'epic-qa-scenarios', status: 'completed', conversation_id: 11 },
      ],
    });

    expect(screen.getByRole('button', { name: 'Run again' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark complete' }));
    expect(handlers.onMarkQaComplete).toHaveBeenCalled();
  });

  it('shows Approved from the flag and retires the backstop', () => {
    renderSection({
      epic: { qa_complete: 1 },
      agentRuns: [
        { id: 1, agent_type: 'epic-qa-scenarios', status: 'completed', conversation_id: 11 },
      ],
    });

    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull();
  });

  it('opens a run conversation by its name', () => {
    renderSection({
      agentRuns: [
        { id: 1, agent_type: 'epic-qa-scenarios', status: 'completed', conversation_id: 11 },
      ],
      conversations: [{ id: 11, name: 'Scenario book v1' }],
    });

    expect(screen.getByText('Scenario book v1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(handlers.onOpenConversation).toHaveBeenCalledWith(11);
  });
});

describe('the execution row', () => {
  it('runs QA once the book is approved and every ticket merged', () => {
    renderSection({ epic: { qa_complete: 1 } });

    const run = screen.getByRole('button', { name: 'Run QA' });
    expect(run).toBeEnabled();
    fireEvent.click(run);
    expect(handlers.onStartExecution).toHaveBeenCalled();
  });

  it('blocks execution until the book is approved, saying why', () => {
    renderSection();

    const run = screen.getByRole('button', { name: 'Run QA' });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', expect.stringMatching(/approve the QA scenarios/i));
  });

  it('blocks execution while a ticket is unmerged, counting them', () => {
    renderSection({
      epic: { qa_complete: 1 },
      tickets: [
        { id: 101, status: 'completed' },
        { id: 102, status: 'in_progress' },
      ] as TaskRow[],
    });

    const run = screen.getByRole('button', { name: 'Run QA' });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', expect.stringMatching(/1 ticket is not merged yet/));
  });

  it('blocks both rows while another epic conversation is running', () => {
    renderSection({ epic: { qa_complete: 1 }, isEpicBusy: true });

    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run QA' })).toBeDisabled();
  });

  it('lists execution runs newest first', () => {
    renderSection({
      epic: { qa_complete: 1 },
      agentRuns: [
        { id: 3, agent_type: 'epic-qa-execution', status: 'completed', conversation_id: 31 },
        { id: 5, agent_type: 'epic-qa-execution', status: 'running', conversation_id: 51 },
      ],
      conversations: [
        { id: 31, name: 'First pass' },
        { id: 51, name: 'Resume run' },
      ],
    });

    const names = screen.getAllByText(/First pass|Resume run/).map((n) => n.textContent);
    expect(names).toEqual(['Resume run', 'First pass']);
  });
});

describe('the fixes row', () => {
  it('offers Fix failures with the count when the book records fails', () => {
    renderSection({ qaFailCount: 3 });

    const button = screen.getByRole('button', { name: 'Fix failures (3)' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(handlers.onStartFixes).toHaveBeenCalled();
  });

  it('blocks the mission on a clean or unknown book, saying why', () => {
    renderSection({ qaFailCount: 0 });
    expect(screen.getByRole('button', { name: 'Fix failures' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Fix failures' })).toHaveAttribute(
      'title',
      'The book records no failed scenario — nothing to fix.',
    );
  });

  it('blocks the mission while orchestration is active', () => {
    renderSection({ epic: { orchestration_active: 1 }, qaFailCount: 3 });
    expect(screen.getByRole('button', { name: 'Fix failures (3)' })).toBeDisabled();
  });

  it('lists fix runs with their conversations', () => {
    renderSection({
      qaFailCount: 2,
      agentRuns: [{ id: 9, agent_type: 'epic-qa-fix', status: 'running', conversation_id: 91 }],
      conversations: [{ id: 91, name: 'Fix mission' }],
    });

    expect(screen.getByText('Fix mission')).toBeInTheDocument();
  });
});
