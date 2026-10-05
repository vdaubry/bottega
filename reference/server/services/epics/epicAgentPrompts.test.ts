import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockListSpecFiles,
  mockListDocs,
  mockListArchitectureDocs,
  mockListReviewDocs,
  mockTasksGetByEpic,
  mockReadEpicDoc,
  mockReadOutcome,
  mockReadTaskDoc,
  mockReadEpicQaFile,
} = vi.hoisted(() => ({
  mockListSpecFiles: vi.fn(),
  mockListDocs: vi.fn(),
  mockListArchitectureDocs: vi.fn(),
  mockListReviewDocs: vi.fn(),
  mockTasksGetByEpic: vi.fn(),
  mockReadEpicDoc: vi.fn(),
  mockReadOutcome: vi.fn(),
  mockReadTaskDoc: vi.fn(),
  mockReadEpicQaFile: vi.fn(),
}));

// The module imports `tasksDb` (for the per-ticket messages); never let the
// real database module load here.
vi.mock('../../database/epics.js', () => ({
  epicTicketsDb: { listTickets: mockTasksGetByEpic },
}));

vi.mock('../documentation.js', () => ({
  getTaskDocPath: (p: number, t: number) => `/archive/${p}/tasks/task-${t}.md`,
  readTaskDoc: mockReadTaskDoc,
}));

vi.mock('./epicArchive.js', () => ({
  getEpicSpecDir: (p: number, e: number) => `/archive/${p}/epics/epic-${e}/spec`,
  getEpicArchitectureDir: (p: number, e: number) => `/archive/${p}/epics/epic-${e}/architecture`,
  getEpicDocsDir: (p: number, e: number) => `/archive/${p}/epics/epic-${e}/docs`,
  getEpicReviewDir: (p: number, e: number) => `/archive/${p}/epics/epic-${e}/review`,
  listEpicSpecFiles: mockListSpecFiles,
  listEpicArchitectureDocs: mockListArchitectureDocs,
  listEpicDocs: mockListDocs,
  listEpicReviewDocs: mockListReviewDocs,
  readEpicDoc: mockReadEpicDoc,
  readEpicTaskOutcome: mockReadOutcome,
  readEpicQaFile: mockReadEpicQaFile,
  getEpicQaFilePath: (p: number, e: number, f: string) =>
    `/archive/${p}/epics/epic-${e}/qa/${f}`,
}));

import {
  generateEpicArchitectureMessage,
  generateEpicSpecificationMessage,
  generateEpicStoriesMessage,
  generateEpicSpecReviewMessage,
  generateEpicPrReviewMessage,
  generateEpicDeliveryMessage,
  generateEpicQaFixMessage,
} from './epicAgentPrompts.js';
import type { EpicDeliveryContext } from './epicAgentPrompts.js';
import { serializeQaScenarios } from '@shared/schemas/qa';
import type { EpicWithProject } from '../../database/epics.js';

const EPIC = {
  id: 7,
  project_id: 3,
  name: 'Nimbus Pricing',
  repo_folder_path: '/repos/nimbus',
} as EpicWithProject;

beforeEach(() => {
  vi.clearAllMocks();
  mockListSpecFiles.mockReturnValue([{ name: 'pricing.md' }]);
  mockListDocs.mockReturnValue([]);
  mockListArchitectureDocs.mockReturnValue([{ name: 'architecture.md' }]);
  mockListReviewDocs.mockReturnValue([]);
  mockTasksGetByEpic.mockReturnValue([]);
});

