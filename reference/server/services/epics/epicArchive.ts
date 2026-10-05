// The epic archive — one epic's documents on disk, OUTSIDE the repository
// (`~/.bottega/projects/{p}/epics/epic-{e}/`), split out of the task-side
// `documentation.ts` in architecture-v2 step 5: this is epic-domain code, and
// the boundary lint keeps it importable only from the epic layer.

import fs from 'fs';
import path from 'path';
import {
  EPICS_FOLDER,
  getProjectArchivePath,
  getEpicDevServerPort,
  deleteInputFile,
  listInputFiles,
  readFileInFolder,
  saveInputFile,
  sortByName,
  type InputFileInfo,
} from '../documentation.js';
// Relative, not `@shared/schemas/qa`: `database/db.ts` reaches this module
// through `epicConversion.ts`, so it sits in the graph of the CLI scripts the
// agent prompts run — and tsx resolves tsconfig `paths` from the CWD, which
// for an agent is its own task worktree. A runtime alias import here kills
// every stage-completion call. See `scripts/agent-invoked-scripts.test.ts`.
import { QA_SCENARIOS_FILENAME } from '../../../shared/schemas/qa.js';
import type { EpicAgentType } from '@shared/types/db';

function getArchiveEpicsFolderPath(projectId: number): string {
  return path.join(getProjectArchivePath(projectId), EPICS_FOLDER);
}

/**
 * Root of one epic's archive: `~/.bottega/projects/{p}/epics/epic-{e}/`.
 * Holds `spec/` (the functional-spec files the user uploaded),
 * `architecture/` (the architecture document the architecture stage writes),
 * `docs/` (the technical-specification set the specification stage writes)
 * and `review/` (the specification review's report). Each writing stage may
 * only write into its own directory — except the review, which edits all of
 * them: keeping the four levels consistent, the functional specification
 * included, is its job.
 *
 * Epic documents deliberately live OUTSIDE the repo: ticket worktrees must
 * never carry the epic's big picture, so ticket-level agents can only see what
 * a ticket description hands them (extracts, or an explicit path to one doc).
 */
export function getEpicDir(projectId: number, epicId: number): string {
  return path.join(getArchiveEpicsFolderPath(projectId), `epic-${epicId}`);
}

export function getEpicSpecDir(projectId: number, epicId: number): string {
  return path.join(getEpicDir(projectId, epicId), 'spec');
}

/**
 * The architecture stage's output: one `architecture.md`, or a few ordered
 * markdown files when the document was split. Kept apart from `docs/` so the
 * specification stage's own contract (`00-master.md` + `NN-topic.md`) stays
 * intact and an implementing agent pointed at one specification document never
 * finds the epic-wide big picture next to it.
 */
export function getEpicArchitectureDir(projectId: number, epicId: number): string {
  return path.join(getEpicDir(projectId, epicId), 'architecture');
}

export function getEpicDocsDir(projectId: number, epicId: number): string {
  return path.join(getEpicDir(projectId, epicId), 'docs');
}

/**
 * The specification review stage's report: one `review.md` — the verdict and
 * the findings across the functional spec, the architecture document, the
 * technical specification and the tickets, then what became of each finding.
 * Its own directory for the same reason `architecture/` is: `docs/` must stay
 * purely the specification, and a ticket agent pointed at one specification
 * document must never find the epic-wide review next to it. The report is for
 * the human; the fixes it leads to land in the documents themselves.
 */
export function getEpicReviewDir(projectId: number, epicId: number): string {
  return path.join(getEpicDir(projectId, epicId), 'review');
}

/**
 * The QA stage's directory: one `scenarios.csv` — the epic-wide test book the
 * scenario writer produces and the execution agent fills results into. Its own
 * directory for the same isolation reason as `review/`: `docs/` stays purely
 * the technical specification.
 */
export function getEpicQaDir(projectId: number, epicId: number): string {
  return path.join(getEpicDir(projectId, epicId), 'qa');
}

