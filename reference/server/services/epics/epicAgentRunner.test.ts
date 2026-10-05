import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../database/epics.js', () => ({
  epicsDb: {
    getWithProject: vi.fn(),
  },
  epicAgentRunsDb: {
    create: vi.fn(),
    getByEpic: vi.fn(),
    linkConversation: vi.fn(),
    updateStatus: vi.fn(),
  },
  epicTicketsDb: {
    epicOf: vi.fn(),
    get: vi.fn(),
    listTickets: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../../database/conversations.js', () => ({
  conversationsDb: {
    createForEpic: vi.fn(),
  },
}));

vi.mock('../conversationAdapter.js', () => ({
  startConversation: vi.fn(),
}));

vi.mock('./epicArchive.js', () => ({
  buildEpicContextPrompt: vi.fn().mockReturnValue('epic context'),
  ensureEpicDirs: vi.fn(),
}));

vi.mock('./epicAgentPrompts.js', () => ({
  generateEpicArchitectureMessage: vi.fn().mockReturnValue('epic architecture message'),
  generateEpicSpecificationMessage: vi.fn().mockReturnValue('epic specification message'),
  generateEpicStoriesMessage: vi.fn().mockReturnValue('epic stories message'),
  generateEpicSpecReviewMessage: vi.fn().mockReturnValue('epic spec review message'),
  generateEpicOrchestratorMessage: vi.fn().mockReturnValue('epic orchestrator message'),
  generateEpicPrReviewMessage: vi.fn().mockReturnValue('epic pr review message'),
  generateEpicDeliveryMessage: vi.fn().mockReturnValue('epic delivery message'),
  generateEpicQaScenariosMessage: vi.fn().mockReturnValue('epic qa scenarios message'),
  generateEpicQaExecutionMessage: vi.fn().mockReturnValue('epic qa execution message'),
}));

vi.mock('./epicBranch.js', () => ({
  ensureEpicDeliveryWorktree: vi
    .fn()
    .mockResolvedValue('/path/to/project-worktrees/epic-42'),
  findEpicCompletionPR: vi.fn().mockResolvedValue('https://github.com/acme/x/pull/148'),
}));

vi.mock('../worktree.js', () => ({
  getWorktreeProjectPath: vi.fn(
    (repo: string, id: number) => `${repo}-worktrees/task-${id}`,
  ),
  worktreeExists: vi.fn().mockResolvedValue(true),
  getPullRequestStatus: vi.fn(),
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
}));

vi.mock('../tasks/index.js', () => ({
  resolveBaseBranch: vi.fn().mockResolvedValue('epic/42-nimbus'),
  getTask: vi.fn(),
}));

const credentialStoreReadMock = vi.hoisted(() => vi.fn(() => ({ token: 'tkn', tokenPath: '/x' })));

vi.mock('../credentials/registry.js', () => ({
  getCredentialStore: vi.fn(() => ({ read: credentialStoreReadMock })),
}));

vi.mock('../agentModelSettings.js', () => ({
  loadAgentModelSettings: vi.fn().mockReturnValue({
    'epic-architecture': { provider: 'anthropic', model: 'opus', effort: 'xhigh' },
    'epic-specification': { provider: 'anthropic', model: 'opus', effort: 'xhigh' },
    'epic-stories': { provider: 'anthropic', model: 'opus', effort: 'high' },
    'epic-spec-review': { provider: 'anthropic', model: 'opus', effort: 'xhigh' },
    'epic-orchestrator': { provider: 'anthropic', model: 'opus', effort: 'high' },
    'epic-pr-review': { provider: 'anthropic', model: 'opus', effort: 'high' },
    'epic-delivery': { provider: 'anthropic', model: 'opus', effort: 'high' },
    'epic-qa-scenarios': { provider: 'anthropic', model: 'opus', effort: 'high' },
    'epic-qa-execution': { provider: 'anthropic', model: 'opus', effort: 'high' },
  }),
}));

