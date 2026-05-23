import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const {
  mockValidateSignature,
  mockParseTaskId,
  mockHasTriggerMention,
  mockGetConfiguredTrigger,
  mockTriggerPrAgent,
  mockTriggerPrAgentFromReview,
  mockRunCommand,
} = vi.hoisted(() => ({
  mockValidateSignature: vi.fn(),
  mockParseTaskId: vi.fn(),
  mockHasTriggerMention: vi.fn(),
  mockGetConfiguredTrigger: vi.fn(),
  mockTriggerPrAgent: vi.fn(),
  mockTriggerPrAgentFromReview: vi.fn(),
  mockRunCommand: vi.fn(),
}));

vi.mock('../services/webhookService.js', () => ({
  validateGitHubWebhookSignature: mockValidateSignature,
  parseTaskIdFromBranch: mockParseTaskId,
  hasTriggerMention: mockHasTriggerMention,
  getConfiguredTrigger: mockGetConfiguredTrigger,
  triggerPrAgentFromComment: mockTriggerPrAgent,
  triggerPrAgentFromReview: mockTriggerPrAgentFromReview,
}));

vi.mock('../services/shell.js', () => ({
  runCommand: mockRunCommand,
}));

import webhooksRoutes from './webhooks.js';

type RunArgs = readonly string[];

function withDispatch(
  handler: (cmd: string, args: RunArgs) => Promise<{ stdout: string; stderr: string }>,
): void {
  mockRunCommand.mockImplementation((cmd: string, args: RunArgs) => handler(cmd, args));
}

