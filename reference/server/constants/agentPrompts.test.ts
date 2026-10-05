import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generateYoloMessage,
  generatePrAgentMessage,
  generatePlanificationMessage,
  generateImplementationMessage,
  generateReviewMessage,
  generateRefinementMessage,
  generatePrAgentCommentMessage,
  generatePrAgentReviewMessage,
} from './agentPrompts.js';
import {
  saveOverride,
  deleteOverride,
  loadDefault,
  listPromptNames,
} from '../services/promptRenderer.js';

// Every test renders against the bundled defaults: point the override root at a
// fresh temp dir so operator overrides in ~/.bottega can't shadow them.
let archiveRoot: string;

beforeEach(() => {
  archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-prompts-test-'));
  process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
});

afterEach(() => {
  if (archiveRoot && fs.existsSync(archiveRoot)) {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
  delete process.env.BOTTEGA_ARCHIVE_ROOT;
});

describe('generateYoloMessage', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-42.md';
  const taskId = 42;

  it('includes the task doc path and task id', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null, 'main');
    expect(msg).toContain(taskDocPath);
    expect(msg).toContain(String(taskId));
  });

  it('instructs the agent not to ask clarifying questions', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null, 'main');
    expect(msg.toLowerCase()).toContain('never ask the user clarifying questions');
  });

  it('instructs the agent not to spawn sub-agents', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null, 'main');
    expect(msg.toLowerCase()).toContain('sub-agent');
  });

  it('requires a testing strategy with unit tests and optional Playwright verification', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null, 'main');
    expect(msg).toContain('Testing Strategy');
    expect(msg.toLowerCase()).toContain('unit test');
    expect(msg).toContain('Playwright');
  });

  it('calls complete-workflow.ts before the PR phase', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null, 'main');
    const workflowIdx = msg.indexOf('complete-workflow.ts');
    const prIdx = msg.indexOf('gh pr create');
    expect(workflowIdx).toBeGreaterThan(-1);
    expect(prIdx).toBeGreaterThan(workflowIdx);
  });

  it('includes CI monitoring and complete-pr.ts', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null, 'main');
    expect(msg).toContain('gh pr checks');
    expect(msg).toContain('complete-pr.ts');
  });

  it('uses a concise PR metadata example instead of generic task placeholders', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null, 'main');
    expect(msg).toContain('--title "<short task title>"');
    expect(msg).toContain('Summary: <what the task does and how this implementation solves it');
    expect(msg).toContain(`Task: #${taskId}`);
    expect(msg).not.toContain(`gh pr create --title "Task #${taskId}" --body "Implementation for task #${taskId}"`);
  });

  it('references an existing PR URL when provided', async () => {
    const prUrl = 'https://github.com/foo/bar/pull/1';
    const msg = await generateYoloMessage(taskDocPath, taskId, prUrl, 'main');
    expect(msg).toContain(prUrl);
  });

  it('does not explicitly merge the PR', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null, 'main');
    expect(msg).toContain('Do NOT merge the PR');
  });
});

describe('generatePrAgentMessage (shared body refactor regression)', () => {
  it('still contains CI monitoring instructions after the refactor', async () => {
    const msg = await generatePrAgentMessage('/repo/.bottega/tasks/task-1.md', 1, null, 'main');
    expect(msg).toContain('gh pr checks');
    expect(msg).toContain('complete-pr.ts');
    expect(msg).toContain('Do NOT merge the PR');
  });

  it('requires a short PR title and concise summary for new pull requests', async () => {
    const msg = await generatePrAgentMessage('/repo/.bottega/tasks/task-1.md', 1, null, 'main');
    expect(msg).toContain('short specific title');
    expect(msg).toContain('concise summary body');
    expect(msg).toContain('--title "<short task title>"');
    expect(msg).toContain('Summary: <what the task does and how this implementation solves it');
    expect(msg).toContain('Keep this to a short paragraph');
    expect(msg).not.toContain('gh pr create --title "Task #1" --body "Implementation for task #1"');
  });
});

