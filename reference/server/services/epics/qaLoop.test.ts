import { describe, it, expect, vi, beforeEach } from 'vitest';

import { serializeQaScenarios, type QaScenarioRow } from '@shared/schemas/qa';

const {
  mockGetWithProject,
  mockReadEpicQaFile,
  mockStartEpicAgentRun,
  mockGetRunningAgentForEpic,
  mockSendBanner,
} = vi.hoisted(() => ({
  mockGetWithProject: vi.fn(),
  mockReadEpicQaFile: vi.fn(),
  mockStartEpicAgentRun: vi.fn(),
  mockGetRunningAgentForEpic: vi.fn(),
  mockSendBanner: vi.fn(),
}));

vi.mock('../../database/epics.js', () => ({
  epicsDb: { getWithProject: mockGetWithProject },
}));

vi.mock('./epicArchive.js', () => ({ readEpicQaFile: mockReadEpicQaFile }));

vi.mock('./epicAgentRunner.js', () => ({
  startEpicAgentRun: mockStartEpicAgentRun,
  getRunningAgentForEpic: mockGetRunningAgentForEpic,
}));

vi.mock('../notifications.js', () => ({ sendBannerNotification: mockSendBanner }));

vi.mock('./orchestrator/bridge.js', () => ({
  getBridgeBroadcasters: () => ({
    broadcastFn: 'bf',
    broadcastToEpicSubscribersFn: 'bes',
  }),
}));

import { MAX_QA_CONTINUATIONS, _resetAllQaLoopState, decide, resetQaLoopState } from './qaLoop.js';

const EPIC = {
  id: 4,
  name: 'NimbusPricing',
  project_id: 169,
  user_id: 1,
  feature_branch: 'epic/4-nimbuspricing',
};

const row = (id: string, status: '' | 'pass' | 'fail'): QaScenarioRow => ({
  id,
  feature: 'Feature',
  title: `Scenario ${id}`,
  steps: '1. Do the thing',
  expected: 'It works',
  status,
  confidence: status === '' ? '' : '3',
  notes: '',
});

/** A book with `done` resulted rows followed by `notRun` empty ones. */
function book(done: number, notRun: number): string {
  const rows: QaScenarioRow[] = [];
  for (let i = 0; i < done + notRun; i++) {
    rows.push(row(`S-${String(i + 1).padStart(3, '0')}`, i < done ? 'pass' : ''));
  }
  return serializeQaScenarios(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetAllQaLoopState();
  mockGetWithProject.mockReturnValue(EPIC);
  mockGetRunningAgentForEpic.mockReturnValue(null);
  mockStartEpicAgentRun.mockResolvedValue({ agentRun: { id: 1 } });
  mockSendBanner.mockResolvedValue(undefined);
});

describe('decide — continuation', () => {
  it('starts a fresh execution run while not-run rows remain', async () => {
    mockReadEpicQaFile.mockReturnValue(book(47, 87));

    await decide(4);

    expect(mockStartEpicAgentRun).toHaveBeenCalledWith(4, 'epic-qa-execution', {
      broadcastFn: 'bf',
      broadcastToEpicSubscribersFn: 'bes',
      userId: 1,
    });
    expect(mockSendBanner).not.toHaveBeenCalled();
  });

  it('keeps continuing while every turn makes progress', async () => {
    mockReadEpicQaFile.mockReturnValue(book(47, 87));
    await decide(4);
    mockReadEpicQaFile.mockReturnValue(book(100, 34));
    await decide(4);

    expect(mockStartEpicAgentRun).toHaveBeenCalledTimes(2);
  });

  it('stops with a completion banner once every row has a result', async () => {
    mockReadEpicQaFile.mockReturnValue(book(134, 0));

    await decide(4);

    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
    expect(mockSendBanner).toHaveBeenCalledWith(
      1,
      'Epic QA complete',
      expect.stringContaining('all 134 scenario(s) executed — 134 pass, 0 fail'),
      expect.objectContaining({ type: 'epic_qa', projectId: '169' }),
    );
  });

  it('sends no banner to an epic without an owner', async () => {
    mockGetWithProject.mockReturnValue({ ...EPIC, user_id: null });
    mockReadEpicQaFile.mockReturnValue(book(134, 0));

    await decide(4);

    expect(mockSendBanner).not.toHaveBeenCalled();
  });
});

