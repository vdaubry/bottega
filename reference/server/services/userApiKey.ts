import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { db as defaultDb } from '../database/db.js';
import type { UserRow } from '../database/db.js';

const PREFIX = 'ccui_';
const KEY_BYTES = 32;

const sha256Hex = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

export const API_KEY_PREFIX = PREFIX;

export function isApiKeyFormat(token: unknown): token is string {
  return typeof token === 'string' && token.startsWith(PREFIX);
}

export function generateApiKey(userId: number, db: Database.Database = defaultDb): string {
  const plaintext = PREFIX + crypto.randomBytes(KEY_BYTES).toString('hex');
  const hash = sha256Hex(plaintext);
  const result = db
    .prepare(
      'UPDATE users SET api_key_hash = ?, api_key_last_used_at = NULL WHERE id = ? AND is_active = 1',
    )
    .run(hash, userId);
  if (result.changes === 0) {
    throw new Error(`User ${userId} not found or inactive`);
  }
  return plaintext;
}

export function revokeApiKey(userId: number, db: Database.Database = defaultDb): void {
  db.prepare(
    'UPDATE users SET api_key_hash = NULL, api_key_last_used_at = NULL WHERE id = ?',
  ).run(userId);
}

export interface ApiKeyStatus {
  hasKey: boolean;
  lastUsedAt: string | null;
}

export function getApiKeyStatus(
  userId: number,
  db: Database.Database = defaultDb,
): ApiKeyStatus | null {
  const row = db
    .prepare(
      `SELECT (api_key_hash IS NOT NULL) AS has_key, api_key_last_used_at AS last_used_at
       FROM users WHERE id = ?`,
    )
    .get(userId) as { has_key: 0 | 1; last_used_at: string | null } | undefined;
  if (!row) return null;
  return {
    hasKey: !!row.has_key,
    lastUsedAt: row.last_used_at || null,
  };
}

export function findUserByApiKey(
  plaintext: unknown,
  db: Database.Database = defaultDb,
): Pick<UserRow, 'id' | 'username' | 'created_at' | 'last_login' | 'is_admin' | 'is_technical'> | null {
  if (!isApiKeyFormat(plaintext)) return null;
  const hash = sha256Hex(plaintext);
  const row = db
    .prepare(
      `SELECT id, username, created_at, last_login, is_admin, is_technical
       FROM users WHERE api_key_hash = ? AND is_active = 1`,
    )
    .get(hash) as
    | Pick<UserRow, 'id' | 'username' | 'created_at' | 'last_login' | 'is_admin' | 'is_technical'>
    | undefined;
  if (!row) return null;
  try {
    db.prepare('UPDATE users SET api_key_last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  } catch {
    // best-effort touch; never fail the auth path
  }
  return row;
}
