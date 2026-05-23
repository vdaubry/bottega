import crypto from 'crypto';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import {
  buildClaudeLoginEnv,
  getClaudeAuthStatus,
  prepareClaudeConfigDir,
  writeClaudeOAuthToken,
} from './claudeCredentials.js';
import type { ClaudeAuthStatus } from './claudeCredentials.js';

const DEFAULT_LOGIN_TTL_MS = 10 * 60 * 1000;
const URL_WAIT_TIMEOUT_MS = 15000;
const COMPLETE_WAIT_TIMEOUT_MS = 60000;
const OUTPUT_LIMIT = 40000;

const AUTH_URL_REGEX = /https:\/\/[A-Za-z0-9.-]*claude\.com\/[A-Za-z0-9._\-/?#=&%]+/;
const OAUTH_TOKEN_REGEX = /sk-ant-oat[A-Za-z0-9_-]{20,}/;
const CLI_ERROR_PATTERNS = [
  /OAuth\s+error[:\s]+([^\r\n]+)/i,
  /Invalid\s+code[.\s]+([^\r\n]+)/i,
];

interface LoginSession {
  id: string;
  userId: number | string;
  userKey: string;
  child: IPty;
  claudeConfigDir: string;
  startedAt: string;
  expiresAt: string;
  authUrl: string | null;
  stdout: string;
  stderr: string;
  exited: boolean;
  exit: { exitCode?: number | null; signal?: string | null; error?: Error } | null;
  cancelReason: string | null;
  completing: boolean;
  ttlTimer: NodeJS.Timeout;
  urlPromise: Promise<PublicSession>;
  resolveUrl: (value: PublicSession) => void;
  rejectUrl: (reason: Error) => void;
  exitPromise: Promise<LoginSession['exit']>;
  resolveExit: (value: LoginSession['exit']) => void;
  tokenPromise: Promise<string>;
  resolveToken: (value: string) => void;
  tokenCaptured: string | null;
  errorPromise: Promise<never>;
  rejectError: (reason: Error) => void;
  errorCaptured: string | null;
}

interface PublicSession {
  loginSessionId: string;
  authUrl: string | null;
  startedAt: string;
  expiresAt: string;
}

const activeLogins = new Map<string, LoginSession>();

export class ClaudeAuthLoginError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'ClaudeAuthLoginError';
    this.statusCode = statusCode;
  }
}

function normalizeUserKey(userId: number | string | undefined): string {
  const numericUserId = Number(userId);
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
    throw new ClaudeAuthLoginError('Cannot authenticate Claude without a valid user ID', 400);
  }
  return String(numericUserId);
}

function limitOutput(output: string): string {
  return output.length > OUTPUT_LIMIT ? output.slice(output.length - OUTPUT_LIMIT) : output;
}

