// Per-user `codex login --device-auth` PTY flow.
//
// Mirrors `claudeAuthFlow.ts` line for line, with three differences
// the device-auth UX dictates:
//
//   1. The Codex CLI prints **both** a URL and a one-time device code.
//      The URL is constant (`https://auth.openai.com/codex/device`);
//      the code rotates. We extract both and surface both to the UI.
//   2. There is **no code paste back** to the CLI. The user enters the
//      code in their browser; the CLI talks directly to OpenAI's auth
//      service and writes `$CODEX_HOME/auth.json` on success. Bottega
//      only watches the subprocess exit.
//   3. There is no "complete" REST endpoint. The frontend polls
//      `/api/codex-auth/status` after `/start`; success is signalled by
//      the subprocess exiting 0 + the auth.json appearing on disk.
//
// Per § 0.2 (non-negotiable per-user isolation): every spawn passes
// `CODEX_HOME=~/.config/bottega/users/{userId}/codex/` and strips every
// inherited `OPENAI_*` / `CODEX_*` env key, so a global `OPENAI_API_KEY`
// in the server's environment can never leak into the login subprocess.

import crypto from 'crypto';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import {
  buildCodexSdkEnv,
  CodexCredentialsError,
  ensureCodexHomeDir,
  getCodexAuthStatus,
  resolveCodexAuthJsonPath,
} from './codexCredentials.js';

const DEFAULT_LOGIN_TTL_MS = 15 * 60 * 1000;
const URL_WAIT_TIMEOUT_MS = 15000;
const EXIT_WAIT_TIMEOUT_MS = 15 * 60 * 1000; // matches CLI's "expires in 15 minutes"
const OUTPUT_LIMIT = 40000;

// Codex's `codex login --device-auth` prints the canonical device-auth
// URL — currently `https://auth.openai.com/codex/device` (no query
// params). Match only that path so the line-wrap stripper doesn't
// glue the next line's "2." onto the end.
const AUTH_URL_REGEX =
  /https:\/\/(?:auth\.openai\.com|chatgpt\.com|platform\.openai\.com)\/[A-Za-z0-9._\-/]+(?:\?[A-Za-z0-9._\-/?#=&%]+)?/;
// Codex device codes: 4 alphanumerics, hyphen, 4-6 alphanumerics.
const DEVICE_CODE_REGEX = /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/;

interface LoginSession {
  id: string;
  userId: number | string;
  userKey: string;
  child: IPty;
  codexHome: string;
  startedAt: string;
  expiresAt: string;
  authUrl: string | null;
  deviceCode: string | null;
  stdout: string;
  exited: boolean;
  exit: { exitCode?: number | null; signal?: string | null; error?: Error } | null;
  cancelReason: string | null;
  ttlTimer: NodeJS.Timeout;
  urlPromise: Promise<PublicSession>;
  resolveUrl: (value: PublicSession) => void;
  rejectUrl: (reason: Error) => void;
  exitPromise: Promise<LoginSession['exit']>;
  resolveExit: (value: LoginSession['exit']) => void;
}

export interface PublicSession {
  loginSessionId: string;
  authUrl: string | null;
  deviceCode: string | null;
  startedAt: string;
  expiresAt: string;
}

const activeLogins = new Map<string, LoginSession>();

export class CodexAuthLoginError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'CodexAuthLoginError';
    this.statusCode = statusCode;
  }
}

function normalizeUserKey(userId: number | string | undefined): string {
  const numericUserId = Number(userId);
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
    throw new CodexAuthLoginError(
      'Cannot authenticate Codex without a valid user ID',
      400,
    );
  }
  return String(numericUserId);
}

function limitOutput(s: string): string {
  return s.length > OUTPUT_LIMIT ? s.slice(s.length - OUTPUT_LIMIT) : s;
}