describe('generateEpicSpecificationMessage', () => {
  it('hands over absolute spec paths, the docs directory and the repo', () => {
    const message = generateEpicSpecificationMessage(EPIC);

    expect(message).toContain('epic #7');
    expect(message).toContain('Nimbus Pricing');
    expect(message).toContain('- /archive/3/epics/epic-7/spec/pricing.md');
    expect(message).toContain('/archive/3/epics/epic-7/docs');
    expect(message).toContain('/repos/nimbus');
    expect(message).not.toContain('{{');
  });

  it('lists the architecture document by absolute path rather than inlining it', () => {
    mockListArchitectureDocs.mockReturnValue([
      { name: '01-overview.md' },
      { name: '02-pricing-engine.md' },
    ]);

    const message = generateEpicSpecificationMessage(EPIC);

    expect(message).toContain('- /archive/3/epics/epic-7/architecture/01-overview.md');
    expect(message).toContain('- /archive/3/epics/epic-7/architecture/02-pricing-engine.md');
    expect(message).not.toContain('```mermaid');
  });

  it('says so when no architecture document was written', () => {
    mockListArchitectureDocs.mockReturnValue([]);

    const message = generateEpicSpecificationMessage(EPIC);

    expect(message).toContain('no architecture document was written');
  });

  it('is revision-aware: a re-run lists the documents already written', () => {
    mockListDocs.mockReturnValue([{ name: '00-master.md' }, { name: '01-data-model.md' }]);

    const message = generateEpicSpecificationMessage(EPIC);

    expect(message).toContain('- /archive/3/epics/epic-7/docs/00-master.md');
    expect(message).toContain('- /archive/3/epics/epic-7/docs/01-data-model.md');
    expect(message).not.toContain('this is the first pass');
  });

  it('tells a first run that the documents directory is empty', () => {
    expect(generateEpicSpecificationMessage(EPIC)).toContain('this is the first pass');
  });

  it('refuses to guess when no functional specification was uploaded', () => {
    mockListSpecFiles.mockReturnValue([]);

    expect(generateEpicSpecificationMessage(EPIC)).toContain(
      'No specification files were uploaded',
    );
  });
});

describe('generateEpicStoriesMessage', () => {
  it('lists the specification documents it must split', () => {
    mockListDocs.mockReturnValue([{ name: '00-master.md' }, { name: '01-data-model.md' }]);

    const message = generateEpicStoriesMessage(EPIC);

    expect(message).toContain('epic #7');
    expect(message).toContain('- /archive/3/epics/epic-7/docs/00-master.md');
    expect(message).toContain('- /archive/3/epics/epic-7/docs/01-data-model.md');
    expect(message).toContain('/repos/nimbus');
    expect(message).not.toContain('{{');
  });

  it('tells the agent to stop when the specification stage produced nothing', () => {
    expect(generateEpicStoriesMessage(EPIC)).toContain('there is nothing to split');
  });

  it('does not snapshot the ticket list — list_epic_tasks is the live source', () => {
    const message = generateEpicStoriesMessage(EPIC);

    expect(message).toContain('list_epic_tasks');
    expect(message).not.toContain('Existing tickets');
  });
});

describe('generateEpicSpecReviewMessage', () => {
  const tickets = [
    { id: 41, epic_id: 7, position: 1, title: 'Pricing engine', status: 'pending' },
    { id: 42, epic_id: 7, position: 2, title: 'Pricing section', status: 'pending' },
  ] as never;

  beforeEach(() => {
    mockListDocs.mockReturnValue([{ name: '00-master.md' }, { name: '01-pricing.md' }]);
    mockTasksGetByEpic.mockReturnValue(tickets);
  });

  it('hands over every input as absolute paths, plus the one directory the report goes to', () => {
    const message = generateEpicSpecReviewMessage(EPIC);

    expect(message).toContain('epic #7');
    expect(message).toContain('- /archive/3/epics/epic-7/spec/pricing.md');
    expect(message).toContain('- /archive/3/epics/epic-7/architecture/architecture.md');
    expect(message).toContain('- /archive/3/epics/epic-7/docs/00-master.md');
    expect(message).toContain('- /archive/3/epics/epic-7/docs/01-pricing.md');
    expect(message).toContain('/archive/3/epics/epic-7/review/review.md');
    expect(message).toContain('/repos/nimbus');
    expect(message).not.toContain('{{');
  });

  it('tables the tickets in execution order with the document path the report will cite', () => {
    const message = generateEpicSpecReviewMessage(EPIC);

    expect(message).toContain('| 1 | #41 | Pricing engine | pending | /archive/3/tasks/task-41.md |');
    expect(message).toContain('| 2 | #42 | Pricing section | pending | /archive/3/tasks/task-42.md |');
    // And still points at the live source for follow-up turns.
    expect(message).toContain('list_epic_tasks');
  });

  it('calls an empty ticket list a blocking finding rather than reviewing nothing', () => {
    mockTasksGetByEpic.mockReturnValue([]);

    expect(generateEpicSpecReviewMessage(EPIC)).toContain('this epic has no tickets');
  });

  it('is revision-aware: a re-review lists the previous report', () => {
    mockListReviewDocs.mockReturnValue([{ name: 'review.md' }]);

    const message = generateEpicSpecReviewMessage(EPIC);

    expect(message).toContain('- /archive/3/epics/epic-7/review/review.md');
    expect(message).not.toContain('this is the first review');
  });

  it('tells a first review that there is no previous report', () => {
    expect(generateEpicSpecReviewMessage(EPIC)).toContain('this is the first review');
  });

  it('names the missing inputs as findings instead of guessing', () => {
    mockListSpecFiles.mockReturnValue([]);
    mockListArchitectureDocs.mockReturnValue([]);
    mockListDocs.mockReturnValue([]);

    const message = generateEpicSpecReviewMessage(EPIC);

    expect(message).toContain('no functional specification was uploaded');
    expect(message).toContain('no architecture document was written');
    expect(message).toContain('the specification stage produced no documents');
  });
});