describe('PR/CI test policy', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-1.md';
  const taskId = 1;

  it('forbids re-running the full suite before opening or updating the PR', async () => {
    const msg = await generatePrAgentMessage(taskDocPath, taskId, null, 'main');
    expect(msg).toContain(
      '**Do NOT run the full suite before committing, creating, or updating the PR.**',
    );
    expect(msg).toContain('the review agent ran the full unit test suite on it and it passed');
  });

  it('still requires the full suite after the agent changes code itself', async () => {
    const msg = await generatePrAgentMessage(taskDocPath, taskId, null, 'main');
    expect(msg).toContain('**you changed code yourself**');
    expect(msg).toContain(
      '**Run the full unit test suite** — the rebased result is a combination of changes nobody has tested',
    );
    expect(msg).toContain(
      'Once the fix is complete, run the full unit test suite locally so the next CI run is the last one',
    );
  });

  it('resolves conflicts before monitoring CI, and completes only once CI passes', async () => {
    const msg = await generatePrAgentMessage(taskDocPath, taskId, null, 'main');
    const conflictIdx = msg.indexOf('### 2. Check for Merge Conflicts');
    const ciIdx = msg.indexOf('### 3. Monitor CI Status');
    // The early complete-pr.ts call is the "nothing to submit" bail-out; the
    // completion that ends the run sits behind a green CI check *and* the
    // worktree-clean gate.
    const completeIdx = msg.indexOf('### 5. Leave the Worktree Deletable, Then Complete');
    expect(conflictIdx).toBeGreaterThan(-1);
    expect(ciIdx).toBeGreaterThan(conflictIdx);
    expect(completeIdx).toBeGreaterThan(ciIdx);
  });

  it('tells the YOLO agent its Phase 3 run already covers the PR', async () => {
    const msg = await generateYoloMessage(taskDocPath, taskId, null, 'main');
    expect(msg).toContain(
      '**Do NOT re-run the full unit test suite before committing or creating the PR**',
    );
    expect(msg).toContain('Phase 3 already ran it and it passed');
  });
});

describe('generatePlanificationMessage', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-42.md';
  const taskId = 42;

  it('requires portable ask_user confirmation and tool-appropriate manual QA', async () => {
    const msg = await generatePlanificationMessage(taskDocPath, taskId, true);

    expect(msg).toContain("portable `ask_user` tool");
    expect(msg).toContain('Testing-strategy confirmation is still mandatory');
    expect(msg).toContain('Automated tests do not replace manual QA');
    expect(msg).toContain('Rails runner/console');
    expect(msg).not.toContain('clarifying questions (AskUserQuestion)');
  });

  it('renders the non-technical prompt when isTechnical is false', async () => {
    const msg = await generatePlanificationMessage(taskDocPath, taskId, false);
    expect(msg).not.toContain('JWT or sessions');
    expect(msg).not.toContain('ALWAYS propose a testing strategy and confirm with the user');
    expect(msg).toContain('non-technical');
    expect(msg.toLowerCase()).toContain('product and ux trade-offs only');
    expect(msg).toContain("portable `ask_user` tool");
    expect(msg).toContain('Automated tests do not replace manual QA');
    expect(msg).toContain('Rails runner/console');
  });

  it('substitutes taskDocPath and taskId in both modes', async () => {
    const techMsg = await generatePlanificationMessage(taskDocPath, taskId, true);
    const nonTechMsg = await generatePlanificationMessage(taskDocPath, taskId, false);
    for (const msg of [techMsg, nonTechMsg]) {
      expect(msg).toContain(taskDocPath);
      expect(msg).toContain(String(taskId));
      // The inlined <plan-template> block legitimately keeps its literal
      // {{ … }} placeholders; everything outside it must be fully rendered.
      const outsideTemplate = msg.replace(/<plan-template>[\s\S]*<\/plan-template>/, '');
      expect(outsideTemplate).not.toContain('{{');
    }
  });
});

describe('generateRefinementMessage', () => {
  it('compares only the ticket branch with its resolved base branch', async () => {
    const msg = await generateRefinementMessage('/archive/tasks/task-42.md', 42, 'epic/7-pricing');

    expect(msg).toContain('git diff origin/epic/7-pricing --name-only');
    expect(msg).toContain('git diff origin/epic/7-pricing');
    expect(msg).toContain('git log origin/epic/7-pricing..HEAD --oneline');
    expect(msg).not.toContain('git diff main');
  });
});