/** Absolute path of one QA file (basename-stripped — traversal cannot escape). */
export function getEpicQaFilePath(projectId: number, epicId: number, filename: string): string {
  return path.join(getEpicQaDir(projectId, epicId), path.basename(filename));
}

/**
 * Whether the scenario book exists. The QA-execution gate checks this because
 * the human backstop can set `qa_complete` without a CSV ever being written,
 * and a run started into nothing should be refused up front.
 */
export function epicQaScenariosCsvExists(projectId: number, epicId: number): boolean {
  return fs.existsSync(getEpicQaFilePath(projectId, epicId, QA_SCENARIOS_FILENAME));
}

/**
 * Where a stage may write — empty for a stage that writes nothing. This is the
 * ONE mapping the write gate (`conversation/epicDocsWriteGate.ts`) and the
 * epic context prompt read, so what the agent is told and what it is allowed
 * can never disagree.
 */
export function getEpicStageWritableDirs(
  agentType: EpicAgentType,
  projectId: number,
  epicId: number,
): string[] {
  switch (agentType) {
    case 'epic-architecture':
      return [getEpicArchitectureDir(projectId, epicId)];
    case 'epic-specification':
      return [getEpicDocsDir(projectId, epicId)];
    case 'epic-spec-review':
      // Its own report, plus every document level it keeps consistent — the
      // functional specification included: when the user confirms that the
      // product deviates from it, the spec is the document that has to change,
      // or every level below it contradicts it forever. The reviewer applies
      // the fixes the user approves in place, so no earlier conversation is
      // ever reopened. (Tickets, the last level, are revised through the story
      // tools, not files.)
      return [
        getEpicReviewDir(projectId, epicId),
        getEpicSpecDir(projectId, epicId),
        getEpicArchitectureDir(projectId, epicId),
        getEpicDocsDir(projectId, epicId),
      ];
    case 'epic-qa-scenarios':
      return [getEpicQaDir(projectId, epicId)];
    case 'epic-stories':
    case 'epic-orchestrator':
    case 'epic-pr-review':
    case 'epic-delivery':
    case 'epic-qa-execution':
    case 'epic-qa-fix':
      // The PR reviewer, the delivery agent and the QA fix agent write code,
      // but into a git worktree, never into the archive — so no archive
      // directory, and no gate. QA execution and the fix agent record results
      // only through `record_qa_results`, whose handler writes the CSV
      // server-side, so their native archive write surface stays empty too.
      return [];
  }
}

/**
 * Where the orchestrator keeps its own notes: one `task-{id}.md` outcome per
 * merged ticket, written by `merge_task` and folded into the message that opens
 * every LATER ticket's orchestrator conversation. This is the epic's memory
 * across tickets — each orchestrator run is a fresh conversation, so what the
 * previous ones learned has to survive on disk.
 *
 * Outside `docs/`, which stays purely the technical specification: an
 * implementing agent sent to read one specification document must never find
 * the epic's ticket-by-ticket narrative sitting next to it.
 */
export function getEpicOutcomesDir(projectId: number, epicId: number): string {
  return path.join(getEpicDir(projectId, epicId), 'orchestrator', 'outcomes');
}

/** Create the epic archive layout; returns the epic's root directory. */
export function ensureEpicDirs(projectId: number, epicId: number): string {
  fs.mkdirSync(getEpicSpecDir(projectId, epicId), { recursive: true });
  fs.mkdirSync(getEpicArchitectureDir(projectId, epicId), { recursive: true });
  fs.mkdirSync(getEpicDocsDir(projectId, epicId), { recursive: true });
  fs.mkdirSync(getEpicReviewDir(projectId, epicId), { recursive: true });
  fs.mkdirSync(getEpicQaDir(projectId, epicId), { recursive: true });
  return getEpicDir(projectId, epicId);
}

