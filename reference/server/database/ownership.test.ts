// Database ownership, exercised against the shape that caused the incident:
// a worktree whose `server/database/bottega.db` is a symlink to the live file.
// The properties worth proving are the ones boot depends on — a live owner
// refuses a second claimant, a dead one does not, and a symlinked path locks
// against the file rather than the link.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  claimDatabaseOwnership,
  releaseDatabaseOwnership,
  resolveDatabasePath,
} from './ownership.js';

let root: string;
let livePath: string;

/** The lock as it sits on disk, next to the real database. */
function lockFor(dbPath: string): string {
  return `${resolveDatabasePath(dbPath)}.owner`;
}

function readLockPid(dbPath: string): number {
  return (JSON.parse(fs.readFileSync(lockFor(dbPath), 'utf8')) as { pid: number }).pid;
}

function writeLock(dbPath: string, pid: number): void {
  fs.writeFileSync(
    lockFor(dbPath),
    JSON.stringify({ pid, startedAt: new Date().toISOString(), install: '/somewhere' }),
  );
}

/** A pid that is certainly not a running process. */
function deadPid(): number {
  // Walk down from a high pid until one is not alive; 2^22 is above the
  // default pid_max on Linux, so the first candidate is almost always free.
  for (let candidate = 4_194_303; candidate > 4_194_000; candidate--) {
    try {
      process.kill(candidate, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return candidate;
    }
  }
  throw new Error('no dead pid available');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-ownership-'));
  livePath = path.join(root, 'bottega.db');
  fs.writeFileSync(livePath, '');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('claimDatabaseOwnership', () => {
  it('claims an unowned database and writes the lock beside it', () => {
    const claim = claimDatabaseOwnership(livePath);

    expect(claim.owned).toBe(true);
    expect(claim.databasePath).toBe(fs.realpathSync(livePath));
    expect(readLockPid(livePath)).toBe(process.pid);
  });

  it('refuses a database a live process already owns, and names the owner', () => {
    writeLock(livePath, process.pid === 1 ? process.ppid : 1);

    const claim = claimDatabaseOwnership(livePath);

    expect(claim.owned).toBe(false);
    expect(claim.heldBy?.pid).toBeGreaterThan(0);
  });

  it('takes over from an owner that is gone', () => {
    writeLock(livePath, deadPid());

    expect(claimDatabaseOwnership(livePath).owned).toBe(true);
    expect(readLockPid(livePath)).toBe(process.pid);
  });

  it('treats an unreadable lock as no lock, rather than wedging recovery shut', () => {
    fs.writeFileSync(lockFor(livePath), 'not json {{{');

    expect(claimDatabaseOwnership(livePath).owned).toBe(true);
  });

  it('is idempotent for the process that already holds the lock', () => {
    expect(claimDatabaseOwnership(livePath).owned).toBe(true);
    expect(claimDatabaseOwnership(livePath).owned).toBe(true);
  });

  // The incident in one test: the live service owns the real file, a worktree
  // opens it through a symlink, and must not conclude the database is free.
  it('locks against the symlink target, so a worktree cannot claim the live database', () => {
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(worktree);
    const symlinked = path.join(worktree, 'bottega.db');
    fs.symlinkSync(livePath, symlinked);
    writeLock(livePath, process.pid === 1 ? process.ppid : 1);

    const claim = claimDatabaseOwnership(symlinked);

    expect(claim.owned).toBe(false);
    expect(claim.databasePath).toBe(fs.realpathSync(livePath));
    // And no private lock appeared next to the link.
    expect(fs.existsSync(`${symlinked}.owner`)).toBe(false);
  });
});

describe('releaseDatabaseOwnership', () => {
  it('drops a lock this process holds', () => {
    claimDatabaseOwnership(livePath);

    releaseDatabaseOwnership(livePath);

    expect(fs.existsSync(lockFor(livePath))).toBe(false);
  });

  it('leaves another live server’s lock alone', () => {
    const otherPid = process.pid === 1 ? process.ppid : 1;
    writeLock(livePath, otherPid);

    releaseDatabaseOwnership(livePath);

    expect(readLockPid(livePath)).toBe(otherPid);
  });

  it('does not throw when there is no lock at all', () => {
    expect(() => releaseDatabaseOwnership(livePath)).not.toThrow();
  });

  it('lets the next boot recover after a graceful shutdown', () => {
    claimDatabaseOwnership(livePath);
    releaseDatabaseOwnership(livePath);

    expect(claimDatabaseOwnership(livePath).owned).toBe(true);
  });
});

describe('resolveDatabasePath', () => {
  it('collapses a symlink onto the file recovery acts on', () => {
    const link = path.join(root, 'link.db');
    fs.symlinkSync(livePath, link);

    expect(resolveDatabasePath(link)).toBe(fs.realpathSync(livePath));
  });

  it('falls back to an absolute path for a database that does not exist yet', () => {
    const missing = path.join(root, 'nope.db');

    expect(resolveDatabasePath(missing)).toBe(missing);
  });
});
