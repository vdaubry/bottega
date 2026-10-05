import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const { mockWorktreeExists, mockGetWorktreeProjectPath } = vi.hoisted(() => ({
  mockWorktreeExists: vi.fn(),
  mockGetWorktreeProjectPath: vi.fn(),
}));

vi.mock('../worktree.js', () => ({
  worktreeExists: mockWorktreeExists,
  getWorktreeProjectPath: mockGetWorktreeProjectPath,
}));

import {
  Workspace,
  WorkspaceError,
  looksBinary,
  sortEntries,
  getWorkspaceForTask,
} from './workspace.js';
import type { TaskWithProject } from '../../database/db.js';

describe('Workspace', () => {
  let root: string;
  let ws: Workspace;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-ws-'));
    ws = new Workspace(root);
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'line1\nline2\nline3');
    await fs.writeFile(path.join(root, 'README.md'), '# hello\n');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('resolve (containment)', () => {
    it('rejects empty paths', () => {
      expect(() => ws.resolve('')).toThrow(WorkspaceError);
    });

    it('rejects parent-directory escapes', () => {
      expect(() => ws.resolve('../outside.txt')).toThrow(/outside the project root/);
      expect(() => ws.resolve('src/../../outside.txt')).toThrow(/outside the project root/);
    });

    it('rejects absolute paths outside the root', () => {
      expect(() => ws.resolve('/etc/passwd')).toThrow(/outside the project root/);
    });

    it('resolves paths inside the root', () => {
      expect(ws.resolve('src/index.ts')).toBe(path.join(root, 'src', 'index.ts'));
    });
  });

  describe('listDir', () => {
    it('lists the root for "" and "." with dirs first, then files, alphabetical', async () => {
      for (const rel of ['', '.']) {
        const entries = await ws.listDir(rel);
        expect(entries.map((e) => `${e.type}:${e.path}`)).toEqual([
          'dir:src',
          'file:README.md',
        ]);
      }
    });

    it('lists subdirectories with workspace-relative posix paths', async () => {
      const entries = await ws.listDir('src');
      expect(entries).toEqual([{ name: 'index.ts', path: 'src/index.ts', type: 'file' }]);
    });

    it('rejects escaping paths', async () => {
      await expect(ws.listDir('../..')).rejects.toThrow(WorkspaceError);
    });
  });

  describe('readFile', () => {
    it('returns content, relative path, and line count', async () => {
      const file = await ws.readFile('src/index.ts');
      expect(file.path).toBe('src/index.ts');
      expect(file.content).toBe('line1\nline2\nline3');
      expect(file.lineCount).toBe(3);
      expect(file.absPath).toBe(path.join(root, 'src', 'index.ts'));
    });

    it('counts an empty file as 1 line', async () => {
      await fs.writeFile(path.join(root, 'empty.txt'), '');
      const file = await ws.readFile('empty.txt');
      expect(file.lineCount).toBe(1);
    });

    it('rejects missing files with "File not found"', async () => {
      await expect(ws.readFile('nope.ts')).rejects.toThrow('File not found: nope.ts');
    });

    it('rejects directories', async () => {
      await expect(ws.readFile('src')).rejects.toThrow(/a directory, not a file/);
    });

    it('rejects files over 2MB', async () => {
      await fs.writeFile(path.join(root, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
      await expect(ws.readFile('big.txt')).rejects.toThrow(/too large to preview/);
    });

    it('rejects binary files', async () => {
      await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([0x68, 0x00, 0x69]));
      await expect(ws.readFile('bin.dat')).rejects.toThrow(/binary file/);
    });
  });
});

describe('looksBinary', () => {
  it('detects NUL bytes in the first 8000 bytes', () => {
    expect(looksBinary(Buffer.from([0x68, 0x00]))).toBe(true);
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
  });
});

describe('sortEntries', () => {
  it('sorts dirs before files, each alphabetically', () => {
    const sorted = sortEntries([
      { name: 'b.txt', path: 'b.txt', type: 'file' },
      { name: 'z', path: 'z', type: 'dir' },
      { name: 'a.txt', path: 'a.txt', type: 'file' },
      { name: 'm', path: 'm', type: 'dir' },
    ]);
    expect(sorted.map((e) => e.name)).toEqual(['m', 'z', 'a.txt', 'b.txt']);
  });
});

describe('getWorkspaceForTask', () => {
  const task = {
    id: 42,
    repo_folder_path: '/repos/demo',
    subproject_path: null,
  } as TaskWithProject;

  beforeEach(() => {
    mockWorktreeExists.mockReset();
    mockGetWorktreeProjectPath.mockReset();
  });

  it('uses the worktree path when one exists (same rule as conversations)', async () => {
    mockWorktreeExists.mockResolvedValue(true);
    mockGetWorktreeProjectPath.mockReturnValue('/repos/demo-worktrees/task-42');
    const ws = await getWorkspaceForTask(task);
    expect(ws.root).toBe('/repos/demo-worktrees/task-42');
    expect(mockGetWorktreeProjectPath).toHaveBeenCalledWith('/repos/demo', 42, null);
  });

  it('passes subproject_path through for monorepos', async () => {
    mockWorktreeExists.mockResolvedValue(true);
    mockGetWorktreeProjectPath.mockReturnValue('/repos/demo-worktrees/task-42/apps/web');
    const ws = await getWorkspaceForTask({ ...task, subproject_path: 'apps/web' });
    expect(ws.root).toBe('/repos/demo-worktrees/task-42/apps/web');
    expect(mockGetWorktreeProjectPath).toHaveBeenCalledWith('/repos/demo', 42, 'apps/web');
  });

  it('falls back to the repo path when no worktree exists', async () => {
    mockWorktreeExists.mockResolvedValue(false);
    const ws = await getWorkspaceForTask(task);
    expect(ws.root).toBe('/repos/demo');
    expect(mockGetWorktreeProjectPath).not.toHaveBeenCalled();
  });
});
