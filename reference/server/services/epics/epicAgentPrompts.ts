// Message builders for the epic pipeline's agents.
//
// Mirrors `agentPrompts.ts` (the task-level builders): each function renders an
// operator-overridable prompt template with the variables that stage needs.
// Epic prompts never inline the spec files — they hand the agent absolute paths
// into the epic archive and tell it to read them, so a large functional spec
// doesn't have to fit in the first message.

import path from 'path';
import { renderPrompt } from '../promptRenderer.js';
import { getTaskDocPath, readTaskDoc } from '../documentation.js';
import {
  getEpicArchitectureDir,
  getEpicDocsDir,
  getEpicQaDir,
  getEpicQaFilePath,
  getEpicReviewDir,
  getEpicSpecDir,
  listEpicArchitectureDocs,
  listEpicDocs,
  listEpicReviewDocs,
  listEpicSpecFiles,
  readEpicDoc,
  readEpicQaFile,
  readEpicTaskOutcome,
} from './epicArchive.js';
import { QA_SCENARIOS_FILENAME, countQaProgress, parseQaScenarios } from '@shared/schemas/qa';
import {
  buildCommentFeedbackSection,
  buildReviewFeedbackSection,
  type CommentWebhookContext,
  type ReviewWebhookContext,
} from '../../constants/prFeedback.js';
import { epicTicketsDb } from '../../database/epics.js';
import type { EpicWithProject } from '../../database/epics.js';
import type { EpicTicketWithTask, TaskRow } from '@shared/types/db';

const NO_SPEC_FILES_NOTE =
  'No specification files were uploaded for this epic. Say so and ask the user for the specification instead of guessing';

/** Bulleted absolute paths, or a parenthetical when the folder is empty. */
function fileListSection(dir: string, files: { name: string }[], emptyNote: string): string {
  return files.length
    ? files.map((f) => `- ${path.join(dir, f.name)}`).join('\n')
    : `(${emptyNote})`;
}

/**
 * The architecture stage's opening message: the epic split into topics, each
 * with its decisions and diagrams, written as markdown into the epic's
 * `architecture/` directory.
 *
 * Re-runs are revision-aware by construction, exactly like the specification
 * stage: the files already in `architecture/` are listed, so a second run
 * revises the document instead of writing a parallel one.
 */
export function generateEpicArchitectureMessage(epic: EpicWithProject): string {
  const projectId = epic.project_id;
  const specDir = getEpicSpecDir(projectId, epic.id);
  const architectureDir = getEpicArchitectureDir(projectId, epic.id);

  return renderPrompt('epic-architecture', {
    epicId: epic.id,
    epicName: epic.name,
    specDir,
    specFileList: fileListSection(specDir, listEpicSpecFiles(projectId, epic.id), NO_SPEC_FILES_NOTE),
    architectureDir,
    architectureFileList: fileListSection(
      architectureDir,
      listEpicArchitectureDocs(projectId, epic.id),
      'none yet — this is the first pass',
    ),
    repoPath: epic.repo_folder_path,
  });
}

/**
 * The technical-specification stage's opening message.
 *
 * Re-runs are revision-aware by construction: the current contents of the
 * epic's `docs/` are listed in the message, so a second run continues the
 * document set instead of starting a parallel one. Every input — the spec
 * files and the architecture document — is handed over as paths to read, so a
 * large document never has to fit in the first message.
 */
export function generateEpicSpecificationMessage(epic: EpicWithProject): string {
  const projectId = epic.project_id;
  const specDir = getEpicSpecDir(projectId, epic.id);
  const architectureDir = getEpicArchitectureDir(projectId, epic.id);
  const docsDir = getEpicDocsDir(projectId, epic.id);

  return renderPrompt('epic-specification', {
    epicId: epic.id,
    epicName: epic.name,
    specDir,
    specFileList: fileListSection(specDir, listEpicSpecFiles(projectId, epic.id), NO_SPEC_FILES_NOTE),
    docsDir,
    docsFileList: fileListSection(
      docsDir,
      listEpicDocs(projectId, epic.id),
      'none yet — this is the first pass',
    ),
    architectureDir,
    architectureFileList: fileListSection(
      architectureDir,
      listEpicArchitectureDocs(projectId, epic.id),
      'no architecture document was written — say so and work from the functional specification and the repository',
    ),
    repoPath: epic.repo_folder_path,
  });
}

