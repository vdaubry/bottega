// Per-user Codex CLI credentials.
//
// Bottega isolates every user's Codex auth (OAuth bundle from
// `codex login --device-auth`, plus the CLI's session/cache scratch)
// inside `~/.config/bottega/users/{userId}/codex/`. The Codex CLI
// honours the `CODEX_HOME` env var as the root for all its on-disk
// state; we set it on every SDK invocation and every login subprocess
// so a user's auth never leaks across tenants.
//
// **The global `~/.codex/` dir is NEVER read by runtime code.**

import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_CODEX_CONFIG_ROOT = path.join(
  os.homedir(),
  '.config',
  'bottega',
  'users',
);
const AUTH_FILE_NAME = 'auth.json';
const CODEX_SUBDIR = 'codex';

// OpenAI / Codex CLI auth keys that override per-user CODEX_HOME if
// inherited from the parent process. Stripped from every SDK + login
// env to keep the per-user auth.json authoritative.
const GLOBAL_CODEX_AUTH_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'CODEX_HOME',
  'CODEX_API_KEY',
] as const;

export class CodexCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexCredentialsError';
  }
}

function normalizeUserId(userId: number | string | undefined): string {
  const numericUserId = Number(userId);
  if (
    !Number.isInteger(numericUserId) ||
    numericUserId <= 0 ||
    String(numericUserId) !== String(userId)
  ) {
    throw new CodexCredentialsError(
      'Cannot resolve Codex credentials without a valid authenticated user ID',
    );
  }
  return String(numericUserId);
}

export function getCodexConfigRoot(): string {
  return process.env['CODEX_CONFIG_ROOT'] || DEFAULT_CODEX_CONFIG_ROOT;
}

export function resolveCodexUserDir(userId: number | string | undefined): string {
  return path.join(getCodexConfigRoot(), normalizeUserId(userId));
}

/** Per-user CODEX_HOME — root of the Codex CLI's on-disk state. */
export function resolveCodexHomeDir(userId: number | string | undefined): string {
  return path.join(resolveCodexUserDir(userId), CODEX_SUBDIR);
}

export function resolveCodexAuthJsonPath(userId: number | string | undefined): string {
  return path.join(resolveCodexHomeDir(userId), AUTH_FILE_NAME);
}

/**
 * Create the per-user CODEX_HOME (mode 0700) if it doesn't exist. The
 * parent users/{userId}/ dir is shared with Claude credentials and
 * created by the Claude flow today; we mkdirp the chain just in case
 * a user is Codex-first.
 */
export function ensureCodexHomeDir(
  userId: number | string | undefined,
): { codexHome: string } {
  const userDir = resolveCodexUserDir(userId);
  try {
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(userDir, 0o700);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new CodexCredentialsError(
        `Codex credential directory is not writable: ${getCodexConfigRoot()}. Check permissions or set CODEX_CONFIG_ROOT in your .env to a writable path.`,
      );
    }
    throw error;
  }
  const codexHome = resolveCodexHomeDir(userId);
  try {
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.chmodSync(codexHome, 0o700);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new CodexCredentialsError(
        `Codex per-user dir is not writable: ${codexHome}.`,
      );
    }
    throw error;
  }
  return { codexHome };
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
      throw new CodexCredentialsError(
        `Codex auth.json is not provisioned for user ${userId}. Run /api/codex-auth/start to log in.`,
      );
    }
    throw err;
  }

  if (!stats.isFile()) {
    throw new CodexCredentialsError(
      `Codex auth.json path for user ${userId} is not a file: ${authPath}`,
    );
  }

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (currentUid !== null && stats.uid !== currentUid) {
    throw new CodexCredentialsError(
      `Codex auth.json for user ${userId} must be owned by the current user`,
    );
  }

  if ((stats.mode & 0o077) !== 0) {
    throw new CodexCredentialsError(
      `Codex auth.json for user ${userId} must not be accessible by group or other users; run chmod 600 ${authPath}`,
    );
  }
}

export interface CodexAuthPayload {
  tokens?: {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    [key: string]: unknown;
  };
  OPENAI_API_KEY?: string;
  [key: string]: unknown;
}

export interface ReadCodexAuthResult {
  payload: CodexAuthPayload;
  authPath: string;
}

