import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../database/epics.js', () => ({
  epicsDb: { getById: vi.fn(), getWithProject: vi.fn() },
  epicAgentRunsDb: {
    getByConversationId: vi.fn(),
    getByEpic: vi.fn().mockReturnValue([]),
    getByStatus: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    interruptConversation: vi.fn(),
    beginConversationTurn: vi.fn(),
  },
  epicTicketsDb: { epicOf: vi.fn() },
}));

vi.mock('../worktree.js', () => ({
  worktreeExists: vi.fn().mockResolvedValue(true),
  getWorktreeProjectPath: vi.fn().mockReturnValue('/repo-worktrees/task-42'),
}));

vi.mock('../tasks/index.js', () => ({
  getTask: vi.fn(),
}));

vi.mock('./epicBranch.js', () => ({
  ensureEpicDeliveryWorktree: vi.fn().mockResolvedValue('/repo-worktrees/epic-7'),
}));

vi.mock('./bottegaInjection.js', () => ({ withBottegaMcpServer: vi.fn((s) => s) }));
vi.mock('./epicDocsWriteGate.js', () => ({
  epicDocsWriteGateForConversation: vi.fn().mockReturnValue(null),
  epicDisallowedToolsForConversation: vi.fn().mockReturnValue([]),
}));

vi.mock('./orchestrator/bridge.js', () => ({
  onOrchestratorTurnEnded: vi.fn().mockResolvedValue(undefined),
  onPrReviewTurnEnded: vi.fn().mockResolvedValue(undefined),
  flush: vi.fn().mockResolvedValue(undefined),
  currentOrchestratorRun: vi.fn(),
  getBridgeBroadcasters: vi.fn(() => ({ broadcastToEpicSubscribersFn: vi.fn() })),
  resetBridgeCounters: vi.fn(),
}));

vi.mock('../notifications.js', () => ({
  sendBannerNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./qaLoop.js', () => ({
  onQaExecutionTurnEnded: vi.fn(),
  resetQaLoopState: vi.fn(),
}));

import { epicOwnerAdapter } from './adapter.js';
import { epicsDb, epicAgentRunsDb, epicTicketsDb } from '../../database/epics.js';
import { getTask } from '../tasks/index.js';
import { ensureEpicDeliveryWorktree } from './epicBranch.js';
import { worktreeExists } from '../worktree.js';
import {
  flush,
  onOrchestratorTurnEnded,
  onPrReviewTurnEnded,
  currentOrchestratorRun,
  getBridgeBroadcasters,
  resetBridgeCounters,
} from './orchestrator/bridge.js';
import { sendBannerNotification } from '../notifications.js';
import { onQaExecutionTurnEnded } from './qaLoop.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(epicAgentRunsDb.getByEpic).mockReturnValue([]);
});

function epicCtx(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 5,
    taskId: null,
    epicId: 42,
    claudeSessionId: 'sess-5',
    userId: 1,
    isNewSession: false,
    broadcastToEpicSubscribersFn: vi.fn(),
    ...overrides,
  } as never;
}

const epicRun = {
  id: 9,
  epic_id: 42,
  agent_type: 'epic-architecture',
  status: 'running',
  conversation_id: 5,
};

