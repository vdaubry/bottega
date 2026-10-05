import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockEpicGetById,
  mockRunsGetByEpic,
  mockRunsGetById,
  mockTasksGetById,
  mockTicketEpicOf,
  mockSendMessage,
  mockBlockOrchestration,
  mockBlockQaFixSupervision,
  mockScheduleNextTicket,
  activeSessions,
} = vi.hoisted(() => ({
  mockEpicGetById: vi.fn(),
  mockRunsGetByEpic: vi.fn(),
  mockRunsGetById: vi.fn(),
  mockTasksGetById: vi.fn(),
  mockTicketEpicOf: vi.fn(),
  mockSendMessage: vi.fn(),
  mockBlockOrchestration: vi.fn(),
  mockBlockQaFixSupervision: vi.fn(),
  mockScheduleNextTicket: vi.fn(),
  activeSessions: new Map<string, unknown>(),
}));

vi.mock('../../../database/epics.js', () => ({
  epicAgentRunsDb: { getByEpic: mockRunsGetByEpic, getById: mockRunsGetById },
  epicsDb: { getById: mockEpicGetById },
  epicTicketsDb: { epicOf: mockTicketEpicOf },
}));

vi.mock('../../conversation/sessionState.js', () => ({ activeSessions }));

vi.mock('./blocking.js', () => ({
  blockOrchestration: mockBlockOrchestration,
  blockQaFixSupervision: mockBlockQaFixSupervision,
}));

vi.mock('../../conversation/startConversation.js', () => ({ sendMessage: mockSendMessage }));

vi.mock('./sequencing.js', () => ({ scheduleNextTicket: mockScheduleNextTicket }));

// The flags line reads task state through the task facade; map it onto the
// same task fixture the old direct read used.
vi.mock('../../tasks/index.js', () => ({
  taskFlags: (taskId: number) => {
    const task = mockTasksGetById(taskId) as Record<string, unknown> | undefined;
    if (!task) return null;
    return {
      status: task.status,
      planificationComplete: !!task.planification_complete,
      workflowComplete: !!task.workflow_complete,
      workflowBlocked: !!task.workflow_blocked,
      refinementComplete: !!task.refinement_complete,
      prAgentComplete: !!task.pr_agent_complete,
      runCount: task.workflow_run_count,
    };
  },
}));

import {
  EVENT_CAPS,
  MAX_WAKES,
  _resetBridgeState,
  currentOrchestratorRun,
  currentQaFixRun,
  flush,
  isOrchestratedTask,
  notifyOrchestrator,
  notifySupervisor,
  resolveSupervisor,
  supervisedEpicOf,
  onOrchestratorTurnEnded,
  onPrReviewTurnEnded,
  renderEventMessage,
  resetBridgeCounters,
} from './bridge.js';

const ORCHESTRATING = {
  id: 7,
  user_id: 4,
  orchestration_active: 1,
  orchestration_blocked: 0,
};

const RUN = {
  id: 55,
  agent_type: 'epic-orchestrator',
  conversation_id: 91,
  ticket_task_id: 42,
};

/**
 * Wait out the fire-and-forget `void flush(...)` inside notifyOrchestrator.
 * It awaits a dynamic import before it sends, so one microtask is not enough —
 * and a flush that leaked past its test would show up as a stray send in the
 * next one.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/** Wait until exactly `count` resumes have been issued, or fail loudly. */
async function waitForSends(count: number): Promise<void> {
  await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(count), {
    timeout: 2000,
    interval: 5,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetBridgeState();
  activeSessions.clear();
  mockEpicGetById.mockReturnValue({ ...ORCHESTRATING });
  mockRunsGetByEpic.mockReturnValue([{ ...RUN }]);
  mockTasksGetById.mockReturnValue(null);
  mockSendMessage.mockResolvedValue(undefined);
});

function sentMessage(call = 0): string {
  return mockSendMessage.mock.calls[call]![1] as string;
}

describe('the orchestrated-task rule', () => {
  it('is null for a task with no epic', () => {
    mockTicketEpicOf.mockReturnValue(null);

    expect(isOrchestratedTask(42)).toBeNull();
  });

  it('is null while the epic is not under orchestration', () => {
    mockTicketEpicOf.mockReturnValue(7);
    mockTasksGetById.mockReturnValue({ id: 42 });
    mockEpicGetById.mockReturnValue({ ...ORCHESTRATING, orchestration_active: 0 });

    expect(isOrchestratedTask(42)).toBeNull();
  });

  it('is the epic id once orchestration is on', () => {
    mockTicketEpicOf.mockReturnValue(7);
    mockTasksGetById.mockReturnValue({ id: 42 });

    expect(isOrchestratedTask(42)).toBe(7);
  });
});

