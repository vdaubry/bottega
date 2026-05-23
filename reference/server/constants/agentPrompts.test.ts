import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generateYoloMessage,
  generatePrAgentMessage,
  generatePlanificationMessage,
  generatePrAgentCommentMessage,
  generatePrAgentReviewMessage,
} from './agentPrompts.js';
import { saveOverride, deleteOverride } from '../services/promptRenderer.js';

describe('generateYoloMessage', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-42.md';
  const taskId = 42;

  it('includes the task doc path and task id', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null);
    expect(msg).toContain(taskDocPath);
    expect(msg).toContain(String(taskId));
  });

  it('instructs the agent not to ask clarifying questions', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null);
    expect(msg.toLowerCase()).toContain('never ask the user clarifying questions');
  });

  it('instructs the agent not to spawn sub-agents', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null);
    expect(msg.toLowerCase()).toContain('sub-agent');
  });

  it('requires a testing strategy with unit tests and optional Playwright verification', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null);
    expect(msg).toContain('Testing Strategy');
    expect(msg.toLowerCase()).toContain('unit test');
    expect(msg).toContain('Playwright');
  });

  it('calls complete-workflow.ts before the PR phase', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null);
    const workflowIdx = msg.indexOf('complete-workflow.ts');
    const prIdx = msg.indexOf('gh pr create');
    expect(workflowIdx).toBeGreaterThan(-1);
    expect(prIdx).toBeGreaterThan(workflowIdx);
  });

  it('includes CI monitoring and complete-pr.ts', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null);
    expect(msg).toContain('gh pr checks');
    expect(msg).toContain('complete-pr.ts');
  });

  it('uses a concise PR metadata example instead of generic task placeholders', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null);
    expect(msg).toContain('--title "<short task title>"');
    expect(msg).toContain('Summary: <what the task does and how this implementation solves it');
    expect(msg).toContain(`Task: #${taskId}`);
    expect(msg).not.toContain(`gh pr create --title "Task #${taskId}" --body "Implementation for task #${taskId}"`);
  });

  it('references an existing PR URL when provided', async () => {
    const prUrl = 'https://github.com/foo/bar/pull/1';
    const msg = await generateYoloMessage(taskDocPath, taskId, prUrl);
    expect(msg).toContain(prUrl);
  });

  it('does not explicitly merge the PR', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null);
    expect(msg).toContain('Do NOT merge the PR');
  });
});

describe('generatePrAgentMessage (shared body refactor regression)', () => {
  it('still contains CI monitoring instructions after the refactor', async () => {
    const msg = await generatePrAgentMessage('/repo/.bottega/tasks/task-1.md', 1, null);
    expect(msg).toContain('gh pr checks');
    expect(msg).toContain('complete-pr.ts');
    expect(msg).toContain('Do NOT merge the PR');
  });

  it('requires a short PR title and concise summary for new pull requests', async () => {
    const msg = await generatePrAgentMessage('/repo/.bottega/tasks/task-1.md', 1, null);
    expect(msg).toContain('short specific title');
    expect(msg).toContain('concise summary body');
    expect(msg).toContain('--title "<short task title>"');
    expect(msg).toContain('Summary: <what the task does and how this implementation solves it');
    expect(msg).toContain('Keep this to a short paragraph');
    expect(msg).not.toContain('gh pr create --title "Task #1" --body "Implementation for task #1"');
  });
});

describe('generatePlanificationMessage', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-42.md';
  const taskId = 42;

  it('renders the technical prompt by default', async () => {
    const msg = await generatePlanificationMessage(taskDocPath, taskId);
    expect(msg).toContain('JWT or sessions');
    expect(msg).toContain('ALWAYS propose a testing strategy and confirm with the user');
  });

  it('renders the non-technical prompt when isTechnical is false', async () => {
    const msg = await generatePlanificationMessage(taskDocPath, taskId, false);
    expect(msg).not.toContain('JWT or sessions');
    expect(msg).not.toContain('ALWAYS propose a testing strategy and confirm with the user');
    expect(msg).toContain('non-technical');
    expect(msg.toLowerCase()).toContain('product and ux trade-offs only');
  });

  it('substitutes taskDocPath and taskId in both modes', async () => {
    const techMsg = await generatePlanificationMessage(taskDocPath, taskId, true);
    const nonTechMsg = await generatePlanificationMessage(taskDocPath, taskId, false);
    for (const msg of [techMsg, nonTechMsg]) {
      expect(msg).toContain(taskDocPath);
      expect(msg).toContain(String(taskId));
      expect(msg).not.toContain('{{');
    }
  });

  it('reframes the goal as producing a planning document, not implementing code', async () => {
    const techMsg = await generatePlanificationMessage(taskDocPath, taskId, true);
    const nonTechMsg = await generatePlanificationMessage(taskDocPath, taskId, false);
    for (const msg of [techMsg, nonTechMsg]) {
      expect(msg).toContain('planning document');
      expect(msg.toLowerCase()).toContain('original request');
    }
  });
});