describe('generateEpicArchitectureMessage', () => {
  beforeEach(() => {
    mockListArchitectureDocs.mockReturnValue([]);
  });

  it('hands over the epic, the spec files, the architecture directory and the repo', () => {
    const message = generateEpicArchitectureMessage(EPIC);

    expect(message).toContain('epic #7');
    expect(message).toContain('Nimbus Pricing');
    expect(message).toContain('- /archive/3/epics/epic-7/spec/pricing.md');
    expect(message).toContain('/archive/3/epics/epic-7/architecture');
    expect(message).toContain('/repos/nimbus');
    expect(message).not.toContain('{{');
  });

  it('tells a first run that the architecture directory is empty', () => {
    expect(generateEpicArchitectureMessage(EPIC)).toContain('this is the first pass');
  });

  it('is revision-aware: a re-run lists the files already written', () => {
    mockListArchitectureDocs.mockReturnValue([{ name: 'architecture.md' }]);

    const message = generateEpicArchitectureMessage(EPIC);

    expect(message).toContain('- /archive/3/epics/epic-7/architecture/architecture.md');
    expect(message).not.toContain('this is the first pass');
  });

  it('refuses to guess when no functional specification was uploaded', () => {
    mockListSpecFiles.mockReturnValue([]);

    expect(generateEpicArchitectureMessage(EPIC)).toContain(
      'No specification files were uploaded',
    );
  });
});

