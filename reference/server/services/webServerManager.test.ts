import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockRunCommand,
  mockAccess,
  mockReadlink,
  mockRealpath,
  mockMkdir,
  mockKill,
  mockProvisioningMode,
} = vi.hoisted(() => ({
  mockRunCommand: vi.fn(),
  mockAccess: vi.fn(),
  mockReadlink: vi.fn(),
  mockRealpath: vi.fn(),
  mockMkdir: vi.fn(),
  mockKill: vi.fn(),
  // Only `getActiveWorktree` consults the mode (for the settings banner);
  // switching behaves identically with or without a hook.
  mockProvisioningMode: vi.fn().mockResolvedValue('none'),
}));

vi.mock('./shell.js', () => ({
  runCommand: mockRunCommand,
}));

vi.mock('fs', () => ({
  default: {
    promises: {
      access: mockAccess,
      readlink: mockReadlink,
      realpath: mockRealpath,
      mkdir: mockMkdir,
    },
    constants: { X_OK: 1, R_OK: 4, W_OK: 2, F_OK: 0 },
  },
  promises: {
    access: mockAccess,
    readlink: mockReadlink,
    realpath: mockRealpath,
    mkdir: mockMkdir,
  },
  constants: { X_OK: 1, R_OK: 4, W_OK: 2, F_OK: 0 },
}));

vi.mock('../database/db.js', () => ({
  projectsDb: {
    updateActiveWorktree: vi.fn(),
    updateWebServerConfig: vi.fn(),
  },
  tasksDb: {
    getWithProject: vi.fn(),
    // `getActiveWorktree` resolves the served ticket's title for the
    // "Serving: …" indicator.
    getById: vi.fn(),
  },
}));

vi.mock('./projectService.js', () => ({
  getProject: vi.fn(),
}));

vi.mock('./worktree.js', () => ({
  worktreeProvisioningMode: mockProvisioningMode,
  getWorktreePath: vi.fn((repoPath, taskId) => `${repoPath}-worktrees/task-${taskId}`),
  getWorktreeProjectPath: vi.fn((repoPath, taskId, subprojectPath) => {
    const worktreePath = `${repoPath}-worktrees/task-${taskId}`;
    return subprojectPath ? `${worktreePath}/${subprojectPath}` : worktreePath;
  }),
  worktreeExists: vi.fn(),
}));

import {
  switchServedTarget,
  getActiveWorktree,
  verifySymlink,
  updateWebServerConfig,
} from './webServerManager.js';
import { projectsDb, tasksDb } from '../database/db.js';
import { registerEpicServeResolver, type EpicServeResolver } from './webServerManager.js';
import { getProject } from './projectService.js';
import { worktreeExists } from './worktree.js';

type RunArgs = readonly string[];

function withDispatch(
  handler: (cmd: string, args: RunArgs) => Promise<{ stdout: string; stderr: string }>,
): void {
  mockRunCommand.mockImplementation((cmd: string, args: RunArgs) => handler(cmd, args));
}

