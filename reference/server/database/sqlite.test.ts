import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isSqliteBusyError, openDatabase, SQLITE_BUSY_TIMEOUT_MS } from './sqlite.js';

describe('isSqliteBusyError', () => {
  it.each([
    'SQLITE_BUSY',
    'SQLITE_BUSY_SNAPSHOT',
    'SQLITE_BUSY_RECOVERY',
    'SQLITE_LOCKED',
    'SQLITE_LOCKED_SHAREDCACHE',
  ])('recognises a SqliteError with code %s', (code) => {
    expect(isSqliteBusyError(new Database.SqliteError('database is locked', code))).toBe(true);
  });

  it('rejects other SqliteError codes', () => {
    expect(
      isSqliteBusyError(
        new Database.SqliteError('UNIQUE constraint failed', 'SQLITE_CONSTRAINT_UNIQUE'),
      ),
    ).toBe(false);
    expect(isSqliteBusyError(new Database.SqliteError('no such table', 'SQLITE_ERROR'))).toBe(
      false,
    );
  });

  it('rejects ordinary errors (even with a busy-looking code) and non-errors', () => {
    expect(isSqliteBusyError(new TypeError('x'))).toBe(false);
    expect(
      isSqliteBusyError(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })),
    ).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
    expect(isSqliteBusyError(undefined)).toBe(false);
    expect(isSqliteBusyError('SQLITE_BUSY')).toBe(false);
    expect(isSqliteBusyError({ name: 'SqliteError' })).toBe(false);
  });

  it('recognises the real thing: a second connection hitting a held write lock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-sqlite-busy-'));
    const file = path.join(dir, 'busy.db');
    const holder = new Database(file);
    holder.exec('CREATE TABLE t (x)');
    holder.exec('BEGIN IMMEDIATE');
    const contender = new Database(file, { timeout: 50 });
    let caught: unknown;
    try {
      contender.exec('BEGIN IMMEDIATE');
    } catch (err) {
      caught = err;
    } finally {
      contender.close();
      holder.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(caught).toBeInstanceOf(Database.SqliteError);
    expect(isSqliteBusyError(caught)).toBe(true);
  });
});

describe('openDatabase', () => {
  const dirs: string[] = [];
  const opened: Database.Database[] = [];
  const tempFile = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-open-'));
    dirs.push(dir);
    return path.join(dir, 'test.db');
  };

  afterEach(() => {
    for (const db of opened.splice(0)) db.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens a file database in WAL mode with foreign keys and the busy timeout', () => {
    const db = openDatabase(tempFile());
    opened.push(db);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(SQLITE_BUSY_TIMEOUT_MS);
  });

  it('leaves the mode in the file, so a plain reopen finds WAL', () => {
    const file = tempFile();
    openDatabase(file).close();
    const plain = new Database(file);
    opened.push(plain);
    expect(plain.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('lets a writer commit while another connection is mid-read', () => {
    const file = tempFile();
    const writer = openDatabase(file);
    const reader = openDatabase(file);
    opened.push(writer, reader);
    writer.exec('CREATE TABLE t (x)');
    writer.exec('INSERT INTO t VALUES (1), (2), (3)');

    // Pulling one row opens the reader's transaction and keeps it open until
    // the iterator is exhausted or returned. In rollback-journal mode the
    // writer below would wait out the busy timeout and throw SQLITE_BUSY.
    const cursor = reader.prepare('SELECT x FROM t').iterate();
    expect(cursor.next().done).toBe(false);
    expect(() => writer.exec('INSERT INTO t VALUES (4)')).not.toThrow();
    cursor.return?.();
  });
});
