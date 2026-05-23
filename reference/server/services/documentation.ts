import fs from 'fs';
import os from 'os';
import path from 'path';

const TASKS_FOLDER = 'tasks';
const RECORDINGS_FOLDER = 'recordings';
const INPUT_FILES_FOLDER = 'input_files';
const TMP_FOLDER = 'tmp';

/**
 * Root of the central per-user archive for task documentation, attachments,
 * and recordings. These files live outside the project repo so they survive
 * worktree destruction on task merge.
 *
 * Override with BOTTEGA_ARCHIVE_ROOT in tests.
 */
function getArchiveRoot(): string {
  return process.env.BOTTEGA_ARCHIVE_ROOT || path.join(os.homedir(), '.bottega');
}

function getProjectArchivePath(projectId: number): string {
  return path.join(getArchiveRoot(), 'projects', String(projectId));
}

function getArchiveTasksFolderPath(projectId: number): string {
  return path.join(getProjectArchivePath(projectId), TASKS_FOLDER);
}

function getArchiveRecordingsFolderPath(projectId: number): string {
  return path.join(getProjectArchivePath(projectId), RECORDINGS_FOLDER);
}

export function getTaskDocPath(projectId: number, taskId: number): string {
  return path.join(getArchiveTasksFolderPath(projectId), `task-${taskId}.md`);
}

export function getTaskInputFilesPath(projectId: number, taskId: number): string {
  return path.join(getArchiveTasksFolderPath(projectId), `task-${taskId}`, INPUT_FILES_FOLDER);
}

export function getRecordingPath(projectId: number, taskId: number): string {
  return path.join(getArchiveRecordingsFolderPath(projectId), `task-${taskId}.webm`);
}

function getTmpFolderPath(repoPath: string): string {
  return path.join(repoPath, TMP_FOLDER);
}

function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.csv': 'text/csv',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.jsx': 'text/javascript',
    '.tsx': 'text/typescript',
    '.py': 'text/x-python',
    '.rb': 'text/x-ruby',
    '.go': 'text/x-go',
    '.rs': 'text/x-rust',
    '.java': 'text/x-java',
    '.c': 'text/x-c',
    '.cpp': 'text/x-c++',
    '.h': 'text/x-c',
    '.hpp': 'text/x-c++',
    '.css': 'text/css',
    '.scss': 'text/x-scss',
    '.html': 'text/html',
    '.xml': 'text/xml',
    '.sh': 'application/x-sh',
    '.bash': 'application/x-sh',
    '.sql': 'text/x-sql',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

function ensureProjectArchive(projectId: number): void {
  const tasksPath = getArchiveTasksFolderPath(projectId);
  fs.mkdirSync(tasksPath, { recursive: true });
}

export function ensureTmpFolder(repoPath: string): string {
  try {
    const tmpPath = getTmpFolderPath(repoPath);
    if (!fs.existsSync(tmpPath)) {
      fs.mkdirSync(tmpPath, { recursive: true });
    }
    return tmpPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to ensure tmp folder: ${message}`);
    throw error;
  }
}

export interface SavedUploadInfo {
  name: string;
  absolutePath: string;
  relativePath: string;
  size: number;
  mimeType: string;
}

export function saveConversationUpload(
  repoPath: string,
  filename: string,
  buffer: Buffer,
): SavedUploadInfo {
  try {
    const tmpPath = ensureTmpFolder(repoPath);
    const sanitizedName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(tmpPath, sanitizedName);

    fs.writeFileSync(filePath, buffer);

    const stats = fs.statSync(filePath);
    const ext = path.extname(sanitizedName).toLowerCase();

    return {
      name: sanitizedName,
      absolutePath: filePath,
      relativePath: `./tmp/${sanitizedName}`,
      size: stats.size,
      mimeType: getMimeType(ext),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to save conversation upload: ${message}`);
    throw error;
  }
}

export function readTaskDoc(projectId: number, taskId: number): string {
  try {
    const docPath = getTaskDocPath(projectId, taskId);

    if (!fs.existsSync(docPath)) {
      return '';
    }

    return fs.readFileSync(docPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read task documentation: ${message}`);
    throw error;
  }
}

export function writeTaskDoc(projectId: number, taskId: number, content: string): void {
  try {
    ensureProjectArchive(projectId);

    const docPath = getTaskDocPath(projectId, taskId);
    fs.writeFileSync(docPath, content, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to write task documentation: ${message}`);
    throw error;
  }
}

export function deleteTaskDoc(projectId: number, taskId: number): boolean {
  try {
    const docPath = getTaskDocPath(projectId, taskId);

    if (!fs.existsSync(docPath)) {
      return false;
    }

    fs.unlinkSync(docPath);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to delete task documentation: ${message}`);
    throw error;
  }
}

export function deleteTaskArchive(projectId: number, taskId: number): void {
  try {
    const docPath = getTaskDocPath(projectId, taskId);
    if (fs.existsSync(docPath)) {
      fs.unlinkSync(docPath);
    }

    const taskFolder = path.join(getArchiveTasksFolderPath(projectId), `task-${taskId}`);
    if (fs.existsSync(taskFolder)) {
      fs.rmSync(taskFolder, { recursive: true, force: true });
    }

    const recordingPath = getRecordingPath(projectId, taskId);
    if (fs.existsSync(recordingPath)) {
      fs.unlinkSync(recordingPath);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to delete task archive: ${message}`);
    throw error;
  }
}

export interface InputFileInfo {
  name: string;
  size: number;
  mimeType: string;
}

