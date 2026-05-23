// Webhook Routes
//
// Handles incoming webhooks from external services like GitHub.
// GitHub webhooks trigger PR agent runs when the configured @-trigger
// (e.g. @bottega) is mentioned in PR comments. The trigger string is
// stored in app_settings.github_pr_trigger and editable from the UI.

import express, { type Request, type Response } from 'express';
import {
  validateGitHubWebhookSignature,
  parseTaskIdFromBranch,
  hasTriggerMention,
  getConfiguredTrigger,
  triggerPrAgentFromComment,
  triggerPrAgentFromReview,
} from '../services/webhookService.js';
import { runCommand } from '../services/shell.js';
import {
  assertValidPositiveInt,
  assertValidRepoFullName,
  ValidationError,
} from '../services/validators.js';

const router = express.Router();

interface GitHubReviewComment {
  body?: string;
  user?: { login?: string };
  path?: string;
  line?: number | null;
  start_line?: number | null;
  diff_hunk?: string | null;
  side?: string | null;
}

async function fetchPrBranchName(
  prNumber: number,
  repoFullName: string,
): Promise<string | null> {
  try {
    assertValidPositiveInt(prNumber, 'PR number');
    assertValidRepoFullName(repoFullName);
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error('[Webhook] Rejected PR fetch:', error.message);
      return null;
    }
    throw error;
  }
  try {
    const { stdout } = await runCommand('gh', [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repoFullName,
      '--json',
      'headRefName',
      '--jq',
      '.headRefName',
    ]);
    return stdout.trim() || null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Webhook] Failed to fetch PR branch:', message);
    return null;
  }
}

async function fetchReviewComments(
  repoFullName: string,
  prNumber: number,
  reviewId: number,
): Promise<GitHubReviewComment[]> {
  try {
    assertValidRepoFullName(repoFullName);
    assertValidPositiveInt(prNumber, 'PR number');
    assertValidPositiveInt(reviewId, 'review ID');
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error('[Webhook] Rejected review-comments fetch:', error.message);
      return [];
    }
    throw error;
  }
  try {
    // After validation, all three pieces are known-safe — but execFile keeps
    // shell metacharacters inert regardless, so this is defense in depth.
    const { stdout } = await runCommand('gh', [
      'api',
      `repos/${repoFullName}/pulls/${prNumber}/reviews/${reviewId}/comments`,
    ]);
    return JSON.parse(stdout) as GitHubReviewComment[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Webhook] Failed to fetch review comments:', message);
    return [];
  }
}

