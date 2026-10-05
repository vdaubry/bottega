import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSupervisedEpicOf = vi.hoisted(() => vi.fn());
const mockNotifySupervisor = vi.hoisted(() => vi.fn());
const mockScheduleNextTicket = vi.hoisted(() => vi.fn());
const mockSchedulePrReview = vi.hoisted(() => vi.fn());
const mockListOrchestrating = vi.hoisted(() => vi.fn().mockReturnValue([]));

vi.mock('./orchestrator/bridge.js', () => ({
  supervisedEpicOf: mockSupervisedEpicOf,
  notifySupervisor: mockNotifySupervisor,
}));
vi.mock('./orchestrator/sequencing.js', () => ({
  scheduleNextTicket: mockScheduleNextTicket,
  schedulePrReview: mockSchedulePrReview,
}));
vi.mock('../../database/epics.js', () => ({
  epicsDb: { listOrchestrating: mockListOrchestrating },
}));

import { emitTaskEvent, _resetTaskEventListeners } from '../tasks/events.js';
import { registerEpicTaskEventSubscriber } from './taskEventSubscriber.js';

beforeEach(() => {
  vi.clearAllMocks();
  _resetTaskEventListeners();
  registerEpicTaskEventSubscriber();
  mockSupervisedEpicOf.mockReturnValue({ epicId: 7, kind: 'orchestrator' });
  mockListOrchestrating.mockReturnValue([]);
});

function runEnded(overrides: Record<string, unknown> = {}) {
  emitTaskEvent('run-ended', {
    taskId: 42,
    runId: 600,
    agentType: 'planification',
    driver: 'automation',
    status: 'completed',
    conversationId: 100,
    ...overrides,
  } as never);
}

describe('epic task-event subscriber', () => {
  it('ignores every event for a task that is not supervised', () => {
    mockSupervisedEpicOf.mockReturnValue(null);

    runEnded();
    emitTaskEvent('question-parked', { taskId: 42, conversationId: 1, questions: [] });
    emitTaskEvent('workflow-blocked', { taskId: 42, reason: 'max-iterations' });
    emitTaskEvent('chain-start-failed', { taskId: 42, nextAgentType: 'review', error: 'x' });
    emitTaskEvent('task-merged', { taskId: 42 });

    expect(mockNotifySupervisor).not.toHaveBeenCalled();
    expect(mockSchedulePrReview).not.toHaveBeenCalled();
    expect(mockScheduleNextTicket).not.toHaveBeenCalled();
  });

  it('planification turn ended (any outcome) wakes the orchestrator', () => {
    runEnded({ status: 'completed' });
    expect(mockNotifySupervisor).toHaveBeenCalledWith(7, {
      type: 'planification-turn-ended',
      taskId: 42,
      agentType: 'planification',
      runId: 600,
      status: 'completed',
    });
  });

  it('a completed PR run hands the pull request to the reviewer, with no wake', () => {
    runEnded({ agentType: 'pr', runId: 601 });
    expect(mockSchedulePrReview).toHaveBeenCalledWith(7, 42, {
      id: 601,
      agent_type: 'pr',
      status: 'completed',
    });
    expect(mockNotifySupervisor).not.toHaveBeenCalled();
  });

  it('a FAILED PR run wakes the orchestrator instead — its call to make', () => {
    runEnded({ agentType: 'pr', runId: 601, status: 'failed' });
    expect(mockSchedulePrReview).not.toHaveBeenCalled();
    expect(mockNotifySupervisor).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'pr-turn-ended',
        status: 'failed',
        payload: expect.stringContaining('start_pr_review'),
      }),
    );
    // Both branches must be named: a failed PR run usually left no pull
    // request at all, and telling the orchestrator only about start_pr_review
    // is what made it block epic 4 rather than restart the stage.
    const payload = mockNotifySupervisor.mock.calls[0]![1].payload as string;
    expect(payload).toContain('resume_ticket');
  });

  it('successful mid-chain hops stay silent; failed ones wake', () => {
    runEnded({ agentType: 'implementation' });
    expect(mockNotifySupervisor).not.toHaveBeenCalled();

    runEnded({ agentType: 'implementation', status: 'failed' });
    expect(mockNotifySupervisor).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'agent-run-failed', status: 'failed' }),
    );
  });

  it('a parked question becomes question-pending with the questions JSON', () => {
    emitTaskEvent('question-parked', {
      taskId: 42,
      conversationId: 100,
      questions: [{ question: 'Which db?' }],
    });
    expect(mockNotifySupervisor).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'question-pending',
        taskId: 42,
        payload: expect.stringContaining('Which db?'),
      }),
    );
  });

  it('workflow-blocked maps by reason: cap → task-blocked, sync → sync-failed', () => {
    emitTaskEvent('workflow-blocked', {
      taskId: 42,
      reason: 'max-iterations',
      detail: 'hit the cap',
    });
    expect(mockNotifySupervisor).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'task-blocked',
        payload: expect.stringContaining('hit the cap'),
      }),
    );

    emitTaskEvent('workflow-blocked', {
      taskId: 42,
      reason: 'base-sync-conflict',
      detail: 'Merging epic/7 failed: conflict',
    });
    expect(mockNotifySupervisor).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'sync-failed',
        payload: 'Merging epic/7 failed: conflict',
      }),
    );
  });

  it("an agent's own block wakes the orchestrator with the reason and a push to verify it", () => {
    emitTaskEvent('workflow-blocked', {
      taskId: 42,
      reason: 'agent-requested',
      detail: 'This session has no Playwright/browser connector, so manual QA cannot run.',
    });

    expect(mockNotifySupervisor).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'task-blocked',
        taskId: 42,
        payload: expect.stringContaining('no Playwright/browser connector'),
      }),
    );
    const payload = mockNotifySupervisor.mock.calls[0]![1].payload as string;
    expect(payload).toContain('Verify this claim');
    expect(payload).toContain('resume_ticket');
  });

  it('chain-start-failed carries the failed agent type and the error', () => {
    emitTaskEvent('chain-start-failed', {
      taskId: 42,
      nextAgentType: 'review',
      error: 'dispatch failed',
    });
    expect(mockNotifySupervisor).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'chain-start-failed',
        agentType: 'review',
        payload: expect.stringContaining('dispatch failed'),
      }),
    );
  });

  it('a merged ticket advances the epic immediately', () => {
    emitTaskEvent('task-merged', { taskId: 42 });
    expect(mockScheduleNextTicket).toHaveBeenCalledWith(7);
  });

  it('a deleted ticket re-evaluates every orchestrating epic', () => {
    mockListOrchestrating.mockReturnValue([{ id: 7 }, { id: 9 }]);
    emitTaskEvent('task-deleted', { taskId: 42 });
    expect(mockScheduleNextTicket).toHaveBeenCalledWith(7);
    expect(mockScheduleNextTicket).toHaveBeenCalledWith(9);
  });
});