function listInputFiles(inputFilesPath: string): InputFileInfo[] {
  if (!fs.existsSync(inputFilesPath)) {
    return [];
  }

  const entries = fs.readdirSync(inputFilesPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const stats = fs.statSync(path.join(inputFilesPath, entry.name));
      const ext = path.extname(entry.name).toLowerCase();
      return {
        name: entry.name,
        size: stats.size,
        mimeType: getMimeType(ext),
      };
    });
}

function saveInputFile(
  inputFilesPath: string,
  filename: string,
  buffer: Buffer,
): InputFileInfo {
  const sanitizedName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(inputFilesPath, sanitizedName);

  fs.writeFileSync(filePath, buffer);

  const ext = path.extname(sanitizedName).toLowerCase();

  return {
    name: sanitizedName,
    size: buffer.length,
    mimeType: getMimeType(ext),
  };
}

function deleteInputFile(inputFilesPath: string, filename: string): boolean {
  const filePath = path.join(inputFilesPath, path.basename(filename));

  if (!fs.existsSync(filePath)) {
    return false;
  }

  fs.unlinkSync(filePath);
  return true;
}

export function ensureTaskInputFilesFolder(projectId: number, taskId: number): string {
  const inputFilesPath = getTaskInputFilesPath(projectId, taskId);
  fs.mkdirSync(inputFilesPath, { recursive: true });
  return inputFilesPath;
}

export function listTaskInputFiles(projectId: number, taskId: number): InputFileInfo[] {
  return listInputFiles(getTaskInputFilesPath(projectId, taskId));
}

export function saveTaskInputFile(
  projectId: number,
  taskId: number,
  filename: string,
  buffer: Buffer,
): InputFileInfo {
  const inputFilesPath = ensureTaskInputFilesFolder(projectId, taskId);
  return saveInputFile(inputFilesPath, filename, buffer);
}

export function deleteTaskInputFile(
  projectId: number,
  taskId: number,
  filename: string,
): boolean {
  return deleteInputFile(getTaskInputFilesPath(projectId, taskId), filename);
}

/**
 * Calculate the dev server port for a task
 * Uses convention: 3100 + (task_id % 900) to get ports in range 3100-3999
 */
export function getDevServerPort(taskId: number): number {
  return 3100 + (taskId % 900);
}

/**
 * Build a context prompt from task documentation and input files.
 * Task doc + input files live in the central archive (per-user).
 */
export function buildContextPrompt(projectId: number, taskId: number): string {
  const devServerPort = getDevServerPort(taskId);

  const sections: string[] = [];

  const taskDocPath = getTaskDocPath(projectId, taskId);
  sections.push(`## Task Plan File

The canonical task plan — also known as the specification for this task — is stored at:
\`${taskDocPath}\`

**At the start of this conversation, before answering the user's first message, you MUST read this file in full using the Read tool.** It contains the requirements, constraints, and prior decisions you need to do this work correctly. Do not skip this step even if the user's first message looks unrelated to the plan.

When the user refers to the "task plan", "task doc", "task spec", "specifications", or asks you to read or update the task documentation, this is the file — read or edit it directly with the Read/Edit tool. Do NOT search for it elsewhere; the path above is authoritative.

Note: any \`.bottega/tasks/*.md\` files inside the repo itself are legacy from before task docs were moved to a central archive. Ignore them — the path above is the only source of truth.`);

  const inputFiles = listTaskInputFiles(projectId, taskId);
  if (inputFiles.length > 0) {
    const inputFilesPath = getTaskInputFilesPath(projectId, taskId);
    const fileList = inputFiles.map((f) => `- ${f.name}`).join('\n');
    sections.push(
      `## Input Files\n\nIMPORTANT: At the start of this conversation, you MUST read ALL files in the following directory to get context:\n${inputFilesPath}\n\nFiles to read:\n${fileList}\n\nUse the Read tool to read each file before proceeding with any other actions. These files contain important context for this task.`,
    );
  }

  sections.push(`## Testing Configuration

- **Task ID:** ${taskId}
- **Dev Server Port:** ${devServerPort}

When running Playwright MCP tests, start the project's dev server on port ${devServerPort}:
1. Check project files (README, package.json, Procfile) for the start command
2. Start server with your assigned port (e.g., \`PORT=${devServerPort} bin/dev\` or \`npm run dev -- --port ${devServerPort}\`)
3. Run Playwright tests against \`http://localhost:${devServerPort}\`
4. Stop the server when testing is complete: \`lsof -ti:${devServerPort} | xargs kill -9 2>/dev/null || true\`

### Test Execution Best Practices

When running the project's test suite:

1. **Run targeted tests first**: Only run test files related to your changes. This gives fast feedback.
2. **Full suite = background**: When running the complete test suite, ALWAYS use \`run_in_background: true\` on the Bash tool. Full suites can take 5-15 minutes and will exceed the default timeout.
3. **Wait for backgrounded tests before re-launching**: If a test command gets backgrounded (you receive a task ID), wait for it to complete using TaskOutput with \`block: true\`. Do NOT start another test run while one is still running — parallel suites compete for resources and take even longer. Only re-launch if the previous run completed and failed.
4. **Use fail-fast flags**: If the test framework supports it, use a fail-fast option to exit on first failure.
5. **Set generous timeouts**: If not using run_in_background, set \`timeout: 600000\` (10 minutes) for full test suites.`);

  return sections.join('\n\n---\n\n');
}

// Export path helper functions for testing
export const _internal = {
  getTmpFolderPath,
  getMimeType,
  getArchiveRoot,
  getProjectArchivePath,
  getArchiveTasksFolderPath,
  getArchiveRecordingsFolderPath,
};
