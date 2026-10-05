import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface RunCommandOptions {
  cwd?: string;
  timeout?: number;
  // Maximum stdout/stderr buffer. Node's default is 1 MB; PR descriptions and
  // gh API JSON payloads can exceed that.
  maxBuffer?: number;
  // When set, replaces the inherited env. Callers that want to layer extra
  // vars on top of process.env should spread it themselves.
  env?: NodeJS.ProcessEnv;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
}

// Centralized exec wrapper. Every shell-out in the codebase goes through this
// helper. By construction it uses `execFile` (NOT `exec`), so each argument
// is passed as a separate argv element — adversarial inputs like
// `$(rm -rf ~)`, backticks, semicolons, or newlines become literal bytes
// rather than shell metacharacters.
//
// There is no `shell: true` escape hatch. Callers that previously relied on
// shell pipelines (e.g. `lsof ... | xargs kill`) must reproduce the pipeline
// in JavaScript.
export async function runCommand(
  cmd: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const { stdout, stderr } = await execFileAsync(cmd, args.slice(), {
    cwd: options.cwd,
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    encoding: 'utf8',
    env: options.env,
  });
  return { stdout, stderr };
}

export interface RunCommandGroupOptions {
  cwd?: string;
  /** Hard ceiling in ms; the whole process group is killed when it passes. */
  timeout: number;
  /** Aborting kills the whole process group, like a timeout. */
  signal?: AbortSignal | undefined;
  env?: NodeJS.ProcessEnv;
}

/**
 * Why a process-group command failed. `stdout`/`stderr` hold what it printed
 * (the last {@link GROUP_OUTPUT_LIMIT} characters of each), so a caller can
 * show the user what went wrong.
 */
export class CommandGroupError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode: number | null,
    readonly timedOut: boolean,
    readonly aborted: boolean,
  ) {
    super(message);
    this.name = 'CommandGroupError';
  }
}

const GROUP_OUTPUT_LIMIT = 64 * 1024;
const GROUP_KILL_GRACE_MS = 5_000;

/**
 * `runCommand` for a command that starts processes of its own — `git worktree
 * add`, which runs the project's post-checkout hook, which may run an install
 * or a build. The command leads its own process group, and a timeout or an
 * abort kills that whole group (SIGTERM, then SIGKILL after a grace period).
 * `execFile`'s own timeout only signals the direct child: the hook's children
 * survive it and run forever. Same argv-only rule as `runCommand`.
 */
export function runCommandGroup(
  cmd: string,
  args: readonly string[],
  options: RunCommandGroupOptions,
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args.slice(), {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const keepTail = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8');
      return next.length > GROUP_OUTPUT_LIMIT ? next.slice(-GROUP_OUTPUT_LIMIT) : next;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = keepTail(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = keepTail(stderr, chunk);
    });

    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = () => {
      const signalGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The group is already gone.
        }
      };
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), GROUP_KILL_GRACE_MS);
      killTimer.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeout);
    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (error: Error | null, exitCode: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (!error && exitCode === 0 && !timedOut && !aborted) {
        if (killTimer) clearTimeout(killTimer);
        resolve({ stdout, stderr });
        return;
      }
      const reason = timedOut
        ? `timed out after ${Math.round(options.timeout / 1000)}s`
        : aborted
          ? 'was cancelled'
          : error
            ? `could not run: ${error.message}`
            : `exited with code ${exitCode}`;
      reject(
        new CommandGroupError(
          `${cmd} ${args.join(' ')} ${reason}`,
          stdout,
          stderr,
          exitCode,
          timedOut,
          aborted,
        ),
      );
    };

    child.once('error', (error) => settle(error, null));
    child.once('close', (code) => settle(null, code));
  });
}
