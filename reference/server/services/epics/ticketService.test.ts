import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../database/epics.js', () => ({
  epicsDb: { getById: vi.fn() },
  epicTicketsDb: {
    listTickets: vi.fn().mockReturnValue([]),
    attach: vi.fn(),
    setPosition: vi.fn(),
    get: vi.fn(),
    epicOf: vi.fn(),
  },
}));
vi.mock('../projectService.js', () => ({ getProject: vi.fn() }));
vi.mock('../tasks/index.js', () => ({ createTaskWithWorktree: vi.fn() }));
vi.mock('../worktree.js', () => ({ isGitRepository: vi.fn() }));
vi.mock('./epicBranch.js', () => ({ ensureEpicFeatureBranch: vi.fn() }));

import {
  createEpicTicket,
  EpicNotInProjectError,
  moveTicket,
  renumberTickets,
} from './ticketService.js';
import { epicsDb, epicTicketsDb } from '../../database/epics.js';
import { getProject } from '../projectService.js';
import { createTaskWithWorktree } from '../tasks/index.js';
import { isGitRepository } from '../worktree.js';
import { ensureEpicFeatureBranch } from './epicBranch.js';

const project = { id: 7, repo_folder_path: '/repo', subproject_path: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(epicsDb.getById).mockReturnValue({ id: 8, project_id: 7 } as never);
  vi.mocked(getProject).mockReturnValue(project as never);
  vi.mocked(isGitRepository).mockResolvedValue(true);
  vi.mocked(ensureEpicFeatureBranch).mockResolvedValue({
    branch: 'epic/8-nimbus',
    created: false,
    pushed: true,
  });
  vi.mocked(epicTicketsDb.listTickets).mockReturnValue([] as never);
  vi.mocked(createTaskWithWorktree).mockResolvedValue({
    success: true,
    task: { id: 5, title: 'Ticket' },
  } as never);
});

describe('createEpicTicket', () => {
  it('ensures the epic feature branch BEFORE creating the task, and passes it as base', async () => {
    const order: string[] = [];
    vi.mocked(ensureEpicFeatureBranch).mockImplementation(async () => {
      order.push('ensure');
      return { branch: 'epic/8-nimbus', created: true, pushed: true };
    });
    vi.mocked(createTaskWithWorktree).mockImplementation((async () => {
      order.push('create');
      return { success: true, task: { id: 5 } };
    }) as never);

    const result = await createEpicTicket(8, { title: 'Ticket' }, 3);

    expect(order).toEqual(['ensure', 'create']);
    expect(ensureEpicFeatureBranch).toHaveBeenCalledWith('/repo', 8);
    expect(createTaskWithWorktree).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ title: 'Ticket', baseBranch: 'epic/8-nimbus' }),
      3,
    );
    expect(result.baseBranch).toBe('epic/8-nimbus');
  });

  it('appends after the epic last ticket when no position is given', async () => {
    vi.mocked(epicTicketsDb.listTickets).mockReturnValue([
      { id: 1, position: 1 },
      { id: 2, position: 3 },
      { id: 3, position: 2 },
    ] as never);

    await createEpicTicket(8, { title: 'Ticket' }, 3);

    expect(epicTicketsDb.attach).toHaveBeenCalledWith(8, 5, 4);
  });

  it('honours an explicit position', async () => {
    await createEpicTicket(8, { title: 'Ticket', epicOrder: 2 }, 3);
    expect(epicTicketsDb.attach).toHaveBeenCalledWith(8, 5, 2);
  });

  it('surfaces the branch warning without failing the creation', async () => {
    vi.mocked(ensureEpicFeatureBranch).mockResolvedValue({
      branch: 'epic/8-nimbus',
      created: true,
      pushed: false,
      warning: 'no reachable origin',
    });

    const result = await createEpicTicket(8, { title: 'Ticket' }, 3);

    expect(result.success).toBe(true);
    expect(result.warning).toBe('no reachable origin');
  });

  it('throws EpicNotInProjectError for a missing or inaccessible epic', async () => {
    vi.mocked(epicsDb.getById).mockReturnValue(undefined);
    await expect(createEpicTicket(8, { title: 'T' }, 3)).rejects.toBeInstanceOf(
      EpicNotInProjectError,
    );

    vi.mocked(epicsDb.getById).mockReturnValue({ id: 8, project_id: 7 } as never);
    vi.mocked(getProject).mockReturnValue(null as never);
    await expect(createEpicTicket(8, { title: 'T' }, 3)).rejects.toBeInstanceOf(
      EpicNotInProjectError,
    );
    expect(createTaskWithWorktree).not.toHaveBeenCalled();
  });

  it('fails cleanly (no task created) when the branch cannot be prepared', async () => {
    vi.mocked(ensureEpicFeatureBranch).mockRejectedValue(new Error('git exploded'));

    const result = await createEpicTicket(8, { title: 'Ticket' }, 3);

    expect(result.success).toBe(false);
    expect(result.error).toContain('git exploded');
    expect(createTaskWithWorktree).not.toHaveBeenCalled();
    expect(epicTicketsDb.attach).not.toHaveBeenCalled();
  });

  it('skips the branch entirely for a non-git project', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(false);

    await createEpicTicket(8, { title: 'Ticket' }, 3);

    expect(ensureEpicFeatureBranch).not.toHaveBeenCalled();
    expect(createTaskWithWorktree).toHaveBeenCalledWith(
      project,
      expect.objectContaining({ baseBranch: null }),
      3,
    );
  });

  it('does not attach membership when the task creation failed', async () => {
    vi.mocked(createTaskWithWorktree).mockResolvedValue({
      success: false,
      error: 'worktree failed',
    });

    const result = await createEpicTicket(8, { title: 'Ticket' }, 3);

    expect(result.success).toBe(false);
    expect(epicTicketsDb.attach).not.toHaveBeenCalled();
  });
});

