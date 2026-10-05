import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../database/epics.js', () => ({
  epicsDb: { getWithProject: vi.fn() },
}));

vi.mock('../../database/db.js', () => ({
  userDb: { getUserById: vi.fn() },
}));

vi.mock('./epicAgentRunner.js', () => ({
  startEpicAgentRun: vi.fn(),
  getRunningAgentForEpic: vi.fn(),
}));

import {
  triggerEpicDeliveryFromComment,
  triggerEpicDeliveryFromReview,
} from './deliveryWebhook.js';
import { epicsDb } from '../../database/epics.js';
import { userDb } from '../../database/db.js';
import { startEpicAgentRun, getRunningAgentForEpic } from './epicAgentRunner.js';

const EPIC = {
  id: 42,
  project_id: 7,
  user_id: 3,
  name: 'Nimbus Pricing',
  feature_branch: 'epic/42-nimbus-pricing',
  repo_folder_path: '/repos/nimbus',
};

const COMMENT = {
  epicId: 42,
  commentBody: '@bottega this conflicts with main',
  commentAuthor: 'octocat',
};

const REVIEW = {
  epicId: 42,
  reviewBody: '@bottega two things',
  reviewAuthor: 'octocat',
  comments: [{ commentBody: 'rename this', commentAuthor: 'octocat', fileContext: null }],
};

describe('epic delivery webhook triggers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(epicsDb.getWithProject).mockReturnValue(EPIC as never);
    vi.mocked(userDb.getUserById).mockReturnValue({ id: 3, username: 'octocat' } as never);
    vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
    vi.mocked(startEpicAgentRun).mockResolvedValue({
      agentRun: { id: 9 },
      conversation: { id: 5 },
      claudeSessionId: 'sess-5',
    } as never);
  });

  it('starts a delivery run as the epic owner, carrying the comment', async () => {
    const result = await triggerEpicDeliveryFromComment({
      ...COMMENT,
      fileContext: { path: 'server/auth.ts', line: 42 },
    });

    expect(result).toEqual({ conversationId: 5, agentRunId: 9 });
    expect(startEpicAgentRun).toHaveBeenCalledWith(42, 'epic-delivery', {
      broadcastFn: undefined,
      broadcastToEpicSubscribersFn: undefined,
      userId: 3,
      deliveryTrigger: {
        kind: 'comment',
        webhookContext: {
          commentBody: '@bottega this conflicts with main',
          commentAuthor: 'octocat',
          fileContext: { path: 'server/auth.ts', line: 42 },
        },
      },
    });
  });

  it('carries a submitted review with its inline comments', async () => {
    const result = await triggerEpicDeliveryFromReview(REVIEW);

    expect(result).toEqual({ conversationId: 5, agentRunId: 9 });
    expect(startEpicAgentRun).toHaveBeenCalledWith(
      42,
      'epic-delivery',
      expect.objectContaining({
        deliveryTrigger: {
          kind: 'review',
          webhookContext: {
            reviewBody: '@bottega two things',
            reviewAuthor: 'octocat',
            comments: REVIEW.comments,
          },
        },
      }),
    );
  });

  it('refuses an epic that does not exist', async () => {
    vi.mocked(epicsDb.getWithProject).mockReturnValue(undefined);

    await expect(triggerEpicDeliveryFromComment(COMMENT)).rejects.toThrow(/Epic 42 not found/);
    expect(startEpicAgentRun).not.toHaveBeenCalled();
  });

  // Nothing to check out, so nothing to work on — the same precondition the
  // REST gate enforces.
  it('refuses an epic with no feature branch', async () => {
    vi.mocked(epicsDb.getWithProject).mockReturnValue({ ...EPIC, feature_branch: null } as never);

    await expect(triggerEpicDeliveryFromComment(COMMENT)).rejects.toThrow(/has no feature branch/);
    expect(startEpicAgentRun).not.toHaveBeenCalled();
  });

  // One conversation at a time per epic, like the task path: a second comment
  // arriving mid-turn is refused, not queued.
  it('refuses while another epic agent is running', async () => {
    vi.mocked(getRunningAgentForEpic).mockReturnValue({
      id: 8,
      agent_type: 'epic-delivery',
    } as never);

    await expect(triggerEpicDeliveryFromComment(COMMENT)).rejects.toThrow(/already running/);
    expect(startEpicAgentRun).not.toHaveBeenCalled();
  });

  it('refuses when the epic has no owning user to run as', async () => {
    vi.mocked(epicsDb.getWithProject).mockReturnValue({ ...EPIC, user_id: null } as never);

    await expect(triggerEpicDeliveryFromComment(COMMENT)).rejects.toThrow(/no owning user/);
  });

  it('refuses when the owner is gone or inactive', async () => {
    vi.mocked(userDb.getUserById).mockReturnValue(undefined);

    await expect(triggerEpicDeliveryFromComment(COMMENT)).rejects.toThrow(/not found or inactive/);
  });
});