describe('epic task-event subscriber — worktree setup', () => {
  it('ignores a setup starting (a retry)', () => {
    emitTaskEvent('worktree-state-changed', { taskId: 42, state: 'provisioning', error: null });

    expect(mockNotifySupervisor).not.toHaveBeenCalled();
    expect(mockScheduleNextTicket).not.toHaveBeenCalled();
  });

  it('wakes the supervising agent that was told to wait, with the outcome', () => {
    mockSupervisedEpicOf.mockReturnValue({ epicId: 7, kind: 'qa-fix' });

    emitTaskEvent('worktree-state-changed', { taskId: 42, state: 'ready', error: null });
    emitTaskEvent('worktree-state-changed', { taskId: 42, state: 'failed', error: 'hook died' });

    expect(mockNotifySupervisor).toHaveBeenNthCalledWith(
      1,
      7,
      expect.objectContaining({ type: 'worktree-setup-ended', taskId: 42, status: 'ready' }),
    );
    expect(mockNotifySupervisor).toHaveBeenNthCalledWith(
      2,
      7,
      expect.objectContaining({
        type: 'worktree-setup-ended',
        status: 'failed',
        payload: expect.stringContaining('hook died'),
      }),
    );
    expect(mockScheduleNextTicket).not.toHaveBeenCalled();
  });

  it('re-advances every orchestrated epic when no agent supervises the ticket yet', () => {
    // The sequencer waits on a ticket still being set up before it starts the
    // orchestrator on it; `advance()` re-reads which epic (if any) it was.
    mockSupervisedEpicOf.mockReturnValue(null);
    mockListOrchestrating.mockReturnValue([{ id: 7 }, { id: 9 }]);

    emitTaskEvent('worktree-state-changed', { taskId: 42, state: 'ready', error: null });

    expect(mockNotifySupervisor).not.toHaveBeenCalled();
    expect(mockScheduleNextTicket).toHaveBeenCalledWith(7);
    expect(mockScheduleNextTicket).toHaveBeenCalledWith(9);
  });
});

describe('epic task-event subscriber — QA fix supervision', () => {
  beforeEach(() => {
    mockSupervisedEpicOf.mockReturnValue({ epicId: 7, kind: 'qa-fix' });
  });

  it('a completed PR run wakes the fix agent to review the PR itself — never the reviewer', () => {
    runEnded({ agentType: 'pr', runId: 601 });
    expect(mockSchedulePrReview).not.toHaveBeenCalled();
    expect(mockNotifySupervisor).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'pr-turn-ended',
        status: 'completed',
        payload: expect.stringContaining('Review it yourself'),
      }),
    );
    const payload = mockNotifySupervisor.mock.calls[0]![1].payload as string;
    expect(payload).toContain('merge_task');
  });

  it('a FAILED PR run tells the fix agent to review or restart — never block_epic', () => {
    runEnded({ agentType: 'pr', runId: 601, status: 'failed' });
    expect(mockNotifySupervisor).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'pr-turn-ended', status: 'failed' }),
    );
    const payload = mockNotifySupervisor.mock.calls[0]![1].payload as string;
    expect(payload).toContain('merge_task');
    expect(payload).toContain('resume_ticket');
    expect(payload).not.toContain('block_epic');
  });

  it('a merged fix ticket triggers no sequencing hop', () => {
    emitTaskEvent('task-merged', { taskId: 42 });
    expect(mockScheduleNextTicket).not.toHaveBeenCalled();
    expect(mockNotifySupervisor).not.toHaveBeenCalled();
  });

  it('planification, questions and failures route to the fix agent like any supervisor', () => {
    runEnded({ status: 'completed' });
    expect(mockNotifySupervisor).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'planification-turn-ended' }),
    );

    emitTaskEvent('question-parked', { taskId: 42, conversationId: 100, questions: [] });
    expect(mockNotifySupervisor).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'question-pending' }),
    );

    runEnded({ agentType: 'review', status: 'failed' });
    expect(mockNotifySupervisor).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'agent-run-failed' }),
    );
  });
});