export function readCodexAuth(
  userId: number | string | undefined,
): ReadCodexAuthResult {
  const authPath = resolveCodexAuthJsonPath(userId);
  validateAuthFileSecurity(userId, authPath);
  const raw = fs.readFileSync(authPath, 'utf8');
  let payload: CodexAuthPayload;
  try {
    payload = JSON.parse(raw) as CodexAuthPayload;
  } catch (err) {
    throw new CodexCredentialsError(
      `Codex auth.json for user ${userId} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const hasOauth =
    typeof payload.tokens?.access_token === 'string' ||
    typeof payload.tokens?.id_token === 'string';
  const hasApiKey = typeof payload.OPENAI_API_KEY === 'string';
  if (!hasOauth && !hasApiKey) {
    throw new CodexCredentialsError(
      `Codex auth.json for user ${userId} carries neither OAuth tokens nor OPENAI_API_KEY`,
    );
  }
  return { payload, authPath };
}

export function writeCodexAuth(
  userId: number | string | undefined,
  payload: unknown,
): { authPath: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CodexCredentialsError(
      `Refusing to persist non-object Codex auth.json for user ${userId}`,
    );
  }
  ensureCodexHomeDir(userId);
  const authPath = resolveCodexAuthJsonPath(userId);
  fs.writeFileSync(authPath, JSON.stringify(payload), { mode: 0o600 });
  fs.chmodSync(authPath, 0o600);
  return { authPath };
}

export function clearCodexAuth(userId: number | string | undefined): boolean {
  const authPath = resolveCodexAuthJsonPath(userId);
  try {
    fs.unlinkSync(authPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function tryDecodeIdTokenEmail(idToken: string | undefined): string | undefined {
  if (!idToken || typeof idToken !== 'string') return undefined;
  const parts = idToken.split('.');
  if (parts.length < 2) return undefined;
  try {
    const body = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf8'),
    ) as { email?: unknown };
    return typeof body.email === 'string' ? body.email : undefined;
  } catch {
    return undefined;
  }
}

function fingerprint(value: string): string {
  // Last 6 chars — same shape as claudeCredentials' tokenFingerprint.
  return value.slice(-6);
}

export interface CodexAuthStatus {
  authenticated: boolean;
  status: 'authenticated' | 'missing';
  authPath: string;
  /** Login method that resolved the credential. */
  method?: 'oauth' | 'api_key';
  tokenFingerprint?: string;
  email?: string;
  reason?: string;
}

export async function getCodexAuthStatus(
  userId: number | string | undefined,
): Promise<CodexAuthStatus> {
  const authPath = resolveCodexAuthJsonPath(userId);
  try {
    const { payload } = readCodexAuth(userId);
    if (typeof payload.tokens?.access_token === 'string') {
      return {
        authenticated: true,
        status: 'authenticated',
        authPath,
        method: 'oauth',
        tokenFingerprint: fingerprint(payload.tokens.access_token),
        ...(tryDecodeIdTokenEmail(payload.tokens.id_token) !== undefined
          ? { email: tryDecodeIdTokenEmail(payload.tokens.id_token)! }
          : {}),
      };
    }
    if (typeof payload.OPENAI_API_KEY === 'string') {
      return {
        authenticated: true,
        status: 'authenticated',
        authPath,
        method: 'api_key',
        tokenFingerprint: fingerprint(payload.OPENAI_API_KEY),
      };
    }
    return {
      authenticated: false,
      status: 'missing',
      authPath,
      reason: 'no credentials',
    };
  } catch (error) {
    if (error instanceof CodexCredentialsError) {
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

function removeInheritedCodexAuthEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  for (const key of GLOBAL_CODEX_AUTH_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export interface CodexSdkEnv extends Record<string, string | undefined> {
  CODEX_HOME: string;
  HOME: string | undefined;
  PATH: string | undefined;
}

/**
 * Build the env handed to `new Codex({ env })` (or to a spawned `codex
 * login` PTY). Strips every global auth key so the per-user
 * `CODEX_HOME` is the only source of truth, and sets the per-user
 * `CODEX_HOME` itself.
 */
export function buildCodexSdkEnv(
  userId: number | string | undefined,
): CodexSdkEnv {
  const env: Record<string, string | undefined> = {
    HOME: process.env['HOME'],
    PATH: process.env['PATH'],
  };
  removeInheritedCodexAuthEnv(env);
  env['CODEX_HOME'] = resolveCodexHomeDir(userId);
  return env as CodexSdkEnv;
}