import {
  startEpicAgentRun,
  getRunningAgentForEpic,
  getActivePrReviewerForEpic,
} from './epicAgentRunner.js';
import { epicsDb, epicAgentRunsDb, epicTicketsDb } from '../../database/epics.js';
import { conversationsDb } from '../../database/conversations.js';
import { startConversation } from '../conversationAdapter.js';
import { generateEpicArchitectureMessage, generateEpicSpecificationMessage, generateEpicStoriesMessage, generateEpicSpecReviewMessage, generateEpicPrReviewMessage, generateEpicDeliveryMessage, generateEpicQaScenariosMessage, generateEpicQaExecutionMessage } from './epicAgentPrompts.js';
import { ensureEpicDeliveryWorktree, findEpicCompletionPR } from './epicBranch.js';
import { getPullRequestStatus, getWorktreeProjectPath, worktreeExists } from '../worktree.js';
import { getTask, resolveBaseBranch } from '../tasks/index.js';
import { loadAgentModelSettings } from '../agentModelSettings.js';
import { buildEpicContextPrompt, ensureEpicDirs } from './epicArchive.js';

describe('epicAgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(worktreeExists).mockResolvedValue(true);
    vi.mocked(epicAgentRunsDb.getByEpic).mockReturnValue([]);
    vi.mocked(loadAgentModelSettings).mockReturnValue({
      'epic-architecture': { provider: 'anthropic', model: 'opus', effort: 'xhigh' },
      'epic-specification': { provider: 'anthropic', model: 'opus', effort: 'xhigh' },
      'epic-stories': { provider: 'anthropic', model: 'opus', effort: 'high' },
      'epic-spec-review': { provider: 'anthropic', model: 'opus', effort: 'xhigh' },
      'epic-orchestrator': { provider: 'anthropic', model: 'opus', effort: 'high' },
      'epic-pr-review': { provider: 'anthropic', model: 'opus', effort: 'high' },
      'epic-delivery': { provider: 'anthropic', model: 'opus', effort: 'high' },
      'epic-qa-scenarios': { provider: 'anthropic', model: 'opus', effort: 'high' },
      'epic-qa-execution': { provider: 'anthropic', model: 'opus', effort: 'high' },
    } as never);
    vi.mocked(buildEpicContextPrompt).mockReturnValue('epic context');
  });

  describe('startEpicAgentRun', () => {
    const mockEpicWithProject = {
      id: 42,
      project_id: 7,
      user_id: 1,
      name: 'Company Quests',
      slug: 'company-quests',
      status: 'active',
      architecture_complete: 0,
      repo_folder_path: '/path/to/project',
      subproject_path: null,
    };

    const mockEpicRun = {
      id: 9,
      task_id: null,
      epic_id: 42,
      agent_type: 'epic-architecture',
      status: 'running',
      conversation_id: null,
    };

    beforeEach(() => {
      vi.mocked(epicsDb.getWithProject).mockReturnValue(mockEpicWithProject as never);
      vi.mocked(epicAgentRunsDb.create).mockReturnValue(mockEpicRun as never);
      vi.mocked(conversationsDb.createForEpic).mockReturnValue({ id: 5 } as never);
      vi.mocked(startConversation).mockResolvedValue({
        conversationId: 5,
        claudeSessionId: 'sess-5',
      });
    });

    it('creates an epic-scoped run + conversation and starts an epic conversation', async () => {
      const broadcastToEpicSubscribersFn = vi.fn();

      const result = await startEpicAgentRun(42, 'epic-architecture', {
        userId: 1,
        broadcastToEpicSubscribersFn,
      });

      expect(epicAgentRunsDb.create).toHaveBeenCalledWith(
        42,
        'epic-architecture',
        null,
        'anthropic',
        null,
      );
      expect(conversationsDb.createForEpic).toHaveBeenCalledWith(42, 'anthropic', 'opus', 'xhigh');
      expect(epicAgentRunsDb.linkConversation).toHaveBeenCalledWith(9, 5);
      expect(generateEpicArchitectureMessage).toHaveBeenCalledWith(mockEpicWithProject);
      expect(buildEpicContextPrompt).toHaveBeenCalledWith(7, 42, 'epic-architecture');
      expect(startConversation).toHaveBeenCalledWith(
        { kind: 'epic', epicId: 42 },
        'epic architecture message',
        expect.objectContaining({
          conversationId: 5,
          provider: 'anthropic',
          model: 'opus',
          customSystemPrompt: 'epic context',
          permissionMode: 'bypassPermissions',
        }),
      );
      expect(result.claudeSessionId).toBe('sess-5');
    });

    it('broadcasts the running run on the EPIC channel', async () => {
      const broadcastToEpicSubscribersFn = vi.fn();

      await startEpicAgentRun(42, 'epic-architecture', {
        userId: 1,
        broadcastToEpicSubscribersFn,
      });

      expect(broadcastToEpicSubscribersFn).toHaveBeenCalledWith(42, {
        type: 'agent-run-updated',
        agentRun: {
          id: 9,
          status: 'running',
          agent_type: 'epic-architecture',
          conversation_id: 5,
        },
      });
    });

    it('routes architecture writes through portable document tools', async () => {
      await startEpicAgentRun(42, 'epic-architecture', { userId: 1 });

      const options = vi.mocked(startConversation).mock.calls[0]![2] as {
        disallowedTools: string[];
      };
      expect(options.disallowedTools).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
    });

    it('makes sure the archive layout exists before the stage starts', async () => {
      await startEpicAgentRun(42, 'epic-architecture', { userId: 1 });

      expect(ensureEpicDirs).toHaveBeenCalledWith(7, 42);
    });

    it('never touches task state (no run counter, no status flip)', async () => {
      await startEpicAgentRun(42, 'epic-architecture', { userId: 1 });

      // No task-layer imports at all: the epic runner reaches tasks only
      // through the facade, never the workflow counters.
    });

    it('throws for an unknown epic', async () => {
      vi.mocked(epicsDb.getWithProject).mockReturnValue(undefined);

      await expect(startEpicAgentRun(42, 'epic-architecture', { userId: 1 })).rejects.toThrow(
        /Epic 42 not found/,
      );
    });

    it('runs an epic stage on an OpenAI model setting', async () => {
      vi.mocked(loadAgentModelSettings).mockReturnValueOnce({
        'epic-architecture': { provider: 'openai', model: 'gpt-6.1-sol', effort: 'high' },
      } as never);

      await expect(startEpicAgentRun(42, 'epic-architecture', { userId: 1 })).resolves.toBeDefined();
      expect(startConversation).toHaveBeenCalledWith(
        { kind: 'epic', epicId: 42 },
        expect.any(String),
        expect.objectContaining({ provider: 'openai', model: 'gpt-6.1-sol' }),
      );
    });

    it('refuses an orchestrator run with no ticket to supervise', async () => {
      // One run + conversation per ticket is the whole run model — a run with
      // no ticket would have nothing to build its context from.
      await expect(startEpicAgentRun(42, 'epic-orchestrator', { userId: 1 })).rejects.toThrow(
        /must be started for a specific ticket/,
      );
      expect(epicAgentRunsDb.create).not.toHaveBeenCalled();
    });

    it('refuses a ticket that belongs to another epic', async () => {
      vi.mocked(getTask).mockReturnValueOnce({ id: 77 } as never);
      vi.mocked(epicTicketsDb.epicOf).mockReturnValueOnce(99);

      await expect(
        startEpicAgentRun(42, 'epic-orchestrator', { userId: 1, ticketTaskId: 77 }),
      ).rejects.toThrow(/not a ticket of epic 42/);
      expect(epicAgentRunsDb.create).not.toHaveBeenCalled();
    });

    it('stamps the supervised ticket on the orchestrator run', async () => {
      vi.mocked(getTask).mockReturnValueOnce({ id: 77 } as never);
      vi.mocked(epicTicketsDb.epicOf).mockReturnValueOnce(42);

      await startEpicAgentRun(42, 'epic-orchestrator', { userId: 1, ticketTaskId: 77 });

      expect(epicAgentRunsDb.create).toHaveBeenCalledWith(
        42,
        'epic-orchestrator',
        null,
        'anthropic',
        77,
      );
    });

    describe('the PR reviewer', () => {
      const reviewedTicket = {
        id: 77,
        epic_id: 42,
        repo_folder_path: '/repos/nimbus',
        subproject_path: null,
      };

      beforeEach(() => {
        vi.mocked(getTask).mockReturnValue(reviewedTicket as never);
        vi.mocked(epicTicketsDb.epicOf).mockReturnValue(42);
        vi.mocked(worktreeExists).mockResolvedValue(true);
        vi.mocked(getWorktreeProjectPath).mockReturnValue('/repos/nimbus-worktrees/task-77');
        vi.mocked(getPullRequestStatus).mockResolvedValue({
          success: true,
          exists: true,
          url: 'https://github.com/o/r/pull/77',
          state: 'OPEN',
        });
        vi.mocked(resolveBaseBranch).mockResolvedValue('epic/42-nimbus');
      });

      it('refuses to start without a ticket', async () => {
        await expect(startEpicAgentRun(42, 'epic-pr-review', { userId: 1 })).rejects.toThrow(
          /must be started for a specific ticket/,
        );
        expect(epicAgentRunsDb.create).not.toHaveBeenCalled();
      });

      it("refuses another epic's ticket", async () => {
        vi.mocked(getTask).mockReturnValue(reviewedTicket as never);
        vi.mocked(epicTicketsDb.epicOf).mockReturnValue(9);

        await expect(
          startEpicAgentRun(42, 'epic-pr-review', { userId: 1, ticketTaskId: 77 }),
        ).rejects.toThrow(/not a ticket of epic 42/);
      });

      it('refuses a ticket with no worktree or no open pull request — nothing to review', async () => {
        vi.mocked(worktreeExists).mockResolvedValueOnce(false);
        await expect(
          startEpicAgentRun(42, 'epic-pr-review', { userId: 1, ticketTaskId: 77 }),
        ).rejects.toThrow(/no worktree/);

        vi.mocked(getPullRequestStatus).mockResolvedValueOnce({
          success: true,
          exists: true,
          url: 'https://github.com/o/r/pull/77',
          state: 'MERGED',
        });
        await expect(
          startEpicAgentRun(42, 'epic-pr-review', { userId: 1, ticketTaskId: 77 }),
        ).rejects.toThrow(/no open pull request/);

        expect(epicAgentRunsDb.create).not.toHaveBeenCalled();
      });

      it("runs in the ticket's worktree on the review message, stamped with the ticket", async () => {
        await startEpicAgentRun(42, 'epic-pr-review', { userId: 1, ticketTaskId: 77 });

        expect(generateEpicPrReviewMessage).toHaveBeenCalledWith(
          mockEpicWithProject,
          reviewedTicket,
          {
            worktreePath: '/repos/nimbus-worktrees/task-77',
            prUrl: 'https://github.com/o/r/pull/77',
            baseBranch: 'epic/42-nimbus',
          },
        );
        expect(epicAgentRunsDb.create).toHaveBeenCalledWith(
          42,
          'epic-pr-review',
          null,
          'anthropic',
          77,
        );
        // The worktree target is what moves the conversation's cwd off the
        // main checkout — the one stage that writes code.
        expect(startConversation).toHaveBeenCalledWith(
          { kind: 'epic', epicId: 42, worktreeTaskId: 77 },
          'epic pr review message',
          expect.objectContaining({
            conversationId: 5,
            permissionMode: 'bypassPermissions',
            disallowedTools: ['AskUserQuestion'],
          }),
        );
      });

      it.each(['running', 'blocked'] as const)(
        'refuses a second reviewer while the existing reviewer is %s',
        async (status) => {
          const existing = {
            id: 8,
            epic_id: 42,
            agent_type: 'epic-pr-review',
            status,
            conversation_id: 91,
          };
          vi.mocked(epicAgentRunsDb.getByEpic).mockReturnValue([existing] as never);

          expect(getActivePrReviewerForEpic(42)).toMatchObject({ id: 8, status });
          await expect(
            startEpicAgentRun(42, 'epic-pr-review', { userId: 1, ticketTaskId: 77 }),
          ).rejects.toThrow(/already has an active PR reviewer/);
          expect(epicAgentRunsDb.create).not.toHaveBeenCalled();
          expect(startConversation).not.toHaveBeenCalled();
        },
      );

      it('allows a fresh reviewer after the previous reviewer failed', async () => {
        vi.mocked(epicAgentRunsDb.getByEpic).mockReturnValue([
          {
            id: 8,
            epic_id: 42,
            agent_type: 'epic-pr-review',
            status: 'failed',
            conversation_id: 91,
          },
        ] as never);

        await expect(
          startEpicAgentRun(42, 'epic-pr-review', { userId: 1, ticketTaskId: 77 }),
        ).resolves.toBeDefined();
      });
    });

    it('runs the specification stage on its own message and model key', async () => {
      await startEpicAgentRun(42, 'epic-specification', { userId: 1 });

      expect(generateEpicSpecificationMessage).toHaveBeenCalledWith(mockEpicWithProject);
      expect(epicAgentRunsDb.create).toHaveBeenCalledWith(
        42,
        'epic-specification',
        null,
        'anthropic',
        null,
      );
      expect(startConversation).toHaveBeenCalledWith(
        { kind: 'epic', epicId: 42 },
        'epic specification message',
        expect.objectContaining({ conversationId: 5, permissionMode: 'bypassPermissions' }),
      );
    });

    it('routes specification writes through portable document tools', async () => {
      await startEpicAgentRun(42, 'epic-specification', { userId: 1 });

      const options = vi.mocked(startConversation).mock.calls[0]![2] as {
        disallowedTools: string[];
      };
      expect(options.disallowedTools).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
    });

    it('runs the stories stage on its own message and model key', async () => {
      await startEpicAgentRun(42, 'epic-stories', { userId: 1 });

      expect(generateEpicStoriesMessage).toHaveBeenCalledWith(mockEpicWithProject);
      expect(epicAgentRunsDb.create).toHaveBeenCalledWith(
        42,
        'epic-stories',
        null,
        'anthropic',
        null,
      );
      expect(startConversation).toHaveBeenCalledWith(
        { kind: 'epic', epicId: 42 },
        'epic stories message',
        expect.objectContaining({ conversationId: 5, permissionMode: 'bypassPermissions' }),
      );
    });

    it('denies the stories agent every file-writing tool — tickets flow through MCP tools', async () => {
      await startEpicAgentRun(42, 'epic-stories', { userId: 1 });

      const options = vi.mocked(startConversation).mock.calls[0]![2] as {
        disallowedTools: string[];
      };
      expect(options.disallowedTools).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
      // Bash stays on for repo research (read-only by prompt), like every
      // non-orchestrator stage.
      expect(options.disallowedTools).not.toContain('Bash');
    });

    it('runs the specification review on its own message and model key, in the main checkout', async () => {
      await startEpicAgentRun(42, 'epic-spec-review', { userId: 1 });

      expect(generateEpicSpecReviewMessage).toHaveBeenCalledWith(mockEpicWithProject);
      expect(epicAgentRunsDb.create).toHaveBeenCalledWith(
        42,
        'epic-spec-review',
        null,
        'anthropic',
        null,
      );
      expect(startConversation).toHaveBeenCalledWith(
        { kind: 'epic', epicId: 42 },
        'epic spec review message',
        expect.objectContaining({ conversationId: 5, permissionMode: 'bypassPermissions' }),
      );
    });

    it('routes specification-review writes through portable document tools', async () => {
      await startEpicAgentRun(42, 'epic-spec-review', { userId: 1 });

      const options = vi.mocked(startConversation).mock.calls[0]![2] as {
        disallowedTools: string[];
      };
      expect(options.disallowedTools).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
    });

    describe('epic-delivery', () => {
      const deliveryEpic = { ...mockEpicWithProject, feature_branch: 'epic/42-company-quests' };

      beforeEach(() => {
        vi.mocked(epicsDb.getWithProject).mockReturnValue(deliveryEpic as never);
      });

      // Delivery works ON the feature branch, so it must run in a checkout of
      // it — never in the project's main checkout, which is a person's (and on
      // a self-hosting box, the running service's) working copy.
      it('runs in the epic delivery worktree, not the main checkout', async () => {
        await startEpicAgentRun(42, 'epic-delivery', { userId: 1 });

        expect(ensureEpicDeliveryWorktree).toHaveBeenCalledWith(deliveryEpic);
        expect(startConversation).toHaveBeenCalledWith(
          { kind: 'epic', epicId: 42, deliveryWorktree: true },
          'epic delivery message',
          expect.anything(),
        );
      });

      it('hands the prompt the worktree, both branches and the open pull request', async () => {
        await startEpicAgentRun(42, 'epic-delivery', { userId: 1 });

        expect(findEpicCompletionPR).toHaveBeenCalledWith(deliveryEpic);
        expect(generateEpicDeliveryMessage).toHaveBeenCalledWith(deliveryEpic, {
          worktreePath: '/path/to/project-worktrees/epic-42',
          featureBranch: 'epic/42-company-quests',
          defaultBranch: 'main',
          prUrl: 'https://github.com/acme/x/pull/148',
          trigger: { kind: 'manual' },
        });
      });

      it('carries the trigger through, so a GitHub comment opens the conversation', async () => {
        const trigger = {
          kind: 'comment' as const,
          webhookContext: { commentBody: 'please rebase', commentAuthor: 'octocat' },
        };

        await startEpicAgentRun(42, 'epic-delivery', { userId: 1, deliveryTrigger: trigger });

        expect(generateEpicDeliveryMessage).toHaveBeenCalledWith(
          deliveryEpic,
          expect.objectContaining({ trigger }),
        );
      });

      // A delivery run is about the epic's own pull request; `ticket_task_id`
      // is what says "this run is ABOUT a ticket", and it is not.
      it('records no ticket on the run and carries the full tool surface', async () => {
        await startEpicAgentRun(42, 'epic-delivery', { userId: 1 });

        expect(epicAgentRunsDb.create).toHaveBeenCalledWith(
          42,
          'epic-delivery',
          null,
          'anthropic',
          null,
        );
        const options = vi.mocked(startConversation).mock.calls[0]![2] as {
          disallowedTools: string[];
        };
        expect(options.disallowedTools).toEqual([]);
      });

      // No run row is created if there is nowhere to work: a loud failure at
      // start beats one half-way through a turn.
      it('refuses before creating a run when the worktree cannot be made', async () => {
        vi.mocked(ensureEpicDeliveryWorktree).mockRejectedValueOnce(
          new Error('Epic 42 has no feature branch yet'),
        );

        await expect(startEpicAgentRun(42, 'epic-delivery', { userId: 1 })).rejects.toThrow(
          /no feature branch/,
        );
        expect(epicAgentRunsDb.create).not.toHaveBeenCalled();
      });
    });

    describe('epic-qa-scenarios', () => {
      it('runs in the main checkout with the document-stage denylist', async () => {
        await startEpicAgentRun(42, 'epic-qa-scenarios', { userId: 1 });

        expect(generateEpicQaScenariosMessage).toHaveBeenCalledWith(mockEpicWithProject);
        expect(startConversation).toHaveBeenCalledWith(
          { kind: 'epic', epicId: 42 },
          'epic qa scenarios message',
          expect.objectContaining({
            disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
          }),
        );
        // Not a worktree agent: the book derives from documents, not the branch.
        expect(ensureEpicDeliveryWorktree).not.toHaveBeenCalled();
      });
    });

    describe('epic-qa-execution', () => {
      const qaEpic = { ...mockEpicWithProject, feature_branch: 'epic/42-company-quests' };

      beforeEach(() => {
        vi.mocked(epicsDb.getWithProject).mockReturnValue(qaEpic as never);
      });

      // QA runs the delivered branch, so like delivery it lives in the epic's
      // delivery worktree — never the main checkout.
      it('runs in the epic delivery worktree with the document-stage denylist', async () => {
        await startEpicAgentRun(42, 'epic-qa-execution', { userId: 1 });

        expect(ensureEpicDeliveryWorktree).toHaveBeenCalledWith(qaEpic);
        expect(startConversation).toHaveBeenCalledWith(
          { kind: 'epic', epicId: 42, deliveryWorktree: true },
          'epic qa execution message',
          expect.objectContaining({
            disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
          }),
        );
      });

      it('hands the prompt the worktree, the branch and the epic-band port', async () => {
        await startEpicAgentRun(42, 'epic-qa-execution', { userId: 1 });

        expect(generateEpicQaExecutionMessage).toHaveBeenCalledWith(qaEpic, {
          worktreePath: '/path/to/project-worktrees/epic-42',
          featureBranch: 'epic/42-company-quests',
          // 4100 + (42 % 900) — the epic band, disjoint from the task band.
          devServerPort: 4142,
        });
      });

      it('refuses before creating a run when the worktree cannot be made', async () => {
        vi.mocked(ensureEpicDeliveryWorktree).mockRejectedValueOnce(
          new Error('Epic 42 has no feature branch yet'),
        );

        await expect(startEpicAgentRun(42, 'epic-qa-execution', { userId: 1 })).rejects.toThrow(
          /no feature branch/,
        );
        expect(epicAgentRunsDb.create).not.toHaveBeenCalled();
      });
    });

    it('needs an acting user to resolve model settings', async () => {
      vi.mocked(epicsDb.getWithProject).mockReturnValue({
        ...mockEpicWithProject,
        user_id: null,
      } as never);

      await expect(startEpicAgentRun(42, 'epic-architecture', {})).rejects.toThrow(
        /no acting user/,
      );
    });
  });

  describe('getRunningAgentForEpic', () => {
    it('returns a running or resumably blocked epic run, or null', () => {
      vi.mocked(epicAgentRunsDb.getByEpic).mockReturnValue([
        { id: 1, status: 'completed' } as never,
        { id: 2, status: 'running' } as never,
      ]);
      expect(getRunningAgentForEpic(42)?.id).toBe(2);

      vi.mocked(epicAgentRunsDb.getByEpic).mockReturnValue([
        { id: 3, status: 'blocked' } as never,
      ]);
      expect(getRunningAgentForEpic(42)?.id).toBe(3);

      vi.mocked(epicAgentRunsDb.getByEpic).mockReturnValue([{ id: 1, status: 'failed' } as never]);
      expect(getRunningAgentForEpic(42)).toBeNull();
    });
  });
});
