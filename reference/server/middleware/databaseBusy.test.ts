import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { NextFunction, Request, Response } from 'express';
import {
  DATABASE_BUSY_ERROR,
  DATABASE_BUSY_RETRY_AFTER_SECONDS,
  withDatabaseBusyGuard,
  type SyncRequestHandler,
} from './databaseBusy.js';

const makeRes = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn(),
  setHeader: vi.fn(),
});

const req = { method: 'GET', baseUrl: '/api', path: '/projects' } as unknown as Request;

const busy = () => new Database.SqliteError('database is locked', 'SQLITE_BUSY');

const run = (handler: SyncRequestHandler) => {
  const res = makeRes();
  const next = vi.fn();
  void withDatabaseBusyGuard(handler)(req, res as unknown as Response, next as NextFunction);
  return { res, next };
};

describe('withDatabaseBusyGuard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes a healthy handler through untouched', () => {
    const { res, next } = run((_req, _res, n) => n());
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('turns SQLITE_BUSY into a 503 with Retry-After and one warning line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { res, next } = run(() => {
      throw busy();
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      'Retry-After',
      String(DATABASE_BUSY_RETRY_AFTER_SECONDS),
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: DATABASE_BUSY_ERROR });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('SQLITE_BUSY on GET /api/projects');
  });

  it('forwards any other error to next(err) instead of swallowing it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boom = new TypeError('not a lock');
    const { res, next } = run(() => {
      throw boom;
    });
    expect(next).toHaveBeenCalledWith(boom);
    expect(res.status).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('forwards a non-busy SqliteError too — a constraint failure is a bug, not a lock', () => {
    const constraint = new Database.SqliteError(
      'UNIQUE constraint failed',
      'SQLITE_CONSTRAINT_UNIQUE',
    );
    const { res, next } = run(() => {
      throw constraint;
    });
    expect(next).toHaveBeenCalledWith(constraint);
    expect(res.status).not.toHaveBeenCalled();
  });
});
