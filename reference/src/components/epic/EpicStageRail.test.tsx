import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import EpicStageRail, { isStageSignedOff, stageBlockedReason } from './EpicStageRail';
import type { EpicAgentRunRow, ConversationRow, EpicRow } from '@shared/types/db';

const EPIC = {
  id: 7,
  project_id: 3,
  name: 'Nimbus Pricing',
  status: 'active',
  architecture_complete: 0,
  specs_complete: 0,
  stories_complete: 0,
  review_complete: 0,
  orchestration_active: 0,
  orchestration_blocked: 0,
  orchestration_blocked_reason: null,
} as EpicRow;

const handlers = {
  onStart: vi.fn(),
  onOpenConversation: vi.fn(),
  onMarkComplete: vi.fn(),
};

function renderRail(
  epic: Partial<EpicRow> = {},
  agentRuns: Partial<EpicAgentRunRow>[] = [],
  conversations: Partial<ConversationRow>[] = [],
) {
  return render(
    <EpicStageRail
      epic={{ ...EPIC, ...epic }}
      agentRuns={agentRuns as EpicAgentRunRow[]}
      conversations={conversations as ConversationRow[]}
      isEpicBusy={agentRuns.some((r) => r.status === 'running')}
      startingStage={null}
      markingStage={null}
      {...handlers}
    />,
  );
}

/** The <li> for one stage — assertions are scoped to it, not the whole rail. */
function stage(label: string): HTMLElement {
  return screen.getByRole('heading', { name: label }).closest('li')!;
}

beforeEach(() => vi.clearAllMocks());

describe('stage status', () => {
  it('shows the four framing stages — implementation lives in its own section now', () => {
    renderRail();

    for (const label of [
      'Architecture',
      'Technical specification',
      'Stories',
      'Specification review',
    ]) {
      expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('heading', { name: 'Implementation' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'PR review' })).toBeNull();
    // QA is not a framing row either — it lives in its own Main-tab section.
    expect(screen.queryByRole('heading', { name: 'QA scenarios' })).toBeNull();
  });

  it('reads the qa sign-off from its own flag and gates it behind the review', () => {
    // The helpers are shared with EpicQaSection; the rail itself never shows QA.
    expect(isStageSignedOff({ ...EPIC, qa_complete: 0 }, 'qa')).toBe(false);
    expect(isStageSignedOff({ ...EPIC, qa_complete: 1 }, 'qa')).toBe(true);
    expect(stageBlockedReason({ ...EPIC, review_complete: 0 }, 'qa')).toMatch(
      /specification review/i,
    );
    expect(stageBlockedReason({ ...EPIC, review_complete: 1 }, 'qa')).toBeNull();
  });

  it('reads the status from the stage latest run — highest id wins', () => {
    renderRail({}, [
      { id: 1, agent_type: 'epic-architecture', status: 'failed' },
      { id: 2, agent_type: 'epic-architecture', status: 'completed' },
    ]);

    expect(within(stage('Architecture')).getByText('Completed')).toBeInTheDocument();
  });

  it('shows a stage with no run as not started', () => {
    renderRail();

    expect(within(stage('Stories')).getByText('Not started')).toBeInTheDocument();
  });

  it('shows a running stage and refuses to start another one meanwhile', () => {
    renderRail({ architecture_complete: 1 }, [
      { id: 3, agent_type: 'epic-specification', status: 'running' },
    ]);

    expect(within(stage('Technical specification')).getByText('Running')).toBeInTheDocument();
    expect(within(stage('Architecture')).getByRole('button', { name: /run again|start/i })).toBeDisabled();
  });

  it('separates "signed off" (the flag) from the run status', () => {
    // The backstop case: a flag set with no run at all.
    renderRail({ architecture_complete: 1 });

    const architecture = stage('Architecture');
    expect(within(architecture).getByText('Signed off')).toBeInTheDocument();
    expect(within(architecture).getByText('Not started')).toBeInTheDocument();
  });

  it('does not call a completed-but-unapproved run signed off', () => {
    renderRail({}, [{ id: 1, agent_type: 'epic-architecture', status: 'completed' }]);

    expect(within(stage('Architecture')).queryByText('Signed off')).not.toBeInTheDocument();
  });
});

