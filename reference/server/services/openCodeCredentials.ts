// Per-user OpenCode credentials.
//
// Per docs/opencode/00-context-decisions.md § R15 + § D7: OpenCode auth is
// a single Zen-billing API key. The on-disk shape mirrors what `opencode
// serve` reads natively — one record under providerID 'opencode' — so the
// spawned server picks it up without translation:
//
//   ~/.config/bottega/users/{userId}/opencode-data/opencode/auth.json
//   { "opencode": { "type": "api", "key": "<zen-key>" } }
//
// The directory pinned by `XDG_DATA_HOME` (and read by the OpenCode runtime
// via `Global.Path.data = ${XDG_DATA_HOME}/opencode`) is
// `~/.config/bottega/users/{userId}/opencode-data` — so the file above is
// what `opencode serve` resolves to.

import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_OPENCODE_CONFIG_ROOT = path.join(
  os.homedir(),
  '.config',
  'bottega',
  'users',
);
const OPENCODE_DATA_SUBDIR = 'opencode-data';
const OPENCODE_CONFIG_SUBDIR = 'opencode-config';
const OPENCODE_STATE_SUBDIR = 'opencode-state';
const OPENCODE_CACHE_SUBDIR = 'opencode-cache';
// `Global.Path.data` is `${XDG_DATA_HOME}/opencode`, and auth.json lives
// directly under that. So the on-disk path is opencode-data/opencode/auth.json.
const OPENCODE_APP_SUBDIR = 'opencode';
const AUTH_FILE_NAME = 'auth.json';

// OpenCode env keys that override per-user state if inherited from the
// parent process. Stripped from every spawned subprocess env so the
// per-user XDG_* paths and auth.json are the only sources of truth.
const GLOBAL_OPENCODE_ENV_KEYS = [
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
] as const;

export class OpenCodeCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenCodeCredentialsError';
  }
}

function normalizeUserId(userId: number | string | undefined): string {
  const numericUserId = Number(userId);
  if (
    !Number.isInteger(numericUserId) ||
    numericUserId <= 0 ||
    String(numericUserId) !== String(userId)
  ) {
    throw new OpenCodeCredentialsError(
      'Cannot resolve OpenCode credentials without a valid authenticated user ID',
    );
  }
  return String(numericUserId);
}

export function getOpenCodeConfigRoot(): string {
  return process.env['OPENCODE_CONFIG_ROOT'] || DEFAULT_OPENCODE_CONFIG_ROOT;
}

export function resolveOpenCodeUserDir(userId: number | string | undefined): string {
  return path.join(getOpenCodeConfigRoot(), normalizeUserId(userId));
}

/** Per-user XDG_DATA_HOME — root of OpenCode's persisted state. */
export function resolveOpenCodeDataDir(userId: number | string | undefined): string {
  return path.join(resolveOpenCodeUserDir(userId), OPENCODE_DATA_SUBDIR);
}

export function resolveOpenCodeConfigDir(userId: number | string | undefined): string {
  return path.join(resolveOpenCodeUserDir(userId), OPENCODE_CONFIG_SUBDIR);
}

export function resolveOpenCodeStateDir(userId: number | string | undefined): string {
  return path.join(resolveOpenCodeUserDir(userId), OPENCODE_STATE_SUBDIR);
}

export function resolveOpenCodeCacheDir(userId: number | string | undefined): string {
  return path.join(resolveOpenCodeUserDir(userId), OPENCODE_CACHE_SUBDIR);
}

/**
 * Resolves to ${XDG_DATA_HOME}/opencode/auth.json — the path the spawned
 * `opencode serve` reads natively (see
 * tmp/opencode/packages/opencode/src/auth/index.ts:9 +
 * tmp/opencode/packages/core/src/global.ts:10).
 */
export function resolveOpenCodeAuthPath(userId: number | string | undefined): string {
  return path.join(
    resolveOpenCodeDataDir(userId),
    OPENCODE_APP_SUBDIR,
    AUTH_FILE_NAME,
  );
}

function ensureDir(dir: string, label: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new OpenCodeCredentialsError(
        `OpenCode ${label} directory is not writable: ${dir}. Check permissions or set OPENCODE_CONFIG_ROOT in your .env to a writable path.`,
      );
    }
    throw error;
  }
}

export interface EnsureOpenCodeDataResult {
  dataDir: string;
  authPath: string;
}

/**
 * Create the per-user OpenCode dirs (mode 0700) if they don't exist.
 * Returns the data dir and the resolved auth.json path. The parent
 * `users/{userId}` dir is shared with Claude/Codex credentials.
 */