describe('epic adapter onTurnEnded', () => {
  it('completes the run and broadcasts on the epic channel', async () => {
    vi.mocked(epicAgentRunsDb.getByConversationId).mockReturnValue(epicRun as never);
    const ctx = epicCtx();

    await epicOwnerAdapter.onTurnEnded(ctx);

    expect(epicAgentRunsDb.updateStatus).toHaveBeenCalledWith(9, 'completed');
    expect(
      (ctx as unknown as { broadcastToEpicSubscribersFn: ReturnType<typeof vi.fn> })
        .broadcastToEpicSubscribersFn,
    ).toHaveBeenCalledWith(42, {
      type: 'agent-run-updated',
      agentRun: {
        id: 9,
        status: 'completed',
        agent_type: 'epic-architecture',
        conversation_id: 5,
      },
    });
  });

  it('leaves an already-completed run untouched on a follow-up turn', async () => {
    vi.mocked(epicAgentRunsDb.getByConversationId).mockReturnValue({
      ...epicRun,
      status: 'completed',
    } as never);

    await epicOwnerAdapter.onTurnEnded(epicCtx());

    expect(epicAgentRunsDb.updateStatus).not.toHaveBeenCalled();
  });

  it('leaves a user-blocked run inert and schedules no replacement', async () => {
    vi.mocked(epicAgentRunsDb.getByConversationId).mockReturnValue({
      ...epicRun,
      agent_type: 'epic-pr-review',
      status: 'blocked',
    } as never);

    await epicOwnerAdapter.onTurnEnded(epicCtx());

    expect(epicAgentRunsDb.updateStatus).not.toHaveBeenCalled();
    expect(onPrReviewTurnEnded).not.toHaveBeenCalled();
    expect(onOrchestratorTurnEnded).not.toHaveBeenCalled();
  });

  it('drains and sequences when the orchestrator own turn ends', async () => {
    vi.mocked(epicAgentRunsDb.getByConversationId).mockReturnValue({
      ...epicRun,
      agent_type: 'epic-orchestrator',
    } as never);

    await epicOwnerAdapter.onTurnEnded(epicCtx({ epicId: 7 }));

    expect(onOrchestratorTurnEnded).toHaveBeenCalledWith(7);
  });

  it('routes a PR reviewer turn end to its own hook, never the orchestrator one', async () => {
    const reviewer = {
      ...epicRun,
      id: 8,
      agent_type: 'epic-pr-review',
      ticket_task_id: 42,
      conversation_id: 100,
    };
    vi.mocked(epicAgentRunsDb.getByConversationId).mockReturnValue(reviewer as never);

    await epicOwnerAdapter.onTurnEnded(epicCtx({ epicId: 7, conversationId: 100 }));

    expect(onPrReviewTurnEnded).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ id: 8, agent_type: 'epic-pr-review', ticket_task_id: 42 }),
    );
    expect(onOrchestratorTurnEnded).not.toHaveBeenCalled();
  });

  it('hands a normally-ended QA execution turn to the continuation loop', async () => {
    vi.mocked(epicAgentRunsDb.getByConversationId).mockReturnValue({
      ...epicRun,
      agent_type: 'epic-qa-execution',
    } as never);

    await epicOwnerAdapter.onTurnEnded(epicCtx({ epicId: 7 }));

    expect(epicAgentRunsDb.updateStatus).toHaveBeenCalledWith(9, 'completed');
    expect(onQaExecutionTurnEnded).toHaveBeenCalledWith(7);
  });

  it('never continues QA after a failed run', async () => {
    vi.mocked(epicAgentRunsDb.getByConversationId).mockReturnValue({
      ...epicRun,
      agent_type: 'epic-qa-execution',
      status: 'failed',
    } as never);

    await epicOwnerAdapter.onTurnEnded(epicCtx());

    expect(onQaExecutionTurnEnded).not.toHaveBeenCalled();
  });

  it('never continues QA after a user Stop', async () => {
    vi.mocked(epicAgentRunsDb.getByConversationId).mockReturnValue({
      ...epicRun,
      agent_type: 'epic-qa-execution',
      status: 'blocked',
    } as never);

    await epicOwnerAdapter.onTurnEnded(epicCtx());

    expect(onQaExecutionTurnEnded).not.toHaveBeenCalled();
  });

  it('flushes the bridge when a QA fix turn ends — and never sequences', async () => {
    vi.mocked(epicAgentRunsDb.getByConversationId).mockReturnValue({
      ...epicRun,
      agent_type: 'epic-qa-fix',
    } as never);

    await epicOwnerAdapter.onTurnEnded(epicCtx({ epicId: 7 }));

    expect(epicAgentRunsDb.updateStatus).toHaveBeenCalledWith(9, 'completed');
    expect(flush).toHaveBeenCalledWith(7);
    expect(onOrchestratorTurnEnded).not.toHaveBeenCalled();
    expect(onPrReviewTurnEnded).not.toHaveBeenCalled();
  });
});

