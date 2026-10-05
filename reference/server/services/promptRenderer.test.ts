import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  render,
  extractVariables,
  findUnknownVariables,
  loadPrompt,
  loadDefault,
  saveOverride,
  deleteOverride,
  hasOverride,
  getOverrideMtime,
  listPromptNames,
  getPromptDefinition,
  getPromptsDir,
  getTemplatesDir,
  renderPrompt,
  resolvePromptPath,
  getAtlasStyleRefsDir
} from './promptRenderer.js';

describe('promptRenderer', () => {
  let archiveRoot: string;

  beforeEach(() => {
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-test-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
  });

  afterEach(() => {
    if (archiveRoot && fs.existsSync(archiveRoot)) {
      fs.rmSync(archiveRoot, { recursive: true, force: true });
    }
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
  });

  describe('render', () => {
    it('substitutes single {{var}}', () => {
      expect(render('hello {{name}}', { name: 'world' })).toBe('hello world');
    });

    it('substitutes multiple occurrences of the same var', () => {
      expect(render('{{x}} and {{x}}', { x: '5' })).toBe('5 and 5');
    });

    it('throws on missing variable', () => {
      expect(() => render('hi {{missing}}', {})).toThrow(/Missing prompt variable: missing/);
    });

    it('supplies the built-in scriptsDir, resolved from this install', () => {
      const scriptsDir = path.resolve(import.meta.dirname, '..', '..', 'scripts');
      expect(render('tsx {{scriptsDir}}/complete-plan.ts', {})).toBe(
        `tsx ${scriptsDir}/complete-plan.ts`,
      );
      expect(fs.existsSync(path.join(scriptsDir, 'complete-plan.ts'))).toBe(true);
      expect(findUnknownVariables('planification', '{{scriptsDir}}')).toEqual([]);
    });

    it('never ships a hard-coded install path in a default prompt', () => {
      for (const name of listPromptNames()) {
        expect(loadDefault(name), name).not.toMatch(/\/home\/\w+\//);
      }
    });

    it('renders nullish values as empty string', () => {
      expect(render('a{{x}}b', { x: null })).toBe('ab');
      expect(render('a{{x}}b', { x: undefined })).toBe('ab');
    });

    it('coerces non-string values', () => {
      expect(render('id={{id}}', { id: 42 })).toBe('id=42');
    });

    it('leaves malformed placeholders as literals', () => {
      expect(render('hi {{name', { name: 'x' })).toBe('hi {{name');
    });
  });

  describe('extractVariables', () => {
    it('returns deduplicated names', () => {
      expect(extractVariables('{{a}} {{b}} {{a}}')).toEqual(['a', 'b']);
    });

    it('returns empty for no placeholders', () => {
      expect(extractVariables('plain text')).toEqual([]);
    });
  });

  describe('findUnknownVariables', () => {
    it('returns empty when all vars are in the allowlist', () => {
      expect(findUnknownVariables('planification', 'hi {{taskDocPath}} {{taskId}}')).toEqual([]);
    });

    it('returns unknown names', () => {
      expect(findUnknownVariables('planification', 'hi {{taskDocPath}} {{bogus}} {{nope}}'))
        .toEqual(['bogus', 'nope']);
    });

    it('throws for unknown prompt name', () => {
      expect(() => findUnknownVariables('nonsense', '')).toThrow(/Unknown prompt/);
    });
  });

  describe('listPromptNames / getPromptDefinition', () => {
    it('registers every prompt in the definitions table', () => {
      const names = listPromptNames();
      expect(names).toContain('planification');
      expect(names).toContain('plan-template');
      expect(names).toContain('pr-feedback');
      // pr-comment + pr-review were merged into pr-feedback; _ci-instructions
      // was inlined into pr.md / yolo.md and removed.
      expect(names).not.toContain('pr-comment');
      expect(names).not.toContain('pr-review');
      expect(names).not.toContain('_ci-instructions');
      expect(names.length).toBeGreaterThanOrEqual(9);
    });

    it('returns null for unknown definition', () => {
      expect(getPromptDefinition('nope')).toBeNull();
    });

    it('returns labels and variables', () => {
      const def = getPromptDefinition('pr');
      expect(def!.label).toBe('PR Agent');
      expect(def!.variables).toContain('prPublishBlock');
      // Legacy: overrides written before the block stopped branching on "a PR
      // already exists" still reference the old name.
      expect(def!.variables).toContain('prCreateOrVerifyBlock');
    });

    it('marks plan-template as a template kind with no variables', () => {
      const def = getPromptDefinition('plan-template');
      expect(def!.kind).toBe('template');
      expect(def!.variables).toEqual([]);
    });

    it('exposes planTemplate (and legacy planTemplatePath) as allowed variables on planification prompts', () => {
      for (const name of ['planification', 'planification-nontechnical']) {
        expect(getPromptDefinition(name)!.variables).toContain('planTemplate');
        // Legacy: pre-inlining operator overrides may still use the path form.
        expect(getPromptDefinition(name)!.variables).toContain('planTemplatePath');
      }
    });

    it('the bundled planification defaults inline {{planTemplate}} and never @-reference a path', () => {
      for (const name of ['planification', 'planification-nontechnical']) {
        const content = loadDefault(name);
        expect(content).toContain('{{planTemplate}}');
        expect(content).not.toContain('@{{planTemplatePath}}');
        expect(findUnknownVariables(name, content)).toEqual([]);
      }
    });
  });

  describe('epic-architecture prompt', () => {
    const VARS = {
      epicId: 2,
      epicName: 'Nimbus Pricing',
      specDir: '/archive/epic-2/spec',
      specFileList: '- /archive/epic-2/spec/a.md',
      architectureDir: '/archive/epic-2/architecture',
      architectureFileList: '(none yet — this is the first pass)',
      repoPath: '/repos/nimbus',
    };

    it('is registered with the seven stage variables', () => {
      expect(listPromptNames()).toContain('epic-architecture');
      const def = getPromptDefinition('epic-architecture');
      expect(def!.kind).toBe('prompt');
      expect(def!.label).toBe('Epic: Architecture');
      expect(def!.variables).toEqual([
        'epicId',
        'epicName',
        'specDir',
        'specFileList',
        'architectureDir',
        'architectureFileList',
        'repoPath',
      ]);
    });

    it('bundles a default that asks for a topic-split document, not a diagram pair', () => {
      const content = loadPrompt('epic-architecture');
      expect(content).toContain('{{architectureDir}}');
      expect(content).toContain('{{architectureFileList}}');
      expect(content).toContain('mark_stage_complete({ stage: "architecture" })');
      expect(content).not.toContain('summary: "');
      // The three kinds of material a topic section is built from.
      expect(content).toMatch(/\*\*Text\*\*/);
      expect(content).toMatch(/\*\*A diagram\*\*/);
      expect(content).toMatch(/\*\*Code blocks\*\*/);
      expect(content).not.toContain('BEFORE');
      expect(content).not.toContain('flowchart LR');
      // The default must only use allowlisted variables.
      expect(findUnknownVariables('epic-architecture', content)).toEqual([]);
    });

    it('renders every variable and fails loud when one is omitted', () => {
      const rendered = renderPrompt('epic-architecture', VARS);
      expect(rendered).toContain('Nimbus Pricing');
      expect(rendered).toContain('/archive/epic-2/spec/a.md');
      expect(rendered).toContain('/archive/epic-2/architecture');
      expect(rendered).not.toContain('{{');

      const { architectureDir: _omitted, ...missingOne } = VARS;
      expect(() => renderPrompt('epic-architecture', missingOne)).toThrow(
        /Missing prompt variable: architectureDir/,
      );
    });
  });

  describe('epic-specification prompt', () => {
    const VARS = {
      epicId: 7,
      epicName: 'Nimbus Pricing',
      specDir: '/archive/epic-7/spec',
      specFileList: '- /archive/epic-7/spec/pricing.md',
      docsDir: '/archive/epic-7/docs',
      docsFileList: '(none yet — this is the first pass)',
      architectureDir: '/archive/epic-7/architecture',
      architectureFileList: '- /archive/epic-7/architecture/architecture.md',
      repoPath: '/repos/nimbus',
    };

    it('is registered with the nine stage variables', () => {
      expect(listPromptNames()).toContain('epic-specification');
      const def = getPromptDefinition('epic-specification');
      expect(def!.kind).toBe('prompt');
      expect(def!.label).toBe('Epic: Specification');
      expect(def!.variables).toEqual([
        'epicId',
        'epicName',
        'specDir',
        'specFileList',
        'docsDir',
        'docsFileList',
        'architectureDir',
        'architectureFileList',
        'repoPath',
      ]);
    });

    it('bundles a default that pins the document contract and the completion tool', () => {
      const content = loadPrompt('epic-specification');
      expect(content).toContain('00-master.md');
      expect(content).toContain('mark_stage_complete');
      expect(content).toContain('ask_user');
      // The default must only use allowlisted variables.
      expect(findUnknownVariables('epic-specification', content)).toEqual([]);
    });

    it('pins the two acceptance criteria: no open questions, entirely self-contained', () => {
      // The documents are the ONLY thing the implementing agents receive —
      // the conversation is lost. Both criteria, and the reason, must survive
      // prompt edits; so must the absence of any side channel for hand-off
      // notes (the `summary` argument was dropped on 2026-08-23).
      const content = loadPrompt('epic-specification');
      expect(content).toContain('**No open questions.**');
      expect(content).toContain('**Entirely self-contained.**');
      expect(content).toContain('**not this conversation**');
      expect(content).toContain('mark_stage_complete({ stage: "specification" })');
      expect(content).not.toContain('summary: "');
    });

    it('renders every variable and fails loud when one is omitted', () => {
      const rendered = renderPrompt('epic-specification', VARS);
      expect(rendered).toContain('Nimbus Pricing');
      expect(rendered).toContain('/archive/epic-7/docs');
      expect(rendered).toContain('/archive/epic-7/architecture/architecture.md');
      expect(rendered).not.toContain('{{');

      const { repoPath: _omitted, ...missingOne } = VARS;
      expect(() => renderPrompt('epic-specification', missingOne)).toThrow(
        /Missing prompt variable: repoPath/,
      );
    });
  });

  describe('epic-stories prompt', () => {
    const VARS = {
      epicId: 7,
      epicName: 'Nimbus Pricing',
      specDir: '/archive/epic-7/spec',
      docsDir: '/archive/epic-7/docs',
      docsFileList: '- /archive/epic-7/docs/00-master.md',
      repoPath: '/repos/nimbus',
    };

    it('is registered with the six stage variables', () => {
      expect(listPromptNames()).toContain('epic-stories');
      const def = getPromptDefinition('epic-stories');
      expect(def!.kind).toBe('prompt');
      expect(def!.label).toBe('Epic: Stories');
      expect(def!.variables).toEqual([
        'epicId',
        'epicName',
        'specDir',
        'docsDir',
        'docsFileList',
        'repoPath',
      ]);
    });

    it('bundles a default that pins discuss-before-creating and the ticket tools', () => {
      const content = loadPrompt('epic-stories');
      expect(content).toContain('create_task');
      expect(content).toContain('list_epic_tasks');
      expect(content).toContain('mark_stage_complete({ stage: "stories" })');
      expect(content).not.toContain('summary: "');
      expect(content).toContain('ask_user');
      // The isolation rule is the whole reason ticket descriptions are written
      // the way they are — it must survive prompt edits.
      expect(content).toContain('sees ONLY this description');
      expect(findUnknownVariables('epic-stories', content)).toEqual([]);
    });

    it('renders every variable and fails loud when one is omitted', () => {
      const rendered = renderPrompt('epic-stories', VARS);
      expect(rendered).toContain('Nimbus Pricing');
      expect(rendered).toContain('/archive/epic-7/docs/00-master.md');
      expect(rendered).not.toContain('{{');

      const { repoPath: _omitted, ...missingOne } = VARS;
      expect(() => renderPrompt('epic-stories', missingOne)).toThrow(
        /Missing prompt variable: repoPath/,
      );
    });
  });

  describe('epic-spec-review prompt', () => {
    const VARS = {
      epicId: 7,
      epicName: 'Nimbus Pricing',
      specDir: '/archive/epic-7/spec',
      specFileList: '- /archive/epic-7/spec/spec.md',
      architectureDir: '/archive/epic-7/architecture',
      architectureFileList: '- /archive/epic-7/architecture/architecture.md',
      docsDir: '/archive/epic-7/docs',
      docsFileList: '- /archive/epic-7/docs/00-master.md\n- /archive/epic-7/docs/01-pricing.md',
      ticketTable: '| 1 | #41 | Engine | pending | /archive/3/tasks/task-41.md |',
      reviewDir: '/archive/epic-7/review',
      reviewFileList: '(none — this is the first review)',
      repoPath: '/repos/nimbus',
    };

    it('is registered with the review variables', () => {
      expect(listPromptNames()).toContain('epic-spec-review');
      const def = getPromptDefinition('epic-spec-review');
      expect(def!.kind).toBe('prompt');
      expect(def!.label).toBe('Epic: Specification review');
      expect(def!.variables).toEqual(Object.keys(VARS));
    });

    it('bundles a default that pins the contract: review all three levels, settle with the user, apply what they approve, sign off on their word', () => {
      const content = loadPrompt('epic-spec-review');
      // The seven dimensions, at least by their headline pairings.
      expect(content).toContain('Functional spec → technical spec');
      expect(content).toContain('Architecture → technical spec');
      expect(content).toContain('against the code');
      expect(content).toContain('Technical spec → tickets');
      expect(content).toContain('Each ticket on its own');
      expect(content).toContain('Autonomy');
      // A consistency gate, not a design review.
      expect(content).toContain('What is NOT a finding');
      expect(content).toContain('not re-reviewing the design');
      // Two severities.
      expect(content).toContain('**Blocking**');
      expect(content).toContain('**Advisory**');
      expect(content).toContain('When in doubt between the two, it is blocking');
      // Review first, then STOP and wait — nothing is edited before the user speaks.
      expect(content).toContain('Present it in chat and stop');
      expect(content).toContain('Never edit a document or a ticket before the user has approved the finding');
      // Then it applies what the user approves, itself, at every level.
      expect(content).toContain('apply an approved finding **yourself, in place, at every level it touches**');
      expect(content).toContain('update_task');
      expect(content).toContain('Propagate');
      expect(content).toContain('Re-verify what you touched');
      // A conversation, not a verdict: questions are allowed and findings can be discarded.
      expect(content).toContain('ask_user');
      expect(content).toContain('discarded');
      expect(content).toContain('never decide a user\'s-call finding for them');
      // One report, one file; every document level is editable — the functional
      // spec included, on the user's confirmation — but never the repository.
      expect(content).toContain('{{reviewDir}}/review.md');
      expect(content).toContain(
        '**only** inside `{{reviewDir}}`, `{{specDir}}`, `{{architectureDir}}` and `{{docsDir}}`',
      );
      expect(content).toContain('**Functional specification** (`{{specDir}}`): when the user confirms');
      expect(content).toContain('Never write, edit or create a file in `{{repoPath}}`');
      expect(content).not.toContain('never edit');
      // Sign-off is the user's explicit go-ahead, with everything applied.
      expect(content).toContain('mark_stage_complete({ stage: "review" })');
      expect(content).toContain('Never call `mark_stage_complete` without the user\'s explicit go-ahead');
      expect(content).toContain('A report with zero findings still ends with you asking');
      // It reads the tickets live, and the shell stays read-only in the main checkout.
      expect(content).toContain('list_epic_tasks');
      expect(content).toContain('never changes the state of `{{repoPath}}`');
      expect(findUnknownVariables('epic-spec-review', content)).toEqual([]);
    });

    it('renders every variable and fails loud when one is omitted', () => {
      const rendered = renderPrompt('epic-spec-review', VARS);
      expect(rendered).toContain('Nimbus Pricing');
      expect(rendered).toContain('/archive/epic-7/review/review.md');
      expect(rendered).toContain('/archive/3/tasks/task-41.md');
      expect(rendered).toContain('(none — this is the first review)');
      expect(rendered).not.toContain('{{');

      const { reviewDir: _omitted, ...missingOne } = VARS;
      expect(() => renderPrompt('epic-spec-review', missingOne)).toThrow(
        /Missing prompt variable: reviewDir/,
      );
    });
  });

  describe('epic-orchestrator prompt', () => {
    it('hands the pull request off and never merges — the reviewer owns that stage', () => {
      const content = loadPrompt('epic-orchestrator');
      expect(content).toContain('start_pr_review');
      expect(content).toContain('pr-review-ended');
      expect(content).toContain('Never merge a pull request yourself');
      expect(content).not.toContain('get_pr_diff');
      expect(content).not.toContain('request_pr_changes');
      expect(content).not.toContain('merge_task');
      expect(findUnknownVariables('epic-orchestrator', content)).toEqual([]);
    });

    it('requires a tool-appropriate manual QA gate before implementation approval', () => {
      const content = loadPrompt('epic-orchestrator');

      expect(content).toContain('Then perform the **QA gate** before approval');
      expect(content).toContain('Rails runner/console');
      expect(content).toContain('Automated tests and manual QA are');
      expect(content).toContain('Backend-only work, a refactor, passing automated tests');
    });
  });

  describe('manual QA prompt contract', () => {
    it('keeps the plan template and review prompt tool-neutral', () => {
      const planTemplate = loadPrompt('plan-template');
      const review = loadPrompt('review');

      expect(planTemplate).toContain('### Manual QA');
      expect(planTemplate).toContain('Rails runner');
      expect(planTemplate).not.toContain('### Manual / Playwright MCP testing');
      expect(review).toContain('### 4. Manual QA');
      expect(review).toContain('Manual QA is tool-neutral');
      expect(review).toContain('Rails runner/console');
      expect(review).not.toContain('### 4. Manual Testing with Playwright MCP');
    });
  });

  describe('epic-pr-review prompt', () => {
    const VARS = {
      epicId: 7,
      epicName: 'Nimbus Pricing',
      ticketTaskId: 42,
      ticketTitle: 'Render the pricing section',
      ticketPosition: 2,
      ticketCount: 3,
      ticketDoc: '# Ticket\n\nRender #pricing.',
      taskDocPath: '/archive/3/tasks/task-42.md',
      masterDoc: '# Master\n\n| 1 | 01-pricing.md |',
      docsDir: '/archive/epic-7/docs',
      storyTable: '| 1 | #41 | Engine | completed |',
      outcomeNotes: '### #41 — Engine\n\nmonthlyCost is the entry point.',
      worktreePath: '/repos/nimbus-worktrees/task-42',
      prUrl: 'https://github.com/o/r/pull/9',
      baseBranch: 'epic/7-nimbus-pricing',
    };

    it('is registered with the review variables', () => {
      expect(listPromptNames()).toContain('epic-pr-review');
      const def = getPromptDefinition('epic-pr-review');
      expect(def!.kind).toBe('prompt');
      expect(def!.label).toBe('Epic: PR reviewer');
      expect(def!.variables).toEqual(Object.keys(VARS));
    });

    it('bundles a default that pins the three decisions: spec is truth, fix in place, bounded CI then block', () => {
      const content = loadPrompt('epic-pr-review');
      // The specification is the source of truth — never challenged, never
      // escalated, and the reviewer never asks the user.
      expect(content).toContain('The specification is the source of truth');
      expect(content).toContain('never ask the user');
      expect(content).not.toContain('AskUserQuestion');
      expect(content).not.toContain('request_pr_changes');
      // It fixes what it finds itself, inside the ticket's scope.
      expect(content).toContain('Fix everything you found — yourself');
      expect(content).toContain("This ticket's scope only");
      // The bounded CI loop, the rebase procedure, and the one exit.
      expect(content).toContain('At most **10** fix rounds');
      expect(content).toContain('--force-with-lease');
      expect(content).toContain('block_epic');
      expect(content).toMatch(/never\s+merge red/);
      // It merges through the tool, never by hand, and runs tests in the foreground.
      expect(content).toContain('merge_task');
      expect(content).toContain('Do not run `complete-pr.ts`');
      expect(content).toContain('in the foreground');
      expect(findUnknownVariables('epic-pr-review', content)).toEqual([]);
    });

    it('renders every variable and fails loud when one is omitted', () => {
      const rendered = renderPrompt('epic-pr-review', VARS);
      expect(rendered).toContain('ticket 2 of 3');
      expect(rendered).toContain('#42 — Render the pricing section');
      expect(rendered).toContain('/repos/nimbus-worktrees/task-42');
      expect(rendered).toContain('https://github.com/o/r/pull/9');
      expect(rendered).toContain('origin/epic/7-nimbus-pricing');
      expect(rendered).toContain('monthlyCost is the entry point.');
      expect(rendered).not.toContain('{{');

      const { prUrl: _omitted, ...missingOne } = VARS;
      expect(() => renderPrompt('epic-pr-review', missingOne)).toThrow(
        /Missing prompt variable: prUrl/,
      );
    });
  });

  describe('loadPrompt fallback chain', () => {
    it('returns default when no override', () => {
      const content = loadPrompt('implementation');
      expect(content).toContain('@agent-Implement');
    });

    it('returns override when present', () => {
      saveOverride('implementation', 'CUSTOM IMPL CONTENT {{taskId}}');
      expect(loadPrompt('implementation')).toBe('CUSTOM IMPL CONTENT {{taskId}}');
    });

    it('falls back after delete', () => {
      saveOverride('implementation', 'CUSTOM');
      deleteOverride('implementation');
      expect(loadPrompt('implementation')).toContain('@agent-Implement');
    });
  });

  describe('saveOverride / deleteOverride / hasOverride / mtime', () => {
    it('hasOverride flips after save and delete', () => {
      expect(hasOverride('review')).toBe(false);
      saveOverride('review', 'x');
      expect(hasOverride('review')).toBe(true);
      deleteOverride('review');
      expect(hasOverride('review')).toBe(false);
    });

    it('deleteOverride is idempotent', () => {
      expect(deleteOverride('review')).toBe(false);
    });

    it('mtime returns null without override and a number with one', () => {
      expect(getOverrideMtime('review')).toBeNull();
      saveOverride('review', 'x');
      expect(typeof getOverrideMtime('review')).toBe('number');
    });

    it('saveOverride creates the prompts dir if missing', () => {
      saveOverride('review', 'x');
      expect(fs.existsSync(getPromptsDir())).toBe(true);
    });

    it('throws on unknown prompt name to block path traversal', () => {
      expect(() => saveOverride('../etc/passwd', 'x')).toThrow(/Unknown prompt/);
    });
  });

  describe('loadDefault', () => {
    it('reads bundled default file', () => {
      expect(loadDefault('planification')).toContain('@agent-Plan');
    });

    it('throws for unknown prompt', () => {
      expect(() => loadDefault('nope')).toThrow();
    });
  });

  describe('renderPrompt', () => {
    it('loads and renders the implementation prompt', () => {
      const out = renderPrompt('implementation', { taskDocPath: '/x/y.md', taskId: 7 });
      expect(out).toContain('/x/y.md');
      expect(out).toContain('Start implementing now.');
    });

    it('renders the pr prompt with the inlined PR/CI block', () => {
      const out = renderPrompt('pr', {
        taskDocPath: '/x/y.md',
        taskId: 99,
        prContextLine: '- No PR exists yet',
        prPublishBlock: '### 1. PUBLISH BLOCK CONTENT',
        baseBranch: 'main',
      });
      expect(out).toContain('### 1. PUBLISH BLOCK CONTENT');
      expect(out).toContain('complete-pr.ts 99');
      expect(out).toContain('gh pr checks');
    });

    it('rebases onto the resolved base branch, not a hardcoded origin/main', () => {
      const out = renderPrompt('pr', {
        taskDocPath: '/x/y.md',
        taskId: 99,
        prContextLine: '- No PR exists yet',
        prPublishBlock: '### block',
        baseBranch: 'epic/8-nimbus',
      });
      expect(out).toContain('git fetch origin epic/8-nimbus && git rebase origin/epic/8-nimbus');
      expect(out).not.toContain('origin/main');
    });

    it('renders an operator override that predates {{baseBranch}} unchanged', () => {
      // render() only throws on template vars missing from the dict, never the
      // reverse — so an override written before Phase 3 keeps working (with
      // its own hardcoded base).
      saveOverride('pr', 'Old override: git rebase origin/main for task {{taskId}}\n');
      const out = renderPrompt('pr', {
        taskDocPath: '/x/y.md',
        taskId: 99,
        prContextLine: '- x',
        prPublishBlock: '### block',
        baseBranch: 'epic/8-nimbus',
      });
      expect(out).toBe('Old override: git rebase origin/main for task 99\n');
      deleteOverride('pr');
    });

    it('accepts {{baseBranch}} in a pr / yolo / pr-feedback override', () => {
      for (const name of ['pr', 'yolo', 'pr-feedback']) {
        expect(findUnknownVariables(name, 'rebase onto {{baseBranch}}')).toEqual([]);
      }
    });
  });

  describe('templates (kind: "template")', () => {
    it('loads the bundled default plan-template', () => {
      const content = loadDefault('plan-template');
      expect(content).toContain('## Original Request');
    });

    it('saveOverride for a template writes under templates/, not prompts/', () => {
      saveOverride('plan-template', '# Custom plan template\n');
      expect(fs.existsSync(path.join(archiveRoot, 'templates', 'plan-template.md'))).toBe(true);
      expect(fs.existsSync(path.join(archiveRoot, 'prompts', 'plan-template.md'))).toBe(false);
    });

    it('saveOverride creates the templates dir if missing', () => {
      saveOverride('plan-template', 'x');
      expect(fs.existsSync(getTemplatesDir())).toBe(true);
    });

    it('loadPrompt returns the template override when set, default otherwise', () => {
      expect(loadPrompt('plan-template')).toContain('## Original Request');
      saveOverride('plan-template', '# CUSTOM');
      expect(loadPrompt('plan-template')).toBe('# CUSTOM');
      deleteOverride('plan-template');
      expect(loadPrompt('plan-template')).toContain('## Original Request');
    });

    it('findUnknownVariables is a no-op for templates (markers are literal text)', () => {
      // Templates are read as-is by the agent, never rendered. Any {{ … }} inside
      // them is literal markdown and must NOT be flagged as an unknown variable.
      expect(findUnknownVariables('plan-template', '{{ task title }} {{ anything else }}')).toEqual([]);
    });
  });

  describe('resolvePromptPath', () => {
    it('returns the bundled default path when no override exists', () => {
      const p = resolvePromptPath('plan-template');
      expect(p).toMatch(/server\/constants\/templates\/plan-template\.md$/);
    });

    it('returns the override path under the archive root once an override is saved', () => {
      saveOverride('plan-template', '# CUSTOM');
      const p = resolvePromptPath('plan-template');
      expect(p).toBe(path.join(archiveRoot, 'templates', 'plan-template.md'));
    });

    it('falls back to the default path after the override is deleted', () => {
      saveOverride('plan-template', '# CUSTOM');
      deleteOverride('plan-template');
      const p = resolvePromptPath('plan-template');
      expect(p).toMatch(/server\/constants\/templates\/plan-template\.md$/);
    });
  });

  describe('atlas-artifact prompt', () => {
    it('is registered with its four variables', () => {
      const def = getPromptDefinition('atlas-artifact');
      expect(def).not.toBeNull();
      expect(def!.kind).toBe('prompt');
      expect(def!.variables).toEqual(['taskDocPath', 'taskId', 'kind', 'styleRefsDir']);
    });

    it('substitutes every variable when rendered', () => {
      const out = renderPrompt('atlas-artifact', {
        taskDocPath: '/docs/task-7.md',
        taskId: 7,
        kind: 'auto',
        styleRefsDir: '/refs',
      });
      expect(out).toContain('/docs/task-7.md');
      expect(out).toContain('task #7');
      expect(out).toContain('/refs');
      // No unsubstituted markers left behind.
      expect(out).not.toMatch(/\{\{\w+\}\}/);
    });

    it('reflects the chosen kind in the rendered text (auto vs concrete)', () => {
      const auto = renderPrompt('atlas-artifact', {
        taskDocPath: '/d',
        taskId: 1,
        kind: 'auto',
        styleRefsDir: '/r',
      });
      expect(auto).toContain('The requested kind is: **auto**');

      const flow = renderPrompt('atlas-artifact', {
        taskDocPath: '/d',
        taskId: 1,
        kind: 'flowchart',
        styleRefsDir: '/r',
      });
      expect(flow).toContain('The requested kind is: **flowchart**');
    });

    it('the default file declares no unknown variables', () => {
      const content = loadDefault('atlas-artifact');
      expect(findUnknownVariables('atlas-artifact', content)).toEqual([]);
    });
  });

  describe('getAtlasStyleRefsDir', () => {
    it('points at the vendored style-refs corpus under server/constants', () => {
      expect(getAtlasStyleRefsDir()).toMatch(/server\/constants\/atlas-style-refs$/);
    });
  });
  describe('epic-qa-scenarios prompt', () => {
    const VARS = {
      epicId: 7,
      epicName: 'Nimbus Pricing',
      specDir: '/archive/epic-7/spec',
      specFileList: '- /archive/epic-7/spec/spec.md',
      architectureDir: '/archive/epic-7/architecture',
      architectureFileList: '- /archive/epic-7/architecture/architecture.md',
      docsDir: '/archive/epic-7/docs',
      docsFileList: '- /archive/epic-7/docs/00-master.md',
      ticketTable: '| 1 | #41 | Engine | completed | /archive/3/tasks/task-41.md |',
      qaDir: '/archive/epic-7/qa',
      qaCsvPath: '/archive/epic-7/qa/scenarios.csv',
      qaCsvState: 'none yet — this is the first pass',
      repoPath: '/repos/nimbus',
    };

    it('is registered with the scenario variables', () => {
      expect(listPromptNames()).toContain('epic-qa-scenarios');
      const def = getPromptDefinition('epic-qa-scenarios');
      expect(def!.kind).toBe('prompt');
      expect(def!.label).toBe('Epic: QA scenarios');
      expect(def!.variables).toEqual(Object.keys(VARS));
    });

    it('bundles a default that pins the contract: exhaustive coverage, structured writes, present-and-stop, sign off on approval only', () => {
      const content = loadPrompt('epic-qa-scenarios');
      // Coverage is the point: every control, every state combination.
      expect(content).toContain('Every user-visible control');
      expect(content).toContain('Every state combination');
      expect(content).toMatch(/scheduled, ongoing,\s+past or future/);
      expect(content).toContain('Error paths');
      // The CSV contract, and who owns the result columns.
      expect(content).toContain('id,feature,title,steps,expected,status,confidence,notes');
      expect(content).toContain('never renumber');
      expect(content).toContain('They belong to execution');
      // Writes flow only through the structured tools.
      expect(content).toContain('write_qa_scenarios');
      expect(content).toContain('delete_qa_scenarios');
      // Present a summary and stop — the CSV itself never lands in chat.
      expect(content).toContain('Present a summary in chat and stop');
      expect(content).toContain('Never paste the CSV');
      // Sign-off is the user's explicit word.
      expect(content).toContain('mark_stage_complete');
      expect(content).toContain('a message with no feedback is not approval');
      // The shell reads; the repository is never written.
      expect(content).toContain('never changes the checkout');
      expect(findUnknownVariables('epic-qa-scenarios', content)).toEqual([]);
    });

    it('renders every variable and fails loud when one is omitted', () => {
      const rendered = renderPrompt('epic-qa-scenarios', VARS);
      expect(rendered).toContain('Nimbus Pricing');
      expect(rendered).toContain('/archive/epic-7/qa/scenarios.csv');
      expect(rendered).toContain('none yet — this is the first pass');
      expect(rendered).not.toContain('{{');

      const { qaCsvState: _omitted, ...missingOne } = VARS;
      expect(() => renderPrompt('epic-qa-scenarios', missingOne)).toThrow(
        /Missing prompt variable: qaCsvState/,
      );
    });
  });

  describe('epic-qa-execution prompt', () => {
    const VARS = {
      epicId: 7,
      epicName: 'Nimbus Pricing',
      worktreePath: '/repos/nimbus-worktrees/epic-7',
      featureBranch: 'epic/7-nimbus-pricing',
      devServerPort: 4107,
      qaCsvPath: '/archive/epic-7/qa/scenarios.csv',
      qaProgress: '12 scenario(s): 3 pass, 1 fail, 8 not run. Resume at the first not-run scenario, S-005.',
      docsDir: '/archive/epic-7/docs',
      docsFileList: '- /archive/epic-7/docs/00-master.md',
      repoPath: '/repos/nimbus',
    };

    it('is registered with the execution variables', () => {
      expect(listPromptNames()).toContain('epic-qa-execution');
      const def = getPromptDefinition('epic-qa-execution');
      expect(def!.kind).toBe('prompt');
      expect(def!.label).toBe('Epic: QA execution');
      expect(def!.variables).toEqual(Object.keys(VARS));
    });

    it('bundles a default that pins the contract: worktree read-only, record per batch, evidence-graded confidence, resumable', () => {
      const content = loadPrompt('epic-qa-execution');
      // The worktree runs the app and is never mutated.
      expect(content).toContain('change\n  **nothing**');
      expect(content).toContain('record results ONLY through `record_qa_results`');
      expect(content).toMatch(/You may not add, remove or\s+reword scenarios/);
      // Progress must survive an interrupted turn.
      expect(content).toContain('immediately after each\nscenario or small batch');
      // The confidence rubric with the two canonical examples.
      expect(content).toContain('a deterministic check');
      expect(content).toContain('a judgment call');
      expect(content).toContain('screenshot');
      // Pass needs direct evidence; failures need repro-grade notes.
      expect(content).toContain('direct evidence');
      expect(content).toContain('expected vs observed');
      expect(content).toContain('never guess');
      // The dev server lives inside a turn, on the assigned port.
      expect(content).toContain('{{devServerPort}}');
      expect(content).toContain('kill only the server you started');
      // There is no stage — the filled book is the outcome, and continuation
      // is automatic: end cleanly, never retry rows you cannot execute.
      expect(content).toContain('Continuation is automatic');
      expect(content).toContain('a fresh run at the first not-run row');
      expect(content).toContain('records nothing new stops the automatic');
      expect(content).toMatch(/no stage to sign\s+off/);
      expect(findUnknownVariables('epic-qa-execution', content)).toEqual([]);
    });

    it('renders every variable and fails loud when one is omitted', () => {
      const rendered = renderPrompt('epic-qa-execution', VARS);
      expect(rendered).toContain('/repos/nimbus-worktrees/epic-7');
      expect(rendered).toContain('4107');
      expect(rendered).toContain('Resume at the first not-run scenario, S-005.');
      expect(rendered).not.toContain('{{');

      const { qaProgress: _omitted, ...missingOne } = VARS;
      expect(() => renderPrompt('epic-qa-execution', missingOne)).toThrow(
        /Missing prompt variable: qaProgress/,
      );
    });
  });

  describe('epic-qa-fix prompt', () => {
    const VARS = {
      epicId: 7,
      epicName: 'Nimbus Pricing',
      repoPath: '/repos/nimbus',
      deliveryWorktreePath: '/repos/nimbus-worktrees/epic-7',
      featureBranch: 'epic/7-nimbus-pricing',
      devServerPort: 4107,
      qaCsvPath: '/archive/epic-7/qa/scenarios.csv',
      failCount: 3,
      failedScenarios: '### S-039 — Shortcut creates a gift',
      masterDoc: 'The pricing engine…',
      docsDir: '/archive/epic-7/docs',
      docsFileList: '- /archive/epic-7/docs/00-master.md',
      storyTable: '| 1 | #42 | Pricing | completed |',
    };

    it('is registered with the fix-mission variables', () => {
      expect(listPromptNames()).toContain('epic-qa-fix');
      const def = getPromptDefinition('epic-qa-fix');
      expect(def!.kind).toBe('prompt');
      expect(def!.label).toBe('Epic: QA fix');
      expect(def!.variables).toEqual(Object.keys(VARS));
    });

    it('bundles a default that pins the contract: dormant supervision, one ticket, self-review + merge, re-test', () => {
      const content = loadPrompt('epic-qa-fix');
      // The dormant/wake model, verbatim from the orchestrator's.
      expect(content).toContain('one turn per event');
      expect(content).toContain('[bottega-event]');
      // One fix ticket per mission; adopt, never duplicate.
      expect(content).toContain('create_fix_ticket');
      expect(content).toContain('adopt_fix_ticket');
      expect(content).toContain('never create a duplicate');
      // It reviews and merges the PR itself.
      expect(content).toMatch(/YOU are the\s+reviewer/);
      expect(content).toContain('merge_task');
      expect(content).toMatch(/Never `gh pr merge`/);
      // The re-test after the merge, self-recorded.
      expect(content).toContain('git pull --ff-only');
      expect(content).toContain('record_qa_results');
      expect(content).toContain('never a pass you did not see');
      // The main checkout stays untouched; notify_user is the only channel.
      expect(content).toContain('MAIN checkout');
      expect(content).toContain('notify_user');
      expect(findUnknownVariables('epic-qa-fix', content)).toEqual([]);
    });

    it('renders every variable and fails loud when one is omitted', () => {
      const rendered = renderPrompt('epic-qa-fix', VARS);
      expect(rendered).toContain('Nimbus Pricing');
      expect(rendered).toContain('### S-039 — Shortcut creates a gift');
      expect(rendered).toContain('4107');
      expect(rendered).not.toContain('{{');

      const { failedScenarios: _omitted, ...missingOne } = VARS;
      expect(() => renderPrompt('epic-qa-fix', missingOne)).toThrow(
        /Missing prompt variable: failedScenarios/,
      );
    });
  });
});

// The non-technical guardrail's registry entry: the protocol prompt that wraps
// a project's sensitive-areas list. The list itself lives on the project row,
// not in a template.
describe('sensitive-areas guardrail definition', () => {
  let archiveRoot: string;

  beforeEach(() => {
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-guardrail-test-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
  });

  afterEach(() => {
    if (archiveRoot && fs.existsSync(archiveRoot)) {
      fs.rmSync(archiveRoot, { recursive: true, force: true });
    }
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
  });

  it('registers the protocol prompt with exactly the variables the builder supplies', () => {
    const def = getPromptDefinition('planification-sensitive-areas');
    expect(def).not.toBeNull();
    expect(def!.kind).toBe('prompt');
    expect(def!.variables).toEqual(['sensitiveAreas', 'taskId']);
    expect(def!.description).toMatch(/project/);
    expect(
      findUnknownVariables('planification-sensitive-areas', loadDefault('planification-sensitive-areas')),
    ).toEqual([]);

    const rendered = renderPrompt('planification-sensitive-areas', {
      sensitiveAreas: '- the orders tables',
      taskId: 42,
    });
    expect(rendered).toContain('<sensitive-areas>\n- the orders tables\n</sensitive-areas>');
    expect(rendered).toContain('block-workflow.ts 42');
    expect(rendered).not.toContain('{{');
    expect(() => renderPrompt('planification-sensitive-areas', { sensitiveAreas: 'x' })).toThrow(
      /Missing prompt variable: taskId/,
    );
  });

  it('registers no instance-wide sensitive-areas template', () => {
    expect(listPromptNames()).not.toContain('sensitive-areas');
    expect(getPromptDefinition('sensitive-areas')).toBeNull();
  });

  it('lets only the non-technical planification prompt reference {{sensitiveAreasSection}}', () => {
    expect(getPromptDefinition('planification-nontechnical')!.variables).toContain('sensitiveAreasSection');
    expect(
      findUnknownVariables('planification-nontechnical', loadDefault('planification-nontechnical')),
    ).toEqual([]);
    expect(findUnknownVariables('planification', '{{sensitiveAreasSection}}')).toEqual([
      'sensitiveAreasSection',
    ]);
  });
});