describe('generatePlanificationMessage — plan-template integration', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-42.md';
  const taskId = 42;

  it('inlines the bundled default template content when no override exists', async () => {
    const msg = await generatePlanificationMessage(taskDocPath, taskId);
    const block = msg.match(/<plan-template>([\s\S]*)<\/plan-template>/);
    expect(block).not.toBeNull();
    expect(block![1]).toContain('## Original Request');
    expect(block![1]).toContain('## Project Docs Update');
  });

  it('inlines the override content once a template override is saved', async () => {
    saveOverride('plan-template', '# CUSTOM PLAN SKELETON\n');
    const msg = await generatePlanificationMessage(taskDocPath, taskId);
    expect(msg).toContain('# CUSTOM PLAN SKELETON');
    expect(msg).not.toContain('## Project Docs Update');
  });

  it('falls back to the default content after the override is deleted', async () => {
    saveOverride('plan-template', '# CUSTOM PLAN SKELETON\n');
    deleteOverride('plan-template');
    const msg = await generatePlanificationMessage(taskDocPath, taskId);
    expect(msg).toContain('## Project Docs Update');
    expect(msg).not.toContain('CUSTOM PLAN SKELETON');
  });

  it('still renders a legacy planification override that uses {{planTemplatePath}}', async () => {
    saveOverride('planification', 'Legacy template ref: {{planTemplatePath}} for {{taskDocPath}}');
    const msg = await generatePlanificationMessage(taskDocPath, taskId);
    expect(msg).toContain(`for ${taskDocPath}`);
    expect(msg).toMatch(/Legacy template ref: \S+plan-template\.md/);
  });
});

// Regression for the CLAUDE.md pull-in leak: an @-file mention of a path inside
// the Bottega installation (e.g. @/…/templates/plan-template.md) makes the
// Claude Agent SDK attach Bottega's own reference/CLAUDE.md to the target
// repo's agent context. No generated agent message may contain an @-mention of
// a file path, and none may contain content from Bottega's project docs.
describe('agent messages never leak Bottega project docs into target repos', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-42.md';
  const taskId = 42;
  const prUrl = 'https://github.com/foo/bar/pull/1';
  // Epic feature branches are the interesting case: the base branch is
  // interpolated into the prompt, so it must not smuggle a path in either.
  const baseBranch = 'epic/7-pricing';

  // In a *rendered* message, an @-mention is an @ followed by a token
  // containing a path separator (@/abs/path, @~/home/path, @./relative).
  // Plain handles (@alice, @agent-Plan) don't match.
  const AT_FILE_MENTION = /(^|\s)@\S*\//;

  // In a *raw* prompt the path is still a {{placeholder}}, so it has no slash
  // yet — `@{{planTemplatePath}}`, the exact shape of the original bug. Any
  // `@` glued to a placeholder is a path reference waiting to be rendered.
  const AT_PLACEHOLDER_MENTION = /(^|\s)@\{\{/;

  // Distinctive strings from Bottega's reference/CLAUDE.md — the markers that
  // showed up in leaked transcripts during the Epics capstone QA.
  const CLAUDE_MD_MARKERS = [
    'sibling services it orchestrates',
    'journalctl --user -u bottega',
    '## Testing Instructions',
    'Web-based UI for the Claude Code CLI',
  ];

  async function allAgentMessages(): Promise<Array<[string, string]>> {
    return [
      ['planification', await generatePlanificationMessage(taskDocPath, taskId, true)],
      ['planification-nontechnical', await generatePlanificationMessage(taskDocPath, taskId, false)],
      ['implementation', await generateImplementationMessage(taskDocPath, taskId)],
      ['review', await generateReviewMessage(taskDocPath, taskId)],
      ['refinement', await generateRefinementMessage(taskDocPath, taskId, baseBranch)],
      ['pr', await generatePrAgentMessage(taskDocPath, taskId, null, baseBranch)],
      ['yolo', await generateYoloMessage(taskDocPath, taskId, null, baseBranch)],
      [
        'pr-feedback (comment)',
        await generatePrAgentCommentMessage(
          taskDocPath,
          taskId,
          prUrl,
          { commentBody: 'please fix', commentAuthor: 'alice' },
          baseBranch,
        ),
      ],
      [
        'pr-feedback (review)',
        await generatePrAgentReviewMessage(
          taskDocPath,
          taskId,
          prUrl,
          {
            reviewBody: 'needs work',
            reviewAuthor: 'bob',
            comments: [{ commentBody: 'typo', commentAuthor: 'bob' }],
          },
          baseBranch,
        ),
      ],
    ];
  }

  it('contains no @-file mention in any generated agent message', async () => {
    for (const [name, msg] of await allAgentMessages()) {
      expect(msg, `${name} message contains an @-file mention`).not.toMatch(AT_FILE_MENTION);
    }
  });

  it('contains no Bottega CLAUDE.md content in any generated agent message', async () => {
    for (const [name, msg] of await allAgentMessages()) {
      for (const marker of CLAUDE_MD_MARKERS) {
        expect(msg, `${name} message contains CLAUDE.md marker "${marker}"`).not.toContain(marker);
      }
    }
  });

  // Derived from the registry, not hardcoded, so a prompt added later (epic
  // stages, a new agent type) is covered by this guard automatically.
  it('no bundled default prompt or template @-references a file, literally or via a placeholder', () => {
    const names = listPromptNames();
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names) {
      const raw = loadDefault(name);
      expect(raw, `default ${name} contains a literal @-file mention`).not.toMatch(AT_FILE_MENTION);
      expect(raw, `default ${name} @-references a path placeholder`).not.toMatch(
        AT_PLACEHOLDER_MENTION,
      );
    }
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
    }, 'main');
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
    }, 'main');
    expect(msg).toContain('Comment Location');
    expect(msg).toContain('src/app.ts');
    expect(msg).toContain('line 42');
  });

  it('inlines the PR/CI procedure (merged prompt keeps CI monitoring)', async () => {
    const msg = await generatePrAgentCommentMessage(taskDocPath, taskId, prUrl, {
      commentBody: 'x',
      commentAuthor: 'alice',
    }, 'main');
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
    }, 'main');
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
    }, 'main');
    expect(msg).toContain('Address all of the feedback');
    expect(msg).toContain('gh pr checks');
    expect(msg).toContain(`complete-pr.ts ${taskId}`);
  });
});