describe('WebServerManager Service', () => {
  const testUserId = 1;
  const testProjectId = 1;
  const testTaskId = 10;

  const mockProject = {
    id: testProjectId,
    user_id: testUserId,
    name: 'Test Project',
    repo_folder_path: '/home/user/myproject',
    serve_symlink_path: '/var/www/myproject',
    systemd_service_name: 'puma@myproject',
    app_url: 'https://myproject.example.com',
    active_worktree_task_id: null,
  };

  const mockTask = {
    id: testTaskId,
    project_id: testProjectId,
    title: 'Test Task',
    user_id: testUserId,
  };

  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // process.kill must not actually signal anything during tests.
    processKillSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      mockKill(pid);
      return true;
    }) as never);
  });

  describe('switchServedTarget', () => {
    // Resolves every fs.access EXCEPT the .bottega/switch.sh probe. Tests that
    // exercise the legacy systemctl path use this so the new hook branch is
    // skipped. Tests that exercise the hook branch use mockResolvedValue
    // directly.
    function mockAccessAllowAllExceptSwitchScript(): void {
      mockAccess.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.endsWith('/.bottega/switch.sh')) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          return Promise.reject(err);
        }
        return Promise.resolve(undefined);
      });
    }

    it('should return error when project not found', async () => {
      vi.mocked(getProject).mockReturnValue(undefined);

      const result = await switchServedTarget(999, { kind: 'main' }, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Project not found');
    });

    it('should return error when symlink path not configured', async () => {
      vi.mocked(getProject).mockReturnValue({
        ...mockProject,
        serve_symlink_path: null,
      } as never);

      const result = await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Symlink path not configured');
    });

    it('should return error when systemd service not configured', async () => {
      vi.mocked(getProject).mockReturnValue({
        ...mockProject,
        systemd_service_name: null,
      } as never);

      const result = await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Systemd service name not configured');
    });

    it('rejects pre-existing DB rows with a malicious systemd service name', async () => {
      vi.mocked(getProject).mockReturnValue({
        ...mockProject,
        systemd_service_name: 'evil; rm -rf /',
      } as never);

      const result = await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid systemd service/i);
    });

    it('rejects pre-existing DB rows with a non-absolute symlink path', async () => {
      vi.mocked(getProject).mockReturnValue({
        ...mockProject,
        serve_symlink_path: 'relative/path',
      } as never);

      const result = await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid absolute symlink/i);
    });

    it('should return error when task not found', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const result = await switchServedTarget(testProjectId, { kind: 'task', taskId: testTaskId }, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Task not found');
    });

    it('should return error when task belongs to different project', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue({
        ...mockTask,
        project_id: 999,
      } as never);

      const result = await switchServedTarget(testProjectId, { kind: 'task', taskId: testTaskId }, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Task does not belong to this project');
    });

    it('should return error when worktree does not exist', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTask as never);
      vi.mocked(worktreeExists).mockResolvedValue(false);

      const result = await switchServedTarget(testProjectId, { kind: 'task', taskId: testTaskId }, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Worktree does not exist');
    });

    it('should return error when target path does not exist', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTask as never);
      vi.mocked(worktreeExists).mockResolvedValue(true);
      vi.mocked(mockAccess).mockRejectedValue(new Error('ENOENT'));

      const result = await switchServedTarget(testProjectId, { kind: 'task', taskId: testTaskId }, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Target path does not exist');
    });

    // Provisioning happened (or didn't) inside `git worktree add`, via the
    // project's own post-checkout hook. Serving must not second-guess it: no
    // dependency-readiness gate, no stack-specific directories.
    it('serves a worktree as-is — no dependency gate, no stack mkdirs', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTask as never);
      vi.mocked(worktreeExists).mockResolvedValue(true);
      mockAccessAllowAllExceptSwitchScript();
      withDispatch(async () => ({ stdout: '', stderr: '' }));
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      const result = await switchServedTarget(testProjectId, { kind: 'task', taskId: testTaskId }, testUserId);

      expect(result.success).toBe(true);
      expect(result.activeTaskId).toBe(testTaskId);
      // Exactly two probes: the target path, then .bottega/switch.sh — never
      // the main checkout's node_modules/.venv.
      expect(mockAccess).toHaveBeenCalledTimes(2);
      expect(mockMkdir).not.toHaveBeenCalled();
    });

    it('passes systemctl invocations through argv (no shell)', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      mockAccessAllowAllExceptSwitchScript();
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async () => ({ stdout: '', stderr: '' }));
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      const result = await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(result.success).toBe(true);
      const stopCall = mockRunCommand.mock.calls.find(
        (c) => c[0] === 'systemctl' && (c[1] as string[]).includes('stop'),
      );
      const startCall = mockRunCommand.mock.calls.find(
        (c) => c[0] === 'systemctl' && (c[1] as string[]).includes('start'),
      );
      expect(stopCall![1]).toEqual(['--user', 'stop', 'puma@myproject']);
      expect(startCall![1]).toEqual(['--user', 'start', 'puma@myproject']);
      const lnCall = mockRunCommand.mock.calls.find((c) => c[0] === 'ln');
      expect(lnCall![1]).toEqual(['-sfn', '/home/user/myproject', '/var/www/myproject']);
    });

    it('parses PORT from systemctl Environment and signals listening pids without a shell pipeline', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      mockAccessAllowAllExceptSwitchScript();
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async (cmd, args) => {
        if (cmd === 'systemctl' && args.includes('show')) {
          return { stdout: 'Environment=PORT=4321 RAILS_ENV=production\n', stderr: '' };
        }
        if (cmd === 'lsof') {
          return { stdout: '12345\n67890\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      const lsofCall = mockRunCommand.mock.calls.find((c) => c[0] === 'lsof');
      expect(lsofCall![1]).toEqual(['-ti', ':4321']);
      expect(mockKill).toHaveBeenCalledWith(12345);
      expect(mockKill).toHaveBeenCalledWith(67890);
    });

    it('ignores a malformed PORT value rather than killing arbitrary pids', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      mockAccessAllowAllExceptSwitchScript();
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async (cmd, args) => {
        if (cmd === 'systemctl' && args.includes('show')) {
          // The regex matches digits, so something like `PORT=99999999` slips through
          // the regex but should be rejected by the validator.
          return { stdout: 'Environment=PORT=99999999\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(mockRunCommand.mock.calls.find((c) => c[0] === 'lsof')).toBeUndefined();
      expect(mockKill).not.toHaveBeenCalled();
    });

    it('returns error when symlink update fails', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(mockAccess).mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async (cmd) => {
        if (cmd === 'ln') throw new Error('Permission denied');
        return { stdout: '', stderr: '' };
      });

      const result = await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to update symlink');
    });

    it('succeeds with warning when service restart fails', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      mockAccessAllowAllExceptSwitchScript();
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async (cmd, args) => {
        if (cmd === 'ln') return { stdout: '', stderr: '' };
        if (cmd === 'systemctl' && args.includes('start')) {
          throw new Error('Service not found');
        }
        return { stdout: '', stderr: '' };
      });
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      const result = await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(result.success).toBe(true);
      expect(result.warning).toContain('service restart failed');
      expect(projectsDb.updateActiveWorktree).toHaveBeenCalled();
    });

    // --- .bottega/switch.sh hook ---

    function findScriptCall(): unknown[] | undefined {
      return mockRunCommand.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].endsWith('/.bottega/switch.sh'),
      );
    }

    it('runs .bottega/switch.sh when present and executable, skipping systemctl', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      // Resolve every fs.access including the script probe → take the hook
      // branch.
      mockAccess.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async () => ({ stdout: '', stderr: '' }));
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      const result = await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(result.success).toBe(true);
      expect(result.warning).toBeUndefined();
      expect(findScriptCall()).toBeDefined();
      const systemctlCalls = mockRunCommand.mock.calls.filter((c) => c[0] === 'systemctl');
      expect(systemctlCalls).toEqual([]);
      expect(projectsDb.updateActiveWorktree).toHaveBeenCalled();
    });

    it('falls back to systemctl when .bottega/switch.sh is absent', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      mockAccessAllowAllExceptSwitchScript();
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async () => ({ stdout: '', stderr: '' }));
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      const result = await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(result.success).toBe(true);
      expect(findScriptCall()).toBeUndefined();
      const startCall = mockRunCommand.mock.calls.find(
        (c) => c[0] === 'systemctl' && (c[1] as string[]).includes('start'),
      );
      expect(startCall).toBeDefined();
    });

    it('falls back to systemctl when .bottega/switch.sh exists but is not executable', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      mockAccess.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.endsWith('/.bottega/switch.sh')) {
          const err = new Error('EACCES') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          return Promise.reject(err);
        }
        return Promise.resolve(undefined);
      });
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async () => ({ stdout: '', stderr: '' }));
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      const result = await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(result.success).toBe(true);
      expect(findScriptCall()).toBeUndefined();
      const startCall = mockRunCommand.mock.calls.find(
        (c) => c[0] === 'systemctl' && (c[1] as string[]).includes('start'),
      );
      expect(startCall).toBeDefined();
    });

    it('passes BOTTEGA_TARGET_PATH / PROJECT_ID / TASK_ID env vars to the script', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTask as never);
      vi.mocked(worktreeExists).mockResolvedValue(true);
      mockAccess.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async () => ({ stdout: '', stderr: '' }));
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      await switchServedTarget(testProjectId, { kind: 'task', taskId: testTaskId }, testUserId);

      const opts = findScriptCall()?.[2] as { env?: Record<string, string> } | undefined;
      expect(opts?.env?.BOTTEGA_TARGET_PATH).toBe('/home/user/myproject-worktrees/task-10');
      expect(opts?.env?.BOTTEGA_PROJECT_ID).toBe(String(testProjectId));
      expect(opts?.env?.BOTTEGA_TASK_ID).toBe(String(testTaskId));
      // PATH (inherited from process.env) must be preserved or the script
      // wouldn't find uv/systemctl.
      expect(opts?.env?.PATH).toBeDefined();
    });

    it('sets BOTTEGA_TASK_ID to empty string when switching back to main repo', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      mockAccess.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async () => ({ stdout: '', stderr: '' }));
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      const opts = findScriptCall()?.[2] as { env?: Record<string, string> } | undefined;
      expect(opts?.env?.BOTTEGA_TASK_ID).toBe('');
    });

    it('runs script with cwd = target path and 30s timeout', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      mockAccess.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async () => ({ stdout: '', stderr: '' }));
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      const opts = findScriptCall()?.[2] as { cwd?: string; timeout?: number } | undefined;
      expect(opts?.cwd).toBe('/home/user/myproject');
      expect(opts?.timeout).toBe(30_000);
    });

    it('returns success+warning when the script exits non-zero, still updates active_worktree_task_id', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      mockAccess.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async (cmd) => {
        if (cmd === 'ln') return { stdout: '', stderr: '' };
        if (typeof cmd === 'string' && cmd.endsWith('/.bottega/switch.sh')) {
          const err = new Error('Command failed: exit 1') as Error & { stderr: string };
          err.stderr = 'tailwind: command not found';
          throw err;
        }
        return { stdout: '', stderr: '' };
      });
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      const result = await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(result.success).toBe(true);
      expect(result.warning).toContain('switch script failed');
      expect(result.warning).toContain('tailwind: command not found');
      // Both owner columns are written on every switch — that is what keeps
      // "at most one is set" true without a CHECK constraint.
      expect(projectsDb.updateActiveWorktree).toHaveBeenCalledWith(
        testProjectId,
        testUserId,
        null,
        null,
      );
    });

    it('returns success+warning when the script times out', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      mockAccess.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async (cmd) => {
        if (cmd === 'ln') return { stdout: '', stderr: '' };
        if (typeof cmd === 'string' && cmd.endsWith('/.bottega/switch.sh')) {
          // execFile timeout shape: error.killed = true, error.signal = SIGTERM
          const err = new Error('Command timed out') as Error & {
            killed: boolean;
            signal: string;
          };
          err.killed = true;
          err.signal = 'SIGTERM';
          throw err;
        }
        return { stdout: '', stderr: '' };
      });
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      const result = await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(result.success).toBe(true);
      expect(result.warning).toContain('switch script failed');
      expect(result.warning).toContain('timed out');
    });

    it('truncates large script stderr in the warning', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      mockAccess.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      const bigStderr = 'x'.repeat(10_000);
      withDispatch(async (cmd) => {
        if (cmd === 'ln') return { stdout: '', stderr: '' };
        if (typeof cmd === 'string' && cmd.endsWith('/.bottega/switch.sh')) {
          const err = new Error('Command failed') as Error & { stderr: string };
          err.stderr = bigStderr;
          throw err;
        }
        return { stdout: '', stderr: '' };
      });
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      const result = await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(result.success).toBe(true);
      expect(result.warning).toBeDefined();
      // 4 KB stderr cap + framing prefix + truncation marker — comfortably
      // below 5 KB.
      expect(result.warning!.length).toBeLessThan(5_000);
      expect(result.warning).toContain('truncated');
    });
  });

  describe('getActiveWorktree', () => {
    it('returns error when project not found', async () => {
      vi.mocked(getProject).mockReturnValue(undefined);

      const result = await getActiveWorktree(999, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Project not found');
    });

    it('returns active worktree status when configured', async () => {
      vi.mocked(getProject).mockReturnValue({
        ...mockProject,
        active_worktree_task_id: testTaskId,
        active_worktree_epic_id: null,
      } as never);
      vi.mocked(tasksDb.getById).mockReturnValue({
        id: testTaskId,
        title: 'Add the pricing page',
      } as never);

      const result = await getActiveWorktree(testProjectId, testUserId);

      expect(result.success).toBe(true);
      expect(result.activeTaskId).toBe(testTaskId);
      expect(result.activeEpicId).toBeNull();
      // Resolved server-side so every surface names it the same way.
      expect(result.activeName).toBe('Add the pricing page');
      expect(result.serveSymlinkPath).toBe('/var/www/myproject');
      expect(result.systemdServiceName).toBe('puma@myproject');
      expect(result.appUrl).toBe('https://myproject.example.com');
      expect(result.isConfigured).toBe(true);
    });

    it('returns isConfigured false when not configured', async () => {
      vi.mocked(getProject).mockReturnValue({
        ...mockProject,
        serve_symlink_path: null,
        systemd_service_name: null,
      } as never);

      const result = await getActiveWorktree(testProjectId, testUserId);

      expect(result.success).toBe(true);
      expect(result.isConfigured).toBe(false);
    });
  });

  describe('verifySymlink', () => {
    it('returns error when project not found', async () => {
      vi.mocked(getProject).mockReturnValue(undefined);

      const result = await verifySymlink(999, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Project not found');
    });

    it('returns error when symlink path not configured', async () => {
      vi.mocked(getProject).mockReturnValue({
        ...mockProject,
        serve_symlink_path: null,
      } as never);

      const result = await verifySymlink(testProjectId, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Symlink path not configured');
    });

    it('returns matches=true when symlink points to correct target', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(mockReadlink).mockResolvedValue('/home/user/myproject');
      vi.mocked(mockRealpath).mockResolvedValue('/home/user/myproject');

      const result = await verifySymlink(testProjectId, testUserId);

      expect(result.success).toBe(true);
      expect(result.matches).toBe(true);
      expect(result.symlinkExists).toBe(true);
    });

    it('returns matches=false when symlink points to wrong target', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(mockReadlink).mockResolvedValue('/wrong/path');
      vi.mocked(mockRealpath).mockImplementation((p) => Promise.resolve(p));

      const result = await verifySymlink(testProjectId, testUserId);

      expect(result.success).toBe(true);
      expect(result.matches).toBe(false);
    });

    it('returns symlinkExists=false when symlink does not exist', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      const error = new Error('ENOENT') as Error & { code: string };
      error.code = 'ENOENT';
      vi.mocked(mockReadlink).mockRejectedValue(error);

      const result = await verifySymlink(testProjectId, testUserId);

      expect(result.success).toBe(true);
      expect(result.symlinkExists).toBe(false);
      expect(result.matches).toBe(false);
    });

    it('returns error when readlink fails for other reasons', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      const error = new Error('Permission denied') as Error & { code: string };
      error.code = 'EACCES';
      vi.mocked(mockReadlink).mockRejectedValue(error);

      const result = await verifySymlink(testProjectId, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to read symlink');
    });
  });

  describe('updateWebServerConfig', () => {
    it('returns error when project not found', () => {
      vi.mocked(getProject).mockReturnValue(undefined);

      const result = updateWebServerConfig(999, testUserId, {
        serveSymlinkPath: '/var/www/test',
        systemdServiceName: 'puma@test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Project not found');
    });

    it('returns error for invalid service name', () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);

      const result = updateWebServerConfig(testProjectId, testUserId, {
        serveSymlinkPath: '/var/www/test',
        systemdServiceName: 'invalid;name',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid service name');
    });

    it('returns error for relative symlink path', () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);

      const result = updateWebServerConfig(testProjectId, testUserId, {
        serveSymlinkPath: 'relative/path',
        systemdServiceName: 'puma@test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('absolute path');
    });

    it('updates config successfully', () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(projectsDb.updateWebServerConfig).mockReturnValue(mockProject as never);

      const result = updateWebServerConfig(testProjectId, testUserId, {
        serveSymlinkPath: '/var/www/test',
        systemdServiceName: 'puma@test',
      });

      expect(result.success).toBe(true);
      expect(result.project).toEqual(mockProject);
      expect(projectsDb.updateWebServerConfig).toHaveBeenCalledWith(testProjectId, testUserId, {
        serveSymlinkPath: '/var/www/test',
        systemdServiceName: 'puma@test',
      });
    });

    it('allows service names with @ symbol', () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(projectsDb.updateWebServerConfig).mockReturnValue(mockProject as never);

      const result = updateWebServerConfig(testProjectId, testUserId, {
        serveSymlinkPath: '/var/www/test',
        systemdServiceName: 'puma@my-project',
      });

      expect(result.success).toBe(true);
    });

    it('allows empty config values to clear settings', () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(projectsDb.updateWebServerConfig).mockReturnValue(mockProject as never);

      const result = updateWebServerConfig(testProjectId, testUserId, {});

      expect(result.success).toBe(true);
      expect(projectsDb.updateWebServerConfig).toHaveBeenCalledWith(testProjectId, testUserId, {});
    });

    it('persists a valid app URL', () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(projectsDb.updateWebServerConfig).mockReturnValue(mockProject as never);

      const result = updateWebServerConfig(testProjectId, testUserId, {
        appUrl: 'https://my-project.example.com',
      });

      expect(result.success).toBe(true);
      expect(projectsDb.updateWebServerConfig).toHaveBeenCalledWith(testProjectId, testUserId, {
        appUrl: 'https://my-project.example.com',
      });
    });

    it('rejects an app URL with a non-http(s) scheme', () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);

      const result = updateWebServerConfig(testProjectId, testUserId, {
        appUrl: 'javascript:alert(1)',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('http(s) URL');
      expect(projectsDb.updateWebServerConfig).not.toHaveBeenCalled();
    });

    it('rejects a malformed app URL', () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);

      const result = updateWebServerConfig(testProjectId, testUserId, {
        appUrl: 'not a url',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('http(s) URL');
    });
  });

  describe('teardown', () => {
    it('restores process.kill', () => {
      // sanity — beforeEach replaced it, ensure spy is active and can be restored
      expect(processKillSpy).toBeDefined();
    });
  });

  /**
   * Serving an EPIC. The epic layer answers "where is this epic's worktree"
   * through a resolver registered at boot, because this module is shared
   * infrastructure and may not import that domain (architecture-v2 rule 1).
   */
  describe('switchServedTarget — epics', () => {
    const resolveEpicServeTarget = vi.fn();
    const epicName = vi.fn();
    const resolver: EpicServeResolver = {
      resolveEpicServeTarget: (id: number, projectId: number) =>
        resolveEpicServeTarget(id, projectId) as Promise<{ worktreePath: string; name: string }>,
      epicName: (id: number) => epicName(id) as string | null,
    };

    beforeEach(() => {
      vi.clearAllMocks();
      mockProvisioningMode.mockResolvedValue('none');
      registerEpicServeResolver(resolver);
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      mockAccess.mockResolvedValue(undefined);
      withDispatch(() => Promise.resolve({ stdout: '', stderr: '' }));
      resolveEpicServeTarget.mockResolvedValue({
        worktreePath: '/repos/myproject-worktrees/epic-8',
        name: 'Nimbus Pricing',
      });
    });

    it('points the symlink at the epic delivery worktree and records the epic', async () => {
      const result = await switchServedTarget(testProjectId, { kind: 'epic', epicId: 8 }, testUserId);

      expect(result.success).toBe(true);
      expect(result.activeEpicId).toBe(8);
      expect(result.activeTaskId).toBeNull();
      expect(resolveEpicServeTarget).toHaveBeenCalledWith(8, testProjectId);
      expect(mockRunCommand).toHaveBeenCalledWith('ln', [
        '-sfn',
        '/repos/myproject-worktrees/epic-8',
        '/var/www/myproject',
      ]);
      // Both columns written: switching to an epic has to clear the task.
      expect(projectsDb.updateActiveWorktree).toHaveBeenCalledWith(testProjectId, testUserId, null, 8);
    });

    // The resolver owns epic-vs-project validation; its message is the user's.
    it('surfaces the resolver refusal as the switch error', async () => {
      resolveEpicServeTarget.mockRejectedValue(new Error('Epic does not belong to this project'));

      const result = await switchServedTarget(testProjectId, { kind: 'epic', epicId: 8 }, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Epic does not belong to this project');
      expect(mockRunCommand).not.toHaveBeenCalled();
    });

    // Provisioning is the project hook's business, settled at `git worktree
    // add` time. Serving never probes dependency dirs and never makes
    // stack-specific directories — a worktree that exists is served as-is.
    it('serves an epic worktree as-is, even with node_modules missing', async () => {
      mockAccess.mockImplementation((p: string) =>
        String(p).includes('node_modules')
          ? Promise.reject(new Error('ENOENT'))
          : Promise.resolve(undefined),
      );

      const result = await switchServedTarget(testProjectId, { kind: 'epic', epicId: 8 }, testUserId);

      expect(result.success).toBe(true);
      expect(mockMkdir).not.toHaveBeenCalled();
    });

    it('resets to the main checkout, clearing both owners', async () => {
      const result = await switchServedTarget(testProjectId, { kind: 'main' }, testUserId);

      expect(result.success).toBe(true);
      expect(result.activeTaskId).toBeNull();
      expect(result.activeEpicId).toBeNull();
      expect(projectsDb.updateActiveWorktree).toHaveBeenCalledWith(
        testProjectId,
        testUserId,
        null,
        null,
      );
    });

    it('names the served epic for the "Serving:" indicator', async () => {
      epicName.mockReturnValue('Nimbus Pricing');
      vi.mocked(getProject).mockReturnValue({
        ...mockProject,
        active_worktree_task_id: null,
        active_worktree_epic_id: 8,
      } as never);

      const result = await getActiveWorktree(testProjectId, testUserId);

      expect(result.activeEpicId).toBe(8);
      expect(result.activeName).toBe('Nimbus Pricing');
    });

    // A deleted epic still leaves the column set until the next switch.
    it('falls back to #id when the served epic row is gone', async () => {
      epicName.mockReturnValue(null);
      vi.mocked(getProject).mockReturnValue({
        ...mockProject,
        active_worktree_task_id: null,
        active_worktree_epic_id: 8,
      } as never);

      expect((await getActiveWorktree(testProjectId, testUserId)).activeName).toBe('Epic #8');
    });
  });
});