function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[\d*C/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[\d;<>=?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

function extractAuthUrl(output: string): string | null {
  // Codex's URL is short and doesn't wrap, but the CLI does put `2.` on
  // the next line — without the line-wrap merge logic the Claude flow
  // uses, the URL extraction is straightforward. Just strip ANSI and
  // run the regex.
  const cleaned = stripAnsi(output);
  return cleaned.match(AUTH_URL_REGEX)?.[0] ?? null;
}

function extractDeviceCode(output: string): string | null {
  const cleaned = stripAnsi(output);
  return cleaned.match(DEVICE_CODE_REGEX)?.[1] ?? null;
}

function publicSession(session: LoginSession): PublicSession {
  return {
    loginSessionId: session.id,
    authUrl: session.authUrl,
    deviceCode: session.deviceCode,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
  };
}

function logSession(
  session: Partial<LoginSession> | null | undefined,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  console.log(
    '[CodexAuthFlow]',
    JSON.stringify({
      message,
      userId: session?.userId ?? null,
      loginSessionId: session?.id ?? null,
      pid: session?.child?.pid ?? null,
      ...extra,
    }),
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  statusCode = 504,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new CodexAuthLoginError(message, statusCode)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function terminateSession(
  session: LoginSession | null | undefined,
  reason = 'cancelled',
): void {
  if (!session || session.exited) return;
  session.cancelReason = reason;
  logSession(session, 'terminating-login-process', { reason });
  try {
    session.child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  const killTimer = setTimeout(() => {
    if (!session.exited) {
      try {
        session.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }, 2000);
  killTimer.unref?.();
}

export function getActiveCodexAuthLogin(
  userId: number | string | undefined,
): PublicSession | null {
  const userKey = normalizeUserKey(userId);
  const session = activeLogins.get(userKey);
  return session ? publicSession(session) : null;
}

export function cancelCodexAuthLogin(
  userId: number | string | undefined,
  reason = 'cancelled',
): boolean {
  const userKey = normalizeUserKey(userId);
  const session = activeLogins.get(userKey);
  if (!session) {
    logSession(null, 'cancel-request-no-active-session', { userId, reason });
    return false;
  }
  logSession(session, 'cancel-request', { reason });
  activeLogins.delete(userKey);
  clearTimeout(session.ttlTimer);
  terminateSession(session, reason);
  return true;
}

export interface StartLoginOptions {
  ttlMs?: number;
  urlWaitMs?: number;
}

/**
 * Spawn `codex login --device-auth` under `node-pty` with the per-user
 * `CODEX_HOME`. Returns once the auth URL + device code are extracted
 * from stdout (typically within a few seconds). The subprocess keeps
 * running in the background until either:
 *   - the user completes the device-code flow → CLI writes auth.json
 *     to `$CODEX_HOME/auth.json` and exits 0,
 *   - the TTL fires (~15 minutes by default),
 *   - the caller cancels via `cancelCodexAuthLogin`.
 */
export async function startCodexAuthLogin(
  userId: number | string,
  options: StartLoginOptions = {},
): Promise<PublicSession> {
  const userKey = normalizeUserKey(userId);
  const envTtlMs = Number(process.env['CODEX_AUTH_LOGIN_TTL_MS']);
  const ttlMs =
    options.ttlMs ?? (Number.isFinite(envTtlMs) ? envTtlMs : DEFAULT_LOGIN_TTL_MS);
  const urlWaitMs = options.urlWaitMs ?? URL_WAIT_TIMEOUT_MS;

  console.log('[CodexAuthFlow]', JSON.stringify({ message: 'start-request', userId, ttlMs }));
  cancelCodexAuthLogin(userId, 'replaced');

  let codexHome: string;
  try {
    ({ codexHome } = ensureCodexHomeDir(userId));
  } catch (error) {
    if (error instanceof CodexCredentialsError) {
      throw new CodexAuthLoginError(error.message, 500);
    }
    throw error;
  }

  const env = buildCodexSdkEnv(userId);
  const codexCli = process.env['CODEX_CLI_PATH'] || 'codex';

  const child = pty.spawn(codexCli, ['login', '--device-auth'], {
    name: 'xterm-256color',
    cols: 1000,
    rows: 30,
    env: env as Record<string, string>,
  });

  const startedAtMs = Date.now();
  const session: LoginSession = {
    id: crypto.randomUUID(),
    userId,
    userKey,
    child,
    codexHome,
    startedAt: new Date(startedAtMs).toISOString(),
    expiresAt: new Date(startedAtMs + ttlMs).toISOString(),
    authUrl: null,
    deviceCode: null,
    stdout: '',
    exited: false,
    exit: null,
    cancelReason: null,
    ttlTimer: undefined as unknown as NodeJS.Timeout,
    urlPromise: undefined as unknown as Promise<PublicSession>,
    resolveUrl: undefined as unknown as (v: PublicSession) => void,
    rejectUrl: undefined as unknown as (e: Error) => void,
    exitPromise: undefined as unknown as Promise<LoginSession['exit']>,
    resolveExit: undefined as unknown as (v: LoginSession['exit']) => void,
  };
  logSession(session, 'spawned-login-process', {
    codexHome,
    expiresAt: session.expiresAt,
  });

  session.urlPromise = new Promise<PublicSession>((resolve, reject) => {
    session.resolveUrl = resolve;
    session.rejectUrl = reject;
  });
  session.exitPromise = new Promise((resolve) => {
    session.resolveExit = resolve;
  });

  session.ttlTimer = setTimeout(() => {
    if (activeLogins.get(userKey)?.id === session.id) {
      logSession(session, 'login-session-expired');
      activeLogins.delete(userKey);
      terminateSession(session, 'expired');
    }
  }, ttlMs);
  session.ttlTimer.unref?.();

  activeLogins.set(userKey, session);

  const handleOutput = (chunk: string | Buffer): void => {
    const text = String(chunk);
    session.stdout = limitOutput(session.stdout + text);
    logSession(session, 'login-process-output', { bytes: Buffer.byteLength(text) });

    if (!session.authUrl || !session.deviceCode) {
      const url = extractAuthUrl(session.stdout);
      const code = extractDeviceCode(session.stdout);
      if (url && code && (session.authUrl === null || session.deviceCode === null)) {
        session.authUrl = url;
        session.deviceCode = code;
        logSession(session, 'auth-url-detected', {
          urlHost: (() => {
            try {
              return new URL(url).host;
            } catch {
              return null;
            }
          })(),
          deviceCodeLength: code.length,
        });
        session.resolveUrl(publicSession(session));
      }
    }
  };

  child.onData(handleOutput);
  child.onExit(({ exitCode, signal }) => {
    session.exited = true;
    session.exit = {
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      // node-pty types signal as `number | undefined` but the field is a
      // POSIX signal number when set; coerce to string for our log shape.
      signal: typeof signal === 'number' ? String(signal) : null,
    };
    logSession(session, 'login-process-closed', { code: exitCode, signal });
    clearTimeout(session.ttlTimer);
    if (activeLogins.get(userKey)?.id === session.id) {
      activeLogins.delete(userKey);
    }
    if (!session.authUrl) {
      session.rejectUrl(
        new CodexAuthLoginError(
          'codex login exited before producing a URL',
          500,
        ),
      );
    }
    session.resolveExit(session.exit);
  });

  return withTimeout(
    session.urlPromise,
    urlWaitMs,
    'Codex authentication did not produce a login URL in time',
  ).catch((error: Error) => {
    logSession(session, 'start-failed', { error: error.message });
    if (activeLogins.get(userKey)?.id === session.id) {
      activeLogins.delete(userKey);
    }
    clearTimeout(session.ttlTimer);
    terminateSession(session, 'url-timeout');
    throw error;
  });
}

/**
 * Watch the running login subprocess for success: wait for exit-0
 * AND the appearance of a valid auth.json under `$CODEX_HOME`. Returns
 * the auth status once both hold. The frontend can either await this
 * or just poll `getCodexAuthStatus`; both are supported.
 */
export async function waitForCodexAuthLoginCompletion(
  userId: number | string,
  loginSessionId: string,
  options: { completeWaitMs?: number } = {},
): Promise<Awaited<ReturnType<typeof getCodexAuthStatus>>> {
  const userKey = normalizeUserKey(userId);
  const session = activeLogins.get(userKey);
  if (!session) {
    throw new CodexAuthLoginError('No active Codex authentication session', 404);
  }
  if (session.id !== loginSessionId) {
    throw new CodexAuthLoginError(
      'Codex authentication session has been replaced',
      409,
    );
  }

  const completeWaitMs = options.completeWaitMs ?? EXIT_WAIT_TIMEOUT_MS;
  try {
    const exit = await withTimeout(
      session.exitPromise,
      completeWaitMs,
      'Codex authentication did not finish in time',
    );
    if (!exit || exit.exitCode !== 0) {
      throw new CodexAuthLoginError(
        `codex login exited with code ${exit?.exitCode ?? 'unknown'}`,
        500,
      );
    }
  } finally {
    clearTimeout(session.ttlTimer);
    activeLogins.delete(userKey);
  }

  // Re-read status off disk now that auth.json should be written.
  const status = await getCodexAuthStatus(userId);
  if (!status.authenticated) {
    throw new CodexAuthLoginError(
      `Codex login exited cleanly but auth.json is not usable: ${status.reason ?? 'unknown'}`,
      500,
    );
  }
  logSession(session, 'login-complete', {
    method: status.method,
    authPath: resolveCodexAuthJsonPath(userId),
  });
  return status;
}

export function clearCodexAuthLoginSessions(): void {
  for (const session of activeLogins.values()) {
    clearTimeout(session.ttlTimer);
    terminateSession(session, 'cleanup');
  }
  activeLogins.clear();
}