router.post(
  '/github',
  async (req: Request, res: Response<unknown>) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!validateGitHubWebhookSignature(req.body, signature, secret)) {
      console.log('[Webhook] Invalid GitHub signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse((req.body as Buffer).toString()) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Webhook] Failed to parse payload:', message);
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    const eventType = req.headers['x-github-event'] as string | undefined;

    if (eventType !== 'issue_comment' && eventType !== 'pull_request_review') {
      return res.status(200).json({ status: 'ignored', event: eventType });
    }

    const expectedAction = eventType === 'pull_request_review' ? 'submitted' : 'created';
    if (payload.action !== expectedAction) {
      return res
        .status(200)
        .json({ status: 'ignored', reason: `not a ${expectedAction} event` });
    }

    if (
      eventType === 'issue_comment' &&
      !(payload.issue as { pull_request?: unknown } | undefined)?.pull_request
    ) {
      return res
        .status(200)
        .json({ status: 'ignored', reason: 'not a PR comment' });
    }

    const repoFullName = (payload.repository as { full_name?: string } | undefined)?.full_name;

    if (eventType === 'pull_request_review') {
      const review = payload.review as
        | { body?: string; user?: { login?: string }; id?: number }
        | undefined;
      const pullRequest = payload.pull_request as
        | { number?: number; head?: { ref?: string }; html_url?: string }
        | undefined;
      const reviewBody = review?.body || '';
      const reviewAuthor = review?.user?.login || 'unknown';
      const reviewId = review?.id;
      const prNumber = pullRequest?.number;
      const branchName = pullRequest?.head?.ref;
      const prUrl = pullRequest?.html_url;

      let reviewComments: GitHubReviewComment[] = [];
      if (reviewId && prNumber && repoFullName !== undefined) {
        reviewComments = await fetchReviewComments(repoFullName, prNumber, reviewId);
      }

      const trigger = getConfiguredTrigger();
      const hasTriggerInBody = hasTriggerMention(reviewBody, trigger);
      const hasTriggerInComments = reviewComments.some((c) =>
        hasTriggerMention(c.body ?? '', trigger),
      );

      if (!hasTriggerInBody && !hasTriggerInComments) {
        return res
          .status(200)
          .json({ status: 'ignored', reason: `no @${trigger} mention` });
      }

      if (!branchName) {
        console.log('[Webhook] Could not determine branch name from review');
        return res
          .status(200)
          .json({ status: 'ignored', reason: 'could not determine branch' });
      }

      const taskId = parseTaskIdFromBranch(branchName);
      if (!taskId) {
        console.log(`[Webhook] Branch ${branchName} does not match task pattern`);
        return res
          .status(200)
          .json({ status: 'ignored', reason: 'branch not in task format' });
      }

      const comments = reviewComments.map((c) => ({
        commentBody: c.body,
        commentAuthor: c.user?.login || 'unknown',
        fileContext: c.path
          ? {
              path: c.path,
              line: c.line || null,
              startLine: c.start_line || null,
              diffHunk: c.diff_hunk || null,
              side: c.side || null,
            }
          : null,
      }));

      try {
        const result = await triggerPrAgentFromReview({
          taskId,
          reviewBody: reviewBody || null,
          reviewAuthor,
          comments,
          prUrl,
          broadcastToConversationSubscribers:
            req.app.locals.broadcastToConversationSubscribers,
          broadcastToTaskSubscribers: req.app.locals.broadcastToTaskSubscribers,
        });

        console.log(
          `[Webhook] Successfully triggered PR agent for task ${taskId} from review`,
        );
        return res.status(200).json({
          status: 'triggered',
          taskId,
          conversationId: result.conversationId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Webhook] Failed to trigger PR agent from review:', message);

        if (
          message.includes('not found') ||
          message.includes('already completed') ||
          message.includes('No worktree') ||
          message.includes('already running')
        ) {
          return res.status(200).json({
            status: 'ignored',
            reason: message,
          });
        }

        return res
          .status(500)
          .json({ error: 'Failed to trigger agent', message });
      }
    }

    const comment = payload.comment as
      | { body?: string; user?: { login?: string } }
      | undefined;
    const issue = payload.issue as
      | { number?: number; html_url?: string }
      | undefined;
    const commentBody = comment?.body || '';
    const issueTrigger = getConfiguredTrigger();
    if (!hasTriggerMention(commentBody, issueTrigger)) {
      return res
        .status(200)
        .json({ status: 'ignored', reason: `no @${issueTrigger} mention` });
    }

    const prNumber = issue?.number;
    if (!prNumber || repoFullName === undefined) {
      return res
        .status(200)
        .json({ status: 'ignored', reason: 'could not determine PR' });
    }
    const branchName = await fetchPrBranchName(prNumber, repoFullName);

    if (!branchName) {
      console.log('[Webhook] Could not determine branch name');
      return res
        .status(200)
        .json({ status: 'ignored', reason: 'could not determine branch' });
    }

    const taskId = parseTaskIdFromBranch(branchName);
    if (!taskId) {
      console.log(`[Webhook] Branch ${branchName} does not match task pattern`);
      return res
        .status(200)
        .json({ status: 'ignored', reason: 'branch not in task format' });
    }

    const prUrl = issue?.html_url;

    try {
      const result = await triggerPrAgentFromComment({
        taskId,
        commentBody,
        commentAuthor: comment?.user?.login || 'unknown',
        prUrl,
        fileContext: null,
        broadcastToConversationSubscribers:
          req.app.locals.broadcastToConversationSubscribers,
        broadcastToTaskSubscribers: req.app.locals.broadcastToTaskSubscribers,
      });

      console.log(`[Webhook] Successfully triggered PR agent for task ${taskId}`);
      res.status(200).json({
        status: 'triggered',
        taskId,
        conversationId: result.conversationId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Webhook] Failed to trigger PR agent:', message);

      if (
        message.includes('not found') ||
        message.includes('already completed') ||
        message.includes('No worktree') ||
        message.includes('already running')
      ) {
        return res.status(200).json({
          status: 'ignored',
          reason: message,
        });
      }

      res.status(500).json({ error: 'Failed to trigger agent', message });
    }
  },
);

router.get('/health', (_req: Request, res: Response<unknown>) => {
  const hasSecret = !!process.env.GITHUB_WEBHOOK_SECRET;
  res.json({
    status: 'ok',
    webhookSecretConfigured: hasSecret,
  });
});

export default router;