describe('epic adapter interruption lifecycle', () => {
  it('refuses to reopen an old reviewer while another reviewer owns the epic', () => {
    const oldReviewer = {
      ...epicRun,
      id: 8,
      agent_type: 'epic-pr-review',
      status: 'completed',
    };
    vi.mocked(epicAgentRunsDb.getByConversationId).mockReturnValue(oldReviewer as never);
    vi.mocked(epicAgentRunsDb.getByEpic).mockReturnValue([
      oldReviewer,
      {
        ...oldReviewer,
        id: 9,
        status: 'blocked',
        conversation_id: 99,
      },
    ] as never);

    expect(() => epicOwnerAdapter.assertTurnCanStart(5)).toThrow(
      /already has an active PR reviewer.*run 9/i,
    );
  });

  it('blocks the exact linked run before Stop and broadcasts the durable state', async () => {
    const linked = {
      ...epicRun,
      agent_type: 'epic-pr-review',
      status: 'running',
    };
    const blocked = { ...linked, status: 'blocked' };
    const updatedEpic = {
      id: 42,
      orchestration_active: 1,
      orchestration_blocked: 1,
    };
    const broadcast = vi.fn();
    vi.mocked(epicAgentRunsDb.getByConversationId).mockReturnValue(linked as never);
    vi.mocked(epicAgentRunsDb.interruptConversation).mockReturnValue({
      run: blocked,
      epic: updatedEpic,
    } as never);
    vi.mocked(getBridgeBroadcasters).mockReturnValue({
      broadcastToEpicSubscribersFn: broadcast,
    });

    await expect(epicOwnerAdapter.interruptLinkedRun(5)).resolves.toMatchObject({
      id: 9,
      status: 'blocked',
    });

    expect(epicAgentRunsDb.interruptConversation).toHaveBeenCalledWith(
      5,
      expect.stringContaining('conversation 5'),
    );
    expect(broadcast).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: 'agent-run-updated',
        agentRun: expect.objectContaining({ id: 9, status: 'blocked' }),
      }),
    );
    expect(broadcast).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ type: 'epic-updated' }),
    );
  });

  it('marks a resumed turn running and releases only its manual block', async () => {
    const running = { ...epicRun, agent_type: 'epic-orchestrator', status: 'running' };
    vi.mocked(epicAgentRunsDb.beginConversationTurn).mockReturnValue({
      run: running,
      epic: {
        id: 42,
        orchestration_active: 1,
        orchestration_blocked: 0,
      },
      resumed: true,
    } as never);
    const ctx = epicCtx();

    await epicOwnerAdapter.onTurnStarted(ctx);

    expect(epicAgentRunsDb.beginConversationTurn).toHaveBeenCalledWith(5);
    expect(resetBridgeCounters).toHaveBeenCalledWith(42);
    expect(
      (ctx as unknown as { broadcastToEpicSubscribersFn: ReturnType<typeof vi.fn> })
        .broadcastToEpicSubscribersFn,
    ).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: 'agent-run-updated',
        agentRun: expect.objectContaining({ id: 9, status: 'running' }),
      }),
    );
  });
});

describe('epic adapter onQuestionParked', () => {
  const conversation = { id: 5, task_id: null, epic_id: 42, owner_kind: 'epic' } as never;

  it("pushes to the user when the ORCHESTRATOR's own conversation asks", async () => {
    vi.mocked(currentOrchestratorRun).mockReturnValue({ conversation_id: 5 } as never);
    vi.mocked(epicsDb.getWithProject).mockReturnValue({
      id: 42,
      name: 'Nimbus',
      user_id: 4,
      project_id: 3,
    } as never);

    await epicOwnerAdapter.onQuestionParked(conversation, []);

    expect(sendBannerNotification).toHaveBeenCalledWith(
      4,
      'The epic orchestrator needs you',
      expect.stringContaining('Nimbus'),
      expect.objectContaining({ type: 'epic_question' }),
    );
  });

  it('stays silent for any other epic conversation', async () => {
    vi.mocked(currentOrchestratorRun).mockReturnValue({ conversation_id: 99 } as never);

    await epicOwnerAdapter.onQuestionParked(conversation, []);

    expect(sendBannerNotification).not.toHaveBeenCalled();
  });
});

