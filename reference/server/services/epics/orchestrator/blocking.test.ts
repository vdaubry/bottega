import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockEpicGetById,
  mockEpicGetWithProject,
  mockSetBlocked,
  mockRunUpdateStatus,
  mockResetBridgeCounters,
  mockBroadcastEpicUpdated,
} = vi.hoisted(() => ({
  mockEpicGetById: vi.fn(),
  mockEpicGetWithProject: vi.fn(),
  mockSetBlocked: vi.fn(),
  mockRunUpdateStatus: vi.fn(),
  mockResetBridgeCounters: vi.fn(),
  mockBroadcastEpicUpdated: vi.fn(),
}));

vi.mock('../../../database/epics.js', () => ({
  epicsDb: {
    getById: mockEpicGetById,
    getWithProject: mockEpicGetWithProject,
    setOrchestrationBlocked: mockSetBlocked,
  },
  epicAgentRunsDb: { updateStatus: mockRunUpdateStatus },
}));

vi.mock('./bridge.js', () => ({ resetBridgeCounters: mockResetBridgeCounters }));

vi.mock('../epicEvents.js', () => ({ broadcastEpicUpdated: mockBroadcastEpicUpdated }));

import { blockQaFixSupervision, resumeOrchestration } from './blocking.js';

const BLOCKED = {
  id: 7,
  user_id: 4,
  orchestration_active: 1,
  orchestration_blocked: 1,
  orchestration_blocked_reason: 'Ticket #42 is stuck at the pull-request step.',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resumeOrchestration', () => {
  it('clears the block, resets the bridge counters and broadcasts', () => {
    const unblocked = { ...BLOCKED, orchestration_blocked: 0, orchestration_blocked_reason: null };
    mockEpicGetById.mockReturnValue(BLOCKED);
    mockSetBlocked.mockReturnValue(unblocked);

    const result = resumeOrchestration(7, { broadcastToEpicSubscribersFn: undefined });

    expect(mockSetBlocked).toHaveBeenCalledWith(7, false);
    expect(mockResetBridgeCounters).toHaveBeenCalledWith(7);
    expect(mockBroadcastEpicUpdated).toHaveBeenCalledWith(undefined, unblocked);
    expect(result).toBe(unblocked);
  });

  it('no-ops on an epic that is not blocked', () => {
    mockEpicGetById.mockReturnValue({ ...BLOCKED, orchestration_blocked: 0 });

    expect(resumeOrchestration(7)).toBeNull();
    expect(mockSetBlocked).not.toHaveBeenCalled();
    expect(mockResetBridgeCounters).not.toHaveBeenCalled();
  });

  it('no-ops on an epic that is not under orchestration at all', () => {
    mockEpicGetById.mockReturnValue({ ...BLOCKED, orchestration_active: 0 });

    expect(resumeOrchestration(7)).toBeNull();
    expect(mockSetBlocked).not.toHaveBeenCalled();
  });

  it('no-ops on an epic that no longer exists', () => {
    mockEpicGetById.mockReturnValue(undefined);

    expect(resumeOrchestration(7)).toBeNull();
    expect(mockSetBlocked).not.toHaveBeenCalled();
  });
});

describe('blockQaFixSupervision', () => {
  it('blocks the RUN row and broadcasts — the orchestration flags stay untouched', () => {
    const blockedRun = {
      id: 70,
      agent_type: 'epic-qa-fix',
      status: 'blocked',
      conversation_id: 95,
    };
    mockRunUpdateStatus.mockReturnValue(blockedRun);
    mockEpicGetWithProject.mockReturnValue({ id: 7, name: 'Nimbus', user_id: null, project_id: 3 });
    const broadcast = vi.fn();

    const result = blockQaFixSupervision(7, 70, 'going in circles', {
      broadcastToEpicSubscribersFn: broadcast,
    });

    expect(mockRunUpdateStatus).toHaveBeenCalledWith(70, 'blocked');
    expect(mockSetBlocked).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        type: 'agent-run-updated',
        agentRun: expect.objectContaining({ id: 70, status: 'blocked' }),
      }),
    );
    expect(result).toBe(blockedRun);
  });

  it('no-ops when the run is gone', () => {
    mockRunUpdateStatus.mockReturnValue(undefined);

    expect(blockQaFixSupervision(7, 70, 'x')).toBeNull();
  });
});
