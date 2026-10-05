import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { installProcessGuards, isSurvivableError, type GuardedProcess } from './processGuards.js';

type Listener = (error: unknown, detail?: unknown) => void;

const fakeProcess = () => {
  const listeners = new Map<string, Listener>();
  const on = vi.fn((event: string, listener: Listener) => {
    listeners.set(event, listener);
  });
  const exit = vi.fn();
  const proc: GuardedProcess = { on, exit };
  const emit = (event: string, error: unknown, detail?: unknown) =>
    listeners.get(event)?.(error, detail);
  return { proc, on, exit, emit };
};

const busy = () => new Database.SqliteError('database is locked', 'SQLITE_BUSY');

describe('isSurvivableError', () => {
  it('is true only for a busy/locked SqliteError', () => {
    expect(isSurvivableError(busy())).toBe(true);
    expect(isSurvivableError(new Database.SqliteError('locked', 'SQLITE_LOCKED'))).toBe(true);
    expect(isSurvivableError(new Database.SqliteError('x', 'SQLITE_CONSTRAINT'))).toBe(false);
    expect(isSurvivableError(new Database.SqliteError('x', 'SQLITE_CORRUPT'))).toBe(false);
    expect(isSurvivableError(new TypeError('x'))).toBe(false);
    expect(isSurvivableError(undefined)).toBe(false);
  });
});

describe('installProcessGuards', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers both last-resort handlers', () => {
    const { proc, on } = fakeProcess();
    installProcessGuards(proc);
    expect(on).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(on).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
  });

  it('keeps serving on an uncaught SQLITE_BUSY, logging it once with the stack', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { proc, exit, emit } = fakeProcess();
    installProcessGuards(proc);
    const err = busy();
    emit('uncaughtException', err, 'uncaughtException');
    expect(exit).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toBe(err);
  });

  it('keeps serving on an unhandled rejection with SQLITE_BUSY', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { proc, exit, emit } = fakeProcess();
    installProcessGuards(proc);
    emit('unhandledRejection', busy(), Promise.resolve());
    expect(exit).not.toHaveBeenCalled();
  });

  it('still exits with code 1 on a programming error, both ways', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { proc, exit, emit } = fakeProcess();
    installProcessGuards(proc);
    emit('uncaughtException', new TypeError('undefined is not a function'), 'uncaughtException');
    expect(exit).toHaveBeenCalledWith(1);
    emit('unhandledRejection', new RangeError('out of range'), Promise.resolve());
    expect(exit).toHaveBeenCalledTimes(2);
  });

  it('exits on a non-busy SqliteError — corruption or a constraint failure is not survivable', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { proc, exit, emit } = fakeProcess();
    installProcessGuards(proc);
    emit(
      'uncaughtException',
      new Database.SqliteError('database disk image is malformed', 'SQLITE_CORRUPT'),
      'uncaughtException',
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