export function ensureOpenCodeDataDir(
  userId: number | string | undefined,
): EnsureOpenCodeDataResult {
  ensureDir(resolveOpenCodeUserDir(userId), 'credential');
  const dataDir = resolveOpenCodeDataDir(userId);
  ensureDir(dataDir, 'data');
  // auth.json's parent is ${dataDir}/opencode — create it too.
  ensureDir(path.join(dataDir, OPENCODE_APP_SUBDIR), 'data');
  return { dataDir, authPath: resolveOpenCodeAuthPath(userId) };
}

function validateAuthFileSecurity(
  userId: number | string | undefined,
  authPath: string,
): void {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(authPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OpenCodeCredentialsError(
        `OpenCode auth.json is not provisioned for user ${userId}. Set the key via Settings → Providers → OpenCode.`,
      );
    }
    throw err;
  }

  if (!stats.isFile()) {
    throw new OpenCodeCredentialsError(
      `OpenCode auth.json path for user ${userId} is not a file: ${authPath}`,
    );
  }

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUid !== null && stats.uid !== currentUid) {
    throw new OpenCodeCredentialsError(
      `OpenCode auth.json for user ${userId} must be owned by the current user`,
    );
  }

  if ((stats.mode & 0o077) !== 0) {
    throw new OpenCodeCredentialsError(
      `OpenCode auth.json for user ${userId} must not be accessible by group or other users; run chmod 600 ${authPath}`,
    );
  }
}

export interface OpenCodeAuthRecord {
  type: 'api';
  key: string;
}

export interface OpenCodeAuthJson {
  opencode: OpenCodeAuthRecord;
  'opencode-go': OpenCodeAuthRecord;
}

function isOpenCodeAuthJson(value: unknown): value is OpenCodeAuthJson {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  // Dual-provider shape: exactly two records under 'opencode' and 'opencode-go'
  // with the same API key (Zen billing covers both).
  const keys = Object.keys(value as Record<string, unknown>).sort();
  if (keys.length !== 2 || keys[0] !== 'opencode' || keys[1] !== 'opencode-go') return false;
  const v1 = (value as { opencode?: unknown }).opencode;
  const v2 = (value as { 'opencode-go'?: unknown })['opencode-go'];
  if (!v1 || typeof v1 !== 'object' || Array.isArray(v1)) return false;
  if (!v2 || typeof v2 !== 'object' || Array.isArray(v2)) return false;
  const rec1 = v1 as { type?: unknown; key?: unknown };
  const rec2 = v2 as { type?: unknown; key?: unknown };
  return (
    rec1.type === 'api' &&
    typeof rec1.key === 'string' &&
    rec1.key.length > 0 &&
    rec2.type === 'api' &&
    typeof rec2.key === 'string' &&
    rec2.key.length > 0
  );
}

/**
 * Reads and validates the on-disk auth.json. Throws when missing /
 * malformed / insecure. Returns the parsed structure when the file holds
 * a non-empty Zen API key under both 'opencode' and 'opencode-go' provider IDs.
 */