describe('generatePlanificationMessage — plan-template integration', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-42.md';
  const taskId = 42;
  let archiveRoot: string;

  beforeEach(() => {
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-tmpl-test-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
  });

  afterEach(() => {
    if (archiveRoot && fs.existsSync(archiveRoot)) {
      fs.rmSync(archiveRoot, { recursive: true, force: true });
    }
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
  });

  it('injects an @-reference to the bundled default template when no override exists', async () => {
    const msg = await generatePlanificationMessage(taskDocPath, taskId);
    expect(msg).toMatch(/@\S+server\/constants\/templates\/plan-template\.md/);
  });

  it('injects an @-reference to the override path once a template override is saved', async () => {
    saveOverride('plan-template', '# CUSTOM\n');
    const expected = path.join(archiveRoot, 'templates', 'plan-template.md');
    const msg = await generatePlanificationMessage(taskDocPath, taskId);
    expect(msg).toContain(`@${expected}`);
    deleteOverride('plan-template');
  });

  it('falls back to the default path after the override is deleted', async () => {
    saveOverride('plan-template', '# CUSTOM\n');
    deleteOverride('plan-template');
    const msg = await generatePlanificationMessage(taskDocPath, taskId);
    expect(msg).toMatch(/@\S+server\/constants\/templates\/plan-template\.md/);
    expect(msg).not.toContain(archiveRoot);
  });
});

// pr-comment + pr-review were merged into a single pr-feedback.md prompt; both
// generators now build a {{feedbackSection}} and render the same template.
describe('generatePrAgentCommentMessage (single PR comment)', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-7.md';
  const taskId = 7;
  const prUrl = 'https://github.com/foo/bar/pull/3';

  it('renders the comment as feedback with author and quote, all vars substituted', async () => {
    const msg = await generatePrAgentCommentMessage(taskDocPath, taskId, prUrl, {
      commentBody: 'Please rename this function',
      commentAuthor: 'alice',
    });
    expect(msg).toContain(taskDocPath);
    expect(msg).toContain(prUrl);
    expect(msg).toContain('## User Feedback');
    expect(msg).toContain('@alice');
    expect(msg).toContain('> Please rename this function');
    expect(msg).toContain('Address all of the feedback');
    expect(msg).not.toContain('{{');
  });

  it('includes the file/line location when fileContext is provided', async () => {
    const msg = await generatePrAgentCommentMessage(taskDocPath, taskId, prUrl, {
      commentBody: 'bug here',
      commentAuthor: 'bob',
      fileContext: { path: 'src/app.ts', line: 42, startLine: 42 },
    });
    expect(msg).toContain('Comment Location');
    expect(msg).toContain('src/app.ts');
    expect(msg).toContain('line 42');
  });

  it('inlines the PR/CI procedure (merged prompt keeps CI monitoring)', async () => {
    const msg = await generatePrAgentCommentMessage(taskDocPath, taskId, prUrl, {
      commentBody: 'x',
      commentAuthor: 'alice',
    });
    expect(msg).toContain('gh pr checks');
    expect(msg).toContain(`complete-pr.ts ${taskId}`);
    expect(msg).toContain('Do NOT merge the PR');
  });
});

describe('generatePrAgentReviewMessage (batched review)', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-9.md';
  const taskId = 9;
  const prUrl = 'https://github.com/foo/bar/pull/5';

  it('renders the review summary and every inline comment as feedback', async () => {
    const msg = await generatePrAgentReviewMessage(taskDocPath, taskId, prUrl, {
      reviewBody: 'Overall looks good, a few nits',
      reviewAuthor: 'carol',
      comments: [
        { commentBody: 'extract a helper', commentAuthor: 'carol', fileContext: { path: 'a.ts', line: 10 } },
        { commentBody: 'typo', commentAuthor: 'carol', fileContext: { path: 'b.ts', line: 20 } },
      ],
    });
    expect(msg).toContain('## User Feedback');
    expect(msg).toContain('Review Summary');
    expect(msg).toContain('@carol');
    expect(msg).toContain('> Overall looks good, a few nits');
    expect(msg).toContain('Inline Comments (2)');
    expect(msg).toContain('extract a helper');
    expect(msg).toContain('typo');
    expect(msg).toContain('a.ts');
    expect(msg).toContain('b.ts');
    expect(msg).not.toContain('{{');
  });

  it('renders the same merged prompt as the comment path (CI procedure inlined)', async () => {
    const msg = await generatePrAgentReviewMessage(taskDocPath, taskId, prUrl, {
      reviewBody: 'fix',
      reviewAuthor: 'carol',
      comments: [{ commentBody: 'x', commentAuthor: 'carol' }],
    });
    expect(msg).toContain('Address all of the feedback');
    expect(msg).toContain('gh pr checks');
    expect(msg).toContain(`complete-pr.ts ${taskId}`);
  });
});