/**
 * The stories stage's opening message.
 *
 * It lists the technical-specification documents rather than inlining them —
 * the set is large by design and the agent must read it in full anyway. The
 * epic's existing tickets are NOT listed here: `list_epic_tasks` returns them
 * live, so a re-run reads the current list instead of a snapshot taken when the
 * run started.
 */
export function generateEpicStoriesMessage(epic: EpicWithProject): string {
  const projectId = epic.project_id;
  const docsDir = getEpicDocsDir(projectId, epic.id);

  return renderPrompt('epic-stories', {
    epicId: epic.id,
    epicName: epic.name,
    specDir: getEpicSpecDir(projectId, epic.id),
    docsDir,
    docsFileList: fileListSection(
      docsDir,
      listEpicDocs(projectId, epic.id),
      'none — the technical specification stage produced no documents. Say so and stop: there is nothing to split',
    ),
    repoPath: epic.repo_folder_path,
  });
}

/**
 * The ticket table the specification reviewer opens with: every ticket in
 * execution order with its status and the absolute path of its document — the
 * locator the report cites. A snapshot at run start, on purpose: the prompt
 * also hands the reviewer `list_epic_tasks`, which reads the rows live, so a
 * follow-up re-review after the stories stage revised a ticket sees the
 * current list rather than this one.
 */
function reviewTicketTableSection(projectId: number, tickets: EpicTicketWithTask[]): string {
  if (tickets.length === 0) {
    return (
      '(this epic has no tickets — that is a blocking finding in itself: the stories stage ' +
      'produced nothing to implement)'
    );
  }
  const rows = tickets.map(
    (t, index) =>
      `| ${t.position ?? index + 1} | #${t.id} | ${t.title || '(untitled)'} | ${t.status} | ${getTaskDocPath(projectId, t.id)} |`,
  );
  return ['| # | Ticket | Title | Status | Document |', '|---|---|---|---|---|', ...rows].join('\n');
}

/**
 * The specification review stage's opening message: the final gate before
 * autonomous implementation. Every input — functional spec, architecture
 * document, technical specification, tickets — is handed over as paths, plus
 * the one directory the report goes to. A previous report is listed so a
 * re-review rewrites it (with a "since the previous review" section) rather
 * than writing a second one beside it.
 */
export function generateEpicSpecReviewMessage(epic: EpicWithProject): string {
  const projectId = epic.project_id;
  const specDir = getEpicSpecDir(projectId, epic.id);
  const architectureDir = getEpicArchitectureDir(projectId, epic.id);
  const docsDir = getEpicDocsDir(projectId, epic.id);
  const reviewDir = getEpicReviewDir(projectId, epic.id);

  return renderPrompt('epic-spec-review', {
    epicId: epic.id,
    epicName: epic.name,
    specDir,
    specFileList: fileListSection(
      specDir,
      listEpicSpecFiles(projectId, epic.id),
      'no functional specification was uploaded — a blocking finding: there is nothing to check the technical specification against',
    ),
    architectureDir,
    architectureFileList: fileListSection(
      architectureDir,
      listEpicArchitectureDocs(projectId, epic.id),
      'no architecture document was written — note it in the report and skip the architecture checks',
    ),
    docsDir,
    docsFileList: fileListSection(
      docsDir,
      listEpicDocs(projectId, epic.id),
      'none — the specification stage produced no documents. That is a blocking finding: there is nothing to implement from',
    ),
    ticketTable: reviewTicketTableSection(projectId, epicTicketsDb.listTickets(epic.id)),
    reviewDir,
    reviewFileList: fileListSection(
      reviewDir,
      listEpicReviewDocs(projectId, epic.id),
      'none — this is the first review',
    ),
    repoPath: epic.repo_folder_path,
  });
}

/** The epic's master specification document, or a note that there is none. */
const MASTER_DOC_NAME = '00-master.md';

/**
 * The story table the orchestrator reads to know where it is in the epic:
 * every ticket, in execution order, with the status it has right now. Rebuilt
 * from live rows at every ticket hop rather than carried in a transcript, so a
 * ticket the user completed by hand shows up as completed.
 */
function storyTableSection(tickets: EpicTicketWithTask[], currentTaskId: number): string {
  if (tickets.length === 0) return '(this epic has no tickets)';
  const rows = tickets.map((t, index) => {
    const marker = t.id === currentTaskId ? ' **<- yours**' : '';
    return `| ${t.position ?? index + 1} | #${t.id} | ${t.title || '(untitled)'} | ${t.status}${marker} |`;
  });
  return ['| # | Ticket | Title | Status |', '|---|---|---|---|', ...rows].join('\n');
}