describe('moveTicket', () => {
  function tickets(rows: Array<[number, number | null]>) {
    vi.mocked(epicTicketsDb.listTickets).mockReturnValue(
      rows.map(([id, position]) => ({ id, position })) as never,
    );
  }

  it('moves a ticket up and renumbers the whole sequence', () => {
    tickets([[1, 1], [2, 2], [3, 3]]);

    moveTicket(8, 3, 1);

    expect(epicTicketsDb.setPosition).toHaveBeenCalledWith(3, 1);
    expect(epicTicketsDb.setPosition).toHaveBeenCalledWith(1, 2);
    expect(epicTicketsDb.setPosition).toHaveBeenCalledWith(2, 3);
  });

  it('clamps a position past the end to last', () => {
    tickets([[1, 1], [2, 2]]);

    moveTicket(8, 1, 99);

    expect(epicTicketsDb.setPosition).toHaveBeenCalledWith(2, 1);
    expect(epicTicketsDb.setPosition).toHaveBeenCalledWith(1, 2);
  });

  it('normalizes gaps and NULLs it finds on the way', () => {
    tickets([[1, 2], [2, null], [3, 7]]);

    moveTicket(8, 1, 1);

    expect(epicTicketsDb.setPosition).toHaveBeenCalledWith(1, 1);
    expect(epicTicketsDb.setPosition).toHaveBeenCalledWith(2, 2);
    expect(epicTicketsDb.setPosition).toHaveBeenCalledWith(3, 3);
  });

  it('does nothing for a ticket that is not in the epic', () => {
    tickets([[1, 1]]);

    moveTicket(8, 99, 1);

    expect(epicTicketsDb.setPosition).not.toHaveBeenCalled();
  });
});

describe('renumberTickets', () => {
  it('closes the gap a deletion left', () => {
    vi.mocked(epicTicketsDb.listTickets).mockReturnValue([
      { id: 1, position: 1 },
      { id: 3, position: 3 },
    ] as never);

    renumberTickets(8);

    expect(epicTicketsDb.setPosition).toHaveBeenCalledWith(3, 2);
    expect(epicTicketsDb.setPosition).not.toHaveBeenCalledWith(1, expect.anything());
  });
});