describe('gates', () => {
  it('blocks the specification stage until the architecture is signed off', () => {
    renderRail();

    const specification = stage('Technical specification');
    expect(within(specification).getByRole('button', { name: /start/i })).toBeDisabled();
    expect(within(specification).getByText(/Run the architecture stage first/)).toBeInTheDocument();
  });

  it('opens the specification stage once the flag is set', () => {
    renderRail({ architecture_complete: 1 });

    fireEvent.click(within(stage('Technical specification')).getByRole('button', { name: /start/i }));

    expect(handlers.onStart).toHaveBeenCalledWith('epic-specification');
  });

  it('blocks the stories stage until the specification is signed off', () => {
    renderRail({ architecture_complete: 1 });

    expect(within(stage('Stories')).getByRole('button', { name: /start/i })).toBeDisabled();
  });

  it('blocks the specification review until the ticket list is signed off', () => {
    renderRail({ architecture_complete: 1, specs_complete: 1 });

    const review = stage('Specification review');
    expect(within(review).getByRole('button', { name: /start/i })).toBeDisabled();
    expect(
      within(review).getByText(/Create and approve the epic tickets first/),
    ).toBeInTheDocument();
  });

  it('opens the specification review once the stories flag is set', () => {
    renderRail({ architecture_complete: 1, specs_complete: 1, stories_complete: 1 });

    fireEvent.click(within(stage('Specification review')).getByRole('button', { name: /start/i }));

    expect(handlers.onStart).toHaveBeenCalledWith('epic-spec-review');
  });

  it('reads the review sign-off from its own flag', () => {
    renderRail({ architecture_complete: 1, specs_complete: 1, stories_complete: 1, review_complete: 1 });

    expect(within(stage('Specification review')).getByText('Signed off')).toBeInTheDocument();
    expect(within(stage('Stories')).getByText('Signed off')).toBeInTheDocument();
  });

  it('keeps the backstop on the review row — accepting the findings is the user’s call', () => {
    renderRail({ architecture_complete: 1, specs_complete: 1, stories_complete: 1 });

    expect(
      within(stage('Specification review')).getByRole('button', { name: /mark complete/i }),
    ).toBeInTheDocument();
  });
});

describe('actions', () => {
  it('offers the backstop only while a stage is unsigned', () => {
    renderRail({ architecture_complete: 1 });

    expect(within(stage('Architecture')).queryByRole('button', { name: /mark complete/i })).toBeNull();
    expect(
      within(stage('Technical specification')).getByRole('button', { name: /mark complete/i }),
    ).toBeInTheDocument();
  });

  it('marks a stage complete by its pipeline name', () => {
    renderRail();

    fireEvent.click(within(stage('Architecture')).getByRole('button', { name: /mark complete/i }));

    expect(handlers.onMarkComplete).toHaveBeenCalledWith('architecture');
  });

  it('opens the latest run conversation', () => {
    renderRail({}, [
      { id: 1, agent_type: 'epic-architecture', status: 'completed', conversation_id: 11 },
      { id: 2, agent_type: 'epic-architecture', status: 'completed', conversation_id: 12 },
    ]);

    fireEvent.click(
      within(stage('Architecture')).getByRole('button', { name: /open conversation/i }),
    );

    expect(handlers.onOpenConversation).toHaveBeenCalledWith(12);
  });

  it('lists the stage own conversations behind a disclosure', () => {
    renderRail(
      {},
      [
        { id: 1, agent_type: 'epic-architecture', status: 'completed', conversation_id: 11 },
        { id: 2, agent_type: 'epic-specification', status: 'completed', conversation_id: 22 },
      ],
      [
        { id: 11, name: 'First pass' },
        { id: 22, name: 'Spec chat' },
      ],
    );

    const architecture = stage('Architecture');
    fireEvent.click(within(architecture).getByText(/1 conversation/));

    expect(within(architecture).getByText('First pass')).toBeInTheDocument();
    // The other stage conversation stays with its own stage.
    expect(within(architecture).queryByText('Spec chat')).not.toBeInTheDocument();
  });

  it('says "Run again" once a stage has run', () => {
    renderRail({}, [{ id: 1, agent_type: 'epic-architecture', status: 'completed' }]);

    expect(within(stage('Architecture')).getByRole('button', { name: /run again/i })).toBeInTheDocument();
  });
});
