import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fakeProjects: Array<{ id: number; repoPath: string }> = [];
const fakeTasks: Array<{ id: number; projectId: number; title: string; userId: number | null }> = [];
let nextProjectId = 1;
let nextTaskId = 1;
let uniqueViolationOnNextCreate = false;

vi.mock('../database/db.js', () => ({
  db: {
    prepare: (_sql: string) => ({
      get: (repoPath: string) => {
        const existing = fakeProjects.find(p => p.repoPath === repoPath);
        return existing ? { id: existing.id } : undefined;
      },
    }),
  },
  projectsDb: {
    getAllAdmin: () => fakeProjects.map(p => ({ id: p.id })),
    create: (userId: number, _name: string, repoPath: string) => {
      if (uniqueViolationOnNextCreate) {
        uniqueViolationOnNextCreate = false;
        const err = new Error('UNIQUE constraint failed: projects.repo_folder_path');
        (err as NodeJS.ErrnoException).code = 'SQLITE_CONSTRAINT_UNIQUE';
        throw err;
      }
      const id = nextProjectId++;
      fakeProjects.push({ id, repoPath });
      return { id, userId, name: _name, repoFolderPath: repoPath, subprojectPath: null };
    },
  },
  tasksDb: {
    create: (projectId: number, title: string, _yolo: boolean, userId: number | null) => {
      const id = nextTaskId++;
      fakeTasks.push({ id, projectId, title, userId });
      return { id, projectId, user_id: userId, title, status: 'pending', yolo_mode: 0 };
    },
  },
}));

const taskDocPaths = new Map<string, string>();
vi.mock('./documentation.js', () => ({
  writeTaskDoc: (projectId: number, taskId: number, content: string) => {
    taskDocPaths.set(`${projectId}:${taskId}`, content);
  },
}));

// We let real `git` run against the temp target dirs — the seeder's spawnSync
// calls are cheap and exercising them gives us real coverage. If `git` is not
// on PATH (rare), the seeder warns and continues, and the assertions below
// still hold (we don't require `.git/` to exist).

import { seedDemoProject, isDemoAlreadySeeded } from './demoSeeder.js';

const TMP_PREFIX = path.join(os.tmpdir(), 'demoseederXXXXXX');

function mkTmpExample(): string {
  const dir = fs.mkdtempSync(TMP_PREFIX);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app', 'page.tsx'), 'export default function Page() {}');
  // include a node_modules folder to verify it's filtered out
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'should-be-filtered.txt'), 'x');
  return dir;
}

function mkTmpTarget(): string {
  return path.join(fs.mkdtempSync(TMP_PREFIX), 'landing-page');
}

describe('demoSeeder', () => {
  let sourceDir: string;
  let targetDir: string;
  let cleanup: string[] = [];

  beforeEach(() => {
    fakeProjects.length = 0;
    fakeTasks.length = 0;
    taskDocPaths.clear();
    nextProjectId = 1;
    nextTaskId = 1;
    uniqueViolationOnNextCreate = false;

    sourceDir = mkTmpExample();
    targetDir = mkTmpTarget();
    cleanup.push(sourceDir, path.dirname(targetDir));
  });

  afterEach(() => {
    for (const p of cleanup) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    cleanup = [];
  });

  it('seeds a project + task + task doc on a fresh install', async () => {
    const result = await seedDemoProject(42, { sourceDir, targetDir, silent: true });

    expect(result.skipped).toBeNull();
    expect(result.projectId).toBe(1);
    expect(result.taskId).toBe(1);
    expect(result.repoPath).toBe(targetDir);

    expect(fakeProjects).toHaveLength(1);
    expect(fakeProjects[0]?.repoPath).toBe(targetDir);
    expect(fakeTasks).toHaveLength(1);
    expect(fakeTasks[0]?.title).toBe('Add a dark-mode toggle to the landing page');
    expect(taskDocPaths.get('1:1')).toMatch(/dark-mode toggle/i);

    expect(fs.existsSync(path.join(targetDir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'app', 'page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'node_modules'))).toBe(false);
  });

  it('is idempotent — second call returns skipped:already-seeded with no duplicate rows', async () => {
    await seedDemoProject(42, { sourceDir, targetDir, silent: true });
    const second = await seedDemoProject(
      42,
      { sourceDir, targetDir: mkTmpTarget(), silent: true }
    );

    expect(second.skipped).toBe('already-seeded');
    expect(fakeProjects).toHaveLength(1);
    expect(fakeTasks).toHaveLength(1);
  });

  it('returns skipped:no-source when sourceDir does not exist (no throw)', async () => {
    const missing = path.join(os.tmpdir(), 'definitely-does-not-exist-' + Date.now());
    const result = await seedDemoProject(42, {
      sourceDir: missing,
      targetDir,
      silent: true,
    });

    expect(result.skipped).toBe('no-source');
    expect(fakeProjects).toHaveLength(0);
    expect(fakeTasks).toHaveLength(0);
  });

  it('isDemoAlreadySeeded reflects fakeProjects length', () => {
    expect(isDemoAlreadySeeded()).toBe(false);
    fakeProjects.push({ id: 1, repoPath: '/x' });
    expect(isDemoAlreadySeeded()).toBe(true);
  });

  it('reuses an existing target directory that already has .git/', async () => {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(path.join(targetDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'preexisting.txt'), 'leave me alone');

    const result = await seedDemoProject(42, { sourceDir, targetDir, silent: true });

    expect(result.skipped).toBeNull();
    expect(result.repoPath).toBe(targetDir);
    // preexisting content should NOT have been overwritten
    expect(fs.readFileSync(path.join(targetDir, 'preexisting.txt'), 'utf8')).toBe('leave me alone');
    // and source files should NOT have been copied in
    expect(fs.existsSync(path.join(targetDir, 'package.json'))).toBe(false);
  });

  it('picks a sibling target when the requested one is non-empty and not a git repo', async () => {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'unrelated.txt'), 'user data');

    const result = await seedDemoProject(42, { sourceDir, targetDir, silent: true });

    expect(result.skipped).toBeNull();
    expect(result.repoPath).not.toBe(targetDir);
    expect(result.repoPath.startsWith(targetDir + '-')).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'unrelated.txt'), 'utf8')).toBe('user data');
    expect(fs.existsSync(path.join(result.repoPath, 'package.json'))).toBe(true);
  });
});