/**
 * What the previous tickets taught, in their own orchestrators' words. This is
 * the only channel through which one ticket's supervision informs the next —
 * each ticket gets a fresh conversation, so nothing else survives.
 */
function outcomeNotesSection(
  projectId: number,
  epicId: number,
  tickets: EpicTicketWithTask[],
  currentTaskId: number,
): string {
  const notes: string[] = [];
  for (const ticket of tickets) {
    if (ticket.id === currentTaskId) break;
    const note = readEpicTaskOutcome(projectId, epicId, ticket.id);
    if (note?.trim()) {
      notes.push(`### #${ticket.id} — ${ticket.title || '(untitled)'}\n\n${note.trim()}`);
    }
  }
  return notes.length > 0
    ? notes.join('\n\n')
    : '(no ticket has been delivered yet — this is the first one)';
}

/**
 * The message that opens one ticket's orchestrator conversation.
 *
 * One run + conversation per ticket, so the epic-wide memory has to be rebuilt
 * here every time: the mission, the master document (small by contract, so it
 * is inlined), the live story table and the outcome notes of everything already
 * delivered. The ticket document is inlined too — the orchestrator reviews the
 * plan and the PR against exactly what the implementing agent was told.
 */
export function generateEpicOrchestratorMessage(
  epic: EpicWithProject,
  ticket: TaskRow,
): string {
  const projectId = epic.project_id;
  const docsDir = getEpicDocsDir(projectId, epic.id);
  const tickets = epicTicketsDb.listTickets(epic.id);
  const master = readEpicDoc(projectId, epic.id, MASTER_DOC_NAME);
  const position =
    tickets.find((t) => t.id === ticket.id)?.position ??
    tickets.findIndex((t) => t.id === ticket.id) + 1;

  return renderPrompt('epic-orchestrator', {
    epicId: epic.id,
    epicName: epic.name,
    ticketTaskId: ticket.id,
    ticketTitle: ticket.title || `Task #${ticket.id}`,
    ticketPosition: position,
    ticketCount: tickets.length,
    ticketDoc:
      readTaskDoc(projectId, ticket.id).trim() ||
      '(this ticket has no document — say so and escalate; you cannot supervise work with no brief)',
    masterDoc:
      master?.trim() ||
      `(no ${MASTER_DOC_NAME} was written — read the documents in ${docsDir} yourself before judging anything)`,
    docsDir,
    storyTable: storyTableSection(tickets, ticket.id),
    outcomeNotes: outcomeNotesSection(projectId, epic.id, tickets, ticket.id),
    repoPath: epic.repo_folder_path,
  });
}

/** Everything the reviewer needs that is not on the ticket row. */
export interface EpicPrReviewContext {
  /** Absolute path of the ticket's worktree — the conversation's cwd. */
  worktreePath: string;
  /** The pull request under review. */
  prUrl: string;
  /** The branch it merges into — the epic's feature branch. */
  baseBranch: string;
}

/**
 * The message that opens one ticket's pull-request review conversation.
 *
 * The reviewer is a fresh conversation by design — the orchestrator's transcript
 * is ~80k tokens of supervision by the time a pull request lands, and the
 * review deserves an empty context — so the epic-wide memory is rebuilt here
 * exactly as it is for the orchestrator: the ticket document (now carrying the
 * approved plan), the master document, the live story table and the outcome
 * notes of every ticket already delivered. What differs is the frame: where
 * you are (worktree, PR, base branch) and that the specification is the source
 * of truth it implements against, never a thing it challenges.
 */
