// Which server owns this database file.
//
// Boot performs crash recovery: it sweeps every agent run still marked
// 'running' to 'failed', reconciles task landings (which removes git
// worktrees), and wakes every orchestrating epic. All three are correct
// exactly once — when the process that *started* those runs died and left
// them behind. They are written on the assumption that this server is the
// only one on this database.
//
// On a box where the live service and worktree dev servers share one SQLite
// file (the worktree `server/database/bottega.db` is a symlink to the live
// one), that assumption is false. A dev server booting for a QA pass ran the
// sweep against runs the live service was actively streaming, and marked them
// failed mid-flight — which then made the live service's completion hook take
// its "the user aborted" branch and stop chaining the workflow. The runs kept
// streaming to a healthy finish that no longer led anywhere.
//
// So recovery is gated on ownership: a server recovers only what it is in a
// position to reason about. Ownership is a pid recorded next to the database;
// a dead pid means the owner crashed and its wreckage is genuinely ours.
// Everything else about a non-owning server is unchanged — it serves, reads,
// writes, and runs the agents you start on it.

import fs from 'fs';
import path from 'path';

/** What a lock file holds. Informational beyond `pid` — for the human reading it. */
interface OwnerRecord {
  pid: number;
  startedAt: string;
  install: string;
}

export interface OwnershipClaim {
  /** True when this process may perform boot-time crash recovery. */
  owned: boolean;
  /** The database this claim is about, symlinks resolved. */
  databasePath: string;
  /** The live owner that refused us, when `owned` is false. */
  heldBy?: OwnerRecord;
}

/**
 * Resolve to the file recovery actually acts on. Essential rather than
 * cosmetic: a worktree's `server/database/bottega.db` is a symlink to the
 * live database, so locking beside the *link* would give every worktree its
 * own private lock and guard nothing. `realpathSync` collapses them onto one
 * path, and therefore one lock.
 *
 * Falls back to the unresolved path when the file does not exist yet (a fresh
 * install). By the time boot claims ownership the connection has already
 * created it, so this is defensive.
 */
export function resolveDatabasePath(dbPath: string): string {
  try {
    return fs.realpathSync(dbPath);
  } catch {
    return path.resolve(dbPath);
  }
}

function lockPathFor(dbPath: string): string {
  return `${resolveDatabasePath(dbPath)}.owner`;
}

/** Is this pid a live process? `signal 0` tests without delivering anything. */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user — alive for
    // our purposes, and not ours to recover for.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(lockPath: string): OwnerRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<OwnerRecord>;
    if (typeof parsed?.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : 'unknown',
      install: typeof parsed.install === 'string' ? parsed.install : 'unknown',
    };
  } catch {
    // Missing, truncated by a crash mid-write, or hand-edited. Treat an
    // unreadable lock as no lock: a corrupt file must not wedge recovery
    // shut on the one boot that needs it.
    return null;
  }
}

function writeOwner(lockPath: string, record: OwnerRecord): void {
  fs.writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Claim the right to run crash recovery against `dbPath`.
 *
 * Returns `owned: false` when a live process already holds the lock — the
 * caller must then skip every boot recovery action. Never throws: a
 * filesystem that will not take the lock (read-only mount, permissions)
 * yields `owned: false`, because a server that cannot record ownership
 * cannot claim it either.
 *
 * Two known, accepted limits, both strictly better than the unconditional
 * sweep they replace:
 *  - **pid reuse.** A lock left by a hard crash whose pid the OS has since
 *    handed to an unrelated process reads as "still owned", so recovery is
 *    skipped once. It is logged loudly and names the pid, so a human can see
 *    it; a graceful shutdown releases the lock and avoids the case entirely.
 *  - **simultaneous takeover.** Two servers booting within milliseconds of
 *    each other, both finding the same dead owner, can both take over. The
 *    exclusive create below makes the common race (cold start, no lock)
 *    atomic; the dead-owner path is last-writer-wins.
 */
export function claimDatabaseOwnership(dbPath: string): OwnershipClaim {
  const databasePath = resolveDatabasePath(dbPath);
  const lockPath = lockPathFor(dbPath);
  const record: OwnerRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    install: process.cwd(),
  };

  try {
    // 'wx' fails if the lock exists, making the uncontended claim atomic
    // against another server starting at the same moment.
    fs.writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    return { owned: true, databasePath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      return { owned: false, databasePath };
    }
  }

  const held = readOwner(lockPath);
  if (held && held.pid !== process.pid && isAlive(held.pid)) {
    return { owned: false, databasePath, heldBy: held };
  }

  // No readable owner, or one that is gone: its wreckage is ours to recover.
  try {
    writeOwner(lockPath, record);
    return { owned: true, databasePath };
  } catch {
    return { owned: false, databasePath };
  }
}

/**
 * Drop the lock on a graceful shutdown, so the next boot recovers instead of
 * reading a stale pid. Only ever removes a lock this process holds — a
 * non-owning server exiting must not hand the live service's database away.
 */
export function releaseDatabaseOwnership(dbPath: string): void {
  const lockPath = lockPathFor(dbPath);
  try {
    if (readOwner(lockPath)?.pid !== process.pid) return;
    fs.unlinkSync(lockPath);
  } catch {
    // Best-effort: a shutdown path never throws. A leftover lock is
    // self-healing — the next boot finds a dead pid and takes over.
  }
}
