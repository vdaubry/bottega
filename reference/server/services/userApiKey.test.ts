import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  API_KEY_PREFIX,
  findUserByApiKey,
  generateApiKey,
  getApiKeyStatus,
  isApiKeyFormat,
  revokeApiKey
} from './userApiKey.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const initSqlPath = path.join(__dirname, '../database/init.sql');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(initSqlPath, 'utf8'));
  // Mirror the partial unique index (created in migrations on real DB).
  db.exec(
    'CREATE UNIQUE INDEX idx_users_api_key_hash ON users(api_key_hash) WHERE api_key_hash IS NOT NULL'
  );
  return db;
}

function seedUser(db: import('better-sqlite3').Database, { username = 'alice', isActive = 1 } = {}): number {
  const r = db
    .prepare('INSERT INTO users (username, password_hash, is_active) VALUES (?, ?, ?)')
    .run(username, 'pw', isActive);
  return Number(r.lastInsertRowid);
}

describe('userApiKey', () => {
  let db: import('better-sqlite3').Database;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('isApiKeyFormat', () => {
    it('accepts ccui_-prefixed strings', () => {
      expect(isApiKeyFormat('ccui_abc')).toBe(true);
    });
    it('rejects everything else', () => {
      expect(isApiKeyFormat('jwt-like.token.here')).toBe(false);
      expect(isApiKeyFormat('')).toBe(false);
      expect(isApiKeyFormat(null)).toBe(false);
      expect(isApiKeyFormat(undefined)).toBe(false);
      expect(isApiKeyFormat(42)).toBe(false);
    });
  });

  describe('generateApiKey', () => {
    it('returns a key with the ccui_ prefix and high entropy', () => {
      const userId = seedUser(db);
      const key = generateApiKey(userId, db);
      expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
      expect(key.length).toBe(API_KEY_PREFIX.length + 64); // 32 bytes hex
    });

    it('persists only the SHA-256 hash, never the plaintext', () => {
      const userId = seedUser(db);
      const key = generateApiKey(userId, db);
      const row = db.prepare('SELECT api_key_hash FROM users WHERE id = ?').get(userId) as { api_key_hash: string };
      expect(row.api_key_hash).toBeTruthy();
      expect(row.api_key_hash).not.toContain(key);
      expect(row.api_key_hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('replaces the previous hash on regeneration', () => {
      const userId = seedUser(db);
      const k1 = generateApiKey(userId, db);
      const h1 = (db.prepare('SELECT api_key_hash FROM users WHERE id = ?').get(userId) as { api_key_hash: string }).api_key_hash;
      const k2 = generateApiKey(userId, db);
      const h2 = (db.prepare('SELECT api_key_hash FROM users WHERE id = ?').get(userId) as { api_key_hash: string }).api_key_hash;
      expect(k1).not.toEqual(k2);
      expect(h1).not.toEqual(h2);
      // Old key no longer resolves
      expect(findUserByApiKey(k1, db)).toBeNull();
      expect(findUserByApiKey(k2, db)?.id).toBe(userId);
    });

    it('throws when the user does not exist', () => {
      expect(() => generateApiKey(9999, db)).toThrow(/not found or inactive/);
    });

    it('throws when the user is inactive', () => {
      const userId = seedUser(db, { isActive: 0 });
      expect(() => generateApiKey(userId, db)).toThrow(/not found or inactive/);
    });
  });

  describe('findUserByApiKey', () => {
    it('returns the user for a valid key', () => {
      const userId = seedUser(db, { username: 'alice' });
      const key = generateApiKey(userId, db);
      const found = findUserByApiKey(key, db);
      expect(found?.id).toBe(userId);
      expect(found?.username).toBe('alice');
    });

    it('returns null for a non-ccui_ token', () => {
      expect(findUserByApiKey('jwt.shaped.token', db)).toBeNull();
    });

    it('returns null for an unknown ccui_ key', () => {
      expect(findUserByApiKey(`${API_KEY_PREFIX}deadbeef`, db)).toBeNull();
    });

    it('does not match deactivated users', () => {
      const userId = seedUser(db);
      const key = generateApiKey(userId, db);
      db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);
      expect(findUserByApiKey(key, db)).toBeNull();
    });

    it('updates api_key_last_used_at on successful lookup', () => {
      const userId = seedUser(db);
      const key = generateApiKey(userId, db);
      const before = (db
        .prepare('SELECT api_key_last_used_at FROM users WHERE id = ?')
        .get(userId) as { api_key_last_used_at: string | null }).api_key_last_used_at;
      expect(before).toBeNull();

      findUserByApiKey(key, db);

      const after = (db
        .prepare('SELECT api_key_last_used_at FROM users WHERE id = ?')
        .get(userId) as { api_key_last_used_at: string | null }).api_key_last_used_at;
      expect(after).toBeTruthy();
    });
  });

  describe('revokeApiKey', () => {
    it('clears the hash and last-used timestamp', () => {
      const userId = seedUser(db);
      const key = generateApiKey(userId, db);
      findUserByApiKey(key, db); // touches last_used_at
      revokeApiKey(userId, db);

      const row = db
        .prepare('SELECT api_key_hash, api_key_last_used_at FROM users WHERE id = ?')
        .get(userId) as { api_key_hash: string | null; api_key_last_used_at: string | null };
      expect(row.api_key_hash).toBeNull();
      expect(row.api_key_last_used_at).toBeNull();
      expect(findUserByApiKey(key, db)).toBeNull();
    });

    it('is idempotent on a user with no key', () => {
      const userId = seedUser(db);
      expect(() => revokeApiKey(userId, db)).not.toThrow();
    });
  });

  describe('getApiKeyStatus', () => {
    it('reports no key when none has been generated', () => {
      const userId = seedUser(db);
      expect(getApiKeyStatus(userId, db)).toEqual({ hasKey: false, lastUsedAt: null });
    });

    it('reports active key with a last-used timestamp after lookup', () => {
      const userId = seedUser(db);
      const key = generateApiKey(userId, db);
      expect(getApiKeyStatus(userId, db)).toMatchObject({ hasKey: true, lastUsedAt: null });
      findUserByApiKey(key, db);
      const status = getApiKeyStatus(userId, db);
      expect(status!.hasKey).toBe(true);
      expect(status!.lastUsedAt).toBeTruthy();
    });

    it('returns null for an unknown user', () => {
      expect(getApiKeyStatus(9999, db)).toBeNull();
    });
  });
});