// The non-technical guardrail: the project's "sensitive areas" list, wrapped in
// the escalation protocol, is injected into the non-technical planification
// prompt — only there, and only when the list is non-empty. On/off is decided
// here in code, never left to the agent.
describe('generatePlanificationMessage — sensitive-areas guardrail', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-42.md';
  const taskId = 42;
  const list = '- the orders tables and every query that reads them\n';

  it('omits the section when the project has no list', async () => {
    for (const empty of [null, undefined, '', '   \n\n']) {
      const msg = await generatePlanificationMessage(taskDocPath, taskId, false, empty);
      expect(msg).not.toContain('Sensitive areas');
      expect(msg).not.toContain('block-workflow.ts');
      expect(msg).not.toContain('{{sensitiveAreasSection}}');
    }
  });

  it('injects the list and the escalation protocol when the project has one', async () => {
    const msg = await generatePlanificationMessage(taskDocPath, taskId, false, list);
    expect(msg).toContain('## Sensitive areas');
    expect(msg).toContain('- the orders tables and every query that reads them');
    expect(msg).toContain('Ask a technical team member');
    expect(msg).toContain('Leave that part out');
    expect(msg).toContain('Use a simpler alternative');
    expect(msg).toContain('`ask_user`');
    expect(msg).toContain(`block-workflow.ts ${taskId}`);
    // Sits between the audience and the workflow steps it hooks into.
    expect(msg.indexOf('## Audience')).toBeLessThan(msg.indexOf('## Sensitive areas'));
    expect(msg.indexOf('## Sensitive areas')).toBeLessThan(msg.indexOf('## Planning Workflow'));
    const outsideTemplate = msg.replace(/<plan-template>[\s\S]*<\/plan-template>/, '');
    expect(outsideTemplate).not.toContain('{{');
  });

  it('never reaches the technical planification prompt', async () => {
    const msg = await generatePlanificationMessage(taskDocPath, taskId, true, list);
    expect(msg).not.toContain('Sensitive areas');
    expect(msg).not.toContain('block-workflow.ts');
  });

  it('is per project, not an instance-wide template', () => {
    expect(listPromptNames()).not.toContain('sensitive-areas');
    expect(listPromptNames()).toContain('planification-sensitive-areas');
  });

  it('keeps a pre-guardrail non-technical override rendering (placeholder not referenced)', async () => {
    saveOverride('planification-nontechnical', 'Legacy override for {{taskDocPath}} / {{taskId}}');
    const msg = await generatePlanificationMessage(taskDocPath, taskId, false, list);
    expect(msg).toBe(`Legacy override for ${taskDocPath} / ${taskId}`);
  });
});