describe('generateEpicPrReviewMessage', () => {
  const tickets = [
    { id: 41, epic_id: 7, position: 1, title: 'Pricing engine', status: 'completed' },
    { id: 42, epic_id: 7, position: 2, title: 'Pricing section', status: 'in_review' },
    { id: 43, epic_id: 7, position: 3, title: 'Seat picker', status: 'pending' },
  ] as never;
  const context = {
    worktreePath: '/repos/nimbus-worktrees/task-42',
    prUrl: 'https://github.com/o/r/pull/9',
    baseBranch: 'epic/7-nimbus-pricing',
  };

  beforeEach(() => {
    mockTasksGetByEpic.mockReturnValue(tickets);
    mockReadEpicDoc.mockReturnValue('# Master\n\n| 1 | 01-pricing.md | engine |');
    mockReadTaskDoc.mockReturnValue('# Ticket 42\n\nRender #pricing.\n\n## Plan\n\n1. Add PricingSection.');
    mockReadOutcome.mockImplementation((_p: number, _e: number, taskId: number) =>
      taskId === 41 ? 'monthlyCost is the entry point.' : null,
    );
  });

  it('rebuilds the epic memory for a fresh conversation, framed by where the reviewer is', () => {
    const message = generateEpicPrReviewMessage(EPIC, tickets[1], context);

    expect(message).toContain('ticket 2 of 3');
    expect(message).toContain('#42 — Pricing section');
    expect(message).toContain('/repos/nimbus-worktrees/task-42');
    expect(message).toContain('https://github.com/o/r/pull/9');
    expect(message).toContain('epic/7-nimbus-pricing');
    expect(message).toContain('/archive/3/tasks/task-42.md');
    // The ticket document — brief AND plan — and the master document are inlined.
    expect(message).toContain('1. Add PricingSection.');
    expect(message).toContain('| 1 | 01-pricing.md | engine |');
    // The live story table marks the reviewed ticket; earlier outcomes only.
    expect(message).toContain('| 2 | #42 | Pricing section | in_review **<- yours** |');
    expect(message).toContain('### #41 — Pricing engine');
    expect(message).toContain('monthlyCost is the entry point.');
    expect(message).not.toContain('### #43');
    expect(message).not.toContain('{{');
  });

  it('says so, rather than guessing, when the ticket document or the master is missing', () => {
    mockReadTaskDoc.mockReturnValue('');
    mockReadEpicDoc.mockReturnValue(null);

    const message = generateEpicPrReviewMessage(EPIC, tickets[1], context);

    expect(message).toContain('this ticket has no document');
    expect(message).toContain('no 00-master.md was written');
    expect(message).toContain('/archive/3/epics/epic-7/docs');
  });

  it('tells the first ticket that nothing has been delivered yet', () => {
    const message = generateEpicPrReviewMessage(EPIC, tickets[0], context);

    expect(message).toContain('no ticket has been delivered yet');
  });
});


describe('generateEpicDeliveryMessage', () => {
  const context: EpicDeliveryContext = {
    worktreePath: '/repos/nimbus-worktrees/epic-7',
    featureBranch: 'epic/7-nimbus-pricing',
    defaultBranch: 'main',
    prUrl: 'https://github.com/acme/nimbus/pull/148',
    trigger: { kind: 'manual' },
  };

  it('frames where the agent is: its worktree, both branches and the pull request', () => {
    mockTasksGetByEpic.mockReturnValue([
      { id: 41, position: 1, title: 'Pricing engine', status: 'completed' },
      { id: 42, position: 2, title: 'Pricing section', status: 'completed' },
    ]);

    const message = generateEpicDeliveryMessage(EPIC, context);

    expect(message).toContain('epic #7');
    expect(message).toContain('/repos/nimbus-worktrees/epic-7');
    expect(message).toContain('epic/7-nimbus-pricing');
    expect(message).toContain('main');
    expect(message).toContain('https://github.com/acme/nimbus/pull/148');
    expect(message).toContain('| 1 | #41 | Pricing engine | completed |');
    expect(message).toContain('| 2 | #42 | Pricing section | completed |');
    expect(message).not.toContain('{{');
  });

  // The main checkout is the working copy a person is using — and on a
  // self-hosting box the one the running service is serving.
  it('names the main checkout as off limits', () => {
    const message = generateEpicDeliveryMessage(EPIC, context);

    expect(message).toContain('/repos/nimbus');
    expect(message).toMatch(/off limits/i);
  });

  it('forbids merging the final pull request and rewriting the shared branch', () => {
    const message = generateEpicDeliveryMessage(EPIC, context);

    expect(message).toMatch(/Never merge the final pull request/i);
    expect(message).toMatch(/Never force-push/i);
    expect(message).toMatch(/Never rebase the feature branch/i);
  });

  it('says the pull request is not open yet rather than inventing one', () => {
    const message = generateEpicDeliveryMessage(EPIC, { ...context, prUrl: null });

    expect(message).toContain('not opened yet');
    expect(message).not.toContain('null');
  });

  it('waits for the user when they opened the conversation themselves', () => {
    const message = generateEpicDeliveryMessage(EPIC, context);

    expect(message).toContain('The user opened this conversation');
    expect(message).not.toContain('## User Feedback');
  });

  // The comment arrived on the epic's final pull request; it is quoted by the
  // same builder the ticket-level PR agent uses.
  it('quotes a GitHub comment, with its file and line anchor', () => {
    const message = generateEpicDeliveryMessage(EPIC, {
      ...context,
      trigger: {
        kind: 'comment',
        webhookContext: {
          commentBody: '@bottega this conflicts with the new auth guard',
          commentAuthor: 'octocat',
          fileContext: { path: 'server/auth.ts', line: 42, diffHunk: '@@ -1 +1 @@' },
        },
      },
    });

    expect(message).toContain('**@octocat**');
    expect(message).toContain('> @bottega this conflicts with the new auth guard');
    expect(message).toContain('`server/auth.ts`');
    expect(message).toContain('**Line**: line 42');
    expect(message).toContain('@@ -1 +1 @@');
  });

  it('renders a submitted review with its inline comments', () => {
    const message = generateEpicDeliveryMessage(EPIC, {
      ...context,
      trigger: {
        kind: 'review',
        webhookContext: {
          reviewBody: '@bottega two things before I merge',
          reviewAuthor: 'octocat',
          comments: [
            { commentBody: 'rename this', commentAuthor: 'octocat', fileContext: { path: 'a.ts' } },
            { commentBody: 'missing test', commentAuthor: 'octocat', fileContext: null },
          ],
        },
      },
    });

    expect(message).toContain('> @bottega two things before I merge');
    expect(message).toContain('### Inline Comments (2)');
    expect(message).toContain('`a.ts`');
    expect(message).toContain('General comment');
  });

  it('says so when the epic has no tickets', () => {
    mockTasksGetByEpic.mockReturnValue([]);

    const message = generateEpicDeliveryMessage(EPIC, context);

    expect(message).toContain('this epic has no tickets');
  });
});

