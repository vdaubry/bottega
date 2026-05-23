import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { db, projectsDb, tasksDb } from '../database/db.js';
import { writeTaskDoc } from './documentation.js';
import { createWorktree, isGitRepository } from './worktree.js';
import {
  DEMO_PROJECT_NAME,
  DEMO_TASK_TITLE,
  TASK_DOC_TEMPLATE,
} from './demoSeederTemplates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface SeedResult {
  projectId: number;
  taskId: number;
  repoPath: string;
  skipped: 'already-seeded' | 'no-source' | null;
}

export interface SeedOptions {
  sourceDir?: string;
  targetDir?: string;
  silent?: boolean;
}

export function isDemoAlreadySeeded(): boolean {
  return projectsDb.getAllAdmin().length > 0;
}

function defaultSourceDir(): string {
  return path.resolve(__dirname, '../../examples/landing-page');
}

function defaultTargetDir(): string {
  return (
    process.env.BOTTEGA_DEMO_TARGET_DIR ||
    path.join(os.homedir(), 'bottega-examples', 'landing-page')
  );
}

function dirIsEmpty(p: string): boolean {
  try {
    return fs.readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

function pickAvailableTarget(base: string): string {
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find an available target directory near ${base}`);
}

function copyExampleTree(sourceDir: string, targetDir: string): void {
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: src => !/(^|\/)node_modules(\/|$)/.test(src),
  });
}

function gitInitRepo(targetDir: string, silent: boolean): void {
  const opts = { cwd: targetDir, stdio: silent ? 'ignore' : 'inherit' } as const;

  const init = spawnSync('git', ['init', '-b', 'main'], opts);
  if (init.error && (init.error as NodeJS.ErrnoException).code === 'ENOENT') {
    console.warn(
      '[demo-seeder] git not found on PATH — sample repo will not be a git repo. Install git and re-run to fix.'
    );
    return;
  }
  spawnSync('git', ['add', '-A'], opts);
  spawnSync(
    'git',
    [
      '-c',
      'user.email=demo@bottega.local',
      '-c',
      'user.name=Bottega',
      'commit',
      '-m',
      'Initial commit',
    ],
    opts
  );
}

function findExistingProjectIdByPath(repoPath: string): number | undefined {
  const row = db
    .prepare('SELECT id FROM projects WHERE repo_folder_path = ?')
    .get(repoPath) as { id: number } | undefined;
  return row?.id;
}

export async function seedDemoProject(
  userId: number,
  opts: SeedOptions = {}
): Promise<SeedResult> {
  const sourceDir = opts.sourceDir ?? defaultSourceDir();
  const targetDirInput = opts.targetDir ?? defaultTargetDir();
  const silent = opts.silent ?? false;

  if (isDemoAlreadySeeded()) {
    return { projectId: 0, taskId: 0, repoPath: targetDirInput, skipped: 'already-seeded' };
  }

  if (!fs.existsSync(sourceDir)) {
    if (!silent) {
      console.warn(`[demo-seeder] source not found at ${sourceDir}, skipping.`);
    }
    return { projectId: 0, taskId: 0, repoPath: targetDirInput, skipped: 'no-source' };
  }

  let targetDir = targetDirInput;
  const targetExists = fs.existsSync(targetDir);
  const hasGitDir = targetExists && fs.existsSync(path.join(targetDir, '.git'));

  if (targetExists && hasGitDir) {
    // Reuse — assume a previous successful run. Don't copy or re-init.
  } else if (targetExists && dirIsEmpty(targetDir)) {
    copyExampleTree(sourceDir, targetDir);
    gitInitRepo(targetDir, silent);
  } else if (targetExists) {
    // Non-empty, no .git/ — refuse to clobber user data.
    targetDir = pickAvailableTarget(targetDirInput);
    fs.mkdirSync(targetDir, { recursive: true });
    copyExampleTree(sourceDir, targetDir);
    gitInitRepo(targetDir, silent);
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
    copyExampleTree(sourceDir, targetDir);
    gitInitRepo(targetDir, silent);
  }

  let projectId: number;
  try {
    const created = projectsDb.create(userId, DEMO_PROJECT_NAME, targetDir, null);
    projectId = created.id;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existingId = findExistingProjectIdByPath(targetDir);
      if (!existingId) throw e;
      projectId = existingId;
    } else {
      throw e;
    }
  }

  const task = tasksDb.create(projectId, DEMO_TASK_TITLE, false, userId);
  writeTaskDoc(projectId, task.id, TASK_DOC_TEMPLATE);

  if (await isGitRepository(targetDir)) {
    await createWorktree(targetDir, task.id, DEMO_TASK_TITLE, null);
  }

  return { projectId, taskId: task.id, repoPath: targetDir, skipped: null };
}