describe('decide — stall guard', () => {
  it('stops instead of respawning when a run recorded nothing new', async () => {
    mockReadEpicQaFile.mockReturnValue(book(47, 87));
    await decide(4); // spawns; baseline = 87 not run

    await decide(4); // same book — the continuation recorded nothing

    expect(mockStartEpicAgentRun).toHaveBeenCalledTimes(1);
    expect(mockSendBanner).toHaveBeenCalledWith(
      1,
      'Epic QA stalled',
      expect.stringContaining('87 scenario(s)'),
      expect.objectContaining({ type: 'epic_qa' }),
    );
  });

  it('does not stall a fresh user-initiated budget', async () => {
    mockReadEpicQaFile.mockReturnValue(book(47, 87));
    await decide(4); // baseline = 87

    resetQaLoopState(4); // the user clicked Run QA
    await decide(4); // same book, but a fresh budget: no baseline to stall on

    expect(mockStartEpicAgentRun).toHaveBeenCalledTimes(2);
    expect(mockSendBanner).not.toHaveBeenCalled();
  });
});

describe('decide — cap', () => {
  it(`pauses after ${MAX_QA_CONTINUATIONS} consecutive continuations`, async () => {
    // Each turn resolves exactly one scenario — slow but real progress, so
    // only the cap can end the loop.
    for (let i = 0; i < MAX_QA_CONTINUATIONS; i++) {
      mockReadEpicQaFile.mockReturnValue(book(i, 100 - i));
      await decide(4);
    }
    expect(mockStartEpicAgentRun).toHaveBeenCalledTimes(MAX_QA_CONTINUATIONS);

    mockReadEpicQaFile.mockReturnValue(book(MAX_QA_CONTINUATIONS, 100 - MAX_QA_CONTINUATIONS));
    await decide(4);

    expect(mockStartEpicAgentRun).toHaveBeenCalledTimes(MAX_QA_CONTINUATIONS);
    expect(mockSendBanner).toHaveBeenCalledWith(
      1,
      'Epic QA paused',
      expect.stringContaining('Run QA to continue'),
      expect.objectContaining({ type: 'epic_qa' }),
    );
  });
});

describe('decide — guards', () => {
  it('does nothing for an unknown epic', async () => {
    mockGetWithProject.mockReturnValue(undefined);

    await decide(999);

    expect(mockReadEpicQaFile).not.toHaveBeenCalled();
    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
  });

  it('never respawns on a missing book', async () => {
    mockReadEpicQaFile.mockReturnValue(null);

    await decide(4);

    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
    expect(mockSendBanner).not.toHaveBeenCalled();
  });

  it('never respawns on an invalid book', async () => {
    mockReadEpicQaFile.mockReturnValue('not,a,scenario,book\n');

    await decide(4);

    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
  });

  it('yields to an active run and keeps its guard state intact', async () => {
    mockReadEpicQaFile.mockReturnValue(book(47, 87));
    await decide(4); // baseline = 87

    mockGetRunningAgentForEpic.mockReturnValue({ id: 5, status: 'running' });
    mockReadEpicQaFile.mockReturnValue(book(50, 84));
    await decide(4); // busy — no spawn, baseline untouched

    expect(mockStartEpicAgentRun).toHaveBeenCalledTimes(1);

    mockGetRunningAgentForEpic.mockReturnValue(null);
    await decide(4); // 84 < 87 — progress against the surviving baseline

    expect(mockStartEpicAgentRun).toHaveBeenCalledTimes(2);
  });

  it('stops when the epic has no feature branch', async () => {
    mockGetWithProject.mockReturnValue({ ...EPIC, feature_branch: null });
    mockReadEpicQaFile.mockReturnValue(book(47, 87));

    await decide(4);

    expect(mockStartEpicAgentRun).not.toHaveBeenCalled();
  });

  it('notifies and clears state when the spawn itself fails', async () => {
    mockReadEpicQaFile.mockReturnValue(book(47, 87));
    mockStartEpicAgentRun.mockRejectedValue(new Error('no credentials'));

    await decide(4);

    expect(mockSendBanner).toHaveBeenCalledWith(
      1,
      'Epic QA interrupted',
      expect.stringContaining('Run QA to continue'),
      expect.objectContaining({ type: 'epic_qa' }),
    );

    // State was cleared, so a later turn-end (same book) tries again rather
    // than reading the failed spawn as a stall.
    mockStartEpicAgentRun.mockResolvedValue({ agentRun: { id: 2 } });
    await decide(4);
    expect(mockStartEpicAgentRun).toHaveBeenCalledTimes(2);
  });
});