export function listEpicSpecFiles(projectId: number, epicId: number): InputFileInfo[] {
  return listInputFiles(getEpicSpecDir(projectId, epicId));
}

export function saveEpicSpecFile(
  projectId: number,
  epicId: number,
  filename: string,
  buffer: Buffer,
): InputFileInfo {
  ensureEpicDirs(projectId, epicId);
  return saveInputFile(getEpicSpecDir(projectId, epicId), filename, buffer);
}

export function deleteEpicSpecFile(
  projectId: number,
  epicId: number,
  filename: string,
): boolean {
  return deleteInputFile(getEpicSpecDir(projectId, epicId), filename);
}

/** Read one spec file. Returns null when it doesn't exist. */
export function readEpicSpecFile(
  projectId: number,
  epicId: number,
  filename: string,
): string | null {
  return readFileInFolder(getEpicSpecDir(projectId, epicId), filename);
}

/**
 * Documents the agents write are numbered to read in order (`00-master.md`,
 * `01-…`), and the UI opens the first one by default — so their listings are
 * sorted by name rather than left in `readdir` order.
 */
export function listEpicArchitectureDocs(projectId: number, epicId: number): InputFileInfo[] {
  return sortByName(listInputFiles(getEpicArchitectureDir(projectId, epicId)));
}

/** Read one architecture document. Returns null when it doesn't exist. */
export function readEpicArchitectureDoc(
  projectId: number,
  epicId: number,
  filename: string,
): string | null {
  return readFileInFolder(getEpicArchitectureDir(projectId, epicId), filename);
}

export function listEpicDocs(projectId: number, epicId: number): InputFileInfo[] {
  return sortByName(listInputFiles(getEpicDocsDir(projectId, epicId)));
}

/** Read one technical-spec doc. Returns null when it doesn't exist. */
export function readEpicDoc(
  projectId: number,
  epicId: number,
  filename: string,
): string | null {
  return readFileInFolder(getEpicDocsDir(projectId, epicId), filename);
}

export function listEpicReviewDocs(projectId: number, epicId: number): InputFileInfo[] {
  return sortByName(listInputFiles(getEpicReviewDir(projectId, epicId)));
}

export function listEpicQaFiles(projectId: number, epicId: number): InputFileInfo[] {
  return sortByName(listInputFiles(getEpicQaDir(projectId, epicId)));
}

/** Read one QA file. Returns null when it doesn't exist. */
export function readEpicQaFile(
  projectId: number,
  epicId: number,
  filename: string,
): string | null {
  return readFileInFolder(getEpicQaDir(projectId, epicId), filename);
}

export function readEpicReviewDoc(
  projectId: number,
  epicId: number,
  filename: string,
): string | null {
  return readFileInFolder(getEpicReviewDir(projectId, epicId), filename);
}

/**
 * Persist one ticket's outcome note. Last write wins — a ticket merges once,
 * and a re-merge after a revert should replace the story, not append to it.
 */
export function writeEpicTaskOutcome(
  projectId: number,
  epicId: number,
  taskId: number,
  content: string,
): string {
  const dir = getEpicOutcomesDir(projectId, epicId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `task-${taskId}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/** One ticket's outcome note, or null while it has not been merged. */
export function readEpicTaskOutcome(
  projectId: number,
  epicId: number,
  taskId: number,
): string | null {
  return readFileInFolder(getEpicOutcomesDir(projectId, epicId), `task-${taskId}.md`);
}

/**
 * Read a file from a folder by name only. `path.basename` strips any directory
 * component, so a traversal attempt ('../../.env') can never escape the folder.
 */
/** Remove an epic's whole archive directory (spec, architecture, docs, review, notes). Idempotent. */
export function deleteEpicArchive(projectId: number, epicId: number): void {
  try {
    const dir = getEpicDir(projectId, epicId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to delete epic archive: ${message}`);
    throw error;
  }
}

