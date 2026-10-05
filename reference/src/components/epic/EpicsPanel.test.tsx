import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../utils/api', () => ({
  api: { epics: { list: vi.fn(), listTasks: vi.fn() } },
}));

import EpicsPanel from './EpicsPanel';
import { api } from '../../utils/api';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as never;
}

function epic(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    project_id: 7,
    name: `Epic ${id}`,
    status: 'active',
    architecture_complete: 0,
    specs_complete: 0,
    stories_complete: 0,
    review_complete: 0,
    created_at: '2026-08-01 09:00:00',
    updated_at: '2026-08-02 09:00:00',
    ...overrides,
  };
}

function renderPanel() {
  const onOpenEpic = vi.fn();
  const onNewEpic = vi.fn();
  render(<EpicsPanel projectId={7} onOpenEpic={onOpenEpic} onNewEpic={onNewEpic} />);
  return { onOpenEpic, onNewEpic };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.epics.listTasks).mockResolvedValue(jsonResponse([]));
});

describe('EpicsPanel', () => {
  it('explains what an epic is when the project has none', async () => {
    vi.mocked(api.epics.list).mockResolvedValue(jsonResponse([]));
    renderPanel();

    expect(await screen.findByText(/No epics yet/)).toBeInTheDocument();
  });

  it('names the stage the epic is waiting on — the first one not signed off', async () => {
    vi.mocked(api.epics.list).mockResolvedValue(
      jsonResponse([epic(41, { architecture_complete: 1 })]),
    );
    renderPanel();

    expect(await screen.findByText('Epic 41')).toBeInTheDocument();
    expect(screen.getByText('Technical specification')).toBeInTheDocument();
  });

  it('waits on the specification review after the stories are signed off', async () => {
    vi.mocked(api.epics.list).mockResolvedValue(
      jsonResponse([
        epic(41, { architecture_complete: 1, specs_complete: 1, stories_complete: 1 }),
      ]),
    );
    renderPanel();

    expect(await screen.findByText('Epic 41')).toBeInTheDocument();
    expect(screen.getByText('Specification review')).toBeInTheDocument();
  });

  it('keeps naming Implementation for an epic past framing, whatever the QA flag says', async () => {
    // Implementation's dot is permanently not-done (its completion lives in
    // the ticket rows), which also keeps the label from skipping ahead to QA.
    vi.mocked(api.epics.list).mockResolvedValue(
      jsonResponse([
        epic(44, {
          architecture_complete: 1,
          specs_complete: 1,
          stories_complete: 1,
          review_complete: 1,
          qa_complete: 1,
        }),
      ]),
    );
    renderPanel();

    expect(await screen.findByText('Epic 44')).toBeInTheDocument();
    expect(screen.getByText('Implementation')).toBeInTheDocument();
  });

  it('shows a QA dot after Implementation, read from qa_complete', async () => {
    vi.mocked(api.epics.list).mockResolvedValue(
      jsonResponse([epic(45, { qa_complete: 1 })]),
    );
    renderPanel();

    expect(await screen.findByText('Epic 45')).toBeInTheDocument();
    expect(screen.getByTitle('QA: signed off')).toBeInTheDocument();
    expect(screen.getByTitle('Implementation: not yet')).toBeInTheDocument();
  });

  it('counts the tickets each epic produced', async () => {
    vi.mocked(api.epics.list).mockResolvedValue(jsonResponse([epic(41)]));
    vi.mocked(api.epics.listTasks).mockResolvedValue(jsonResponse([{ id: 1 }, { id: 2 }]));
    renderPanel();

    expect(await screen.findByText('2 tickets')).toBeInTheDocument();
  });

  it('shows a non-active epic status', async () => {
    vi.mocked(api.epics.list).mockResolvedValue(jsonResponse([epic(41, { status: 'completed' })]));
    renderPanel();

    expect(await screen.findByText('completed')).toBeInTheDocument();
  });

  it('opens an epic and starts a new one', async () => {
    vi.mocked(api.epics.list).mockResolvedValue(jsonResponse([epic(41)]));
    const { onOpenEpic, onNewEpic } = renderPanel();

    fireEvent.click(await screen.findByTestId('epic-card-41'));
    expect(onOpenEpic).toHaveBeenCalledWith(41);

    fireEvent.click(screen.getByRole('button', { name: /new epic/i }));
    expect(onNewEpic).toHaveBeenCalled();
  });

  it('survives a failing list without blanking the board', async () => {
    vi.mocked(api.epics.list).mockResolvedValue(jsonResponse({ error: 'nope' }, 500));
    renderPanel();

    await waitFor(() => expect(api.epics.list).toHaveBeenCalled());
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new epic/i })).toBeInTheDocument();
  });
});