// The defect this suite pins: the opening step used to branch into "create a PR"
// vs "a PR already exists at …, skip to step 2", and that second path checked
// for unpublished work nowhere. The review and refinement stages edit files and
// deliberately never commit, so taking it once meant signing a task off against
// a commit that predated their work — and the worktree that still held it is
// deleted when the PR merges.
describe('PR publish step — same procedure whether or not a PR exists', () => {
  const taskDocPath = '/repo/.bottega/tasks/task-7.md';
  const taskId = 7;
  const prUrl = 'https://github.com/foo/bar/pull/12';

  async function bothStates(): Promise<Array<[string, string]>> {
    return [
      ['pr (no PR yet)', await generatePrAgentMessage(taskDocPath, taskId, null, 'main')],
      ['pr (PR exists)', await generatePrAgentMessage(taskDocPath, taskId, prUrl, 'main')],
      ['yolo (no PR yet)', await generateYoloMessage(taskDocPath, taskId, null, 'main')],
      ['yolo (PR exists)', await generateYoloMessage(taskDocPath, taskId, prUrl, 'main')],
    ];
  }

  it('never tells the agent to skip the publish step because a PR exists', async () => {
    for (const [name, msg] of await bothStates()) {
      expect(msg, name).not.toContain('Skip to step 2');
      expect(msg, name).not.toContain('### 1. Verify PR Exists');
    }
  });

  it('inspects uncommitted files AND unpushed commits in both states', async () => {
    for (const [name, msg] of await bothStates()) {
      expect(msg, name).toContain('git status --porcelain --untracked-files=all');
      expect(msg, name).toContain('git log --oneline HEAD --not --remotes=origin');
    }
  });

  it('requires byproducts to be deleted rather than committed or gitignored', async () => {
    for (const [name, msg] of await bothStates()) {
      expect(msg, name).toContain('keep it or delete it');
      expect(msg, name).toContain('QA screenshots');
      expect(msg, name).toContain('scratch or one-off scripts');
      expect(msg, name).toContain('do not hide them behind a');
    }
  });

  it('verifies the PR head is the local HEAD in both states', async () => {
    for (const [name, msg] of await bothStates()) {
      expect(msg, name).toContain('gh pr view --json headRefOid --jq .headRefOid');
      expect(msg, name).toContain('git rev-parse HEAD');
    }
  });

  it('pushes in both states — the push is what updates an existing PR', async () => {
    for (const [name, msg] of await bothStates()) {
      expect(msg, name).toContain('git push -u origin HEAD');
    }
  });

  it('creates a PR only when none exists, and updates the open one otherwise', async () => {
    const created = await generatePrAgentMessage(taskDocPath, taskId, null, 'main');
    expect(created).toContain('gh pr create --base main');

    const updated = await generatePrAgentMessage(taskDocPath, taskId, prUrl, 'main');
    expect(updated).toContain(prUrl);
    expect(updated).toContain('there is nothing to create');
    expect(updated).not.toContain('gh pr create');
    expect(updated).toContain('gh pr edit');
  });

  it('re-checks the worktree after CI before completing, in every PR prompt', async () => {
    const pr = await generatePrAgentMessage(taskDocPath, taskId, prUrl, 'main');
    const yolo = await generateYoloMessage(taskDocPath, taskId, prUrl, 'main');
    const feedback = await generatePrAgentCommentMessage(
      taskDocPath,
      taskId,
      prUrl,
      { commentBody: 'please fix', commentAuthor: 'alice' },
      'main',
    );

    for (const [name, msg] of [
      ['pr', pr],
      ['yolo', yolo],
      ['pr-feedback', feedback],
    ] as Array<[string, string]>) {
      expect(msg, name).toContain('Leave the Worktree Deletable');
      // complete-pr.ts is reached only through that gate.
      const gateIdx = msg.indexOf('Leave the Worktree Deletable');
      expect(msg.lastIndexOf('complete-pr.ts'), name).toBeGreaterThan(gateIdx);
    }
  });

  it('tells the agent the gate is enforced, not advisory', async () => {
    // Collapse whitespace: these sentences are hard-wrapped in the markdown, so
    // the assertion must not depend on where the line breaks land.
    const flat = (text: string) => text.replace(/\s+/g, ' ');
    for (const [name, msg] of await bothStates()) {
      expect(flat(msg), name).toContain(
        '`complete-pr.ts` refuses to mark the stage complete while either one is non-empty',
      );
    }
  });
});