/**
 * The write rule an epic conversation is told. A stage run states the one
 * directory its gate enforces; a stage that writes nothing says so; a manual
 * epic chat (no linked run, hence no gate) gets the general rule without any
 * claim of enforcement.
 */
function writeRuleSection(
  agentType: EpicAgentType | undefined,
  projectId: number,
  epicId: number,
): string {
  if (agentType === undefined) {
    return (
      'Epic agents never write into the repository; each stage writes only into its own ' +
      'archive directory (`architecture/` for the architecture stage, `docs/` for the ' +
      'specification stage, `review/` for the specification review). This conversation is ' +
      'not bound to a stage.'
    );
  }
  if (agentType === 'epic-pr-review') {
    return (
      'This conversation runs inside the ticket\'s git worktree (its working directory) and ' +
      'changes the code THERE — that is the one place it writes. The epic archive above is ' +
      'read-only: never write into it, and never write into the project\'s main checkout.'
    );
  }
  if (agentType === 'epic-delivery') {
    return (
      'This conversation runs inside the epic\'s DELIVERY worktree (its working directory), ' +
      'which has the epic feature branch checked out — that is the one place it writes. The ' +
      'epic archive above is read-only, and the project\'s main checkout is off limits: it is ' +
      'the working copy a person (and, on a self-hosting box, the running service) is using, ' +
      'so never `cd` into it and never change its HEAD.'
    );
  }
  if (agentType === 'epic-qa-execution') {
    return (
      'This conversation runs inside the epic\'s DELIVERY worktree (its working directory), ' +
      'which has the epic feature branch checked out — but ONLY to run the app, never to ' +
      'change it: never modify the worktree\'s code or git state. QA results are recorded ' +
      'exclusively through the `record_qa_results` tool; the epic archive above, the ' +
      'scenarios CSV included, is otherwise read-only. The project\'s main checkout is off ' +
      'limits: never `cd` into it and never change its HEAD.'
    );
  }
  if (agentType === 'epic-qa-fix') {
    return (
      'This conversation\'s working directory is the project\'s MAIN checkout, for framing ' +
      'only — NEVER modify its files, branches or HEAD: it is the working copy a person ' +
      '(and, on a self-hosting box, the running service) is using. Code edits belong ' +
      'exclusively in the fix ticket\'s git worktree (absolute path from ' +
      '`get_task_progress`). The epic\'s DELIVERY worktree may only be updated with ' +
      '`git pull --ff-only` and used to run the app for re-testing. QA results are recorded ' +
      'exclusively through the `record_qa_results` tool; the epic archive above, the ' +
      'scenarios CSV included, is otherwise read-only.'
    );
  }
  const dirs = getEpicStageWritableDirs(agentType, projectId, epicId);
  if (dirs.length === 0) return 'This stage writes no files. Never write into the repository.';
  if (dirs.length === 1) {
    return `\`${dirs[0]}\` is the ONLY directory this conversation may write to (enforced). Never write into the repository.`;
  }
  const list = dirs.map((d) => `\`${d}\``).join(', ');
  return `${list} are the ONLY directories this conversation may write to (enforced). Never write into the repository.`;
}

/**
 * Context prompt for an epic conversation — the epic-scoped counterpart of
 * `buildContextPrompt`. Hands the agent the authoritative absolute paths of the
 * epic's archive (uploaded spec files, the architecture document, the
 * technical-spec docs) and tells it to read the spec before doing anything
 * else. `agentType` is the stage this conversation runs (undefined for a manual
 * epic chat) and only drives the write rule. Deliberately says nothing about
 * tickets: epic docs never leak into ticket worktrees, and ticket agents never
 * see this prompt.
 */