describe('epic adapter scope + sweep', () => {
  it("resolves the main checkout, or the reviewer's ticket worktree", async () => {
    vi.mocked(epicsDb.getWithProject).mockReturnValue({
      id: 42,
      project_id: 3,
      repo_folder_path: '/repo',
      subproject_path: null,
    } as never);

    const plain = await epicOwnerAdapter.resolveScope({ kind: 'epic', epicId: 42 });
    expect(plain.cwd).toBe('/repo');

    vi.mocked(getTask).mockReturnValue({
      id: 77,
      repo_folder_path: '/repo',
      subproject_path: null,
    } as never);
    vi.mocked(epicTicketsDb.epicOf).mockReturnValue(42);

    const reviewer = await epicOwnerAdapter.resolveScope({
      kind: 'epic',
      epicId: 42,
      worktreeTaskId: 77,
    });
    expect(reviewer.cwd).toBe('/repo-worktrees/task-42');
  });

  it("refuses another epic's ticket as the reviewer's worktree", async () => {
    vi.mocked(epicsDb.getWithProject).mockReturnValue({
      id: 42,
      project_id: 3,
      repo_folder_path: '/repo',
      subproject_path: null,
    } as never);
    vi.mocked(getTask).mockReturnValue({ id: 77, repo_folder_path: '/repo' } as never);
    vi.mocked(epicTicketsDb.epicOf).mockReturnValue(9);

    await expect(
      epicOwnerAdapter.resolveScope({ kind: 'epic', epicId: 42, worktreeTaskId: 77 }),
    ).rejects.toThrow(/not a ticket of epic 42/);
  });

  it('sweepOrphans fails running epic runs', () => {
    vi.mocked(epicAgentRunsDb.getByStatus).mockReturnValue([
      {
        id: 8,
        epic_id: 42,
        agent_type: 'epic-pr-review',
        status: 'running',
        ticket_task_id: 77,
        conversation_id: 91,
      },
    ] as never);

    epicOwnerAdapter.sweepOrphans();

    expect(epicAgentRunsDb.updateStatus).toHaveBeenCalledWith(8, 'failed');
  });

  it('allows every connected provider for epic conversations', () => {
    expect(() => epicOwnerAdapter.assertProviderAllowed('openai')).not.toThrow();
    expect(() => epicOwnerAdapter.assertProviderAllowed('opencode')).not.toThrow();
    expect(() => epicOwnerAdapter.assertProviderAllowed('anthropic')).not.toThrow();
  });
});


describe('epicOwnerAdapter.resolveScope', () => {
  const EPIC = {
    id: 7,
    project_id: 3,
    repo_folder_path: '/repo',
    subproject_path: null,
  };

  beforeEach(() => {
    vi.mocked(epicsDb.getWithProject).mockReturnValue(EPIC as never);
  });

  // Framing stages read the repository; they never change it, so the main
  // checkout is the right cwd and there is no worktree to make.
  it('runs a framing conversation in the project main checkout', async () => {
    const scope = await epicOwnerAdapter.resolveScope({ kind: 'epic', epicId: 7 });

    expect(scope.cwd).toBe('/repo');
    expect(ensureEpicDeliveryWorktree).not.toHaveBeenCalled();
  });

  // Delivery changes the feature branch, so it needs a checkout of it — never
  // the main checkout, whose HEAD a person (and the running service) depends on.
  it('runs a delivery conversation in the epic delivery worktree', async () => {
    const scope = await epicOwnerAdapter.resolveScope({
      kind: 'epic',
      epicId: 7,
      deliveryWorktree: true,
    });

    expect(scope.cwd).toBe('/repo-worktrees/epic-7');
    expect(scope.repoFolderPath).toBe('/repo');
    expect(ensureEpicDeliveryWorktree).toHaveBeenCalledWith(EPIC);
  });

  // Ensured on every turn, not only at run start: a delivery conversation
  // resumed after the directory went missing recreates it rather than failing
  // inside the provider subprocess.
  it('re-ensures the delivery worktree on a resumed turn', async () => {
    await epicOwnerAdapter.resolveScope({ kind: 'epic', epicId: 7, deliveryWorktree: true });
    await epicOwnerAdapter.resolveScope({ kind: 'epic', epicId: 7, deliveryWorktree: true });

    expect(ensureEpicDeliveryWorktree).toHaveBeenCalledTimes(2);
  });

  it('still routes the PR reviewer into its ticket worktree', async () => {
    vi.mocked(getTask).mockReturnValue({
      id: 42,
      repo_folder_path: '/repo',
      subproject_path: null,
    } as never);
    vi.mocked(epicTicketsDb.epicOf).mockReturnValue(7);
    vi.mocked(worktreeExists).mockResolvedValue(true);

    const scope = await epicOwnerAdapter.resolveScope({
      kind: 'epic',
      epicId: 7,
      worktreeTaskId: 42,
    });

    expect(scope.cwd).toBe('/repo-worktrees/task-42');
    expect(ensureEpicDeliveryWorktree).not.toHaveBeenCalled();
  });
});