export function readOpenCodeAuth(
  userId: number | string | undefined,
): OpenCodeAuthJson {
  const authPath = resolveOpenCodeAuthPath(userId);
  validateAuthFileSecurity(userId, authPath);
  const raw = fs.readFileSync(authPath, 'utf8');
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new OpenCodeCredentialsError(
      `OpenCode auth.json for user ${userId} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!isOpenCodeAuthJson(payload)) {
    throw new OpenCodeCredentialsError(
      `OpenCode auth.json for user ${userId} does not carry Zen API keys under both 'opencode' and 'opencode-go' provider IDs`,
    );
  }
  return payload;
}

/**
 * Persist a Zen API key. The on-disk shape is dual-record:
 *   {
 *     "opencode": { "type": "api", "key": apiKey },
 *     "opencode-go": { "type": "api", "key": apiKey }
 *   }
 *
 * Both entries use the same key (Zen billing covers both providers).
 * Overwrites any existing file wholesale — there is no merge logic.
 */
export function setOpenCodeKey(
  userId: number | string | undefined,
  apiKey: string,
): { authPath: string } {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new OpenCodeCredentialsError(
      'Refusing to persist an empty OpenCode API key',
    );
  }
  ensureOpenCodeDataDir(userId);
  const authPath = resolveOpenCodeAuthPath(userId);
  const payload: OpenCodeAuthJson = {
    opencode: { type: 'api', key: apiKey },
    'opencode-go': { type: 'api', key: apiKey },
  };
  fs.writeFileSync(authPath, JSON.stringify(payload), { mode: 0o600 });
  fs.chmodSync(authPath, 0o600);
  return { authPath };
}

/** Removes the on-disk auth.json. Returns true iff a file was removed. */
export function clearOpenCodeKey(userId: number | string | undefined): boolean {
  const authPath = resolveOpenCodeAuthPath(userId);
  try {
    fs.unlinkSync(authPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function fingerprint(value: string): string {
  // Last 6 chars — same shape as claudeCredentials' / codexCredentials' fingerprint.
  return value.slice(-6);
}

export interface OpenCodeAuthStatus {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  authPath: string;
  /** Last-6 of the API key when present. */
  tokenFingerprint?: string;
  reason?: string;
}

export async function getOpenCodeAuthStatus(
  userId: number | string | undefined,
): Promise<OpenCodeAuthStatus> {
  const authPath = resolveOpenCodeAuthPath(userId);
  try {
    const auth = readOpenCodeAuth(userId);
    return {
      authenticated: true,
      status: 'authenticated',
      authPath,
      tokenFingerprint: fingerprint(auth.opencode.key),
    };
  } catch (error) {
    if (error instanceof OpenCodeCredentialsError) {
      return {
        authenticated: false,
        status: 'missing',
        authPath,
        reason: error.message,
      };
    }
    throw error;
  }
}

function removeInheritedOpenCodeEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  for (const key of GLOBAL_OPENCODE_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export interface OpenCodeSpawnEnv extends Record<string, string | undefined> {
  HOME: string | undefined;
  PATH: string | undefined;
  XDG_DATA_HOME: string;
  XDG_CONFIG_HOME: string;
  XDG_STATE_HOME: string;
  XDG_CACHE_HOME: string;
  /**
   * Keep gh pointed at the host's config dir even though XDG_CONFIG_HOME
   * is pinned per-user for OpenCode isolation.
   */
  GH_CONFIG_DIR: string;
  /**
   * Set to /dev/null so a worktree-local opencode.json cannot override
   * our spawn config (see R13 in docs/opencode/00-context-decisions.md).
   * Per-user config still applies via XDG_CONFIG_HOME.
   */
  OPENCODE_CONFIG: string;
  /**
   * Inline config merged on top by OpenCode's loader (see
   * `packages/opencode/src/config/config.ts`). We grant
   * `external_directory: allow` so the `build` agent's `read`/`bash`
   * tools don't hang on a permission prompt when an agent touches
   * paths outside the worktree — most notably
   * `~/.bottega/projects/.../task-*.md` (task docs) and the
   * `${HOME}/.config/bottega/...` per-user state tree. Bottega is the
   * only "user" of this OpenCode server, so always-allow is correct.
   */
  OPENCODE_CONFIG_CONTENT: string;
}

const SPAWN_CONFIG_CONTENT = JSON.stringify({
  permission: {
    external_directory: 'allow',
  },
});

function resolveHostGhConfigDir(): string {
  if (process.env['GH_CONFIG_DIR']) return process.env['GH_CONFIG_DIR'];
  if (process.env['XDG_CONFIG_HOME']) {
    return path.join(process.env['XDG_CONFIG_HOME'], 'gh');
  }
  const appData = process.env['AppData'] || process.env['APPDATA'];
  if (appData) return path.join(appData, 'GitHub CLI');
  return path.join(process.env['HOME'] || os.homedir(), '.config', 'gh');
}

/**
 * Build the env handed to a spawned `opencode serve`. Strips every global
 * OpenCode env key so the per-user XDG_* paths + auth.json are
 * authoritative, then sets the per-user XDG_* paths and the
 * OPENCODE_CONFIG=/dev/null guard.
 *
 * gh reads credentials from XDG_CONFIG_HOME unless GH_CONFIG_DIR is set,
 * so we point GH_CONFIG_DIR at the host config before redirecting
 * XDG_CONFIG_HOME to the per-user OpenCode config dir.
 */
export function buildOpenCodeSpawnEnv(
  userId: number | string | undefined,
): OpenCodeSpawnEnv {
  const env: Record<string, string | undefined> = {
    HOME: process.env['HOME'],
    PATH: process.env['PATH'],
  };
  removeInheritedOpenCodeEnv(env);
  env['XDG_DATA_HOME'] = resolveOpenCodeDataDir(userId);
  env['XDG_CONFIG_HOME'] = resolveOpenCodeConfigDir(userId);
  env['XDG_STATE_HOME'] = resolveOpenCodeStateDir(userId);
  env['XDG_CACHE_HOME'] = resolveOpenCodeCacheDir(userId);
  env['GH_CONFIG_DIR'] = resolveHostGhConfigDir();
  env['OPENCODE_CONFIG'] = '/dev/null';
  env['OPENCODE_CONFIG_CONTENT'] = SPAWN_CONFIG_CONTENT;
  return env as OpenCodeSpawnEnv;
}