export function buildEpicContextPrompt(
  projectId: number,
  epicId: number,
  agentType?: EpicAgentType,
): string {
  const specDir = getEpicSpecDir(projectId, epicId);
  const architectureDir = getEpicArchitectureDir(projectId, epicId);
  const docsDir = getEpicDocsDir(projectId, epicId);
  const reviewDir = getEpicReviewDir(projectId, epicId);
  const qaDir = getEpicQaDir(projectId, epicId);
  const specFiles = listEpicSpecFiles(projectId, epicId);
  const architectureDocs = listEpicArchitectureDocs(projectId, epicId);
  const docs = listEpicDocs(projectId, epicId);

  const sections: string[] = [];

  sections.push(`## Epic Archive

This conversation belongs to epic #${epicId}. Its documents live OUTSIDE the repository, in the archive below. These paths are authoritative — never search the repo for them:

- Functional specification (uploaded by the user${agentType === 'epic-spec-review' ? '; amended by the specification review on the user\'s confirmation' : ', read-only'}): \`${specDir}\`
- Architecture document (written by the architecture stage): \`${architectureDir}\`
- Technical specification documents (written by the specification stage): \`${docsDir}\`
- Specification review report (written by the review stage, for the user): \`${reviewDir}\`
- QA scenarios (written by the QA scenario stage; results recorded by QA execution): \`${qaDir}\`

${writeRuleSection(agentType, projectId, epicId)}`);

  if (agentType === 'epic-qa-execution' || agentType === 'epic-qa-fix') {
    const devServerPort = getEpicDevServerPort(epicId);
    const serverHome =
      agentType === 'epic-qa-fix'
        ? "the epic's DELIVERY worktree (its absolute path is in your opening message — NOT this conversation's working directory)"
        : "this conversation's working directory (the epic's delivery worktree)";
    sections.push(`## Testing Configuration

- **Epic ID:** ${epicId}
- **Dev Server Port:** ${devServerPort}

When driving the app with the Playwright MCP browser tools, run the project's dev server yourself, from ${serverHome}, on port ${devServerPort}:
1. Check the port is free first: \`lsof -i:${devServerPort}\`. If it is occupied, pick another free port — NEVER kill a process you did not start in this same turn, even one on your assigned port.
2. Find the start command in the project's files (README, package.json, Procfile) and start the server with your port as a shell background process inside a plain Bash call (e.g. \`PORT=${devServerPort} npm run dev > /tmp/qa-server-${devServerPort}.log 2>&1 &\`), then confirm it answers with \`curl\`. Do NOT use the Bash tool's run_in_background option. The server only lives until this turn ends — every process this turn started is terminated with it — so start it again at the top of the next turn if you still need it.
3. Verify the process you started is serving THIS worktree, then test against \`http://localhost:${devServerPort}\` (or the port you actually used).
4. Before ending every turn, stop the server you started: \`lsof -ti:${devServerPort} | xargs kill -9 2>/dev/null || true\` (only for the port YOU used).`);
  }

  if (specFiles.length > 0) {
    const fileList = specFiles.map((f) => `- ${path.join(specDir, f.name)}`).join('\n');
    sections.push(
      `## Functional Specification — read these first\n\nBefore answering, you MUST read every file below in full with the Read tool. They are the source of truth for what this epic must deliver:\n\n${fileList}`,
    );
  } else {
    sections.push(
      `## Functional Specification\n\nNo spec files have been uploaded for this epic yet. Work from the user's messages, and say so if you need the specification.`,
    );
  }

  if (architectureDocs.length > 0) {
    const fileList = architectureDocs
      .map((f) => `- ${path.join(architectureDir, f.name)}`)
      .join('\n');
    sections.push(
      `## Architecture Document\n\nThe architecture stage wrote the following file(s) for this epic — the epic split into topics, with the key decisions and diagrams:\n\n${fileList}`,
    );
  }

  if (docs.length > 0) {
    const docList = docs.map((f) => `- ${path.join(docsDir, f.name)}`).join('\n');
    sections.push(
      `## Technical Specification Documents\n\nThe following documents already exist for this epic:\n\n${docList}`,
    );
  }

  return sections.join('\n\n---\n\n');
}