function extractAuthUrl(output: string): string | null {
  // The login subprocess runs under a PTY, so the CLI may (a) decorate the URL
  // with ANSI/OSC escapes and (b) hard-wrap it across 80-column lines when the
  // terminal is narrow. Strip ANSI noise, then splice back *single* line breaks
  // that fall between URL characters (a soft wrap), while leaving blank lines
  // (two+ newlines — a real paragraph break, i.e. the URL has ended) intact.
  const cleaned = stripAnsi(output).replace(
    /(?<=[A-Za-z0-9._\-/?#=&%])([\r\n]+)(?=[A-Za-z0-9._\-/?#=&%])/g,
    (whole, brk: string) => ((brk.match(/\n/g) || []).length === 1 ? '' : whole),
  );
  const url = cleaned.match(AUTH_URL_REGEX)?.[0] || null;
  if (!url) return null;
  // Guard against capturing a still-incomplete URL (e.g. a mid-stream partial
  // read, or a wrap we failed to splice): the OAuth authorize URL always ends
  // with a `state` parameter, so its absence means we don't have the whole URL
  // yet — keep waiting rather than hand the user a broken link.
  if (!/[?&]state=[^&\s]/.test(url)) return null;
  return url;
}

function extractOAuthToken(output: string): string | null {
  const match = output.match(OAUTH_TOKEN_REGEX);
  return match?.[0] || null;
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

function extractCliError(output: string): string | null {
  const cleaned = stripAnsi(output);
  for (const pattern of CLI_ERROR_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match) {
      return match[0].trim();
    }
  }
  return null;
}

function publicSession(session: LoginSession): PublicSession {
  return {
    loginSessionId: session.id,
    authUrl: session.authUrl,
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
    '[ClaudeAuthFlow]',
    JSON.stringify({
      message,
      userId: session?.userId ?? null,
      loginSessionId: session?.id ?? null,
      pid: session?.child?.pid ?? null,
      claudeConfigDir: session?.claudeConfigDir ?? null,
      ...extra,
    }),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string, statusCode = 504): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new ClaudeAuthLoginError(message, statusCode)), ms);
    timer.unref?.();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function terminateSession(session: LoginSession | null | undefined, reason = 'cancelled'): void {
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

export function getActiveClaudeAuthLogin(
  userId: number | string | undefined,
): PublicSession | null {
  const userKey = normalizeUserKey(userId);
  const session = activeLogins.get(userKey);
  if (!session) return null;
  return publicSession(session);
}

export function cancelClaudeAuthLogin(
  userId: number | string | undefined,
  reason: string = 'cancelled',
): boolean {
  const userKey = normalizeUserKey(userId);
  const session = activeLogins.get(userKey);
  if (!session) {
    console.log(
      '[ClaudeAuthFlow]',
      JSON.stringify({
        message: 'cancel-request-no-active-session',
        userId,
        reason,
      }),
    );
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

export async function startClaudeAuthLogin(
  userId: number | string,
  options: StartLoginOptions = {},
): Promise<PublicSession> {
  const userKey = normalizeUserKey(userId);
  const ttlMs = options.ttlMs || Number(process.env.CLAUDE_AUTH_LOGIN_TTL_MS) || DEFAULT_LOGIN_TTL_MS;
  const urlWaitMs = options.urlWaitMs || URL_WAIT_TIMEOUT_MS;

  console.log(
    '[ClaudeAuthFlow]',
    JSON.stringify({
      message: 'start-request',
      userId,
      ttlMs,
      urlWaitMs,
    }),
  );
  cancelClaudeAuthLogin(userId, 'replaced');

  const { claudeConfigDir } = prepareClaudeConfigDir(userId);
  const env = buildClaudeLoginEnv(userId);

  // node-pty allocates a real PTY so the Claude CLI (an Ink/React app that
  // requires raw-mode stdin) runs normally and emits a single-line OAuth URL.
  const claudeCli = process.env.CLAUDE_CLI_PATH || 'claude';
  const child = pty.spawn(claudeCli, ['setup-token'], {
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
    claudeConfigDir,
    startedAt: new Date(startedAtMs).toISOString(),
    expiresAt: new Date(startedAtMs + ttlMs).toISOString(),
    authUrl: null,
    stdout: '',
    stderr: '',
    exited: false,
    exit: null,
    cancelReason: null,
    completing: false,
    // placeholders, set below
    ttlTimer: undefined as unknown as NodeJS.Timeout,
    urlPromise: undefined as unknown as Promise<PublicSession>,
    resolveUrl: undefined as unknown as (v: PublicSession) => void,
    rejectUrl: undefined as unknown as (e: Error) => void,
    exitPromise: undefined as unknown as Promise<LoginSession['exit']>,
    resolveExit: undefined as unknown as (v: LoginSession['exit']) => void,
    tokenPromise: undefined as unknown as Promise<string>,
    resolveToken: undefined as unknown as (v: string) => void,
    tokenCaptured: null,
    errorPromise: undefined as unknown as Promise<never>,
    rejectError: undefined as unknown as (e: Error) => void,
    errorCaptured: null,
  };
  logSession(session, 'spawned-login-process', {
    expiresAt: session.expiresAt,
  });

  session.urlPromise = new Promise<PublicSession>((resolve, reject) => {
    session.resolveUrl = resolve;
    session.rejectUrl = reject;
  });

  session.exitPromise = new Promise((resolve) => {
    session.resolveExit = resolve;
  });

  session.tokenPromise = new Promise<string>((resolve) => {
    session.resolveToken = resolve;
  });
  session.errorPromise = new Promise<never>((_, reject) => {
    session.rejectError = reject;
  });
  // Don't let unhandled-rejection warnings fire if the race ignores this leg.
  session.errorPromise.catch(() => {});

  session.ttlTimer = setTimeout(() => {
    if (activeLogins.get(userKey)?.id === session.id) {
      logSession(session, 'login-session-expired');
      activeLogins.delete(userKey);
      terminateSession(session, 'expired');
    }
  }, ttlMs);
  session.ttlTimer.unref?.();

  activeLogins.set(userKey, session);

  const handleOutput = (chunk: Buffer | string, streamName: 'stdout' | 'stderr'): void => {
    const text = String(chunk);
    session[streamName] = limitOutput(session[streamName] + text);
    logSession(session, 'login-process-output', {
      stream: streamName,
      bytes: Buffer.byteLength(text),
    });

    if (!session.authUrl) {
      const url = extractAuthUrl(`${session.stdout}\n${session.stderr}`);
      if (url) {
        session.authUrl = url;
        // Log structural facts about the captured URL (not its value — it
        // carries a PKCE challenge) so a future "redirect_uri manquant"-style
        // report can be diagnosed from logs: a complete authorize URL has a
        // host, ~7 query params, and both `redirect_uri` and `state`.
        let urlHost: string | null = null;
        let urlParamCount: number | null = null;
        try {
          const parsed = new URL(url);
          urlHost = parsed.host;
          urlParamCount = Array.from(parsed.searchParams.keys()).length;
        } catch {
          /* not a parseable URL — leave host/paramCount null */
        }
        logSession(session, 'auth-url-detected', {
          hasAuthUrl: true,
          urlLength: url.length,
          urlHost,
          urlParamCount,
          hasRedirectUri: /[?&]redirect_uri=/.test(url),
          hasState: /[?&]state=/.test(url),
        });
        session.resolveUrl(publicSession(session));
      }
    }

    if (session.completing && !session.tokenCaptured && !session.errorCaptured) {
      const combined = `${session.stdout}\n${session.stderr}`;
      const token = extractOAuthToken(combined);
      if (token) {
        session.tokenCaptured = token;
        logSession(session, 'oauth-token-detected', {
          tokenFingerprint: token.slice(-6),
        });
        session.resolveToken(token);
        return;
      }
      const cliError = extractCliError(combined);
      if (cliError) {
        session.errorCaptured = cliError;
        logSession(session, 'oauth-error-detected', { cliError });
        session.rejectError(
          new ClaudeAuthLoginError(`Claude rejected the authentication code: ${cliError}`, 400),
        );
      }
    }
  };

  // node-pty merges stdout+stderr into a single onData stream.
  child.onData((chunk) => handleOutput(chunk, 'stdout'));

  child.onExit(({ exitCode, signal }) => {
    session.exited = true;
    // node-pty reports the terminating signal as a number; our exit record
    // stores it as a string (or null when the process exited normally).
    session.exit = { exitCode, signal: signal == null ? null : String(signal) };
    logSession(session, 'login-process-closed', {
      code: exitCode,
      signal,
      completing: session.completing,
      cancelReason: session.cancelReason,
    });
    clearTimeout(session.ttlTimer);
    if (activeLogins.get(userKey)?.id === session.id && !session.completing) {
      activeLogins.delete(userKey);
    }
    if (!session.authUrl) {
      session.rejectUrl(
        new ClaudeAuthLoginError('Claude authentication exited before producing a login URL', 500),
      );
    }
    session.resolveExit(session.exit);
  });

  return withTimeout(
    session.urlPromise,
    urlWaitMs,
    'Claude authentication did not produce a login URL in time',
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

export interface CompleteLoginOptions {
  completeWaitMs?: number;
}

export async function completeClaudeAuthLogin(
  userId: number | string,
  loginSessionId: string,
  code: unknown,
  options: CompleteLoginOptions = {},
): Promise<ClaudeAuthStatus> {
  const userKey = normalizeUserKey(userId);
  const session = activeLogins.get(userKey);

  if (!session) {
    console.log(
      '[ClaudeAuthFlow]',
      JSON.stringify({
        message: 'complete-request-no-active-session',
        userId,
        submittedLoginSessionId: loginSessionId || null,
      }),
    );
    throw new ClaudeAuthLoginError('No active Claude authentication session', 404);
  }

  if (session.id !== loginSessionId) {
    logSession(session, 'complete-request-replaced-session', {
      submittedLoginSessionId: loginSessionId || null,
    });
    throw new ClaudeAuthLoginError('Claude authentication session has been replaced', 409);
  }

  if (Date.now() >= Date.parse(session.expiresAt)) {
    logSession(session, 'complete-request-expired');
    cancelClaudeAuthLogin(userId, 'expired');
    throw new ClaudeAuthLoginError('Claude authentication link expired', 410);
  }

  const trimmedCode = typeof code === 'string' ? code.trim() : '';
  if (!trimmedCode || trimmedCode.length > 4096 || trimmedCode.includes('\0')) {
    logSession(session, 'complete-request-invalid-code', {
      codeLength: trimmedCode.length,
    });
    throw new ClaudeAuthLoginError('A valid Claude authentication code is required', 400);
  }

  session.completing = true;
  logSession(session, 'submitting-auth-code', {
    codeLength: trimmedCode.length,
  });

  try {
    session.child.write(trimmedCode);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 100);
      t.unref?.();
    });
    session.child.write('\r');
  } catch {
    activeLogins.delete(userKey);
    clearTimeout(session.ttlTimer);
    logSession(session, 'auth-code-submit-failed');
    throw new ClaudeAuthLoginError('Failed to submit Claude authentication code', 500);
  }

  let token: string | null;
  try {
    logSession(session, 'waiting-for-token-or-exit');
    token = await withTimeout(
      Promise.race<string | null>([
        session.tokenPromise,
        session.errorPromise,
        session.exitPromise.then((exit) => {
          if (exit?.error || exit?.exitCode !== 0) {
            throw new ClaudeAuthLoginError(
              'Claude authentication failed. Check the code and try again.',
              400,
            );
          }
          return null;
        }),
      ]),
      options.completeWaitMs || COMPLETE_WAIT_TIMEOUT_MS,
      'Claude authentication did not finish in time',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logSession(session, 'complete-failed', {
      error: message,
      stdoutTail: session.stdout.slice(-400),
      stderrTail: session.stderr.slice(-400),
    });
    cancelClaudeAuthLogin(userId, 'complete-failed');
    throw error;
  }

  activeLogins.delete(userKey);
  clearTimeout(session.ttlTimer);

  if (!token) {
    token = extractOAuthToken(`${session.stdout}\n${session.stderr}`);
  }
  if (!token) {
    logSession(session, 'token-not-found-in-output', {
      stdoutTail: session.stdout.slice(-400),
    });
    throw new ClaudeAuthLoginError('Claude setup-token completed but no token was emitted', 500);
  }

  terminateSession(session, 'token-captured');

  try {
    writeClaudeOAuthToken(userId, token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logSession(session, 'token-persist-failed', { error: message });
    throw new ClaudeAuthLoginError(`Failed to persist Claude OAuth token: ${message}`, 500);
  }

  logSession(session, 'login-process-exited-successfully');
  const status = await getClaudeAuthStatus(userId);
  if (!status.authenticated) {
    logSession(session, 'post-login-status-not-authenticated', {
      status: status.status,
    });
    throw new ClaudeAuthLoginError(
      'Claude authentication completed, but credentials are not usable yet',
      500,
    );
  }

  logSession(session, 'complete-success', {
    tokenFingerprint: status.tokenFingerprint || null,
  });
  return status;
}

export function clearClaudeAuthLoginSessions(): void {
  for (const session of activeLogins.values()) {
    clearTimeout(session.ttlTimer);
    terminateSession(session, 'cleanup');
  }
  activeLogins.clear();
}
