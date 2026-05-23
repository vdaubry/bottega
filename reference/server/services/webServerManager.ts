import fs from 'fs';
import path from 'path';
import { getWorktreeProjectPath, worktreeExists } from './worktree.js';
import { projectsDb, tasksDb } from '../database/db.js';
import { getProject } from './projectService.js';
import { runCommand } from './shell.js';
import {
  assertAbsolutePath,
  assertHttpUrl,
  assertValidPort,
  assertValidServiceName,
  ValidationError,
} from './validators.js';
import type { ProjectRow, WebServerConfig } from '../database/db.js';

/**
 * Get the target path that the symlink should point to
 * For monorepos, returns the project subfolder within the worktree.
 */
function getTargetPath(
  repoPath: string,
  taskId: number | null | undefined,
  subprojectPath: string | null | undefined,
): string {
  if (taskId === null || taskId === undefined) {
    // For monorepos, return git root + subproject path
    // For simple repos, just return the repo path
    if (subprojectPath) {
      return path.join(repoPath, subprojectPath);
    }
    return repoPath;
  }
  return getWorktreeProjectPath(repoPath, taskId, subprojectPath ?? null);
}

// Best-effort: stop any process currently bound to the service's PORT.
// Replaces the old `lsof -ti:$port | xargs kill -9 2>/dev/null || true` shell
// pipeline. Pulls pids via `lsof`, then signals each one from Node — no shell
// involved, so the port number cannot smuggle metacharacters into the
// command.
async function killProcessesOnPort(port: number): Promise<void> {
  try {
    const { stdout } = await runCommand('lsof', ['-ti', `:${port}`], { timeout: 5000 });
    const pids = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map((line) => Number.parseInt(line, 10));
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // pid may have already exited; ignore.
      }
    }
  } catch {
    // lsof exits non-zero when nothing's listening — that's fine.
  }
}

export interface SwitchWorktreeResult {
  success: boolean;
  error?: string;
  activeTaskId?: number | null;
  warning?: string;
}

/**
 * Switch the serving symlink to a specific worktree (or main repo)
 */