export function generateEpicPrReviewMessage(
  epic: EpicWithProject,
  ticket: TaskRow,
  context: EpicPrReviewContext,
): string {
  const projectId = epic.project_id;
  const docsDir = getEpicDocsDir(projectId, epic.id);
  const tickets = epicTicketsDb.listTickets(epic.id);
  const master = readEpicDoc(projectId, epic.id, MASTER_DOC_NAME);
  const position =
    tickets.find((t) => t.id === ticket.id)?.position ??
    tickets.findIndex((t) => t.id === ticket.id) + 1;

  return renderPrompt('epic-pr-review', {
    epicId: epic.id,
    epicName: epic.name,
    ticketTaskId: ticket.id,
    ticketTitle: ticket.title || `Task #${ticket.id}`,
    ticketPosition: position,
    ticketCount: tickets.length,
    ticketDoc:
      readTaskDoc(projectId, ticket.id).trim() ||
      '(this ticket has no document — review against the specification alone, and say so in your outcome summary)',
    taskDocPath: getTaskDocPath(projectId, ticket.id),
    masterDoc:
      master?.trim() ||
      `(no ${MASTER_DOC_NAME} was written — read the documents in ${docsDir} yourself before judging anything)`,
    docsDir,
    storyTable: storyTableSection(tickets, ticket.id),
    outcomeNotes: outcomeNotesSection(projectId, epic.id, tickets, ticket.id),
    worktreePath: context.worktreePath,
    prUrl: context.prUrl,
    baseBranch: context.baseBranch,
  });
}


// ---------------------------------------------------------------------------
// Delivery — the epic's final pull request
// ---------------------------------------------------------------------------

/**
 * What opened a delivery run. `null` is the user clicking "New conversation" on
 * the epic page: they will say what they want in their own first message, so the
 * prompt only frames where the agent is. The two webhook shapes are the same
 * ones the ticket-level PR agent receives, quoted by the same builders.
 */
export type EpicDeliveryTrigger =
  | { kind: 'manual' }
  | { kind: 'comment'; webhookContext: CommentWebhookContext }
  | { kind: 'review'; webhookContext: ReviewWebhookContext };

/** Everything the delivery agent needs that is not on the epic row. */
export interface EpicDeliveryContext {
  /** Absolute path of the epic's delivery worktree — the conversation's cwd. */
  worktreePath: string;
  /** The epic's feature branch, checked out in that worktree. */
  featureBranch: string;
  /** The branch the final pull request merges into. */
  defaultBranch: string;
  /** The final pull request, or null when it has not been opened yet. */
  prUrl: string | null;
  trigger: EpicDeliveryTrigger;
}

/** The tickets the epic delivered, in execution order — what is IN this PR. */
function deliveredTicketTableSection(tickets: EpicTicketWithTask[]): string {
  if (tickets.length === 0) return '(this epic has no tickets)';
  const rows = tickets.map(
    (t, index) =>
      `| ${t.position ?? index + 1} | #${t.id} | ${t.title || '(untitled)'} | ${t.status} |`,
  );
  return ['| # | Ticket | Title | Status |', '|---|---|---|---|', ...rows].join('\n');
}

function openingSection(trigger: EpicDeliveryTrigger): string {
  switch (trigger.kind) {
    case 'manual':
      return (
        'The user opened this conversation from the epic page. Read the frame below, ' +
        'then wait for what they ask — do not start changing anything before they have ' +
        'said what they need.'
      );
    case 'comment':
      return buildCommentFeedbackSection(trigger.webhookContext);
    case 'review':
      return buildReviewFeedbackSection(trigger.webhookContext);
  }
}

/**
 * The message that opens a delivery conversation.
 *
 * Delivery is not a pipeline stage: it has no flag, signs nothing off, and can
 * run any number of times. What it needs is a frame — which branch, which
 * worktree, which pull request, what the epic delivered — plus whatever opened
 * it. The epic's documents are NOT inlined: the system prompt
 * (`buildEpicContextPrompt`) already hands over the archive paths, and a
 * conflict resolution rarely needs the whole specification.
 */
export function generateEpicDeliveryMessage(
  epic: EpicWithProject,
  context: EpicDeliveryContext,
): string {
  return renderPrompt('epic-delivery', {
    epicId: epic.id,
    epicName: epic.name,
    openingSection: openingSection(context.trigger),
    worktreePath: context.worktreePath,
    featureBranch: context.featureBranch,
    defaultBranch: context.defaultBranch,
    prSection:
      context.prUrl ??
      'not opened yet — say so rather than opening one; the user opens it from the epic page.',
    repoPath: epic.repo_folder_path,
    ticketTable: deliveredTicketTableSection(epicTicketsDb.listTickets(epic.id)),
  });
}


// ---------------------------------------------------------------------------
// QA — the scenario book, and its execution
// ---------------------------------------------------------------------------

/**
 * The ticket table the QA scenario writer opens with: every ticket with its
 * document path, because the tickets are the finest-grained description of
 * what the epic changed — exactly what the scenario coverage must span.
 */
