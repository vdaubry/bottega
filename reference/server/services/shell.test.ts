import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CommandGroupError, runCommandGroup } from './shell.js';

// Real processes: what matters is what the OS ends up running.

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

describe('runCommandGroup', () => {
  it('resolves with the output of a successful command', async () => {
    const result = await runCommandGroup('bash', ['-c', 'echo out; echo err >&2'], {
      timeout: 5_000,
    });
    expect(result).toEqual({ stdout: 'out\n', stderr: 'err\n' });
  });

  it('rejects with the exit code and the output of a failing command', async () => {
    const error = await runCommandGroup('bash', ['-c', 'echo why >&2; exit 3'], {
      timeout: 5_000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CommandGroupError);
    const failure = error as CommandGroupError;
    expect(failure.exitCode).toBe(3);
    expect(failure.stderr).toBe('why\n');
    expect(failure.timedOut).toBe(false);
    expect(failure.message).toContain('exited with code 3');
  });

  // The bug this exists for: a hook's child (a hung build) outlived the
  // timeout because only the direct child was signalled.
  it('kills the whole process group on timeout, grandchildren included', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-group-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    try {
      const error = await runCommandGroup(
        'bash',
        ['-c', `sleep 30 & echo $! > ${pidFile}; wait`],
        { timeout: 300 },
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CommandGroupError);
      expect((error as CommandGroupError).timedOut).toBe(true);
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
      expect(await waitUntil(() => !isAlive(grandchild))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('kills the process group when the signal aborts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-group-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    const controller = new AbortController();
    try {
      const running = runCommandGroup(
        'bash',
        ['-c', `sleep 30 & echo $! > ${pidFile}; wait`],
        { timeout: 30_000, signal: controller.signal },
      ).catch((e: unknown) => e);
      expect(await waitUntil(() => fs.existsSync(pidFile) && fs.statSync(pidFile).size > 0)).toBe(
        true,
      );
      controller.abort();

      const error = await running;
      expect(error).toBeInstanceOf(CommandGroupError);
      expect((error as CommandGroupError).aborted).toBe(true);
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
      expect(await waitUntil(() => !isAlive(grandchild))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