export async function switchWorktree(
  projectId: number,
  taskId: number | null | undefined,
  userId: number,
): Promise<SwitchWorktreeResult> {
  try {
    // Get project with user ownership verification
    const project = getProject(projectId, userId);
    if (!project) {
      return { success: false, error: 'Project not found' };
    }

    // Validate serve_symlink_path and systemd_service_name are configured
    if (!project.serve_symlink_path) {
      return {
        success: false,
        error: 'Symlink path not configured for this project. Configure it in project settings.',
      };
    }
    if (!project.systemd_service_name) {
      return {
        success: false,
        error: 'Systemd service name not configured for this project. Configure it in project settings.',
      };
    }

    // Defense-in-depth: validate stored values even though the write path
    // already enforces these. Historic rows may pre-date the write-side
    // check.
    let symlinkPath: string;
    let serviceName: string;
    try {
      symlinkPath = assertAbsolutePath(project.serve_symlink_path, 'symlink path');
      serviceName = assertValidServiceName(project.systemd_service_name);
    } catch (e) {
      if (e instanceof ValidationError) {
        return { success: false, error: e.message };
      }
      throw e;
    }

    // Validate task ownership if switching to a worktree
    if (taskId !== null && taskId !== undefined) {
      const task = tasksDb.getWithProject(taskId);
      if (!task) {
        return { success: false, error: 'Task not found' };
      }
      if (task.project_id !== projectId) {
        return { success: false, error: 'Task does not belong to this project' };
      }
      // Verify worktree exists
      const exists = await worktreeExists(project.repo_folder_path, taskId);
      if (!exists) {
        return {
          success: false,
          error:
            'Worktree does not exist for this task. The task may not have been created with worktree support.',
        };
      }
    }

    const targetPath = getTargetPath(project.repo_folder_path, taskId, project.subproject_path);

    // Verify target path exists
    try {
      await fs.promises.access(targetPath);
    } catch {
      return { success: false, error: `Target path does not exist: ${targetPath}` };
    }

    // For worktree switches, verify any dependency folder that exists in the main repo
    // has finished copying into the worktree.
    if (taskId !== null && taskId !== undefined) {
      const dependencyDirs = ['node_modules', '.venv'];
      const mainProjectPath = getTargetPath(project.repo_folder_path, null, project.subproject_path);
      const requiredDirs: string[] = [];
      for (const dir of dependencyDirs) {
        const existsInMain = await fs.promises
          .access(path.join(mainProjectPath, dir))
          .then(() => true)
          .catch(() => false);
        if (existsInMain) requiredDirs.push(dir);
      }
      for (const dir of requiredDirs) {
        const existsInWorktree = await fs.promises
          .access(path.join(targetPath, dir))
          .then(() => true)
          .catch(() => false);
        if (!existsInWorktree) {
          return {
            success: false,
            error: `Dependencies are not ready yet (${dir} still being copied). Please try again shortly.`,
          };
        }
      }
    }

    // Ensure tmp/pids exists in the target path (Rails/Puma needs it for server.pid)
    try {
      await fs.promises.mkdir(path.join(targetPath, 'tmp', 'pids'), { recursive: true });
    } catch {
      // Non-fatal: directory may already exist or path may not need it
    }

    // Update symlink atomically using `ln -sfn`. execFile means targetPath
    // and symlinkPath are argv elements; shell metacharacters are inert.
    try {
      await runCommand('ln', ['-sfn', targetPath, symlinkPath]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to update symlink: ${message}` };
    }

    // Restart the systemd user service
    try {
      await runCommand('systemctl', ['--user', 'stop', serviceName], { timeout: 10000 }).catch(
        () => {},
      );

      try {
        const { stdout: envOutput } = await runCommand(
          'systemctl',
          ['--user', 'show', serviceName, '-p', 'Environment', '--no-pager'],
        );
        const portMatch = envOutput.match(/PORT=(\d+)/);
        if (portMatch) {
          let port: number | null = null;
          try {
            port = assertValidPort(portMatch[1] as string);
          } catch {
            // Ignore malformed PORT values — proceed to start without freeing.
          }
          if (port !== null) {
            await killProcessesOnPort(port);
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      } catch {
        // Non-fatal: if we can't extract the port, proceed with start anyway
      }

      await runCommand('systemctl', ['--user', 'start', serviceName], { timeout: 30000 });
    } catch (restartError) {
      const message = restartError instanceof Error ? restartError.message : String(restartError);
      console.error(`Warning: Service restart failed for ${serviceName}:`, message);
      projectsDb.updateActiveWorktree(projectId, userId, taskId ?? null);
      return {
        success: true,
        activeTaskId: taskId ?? null,
        warning: `Symlink updated but service restart failed: ${message}. You may need to restart the service manually.`,
      };
    }

    projectsDb.updateActiveWorktree(projectId, userId, taskId ?? null);

    return { success: true, activeTaskId: taskId ?? null };
  } catch (error) {
    console.error('Error switching worktree:', error);
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface ActiveWorktreeResult {
  success: boolean;
  activeTaskId?: number | null;
  serveSymlinkPath?: string | null;
  systemdServiceName?: string | null;
  appUrl?: string | null;
  isConfigured?: boolean;
  error?: string;
}

/**
 * Get the currently active worktree for a project
 */
export async function getActiveWorktree(
  projectId: number,
  userId: number,
): Promise<ActiveWorktreeResult> {
  try {
    const project = getProject(projectId, userId);
    if (!project) {
      return { success: false, error: 'Project not found' };
    }

    const isConfigured = !!(project.serve_symlink_path && project.systemd_service_name);

    return {
      success: true,
      activeTaskId: project.active_worktree_task_id,
      serveSymlinkPath: project.serve_symlink_path,
      systemdServiceName: project.systemd_service_name,
      appUrl: project.app_url,
      isConfigured,
    };
  } catch (error) {
    console.error('Error getting active worktree:', error);
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface VerifySymlinkResult {
  success: boolean;
  matches?: boolean;
  expectedTarget?: string;
  actualTarget?: string | null;
  symlinkExists?: boolean;
  error?: string;
}

/**
 * Verify the symlink matches the expected configuration
 */
export async function verifySymlink(
  projectId: number,
  userId: number,
): Promise<VerifySymlinkResult> {
  try {
    const project = getProject(projectId, userId);
    if (!project) {
      return { success: false, error: 'Project not found' };
    }

    if (!project.serve_symlink_path) {
      return { success: false, error: 'Symlink path not configured' };
    }

    const expectedTarget = getTargetPath(
      project.repo_folder_path,
      project.active_worktree_task_id,
      project.subproject_path,
    );

    try {
      const actualTarget = await fs.promises.readlink(project.serve_symlink_path);
      // Resolve both paths for accurate comparison
      const resolvedExpected = await fs.promises
        .realpath(expectedTarget)
        .catch(() => expectedTarget);
      const resolvedActual = await fs.promises.realpath(actualTarget).catch(() => actualTarget);
      const matches = resolvedExpected === resolvedActual;

      return {
        success: true,
        matches,
        expectedTarget,
        actualTarget,
        symlinkExists: true,
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          success: true,
          matches: false,
          expectedTarget,
          actualTarget: null,
          symlinkExists: false,
          error: 'Symlink does not exist',
        };
      }
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: `Failed to read symlink: ${message}` };
    }
  } catch (error) {
    console.error('Error verifying symlink:', error);
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface UpdateWebServerConfigResult {
  success: boolean;
  project?: ProjectRow | null | undefined;
  error?: string | undefined;
}

/**
 * Update web server configuration for a project
 */
export function updateWebServerConfig(
  projectId: number,
  userId: number,
  config: WebServerConfig,
): UpdateWebServerConfigResult {
  try {
    const project = getProject(projectId, userId);
    if (!project) {
      return { success: false, error: 'Project not found' };
    }

    // Validate service name (alphanumeric, hyphens, underscores, @ for templates).
    // Delegated to the shared validator so the rule lives in one place.
    if (config.systemdServiceName) {
      try {
        assertValidServiceName(config.systemdServiceName);
      } catch (e) {
        if (e instanceof ValidationError) {
          return {
            success: false,
            error:
              'Invalid service name. Use only alphanumeric characters, hyphens, underscores, and @ symbol.',
          };
        }
        throw e;
      }
    }

    // Validate symlink path (must be absolute)
    if (config.serveSymlinkPath) {
      try {
        assertAbsolutePath(config.serveSymlinkPath, 'symlink path');
      } catch (e) {
        if (e instanceof ValidationError) {
          return { success: false, error: 'Symlink path must be an absolute path (starting with /).' };
        }
        throw e;
      }
    }

    // Validate app URL (must be an http/https URL when provided).
    if (config.appUrl) {
      try {
        assertHttpUrl(config.appUrl);
      } catch (e) {
        if (e instanceof ValidationError) {
          return {
            success: false,
            error: 'App URL must be a valid http(s) URL (e.g. https://app.example.com).',
          };
        }
        throw e;
      }
    }

    const updatedProject = projectsDb.updateWebServerConfig(projectId, userId, config);
    return { success: true, project: updatedProject };
  } catch (error) {
    console.error('Error updating web server config:', error);
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}