function qaTicketTableSection(projectId: number, tickets: EpicTicketWithTask[]): string {
  if (tickets.length === 0) {
    return '(this epic has no tickets — derive the scenarios from the documents alone)';
  }
  const rows = tickets.map(
    (t, index) =>
      `| ${t.position ?? index + 1} | #${t.id} | ${t.title || '(untitled)'} | ${t.status} | ${getTaskDocPath(projectId, t.id)} |`,
  );
  return ['| # | Ticket | Title | Status | Document |', '|---|---|---|---|---|', ...rows].join('\n');
}

/**
 * The scenario book's current state, for the writer's opening message — what
 * makes a re-run revision-aware: a second run continues the existing book
 * (upsert/delete by id) instead of numbering a parallel one from S-001.
 */
function qaScenariosStateNote(projectId: number, epicId: number): string {
  const content = readEpicQaFile(projectId, epicId, QA_SCENARIOS_FILENAME);
  if (content === null) return 'none yet — this is the first pass';
  const parsed = parseQaScenarios(content);
  if (!parsed.ok) {
    return `the file exists but does not parse (${parsed.errors[0]}) — rewrite it whole with a replace`;
  }
  const withResults = parsed.rows.filter((r) => r.status !== '').length;
  return (
    `the file exists with ${parsed.rows.length} scenario(s), ${withResults} carrying recorded ` +
    'results — this is a revision: change it by id (upsert/delete), never renumber, and be ' +
    'aware that replacing a scenario that carries a result discards that result'
  );
}

/**
 * Where execution stands, computed from the CSV at run start — what makes a
 * fresh execution run naturally resume instead of starting over.
 */
function qaProgressSection(projectId: number, epicId: number): string {
  const content = readEpicQaFile(projectId, epicId, QA_SCENARIOS_FILENAME);
  if (content === null) {
    return '(scenarios.csv is missing — say so and stop; the QA scenario stage writes it)';
  }
  const parsed = parseQaScenarios(content);
  if (!parsed.ok) {
    return `(scenarios.csv does not parse: ${parsed.errors[0]} — say so and stop; it must be fixed in the QA scenario stage)`;
  }
  const { total, pass, fail, notRun } = countQaProgress(parsed.rows);
  const firstNotRun = parsed.rows.find((r) => r.status === '');
  const resume = firstNotRun
    ? `Resume at the first not-run scenario, ${firstNotRun.id}.`
    : 'Every scenario already has a result — re-run only what the user asks for.';
  return `${total} scenario(s): ${pass} pass, ${fail} fail, ${notRun} not run. ${resume}`;
}

/**
 * The QA scenario stage's opening message. Every input — the functional spec,
 * the architecture document, the technical specification, the tickets — is
 * handed over as paths to read; the output contract (one CSV, written through
 * `write_qa_scenarios`) lives in the prompt template.
 */
export function generateEpicQaScenariosMessage(epic: EpicWithProject): string {
  const projectId = epic.project_id;
  const specDir = getEpicSpecDir(projectId, epic.id);
  const architectureDir = getEpicArchitectureDir(projectId, epic.id);
  const docsDir = getEpicDocsDir(projectId, epic.id);

  return renderPrompt('epic-qa-scenarios', {
    epicId: epic.id,
    epicName: epic.name,
    specDir,
    specFileList: fileListSection(specDir, listEpicSpecFiles(projectId, epic.id), NO_SPEC_FILES_NOTE),
    architectureDir,
    architectureFileList: fileListSection(
      architectureDir,
      listEpicArchitectureDocs(projectId, epic.id),
      'no architecture document was written — work from the functional specification and the technical specification',
    ),
    docsDir,
    docsFileList: fileListSection(
      docsDir,
      listEpicDocs(projectId, epic.id),
      'none — the specification stage produced no documents. Work from the functional specification and the tickets',
    ),
    ticketTable: qaTicketTableSection(projectId, epicTicketsDb.listTickets(epic.id)),
    qaDir: getEpicQaDir(projectId, epic.id),
    qaCsvPath: getEpicQaFilePath(projectId, epic.id, QA_SCENARIOS_FILENAME),
    qaCsvState: qaScenariosStateNote(projectId, epic.id),
    repoPath: epic.repo_folder_path,
  });
}

/** Everything the QA execution agent needs that is not on the epic row. */
export interface EpicQaExecutionContext {
  /** Absolute path of the epic's delivery worktree — the conversation's cwd. */
  worktreePath: string;
  /** The epic's feature branch, checked out in that worktree. */
  featureBranch: string;
  /** The port this epic's QA dev server is assigned. */
  devServerPort: number;
}

