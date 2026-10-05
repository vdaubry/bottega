// Atlas workspace — read-only, containment-enforced file access for the
// Explore (IDE) view and the code-atlas MCP tools. Ported from CodeAtlas
// (src/main/workspace.ts), minus the Electron/remote-SSH abstraction.

import { promises as fs } from 'fs';
import * as path from 'path';
import { worktreeExists, getWorktreeProjectPath } from '../worktree.js';
import type { TaskWithProject } from '../../database/db.js';
import type { AtlasTreeEntry } from '@shared/types/atlas';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB — this is a reading surface, not a hex viewer

export interface FilePayload {
  path: string; // workspace-relative, posix separators
  absPath: string;
  content: string;
  lineCount: number;
}

export class WorkspaceError extends Error {}

export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

export function sortEntries(entries: AtlasTreeEntry[]): AtlasTreeEntry[] {
  return entries.sort((a, b) =>
    a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name),
  );
}

/**
 * All filesystem access for a task's workspace goes through here so that
 * path containment (no escaping the root) is enforced in one place.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Resolve a workspace-relative path, rejecting anything outside the root. */
  resolve(relPath: string): string {
    if (typeof relPath !== 'string' || relPath.length === 0) {
      throw new WorkspaceError('Path must be a non-empty string');
    }
    const abs = path.resolve(this.root, relPath);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new WorkspaceError(`Path "${relPath}" is outside the project root`);
    }
    return abs;
  }

  relative(absPath: string): string {
    return path.relative(this.root, absPath).split(path.sep).join('/');
  }

  async listDir(relPath: string): Promise<AtlasTreeEntry[]> {
    const abs = relPath === '' || relPath === '.' ? this.root : this.resolve(relPath);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const result: AtlasTreeEntry[] = [];
    for (const e of entries) {
      if (!e.isDirectory() && !e.isFile()) continue; // skip sockets, symlink edge cases
      result.push({
        name: e.name,
        path: this.relative(path.join(abs, e.name)),
        type: e.isDirectory() ? 'dir' : 'file',
      });
    }
    return sortEntries(result);
  }

  async readFile(relPath: string): Promise<FilePayload> {
    const abs = this.resolve(relPath);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new WorkspaceError(`File not found: ${relPath}`);
    }
    if (stat.isDirectory()) {
      throw new WorkspaceError(`"${relPath}" is a directory, not a file`);
    }
    if (stat.size > MAX_FILE_SIZE) {
      throw new WorkspaceError(
        `File too large to preview (${(stat.size / 1024 / 1024).toFixed(1)} MB): ${relPath}`,
      );
    }
    const buf = await fs.readFile(abs);
    if (looksBinary(buf)) {
      throw new WorkspaceError(`"${relPath}" appears to be a binary file`);
    }
    const content = buf.toString('utf8');
    const lineCount = content.length === 0 ? 1 : content.split('\n').length;
    return { path: this.relative(abs), absPath: abs, content, lineCount };
  }
}

/**
 * The Explore view and the code-atlas tools must show exactly what a
 * conversation on this task sees: the task worktree when one exists,
 * otherwise the project repo (same rule as startConversation).
 */
export async function getWorkspaceForTask(taskWithProject: TaskWithProject): Promise<Workspace> {
  let root = taskWithProject.repo_folder_path;
  if (await worktreeExists(root, taskWithProject.id)) {
    root = getWorktreeProjectPath(root, taskWithProject.id, taskWithProject.subproject_path);
  }
  return new Workspace(root);
}