describe('currentOrchestratorRun', () => {
  it('takes the newest orchestrator run that has a conversation', () => {
    mockRunsGetByEpic.mockReturnValue([
      { id: 10, agent_type: 'epic-orchestrator', conversation_id: 80 },
      { id: 12, agent_type: 'epic-orchestrator', conversation_id: 82 },
      { id: 14, agent_type: 'epic-stories', conversation_id: 84 },
      { id: 13, agent_type: 'epic-orchestrator', conversation_id: null },
    ]);

    expect(currentOrchestratorRun(7)?.id).toBe(12);
  });
});

describe('waking the orchestrator', () => {
  it('resumes its conversation with the rendered event', async () => {
    notifyOrchestrator(7, { type: 'pr-turn-ended', taskId: 42, runId: 9, status: 'completed' });
    await waitForSends(1);

    expect(mockSendMessage.mock.calls[0]![0]).toBe(91);
    expect(sentMessage()).toContain('[bottega-event] type=pr-turn-ended task=42 run=9');
    expect(sentMessage()).toMatch(/end your turn/i);
  });

  it('carries the ticket flags, read fresh at send time', async () => {
    mockTasksGetById.mockReturnValue({
      id: 42,
      epic_id: 7,
      status: 'in_review',
      planification_complete: 1,
      workflow_complete: 1,
      workflow_blocked: 0,
      pr_agent_complete: 1,
      workflow_run_count: 6,
    });

    notifyOrchestrator(7, { type: 'pr-turn-ended', taskId: 42 });
    await waitForSends(1);

    expect(sentMessage()).toContain('status=in_review');
    expect(sentMessage()).toContain('planificationComplete=true');
    expect(sentMessage()).toContain('prAgentComplete=true');
  });

  it('stays silent for an epic that is not orchestrated', async () => {
    mockEpicGetById.mockReturnValue({ ...ORCHESTRATING, orchestration_active: 0 });

    notifyOrchestrator(7, { type: 'pr-turn-ended', taskId: 42 });
    await settle();

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('stays silent while the epic is blocked — that is what pausing means', async () => {
    mockEpicGetById.mockReturnValue({ ...ORCHESTRATING, orchestration_blocked: 1 });

    notifyOrchestrator(7, { type: 'task-blocked', taskId: 42 });
    await settle();

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('stays silent when no orchestrator conversation exists yet', async () => {
    mockRunsGetByEpic.mockReturnValue([]);

    notifyOrchestrator(7, { type: 'pr-turn-ended', taskId: 42 });
    await settle();

    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

describe('queueing while it is mid-turn', () => {
  beforeEach(() => {
    activeSessions.set('sess-1', { conversationId: 91, status: 'active' });
  });

  it('holds events instead of forking the session', async () => {
    notifyOrchestrator(7, { type: 'agent-run-failed', taskId: 42, runId: 1 });
    await settle();

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('delivers everything queued as ONE message when the turn ends', async () => {
    notifyOrchestrator(7, { type: 'agent-run-failed', taskId: 42, runId: 1 });
    notifyOrchestrator(7, { type: 'task-blocked', taskId: 42 });
    await settle();

    activeSessions.clear();
    await flush(7);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(sentMessage()).toContain('type=agent-run-failed');
    expect(sentMessage()).toContain('type=task-blocked');
  });

  it('collapses the same news arriving twice', async () => {
    notifyOrchestrator(7, { type: 'agent-run-failed', taskId: 42, runId: 1 });
    notifyOrchestrator(7, { type: 'agent-run-failed', taskId: 42, runId: 1 });
    await settle();

    activeSessions.clear();
    await flush(7);

    expect(sentMessage().match(/type=agent-run-failed/g)).toHaveLength(1);
  });

  it('keeps events that differ only by run id', async () => {
    notifyOrchestrator(7, { type: 'agent-run-failed', taskId: 42, runId: 1 });
    notifyOrchestrator(7, { type: 'agent-run-failed', taskId: 42, runId: 2 });
    await settle();

    activeSessions.clear();
    await flush(7);

    expect(sentMessage().match(/type=agent-run-failed/g)).toHaveLength(2);
  });

  it('puts events back when the resume itself fails', async () => {
    activeSessions.clear();
    mockSendMessage.mockRejectedValueOnce(new Error('socket died'));

    notifyOrchestrator(7, { type: 'pr-turn-ended', taskId: 42, runId: 3 });
    await waitForSends(1);

    mockSendMessage.mockResolvedValue(undefined);
    await flush(7);

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(sentMessage(1)).toContain('type=pr-turn-ended');
  });
});

describe('runaway guards', () => {
  it('blocks the epic when one event type keeps repeating', async () => {
    const cap = EVENT_CAPS['question-pending']!;
    for (let i = 0; i <= cap; i++) {
      notifyOrchestrator(7, { type: 'question-pending', taskId: 42, runId: i });
      await settle();
    }

    expect(mockBlockOrchestration).toHaveBeenCalledWith(
      7,
      expect.stringMatching(/going in circles/),
      expect.anything(),
    );
  });

  it('blocks the epic after too many wakes on one ticket', async () => {
    for (let i = 0; i < MAX_WAKES + 1; i++) {
      notifyOrchestrator(7, { type: 'agent-run-failed', taskId: 42, runId: i });
      await settle();
    }

    expect(mockBlockOrchestration).toHaveBeenCalledWith(
      7,
      expect.stringMatching(/woken \d+ times/),
      expect.anything(),
    );
  });

  it('starts the counters clean on a new ticket conversation', async () => {
    for (let i = 0; i < MAX_WAKES; i++) {
      notifyOrchestrator(7, { type: 'agent-run-failed', taskId: 42, runId: i });
      await settle();
    }
    mockSendMessage.mockClear();

    // The sequencer hopped to the next ticket: new run, new conversation.
    mockRunsGetByEpic.mockReturnValue([
      { ...RUN, id: 56, conversation_id: 92, ticket_task_id: 43 },
    ]);

    notifyOrchestrator(7, { type: 'agent-run-failed', taskId: 43, runId: 999 });
    await waitForSends(1);

    expect(mockSendMessage.mock.calls[0]![0]).toBe(92);
  });

  it('forgets the counters when the user resumes', async () => {
    for (let i = 0; i < MAX_WAKES; i++) {
      notifyOrchestrator(7, { type: 'agent-run-failed', taskId: 42, runId: i });
      await settle();
    }
    mockSendMessage.mockClear();
    resetBridgeCounters(7);

    notifyOrchestrator(7, { type: 'agent-run-failed', taskId: 42, runId: 999 });
    await waitForSends(1);
  });
});

describe('the orchestrator own turn ending', () => {
  it('drains news that arrives during a bridge-started wake turn', async () => {
    mockSendMessage.mockImplementationOnce(async () => {
      notifyOrchestrator(7, { type: 'task-blocked', taskId: 42 });
      await onOrchestratorTurnEnded(7);
    });

    notifyOrchestrator(7, { type: 'pr-turn-ended', taskId: 42, runId: 9 });
    await waitForSends(2);

    expect(sentMessage(0)).toContain('type=pr-turn-ended');
    expect(sentMessage(1)).toContain('type=task-blocked');
  });

  it('drains the queue and then lets the sequencer decide', async () => {
    activeSessions.set('sess-1', { conversationId: 91, status: 'active' });
    notifyOrchestrator(7, { type: 'agent-run-failed', taskId: 42, runId: 1 });
    await settle();
    activeSessions.clear();

    await onOrchestratorTurnEnded(7);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockScheduleNextTicket).toHaveBeenCalledWith(7);
  });

  it('still runs the sequencer when there is nothing queued', async () => {
    await onOrchestratorTurnEnded(7);

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockScheduleNextTicket).toHaveBeenCalledWith(7);
  });
});

describe('a PR reviewer turn ending', () => {
  const REVIEW = { id: 88, agent_type: 'epic-pr-review', ticket_task_id: 42 };

  it('hops to the next ticket once the reviewer merged, without waking the orchestrator', async () => {
    mockTasksGetById.mockReturnValue({ id: 42, epic_id: 7, status: 'completed' });

    await onPrReviewTurnEnded(7, REVIEW);
    await settle();

    expect(mockScheduleNextTicket).toHaveBeenCalledWith(7);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('wakes the orchestrator with the run final status when the ticket is still open', async () => {
    mockTasksGetById.mockReturnValue({ id: 42, epic_id: 7, status: 'in_review' });
    mockRunsGetById.mockReturnValue({ ...REVIEW, status: 'failed' });

    await onPrReviewTurnEnded(7, REVIEW);
    await waitForSends(1);

    expect(mockScheduleNextTicket).not.toHaveBeenCalled();
    expect(sentMessage(0)).toContain('[bottega-event] type=pr-review-ended task=42 agent=epic-pr-review run=88 status=failed');
    expect(sentMessage(0)).toContain('start_pr_review');
  });

  it('is dropped when the reviewer blocked the epic itself', async () => {
    mockTasksGetById.mockReturnValue({ id: 42, epic_id: 7, status: 'in_review' });
    mockRunsGetById.mockReturnValue({ ...REVIEW, status: 'completed' });
    mockEpicGetById.mockReturnValue({ ...ORCHESTRATING, orchestration_blocked: 1 });

    await onPrReviewTurnEnded(7, REVIEW);
    await settle();

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockScheduleNextTicket).not.toHaveBeenCalled();
  });

  it('is capped like the other per-ticket events', () => {
    expect(EVENT_CAPS['pr-review-ended']).toBe(3);
  });
});

describe('renderEventMessage', () => {
  it('separates batched events and closes with one instruction', () => {
    const message = renderEventMessage([
      { type: 'planification-turn-ended', taskId: 42 },
      { type: 'sync-failed', taskId: 43, payload: 'CONFLICT in src/lib/pricing.ts' },
    ]);

    expect(message.split('---')).toHaveLength(2);
    expect(message).toContain('CONFLICT in src/lib/pricing.ts');
    expect(message.match(/Decide your next action/g)).toHaveLength(1);
  });
});

describe('QA fix supervision', () => {
  const QA_FIX_RUN = {
    id: 70,
    agent_type: 'epic-qa-fix',
    status: 'completed',
    conversation_id: 95,
    ticket_task_id: 42,
  };
  const IDLE_EPIC = { ...ORCHESTRATING, orchestration_active: 0 };

  beforeEach(() => {
    mockEpicGetById.mockReturnValue({ ...IDLE_EPIC });
    mockRunsGetByEpic.mockReturnValue([{ ...QA_FIX_RUN }]);
    mockTicketEpicOf.mockReturnValue(7);
  });

  it('currentQaFixRun takes the newest fix run that has a conversation', () => {
    mockRunsGetByEpic.mockReturnValue([
      { id: 60, agent_type: 'epic-qa-fix', conversation_id: 90 },
      { id: 62, agent_type: 'epic-qa-fix', conversation_id: 92 },
      { id: 63, agent_type: 'epic-qa-fix', conversation_id: null },
      { id: 64, agent_type: 'epic-orchestrator', conversation_id: 93 },
    ]);

    expect(currentQaFixRun(7)?.id).toBe(62);
  });

  it('supervisedEpicOf routes ONLY the stamped ticket to the fix run', () => {
    expect(supervisedEpicOf(42)).toEqual({ epicId: 7, kind: 'qa-fix' });
    // Another task of the same epic never wakes the fix agent.
    mockRunsGetByEpic.mockReturnValue([{ ...QA_FIX_RUN, ticket_task_id: 41 }]);
    expect(supervisedEpicOf(42)).toBeNull();
  });

  it('orchestration wins over a newer fix run, outright', () => {
    mockEpicGetById.mockReturnValue({ ...ORCHESTRATING });
    mockRunsGetByEpic.mockReturnValue([
      { ...RUN },
      { ...QA_FIX_RUN, id: 99 },
    ]);
    mockTasksGetById.mockReturnValue({ id: 42 });

    expect(supervisedEpicOf(42)).toEqual({ epicId: 7, kind: 'orchestrator' });
    expect(resolveSupervisor(7)?.kind).toBe('orchestrator');
  });

  it('wakes the fix conversation with the same rendered event', async () => {
    notifySupervisor(7, { type: 'pr-turn-ended', taskId: 42, runId: 9, status: 'completed' });
    await waitForSends(1);

    expect(mockSendMessage.mock.calls[0]![0]).toBe(95);
    expect(sentMessage()).toContain('[bottega-event] type=pr-turn-ended task=42 run=9');
  });

  it('drops wakes while the fix run is blocked — a Stop means stopped', async () => {
    mockRunsGetByEpic.mockReturnValue([{ ...QA_FIX_RUN, status: 'blocked' }]);

    notifySupervisor(7, { type: 'question-pending', taskId: 42 });
    await settle();

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('a runaway counter blocks the RUN, never the orchestration flags', async () => {
    const cap = EVENT_CAPS['question-pending']!;
    for (let i = 0; i <= cap; i++) {
      notifySupervisor(7, { type: 'question-pending', taskId: 42, runId: i });
    }
    await settle();

    expect(mockBlockQaFixSupervision).toHaveBeenCalledWith(
      7,
      70,
      expect.stringContaining('question-pending'),
      expect.anything(),
    );
    expect(mockBlockOrchestration).not.toHaveBeenCalled();
  });
});