/**
 * The message that opens a QA execution conversation. Not a pipeline stage
 * (any number of runs, no flag): the frame is where it runs (the delivery
 * worktree, its port), what it executes (the scenario book) and where that
 * stands right now, so a second run picks up where the first stopped.
 */
export function generateEpicQaExecutionMessage(
  epic: EpicWithProject,
  context: EpicQaExecutionContext,
): string {
  const projectId = epic.project_id;
  const docsDir = getEpicDocsDir(projectId, epic.id);

  return renderPrompt('epic-qa-execution', {
    epicId: epic.id,
    epicName: epic.name,
    worktreePath: context.worktreePath,
    featureBranch: context.featureBranch,
    devServerPort: context.devServerPort,
    qaCsvPath: getEpicQaFilePath(projectId, epic.id, QA_SCENARIOS_FILENAME),
    qaProgress: qaProgressSection(projectId, epic.id),
    docsDir,
    docsFileList: fileListSection(
      docsDir,
      listEpicDocs(projectId, epic.id),
      'none — the specification stage produced no documents; the scenarios and the app are your ground truth',
    ),
    repoPath: epic.repo_folder_path,
  });
}

export interface EpicQaFixContext {
  /** The epic's delivery worktree — where the re-test runs the app. */
  worktreePath: string;
  /** The epic's feature branch, checked out in that worktree. */
  featureBranch: string;
  /** The port this epic's QA dev server is assigned. */
  devServerPort: number;
}

/**
 * The message that opens a QA fix mission. The failed rows are extracted here,
 * deterministically, so the agent writes its fix ticket from an exact record
 * rather than re-parsing the CSV; the epic-wide memory (master document, story
 * table) is rebuilt like the orchestrator's, because this conversation drives
 * a ticket the same way. Throws on a missing, unparseable or clean book — the
 * route gate makes that unreachable, so reaching it is a bug worth a loud
 * failure at start rather than a confused agent mid-run.
 */
export function generateEpicQaFixMessage(
  epic: EpicWithProject,
  context: EpicQaFixContext,
): string {
  const projectId = epic.project_id;
  const docsDir = getEpicDocsDir(projectId, epic.id);

  const content = readEpicQaFile(projectId, epic.id, QA_SCENARIOS_FILENAME);
  if (content === null) {
    throw new Error(`Epic ${epic.id} has no scenario book — nothing for a QA fix run to read`);
  }
  const parsed = parseQaScenarios(content);
  if (!parsed.ok) {
    throw new Error(`Epic ${epic.id}'s scenario book does not parse: ${parsed.errors[0]}`);
  }
  const failed = parsed.rows.filter((r) => r.status === 'fail');
  if (failed.length === 0) {
    throw new Error(`Epic ${epic.id}'s scenario book records no failed scenario — nothing to fix`);
  }

  // Blocks, not a table: steps and notes carry newlines and pipes.
  const failedScenarios = failed
    .map((row) =>
      [
        `### ${row.id} — ${row.title || '(untitled)'}`,
        `- Feature: ${row.feature || '(none)'}`,
        '- Steps:',
        row.steps,
        `- Expected: ${row.expected}`,
        `- Recorded notes: ${row.notes || '(none)'}`,
      ].join('\n'),
    )
    .join('\n\n');

  const master = readEpicDoc(projectId, epic.id, MASTER_DOC_NAME);
  const tickets = epicTicketsDb.listTickets(epic.id);

  return renderPrompt('epic-qa-fix', {
    epicId: epic.id,
    epicName: epic.name,
    repoPath: epic.repo_folder_path,
    deliveryWorktreePath: context.worktreePath,
    featureBranch: context.featureBranch,
    devServerPort: context.devServerPort,
    qaCsvPath: getEpicQaFilePath(projectId, epic.id, QA_SCENARIOS_FILENAME),
    failCount: failed.length,
    failedScenarios,
    masterDoc:
      master?.trim() ||
      `(no ${MASTER_DOC_NAME} was written — read the documents in ${docsDir} yourself before judging anything)`,
    docsDir,
    docsFileList: fileListSection(
      docsDir,
      listEpicDocs(projectId, epic.id),
      'none — the specification stage produced no documents; the scenarios and the app are your ground truth',
    ),
    storyTable: storyTableSection(tickets, -1),
  });
}
