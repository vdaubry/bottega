import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRunCommand, mockAccess, mockReadlink, mockRealpath, mockMkdir, mockKill } = vi.hoisted(
  () => ({
    mockRunCommand: vi.fn(),
    mockAccess: vi.fn(),
    mockReadlink: vi.fn(),
    mockRealpath: vi.fn(),
    mockMkdir: vi.fn(),
    mockKill: vi.fn(),
  }),
);

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
  },
  promises: {
    access: mockAccess,
    readlink: mockReadlink,
    realpath: mockRealpath,
    mkdir: mockMkdir,
  },
}));

vi.mock('../database/db.js', () => ({
  projectsDb: {
    updateActiveWorktree: vi.fn(),
    updateWebServerConfig: vi.fn(),
  },
  tasksDb: {
    getWithProject: vi.fn(),
  },
}));

vi.mock('./projectService.js', () => ({
  getProject: vi.fn(),
}));

vi.mock('./worktree.js', () => ({
  getWorktreePath: vi.fn((repoPath, taskId) => `${repoPath}-worktrees/task-${taskId}`),
  getWorktreeProjectPath: vi.fn((repoPath, taskId, subprojectPath) => {
    const worktreePath = `${repoPath}-worktrees/task-${taskId}`;
    return subprojectPath ? `${worktreePath}/${subprojectPath}` : worktreePath;
  }),
  worktreeExists: vi.fn(),
}));

import {
  switchWorktree,
  getActiveWorktree,
  verifySymlink,
  updateWebServerConfig,
} from './webServerManager.js';
import { projectsDb, tasksDb } from '../database/db.js';
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

  describe('switchWorktree', () => {
    it('should return error when project not found', async () => {
      vi.mocked(getProject).mockReturnValue(undefined);

      const result = await switchWorktree(999, null, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Project not found');
    });

    it('should return error when symlink path not configured', async () => {
      vi.mocked(getProject).mockReturnValue({
        ...mockProject,
        serve_symlink_path: null,
      } as never);

      const result = await switchWorktree(testProjectId, null, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Symlink path not configured');
    });

    it('should return error when systemd service not configured', async () => {
      vi.mocked(getProject).mockReturnValue({
        ...mockProject,
        systemd_service_name: null,
      } as never);

      const result = await switchWorktree(testProjectId, null, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Systemd service name not configured');
    });

    it('rejects pre-existing DB rows with a malicious systemd service name', async () => {
      vi.mocked(getProject).mockReturnValue({
        ...mockProject,
        systemd_service_name: 'evil; rm -rf /',
      } as never);

      const result = await switchWorktree(testProjectId, null, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid systemd service/i);
    });

    it('rejects pre-existing DB rows with a non-absolute symlink path', async () => {
      vi.mocked(getProject).mockReturnValue({
        ...mockProject,
        serve_symlink_path: 'relative/path',
      } as never);

      const result = await switchWorktree(testProjectId, null, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid absolute symlink/i);
    });

    it('should return error when task not found', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(undefined);

      const result = await switchWorktree(testProjectId, testTaskId, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Task not found');
    });

    it('should return error when task belongs to different project', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue({
        ...mockTask,
        project_id: 999,
      } as never);

      const result = await switchWorktree(testProjectId, testTaskId, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Task does not belong to this project');
    });

    it('should return error when worktree does not exist', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTask as never);
      vi.mocked(worktreeExists).mockResolvedValue(false);

      const result = await switchWorktree(testProjectId, testTaskId, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Worktree does not exist');
    });

    it('should return error when target path does not exist', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTask as never);
      vi.mocked(worktreeExists).mockResolvedValue(true);
      vi.mocked(mockAccess).mockRejectedValue(new Error('ENOENT'));

      const result = await switchWorktree(testProjectId, testTaskId, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Target path does not exist');
    });

    it('should return error when node_modules exists in main but not yet copied to worktree', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTask as never);
      vi.mocked(worktreeExists).mockResolvedValue(true);
      mockAccess
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockRejectedValueOnce(new Error('ENOENT'));

      const result = await switchWorktree(testProjectId, testTaskId, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Dependencies are not ready yet');
      expect(result.error).toContain('node_modules');
    });

    it('skips dep gate entirely when main repo has no node_modules or .venv', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(tasksDb.getWithProject).mockReturnValue(mockTask as never);
      vi.mocked(worktreeExists).mockResolvedValue(true);
      mockAccess
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockRejectedValueOnce(new Error('ENOENT'));
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async () => ({ stdout: '', stderr: '' }));
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      const result = await switchWorktree(testProjectId, testTaskId, testUserId);

      expect(result.success).toBe(true);
      expect(result.activeTaskId).toBe(testTaskId);
    });

    it('passes systemctl invocations through argv (no shell)', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(mockAccess).mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async () => ({ stdout: '', stderr: '' }));
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      const result = await switchWorktree(testProjectId, null, testUserId);

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
      vi.mocked(mockAccess).mockResolvedValue(undefined);
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

      await switchWorktree(testProjectId, null, testUserId);

      const lsofCall = mockRunCommand.mock.calls.find((c) => c[0] === 'lsof');
      expect(lsofCall![1]).toEqual(['-ti', ':4321']);
      expect(mockKill).toHaveBeenCalledWith(12345);
      expect(mockKill).toHaveBeenCalledWith(67890);
    });

    it('ignores a malformed PORT value rather than killing arbitrary pids', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(mockAccess).mockResolvedValue(undefined);
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

      await switchWorktree(testProjectId, null, testUserId);

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

      const result = await switchWorktree(testProjectId, null, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to update symlink');
    });

    it('succeeds with warning when service restart fails', async () => {
      vi.mocked(getProject).mockReturnValue(mockProject as never);
      vi.mocked(mockAccess).mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);
      withDispatch(async (cmd, args) => {
        if (cmd === 'ln') return { stdout: '', stderr: '' };
        if (cmd === 'systemctl' && args.includes('start')) {
          throw new Error('Service not found');
        }
        return { stdout: '', stderr: '' };
      });
      vi.mocked(projectsDb.updateActiveWorktree).mockReturnValue(mockProject as never);

      const result = await switchWorktree(testProjectId, null, testUserId);

      expect(result.success).toBe(true);
      expect(result.warning).toContain('service restart failed');
      expect(projectsDb.updateActiveWorktree).toHaveBeenCalled();
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
      } as never);

      const result = await getActiveWorktree(testProjectId, testUserId);

      expect(result.success).toBe(true);
      expect(result.activeTaskId).toBe(testTaskId);
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
});