describe('Webhooks Routes', () => {
  let app: import('express').Application;
  const testSecret = 'test-webhook-secret';

  beforeEach(() => {
    vi.clearAllMocks();

    process.env.GITHUB_WEBHOOK_SECRET = testSecret;

    vi.mocked(mockValidateSignature).mockReturnValue(true);
    vi.mocked(mockParseTaskId).mockReturnValue(123);
    vi.mocked(mockHasTriggerMention).mockReturnValue(true);
    vi.mocked(mockGetConfiguredTrigger).mockReturnValue('bottega');
    vi.mocked(mockTriggerPrAgent).mockResolvedValue({
      conversationId: 100,
      agentRunId: 1,
    });
    vi.mocked(mockTriggerPrAgentFromReview).mockResolvedValue({
      conversationId: 200,
      agentRunId: 2,
    });

    // Default: `gh pr view` returns a task branch, `gh api` returns [].
    withDispatch(async (_cmd, args) => {
      if (args[0] === 'api') return { stdout: '[]', stderr: '' };
      return { stdout: 'task/123-feature\n', stderr: '' };
    });

    app = express();
    app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhooksRoutes);
    app.locals.broadcastToTaskSubscribers = null;
    // broadcastToConversationSubscribers intentionally left unset — assertions
    // expect it to read as `undefined` from app.locals.
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  describe('GET /api/webhooks/health', () => {
    it('returns health status with secret configured', async () => {
      const response = await request(app).get('/api/webhooks/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.webhookSecretConfigured).toBe(true);
    });

    it('indicates when secret is not configured', async () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;

      const response = await request(app).get('/api/webhooks/health');

      expect(response.status).toBe(200);
      expect(response.body.webhookSecretConfigured).toBe(false);
    });
  });

  describe('POST /api/webhooks/github - issue_comment', () => {
    const validPayload = {
      action: 'created',
      issue: {
        number: 42,
        pull_request: { url: 'https://api.github.com/repos/org/repo/pulls/42' },
        html_url: 'https://github.com/org/repo/pull/42',
      },
      comment: {
        body: '@bottega please fix this bug',
        user: { login: 'octocat' },
      },
      repository: {
        full_name: 'org/repo',
      },
    };

    function makeRequest(payload: unknown, headers: Record<string, string> = {}) {
      const body = JSON.stringify(payload);
      return request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'issue_comment')
        .set('X-Hub-Signature-256', 'sha256=valid-signature')
        .set(headers)
        .send(body);
    }

    it('returns 401 for invalid signature', async () => {
      vi.mocked(mockValidateSignature).mockReturnValue(false);

      const response = await makeRequest(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Invalid signature');
    });

    it('ignores non-PR comment events', async () => {
      const response = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'push')
        .set('X-Hub-Signature-256', 'sha256=valid-signature')
        .send(JSON.stringify(validPayload));

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ignored');
      expect(response.body.event).toBe('push');
    });

    it('ignores non-created actions', async () => {
      const payload = { ...validPayload, action: 'edited' };

      const response = await makeRequest(payload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ignored');
      expect(response.body.reason).toBe('not a created event');
    });

    it('ignores comments on regular issues (not PRs)', async () => {
      const payload = {
        ...validPayload,
        issue: { number: 42 },
      };

      const response = await makeRequest(payload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ignored');
      expect(response.body.reason).toBe('not a PR comment');
    });

    it('ignores comments without the configured @-trigger', async () => {
      vi.mocked(mockHasTriggerMention).mockReturnValue(false);

      const response = await makeRequest(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ignored');
      expect(response.body.reason).toBe('no @bottega mention');
    });

    it('reflects a custom configured trigger in the ignore reason', async () => {
      vi.mocked(mockHasTriggerMention).mockReturnValue(false);
      vi.mocked(mockGetConfiguredTrigger).mockReturnValue('mybot');

      const response = await makeRequest(validPayload);

      expect(response.body.reason).toBe('no @mybot mention');
    });

    it('ignores branches not matching task pattern', async () => {
      vi.mocked(mockParseTaskId).mockReturnValue(null);

      const response = await makeRequest(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ignored');
      expect(response.body.reason).toBe('branch not in task format');
    });

    it('triggers PR agent for valid webhook and passes gh args as argv (no shell)', async () => {
      const response = await makeRequest(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('triggered');
      expect(response.body.taskId).toBe(123);
      expect(response.body.conversationId).toBe(100);

      // No shell interpolation; prNumber and repoFullName are argv elements.
      const prViewCall = mockRunCommand.mock.calls.find(
        (c) => c[0] === 'gh' && (c[1] as string[]).includes('view'),
      );
      expect(prViewCall![1]).toEqual([
        'pr',
        'view',
        '42',
        '--repo',
        'org/repo',
        '--json',
        'headRefName',
        '--jq',
        '.headRefName',
      ]);

      expect(mockTriggerPrAgent).toHaveBeenCalledWith({
        taskId: 123,
        commentBody: '@bottega please fix this bug',
        commentAuthor: 'octocat',
        prUrl: 'https://github.com/org/repo/pull/42',
        fileContext: null,
        broadcastToConversationSubscribers: undefined,
        broadcastToTaskSubscribers: null,
      });
    });

    it('rejects an adversarial repoFullName before running gh — no shell-out', async () => {
      const adversarial = {
        ...validPayload,
        repository: { full_name: 'evil;rm -rf /' },
      };

      const response = await makeRequest(adversarial);

      // The validator short-circuits fetchPrBranchName, which returns null;
      // the route then reports the branch couldn't be determined.
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ignored');
      expect(response.body.reason).toBe('could not determine branch');
      expect(mockRunCommand).not.toHaveBeenCalled();
    });

    it('returns 200 with ignored status for expected errors', async () => {
      vi.mocked(mockTriggerPrAgent).mockRejectedValue(new Error('Task 123 not found'));

      const response = await makeRequest(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ignored');
      expect(response.body.reason).toBe('Task 123 not found');
    });

    it('returns 200 with ignored for already completed tasks', async () => {
      vi.mocked(mockTriggerPrAgent).mockRejectedValue(new Error('Task 123 is already completed'));

      const response = await makeRequest(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ignored');
      expect(response.body.reason).toBe('Task 123 is already completed');
    });

    it('returns 200 with ignored for already running agent', async () => {
      vi.mocked(mockTriggerPrAgent).mockRejectedValue(
        new Error('PR agent already running for task 123'),
      );

      const response = await makeRequest(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ignored');
      expect(response.body.reason).toBe('PR agent already running for task 123');
    });

    it('returns 500 for unexpected errors', async () => {
      vi.mocked(mockTriggerPrAgent).mockRejectedValue(new Error('Unexpected database error'));

      const response = await makeRequest(validPayload);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to trigger agent');
      expect(response.body.message).toBe('Unexpected database error');
    });
  });

  describe('POST /api/webhooks/github - pull_request_review', () => {
    const validReviewPayload = {
      action: 'submitted',
      review: {
        id: 12345,
        body: '@bottega please address these issues',
        user: { login: 'reviewer' },
      },
      pull_request: {
        number: 42,
        head: { ref: 'task/123-feature' },
        html_url: 'https://github.com/org/repo/pull/42',
      },
      repository: {
        full_name: 'org/repo',
      },
    };

    function makeReviewRequest(payload: unknown, headers: Record<string, string> = {}) {
      const body = JSON.stringify(payload);
      return request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'pull_request_review')
        .set('X-Hub-Signature-256', 'sha256=valid-signature')
        .set(headers)
        .send(body);
    }

    it('triggers PR agent for valid review with the trigger in body', async () => {
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'api') {
          return {
            stdout: JSON.stringify([
              {
                body: 'Fix this function',
                user: { login: 'reviewer' },
                path: 'src/app.js',
                line: 10,
                start_line: null,
                diff_hunk: '@@ -8,6 +8,12 @@\n+function foo() {}',
                side: 'RIGHT',
              },
            ]),
            stderr: '',
          };
        }
        return { stdout: 'task/123-feature\n', stderr: '' };
      });

      const response = await makeReviewRequest(validReviewPayload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('triggered');
      expect(response.body.taskId).toBe(123);
      expect(response.body.conversationId).toBe(200);

      // gh api path is built with validated values; the entire path lives in a
      // single argv element so shell metacharacters could not break out.
      const apiCall = mockRunCommand.mock.calls.find(
        (c) => c[0] === 'gh' && (c[1] as string[])[0] === 'api',
      );
      expect(apiCall![1]).toEqual([
        'api',
        'repos/org/repo/pulls/42/reviews/12345/comments',
      ]);

      expect(mockTriggerPrAgentFromReview).toHaveBeenCalledWith({
        taskId: 123,
        reviewBody: '@bottega please address these issues',
        reviewAuthor: 'reviewer',
        comments: [
          {
            commentBody: 'Fix this function',
            commentAuthor: 'reviewer',
            fileContext: {
              path: 'src/app.js',
              line: 10,
              startLine: null,
              diffHunk: '@@ -8,6 +8,12 @@\n+function foo() {}',
              side: 'RIGHT',
            },
          },
        ],
        prUrl: 'https://github.com/org/repo/pull/42',
        broadcastToConversationSubscribers: undefined,
        broadcastToTaskSubscribers: null,
      });
    });

    it('triggers when the trigger is in an inline comment but not the review body', async () => {
      const payload = {
        ...validReviewPayload,
        review: {
          ...validReviewPayload.review,
          body: 'Please fix these',
        },
      };

      vi.mocked(mockHasTriggerMention).mockImplementation((text) => {
        if (!text) return false;
        return text.toLowerCase().includes('@bottega');
      });

      withDispatch(async (_cmd, args) => {
        if (args[0] === 'api') {
          return {
            stdout: JSON.stringify([
              {
                body: '@bottega update this logic',
                user: { login: 'reviewer' },
                path: 'src/utils.js',
                line: 5,
                start_line: null,
                diff_hunk: null,
                side: 'RIGHT',
              },
            ]),
            stderr: '',
          };
        }
        return { stdout: 'task/123-feature\n', stderr: '' };
      });

      const response = await makeReviewRequest(payload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('triggered');
      expect(mockTriggerPrAgentFromReview).toHaveBeenCalled();
    });

    it('ignores review without the configured @-trigger anywhere', async () => {
      vi.mocked(mockHasTriggerMention).mockReturnValue(false);

      const response = await makeReviewRequest(validReviewPayload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ignored');
      expect(response.body.reason).toBe('no @bottega mention');
    });

    it('ignores non-submitted review actions', async () => {
      const payload = { ...validReviewPayload, action: 'dismissed' };

      const response = await makeReviewRequest(payload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ignored');
      expect(response.body.reason).toBe('not a submitted event');
    });

    it('ignores review on non-task branches', async () => {
      vi.mocked(mockParseTaskId).mockReturnValue(null);

      const response = await makeReviewRequest(validReviewPayload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ignored');
      expect(response.body.reason).toBe('branch not in task format');
    });

    it('handles review with empty comments array', async () => {
      withDispatch(async (_cmd, args) => {
        if (args[0] === 'api') return { stdout: '[]', stderr: '' };
        return { stdout: 'task/123-feature\n', stderr: '' };
      });

      const response = await makeReviewRequest(validReviewPayload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('triggered');
      expect(mockTriggerPrAgentFromReview).toHaveBeenCalledWith(
        expect.objectContaining({ comments: [] }),
      );
    });

    it('rejects adversarial repo names in the review path before shelling out', async () => {
      const adversarial = {
        ...validReviewPayload,
        repository: { full_name: 'evil$(id)/repo' },
      };

      const response = await makeReviewRequest(adversarial);

      // fetchReviewComments returns []; the trigger may still match the
      // body, so the agent is triggered with an empty comments list. The key
      // point: runCommand was never called with an unvalidated repo.
      expect(response.status).toBe(200);
      expect(mockRunCommand).not.toHaveBeenCalled();
    });

    it('returns 200 with ignored for expected errors from review trigger', async () => {
      vi.mocked(mockTriggerPrAgentFromReview).mockRejectedValue(new Error('Task 123 not found'));

      const response = await makeReviewRequest(validReviewPayload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ignored');
      expect(response.body.reason).toBe('Task 123 not found');
    });

    it('returns 200 with ignored for already running agent', async () => {
      vi.mocked(mockTriggerPrAgentFromReview).mockRejectedValue(
        new Error('PR agent already running for task 123'),
      );

      const response = await makeReviewRequest(validReviewPayload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ignored');
      expect(response.body.reason).toBe('PR agent already running for task 123');
    });

    it('returns 500 for unexpected errors from review trigger', async () => {
      vi.mocked(mockTriggerPrAgentFromReview).mockRejectedValue(
        new Error('Database connection lost'),
      );

      const response = await makeReviewRequest(validReviewPayload);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to trigger agent');
      expect(response.body.message).toBe('Database connection lost');
    });
  });
});