describe('generateEpicQaFixMessage', () => {
  const context = {
    worktreePath: '/repos/nimbus-worktrees/epic-7',
    featureBranch: 'epic/7-nimbus-pricing',
    devServerPort: 4107,
  };

  function book(): string {
    return serializeQaScenarios([
      {
        id: 'S-001',
        feature: 'Login',
        title: 'Happy path',
        steps: '1. Log in',
        expected: 'Dashboard',
        status: 'pass',
        confidence: '3',
        notes: '',
      },
      {
        id: 'S-039',
        feature: 'Gifts',
        title: 'Shortcut creates a gift',
        steps: '1. Open the day form\n2. Click the shortcut',
        expected: 'A gift exists',
        status: 'fail',
        confidence: '3',
        notes: 'expected a gift, observed: nothing',
      },
    ]);
  }

  it('embeds only the failed rows, the paths and the port', () => {
    mockReadEpicQaFile.mockReturnValue(book());

    const message = generateEpicQaFixMessage(EPIC, context);

    expect(message).toContain('### S-039 — Shortcut creates a gift');
    expect(message).toContain('expected a gift, observed: nothing');
    expect(message).not.toContain('S-001');
    expect(message).toContain('1 scenario(s) failed');
    expect(message).toContain('/repos/nimbus-worktrees/epic-7');
    expect(message).toContain('epic/7-nimbus-pricing');
    expect(message).toContain('4107');
    expect(message).toContain('/archive/3/epics/epic-7/qa/scenarios.csv');
    expect(message).not.toContain('{{');
  });

  it('throws on a missing, unparseable or clean book — the gate makes those unreachable', () => {
    mockReadEpicQaFile.mockReturnValue(null);
    expect(() => generateEpicQaFixMessage(EPIC, context)).toThrow(/no scenario book/);

    mockReadEpicQaFile.mockReturnValue('not,a,book');
    expect(() => generateEpicQaFixMessage(EPIC, context)).toThrow(/does not parse/);

    mockReadEpicQaFile.mockReturnValue(
      serializeQaScenarios([
        {
          id: 'S-001',
          feature: 'Login',
          title: 'Happy path',
          steps: '1. Log in',
          expected: 'Dashboard',
          status: 'pass',
          confidence: '3',
          notes: '',
        },
      ]),
    );
    expect(() => generateEpicQaFixMessage(EPIC, context)).toThrow(/no failed scenario/);
  });
});
