import fs from 'fs';
import path from 'path';
import {
  getWorktreeProjectPath,
  worktreeExists,
  worktreeProvisioningMode,
  type WorktreeProvisioning,
} from './worktree.js';
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
 * What the project's serving symlink points at.
 *
 * `main` is the project's own checkout; `task` is a ticket worktree; `epic` is
 * an epic's delivery worktree — the feature branch, i.e. the whole epic so far,
 * which is exactly what you want to click through before merging its final
 * pull request.
 */
export type ServeTarget =
  | { kind: 'main' }
  | { kind: 'task'; taskId: number }
  | { kind: 'epic'; epicId: number };

/**
 * How the epic layer answers "where is epic N's worktree, and may this project
 * serve it". Registered at boot by `initEpics()`, exactly like the conversation
 * runtime's owner adapters: this module is shared infrastructure and may not
 * import the epic layer (architecture-v2 rule 1), but it still needs the epic
 * domain's answer to a question only that domain can answer.
 */
export interface EpicServeResolver {
  /**
   * Validate that the epic belongs to the project, ensure its delivery worktree
   * exists, and return that worktree's root plus a display name. Throws with a
   * user-facing message when the epic is not servable.
   */
  resolveEpicServeTarget(
    epicId: number,
    projectId: number,
  ): Promise<{ worktreePath: string; name: string }>;
  /**
   * Display name of an epic already being served, or null when the row is gone.
   * Read-only and side-effect free — unlike the resolver above it never creates
   * a worktree, because this answers "what is on screen", not "serve this".
   */
  epicName(epicId: number): string | null;
}

let epicServeResolver: EpicServeResolver | null = null;

/** Wire the epic domain in. Idempotent; called from `initEpics()`. */
export function registerEpicServeResolver(resolver: EpicServeResolver): void {
  epicServeResolver = resolver;
}

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

// Repo-relative path to the optional per-project switch hook. When this file
// exists and is executable at the new symlink target, switchWorktree delegates
// to it instead of running its own `systemctl stop/start`. The script owns
// build + restart for whatever stack the project uses (e.g. Django needs
// tailwind+collectstatic+migrate before the unit restart).
const SWITCH_SCRIPT_RELPATH = '.bottega/switch.sh';

// Hard cap on captured stderr surfaced in the API warning. The script can dump
// a lot (uv sync, collectstatic) on failure; we keep the response bounded so
// the UI banner stays usable.
const MAX_SCRIPT_STDERR_BYTES = 4096;

function truncateForWarning(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… (truncated, ${s.length} bytes total)`;
}

// Runs <target>/.bottega/switch.sh, with the new symlink target as cwd and
// BOTTEGA_* env vars set. Returns ok on zero exit, or a pre-formatted warning
// string on any failure (non-zero exit, timeout, signal).
async function runSwitchScript(
  scriptPath: string,
  targetPath: string,
  projectId: number,
  taskId: number | null,
  epicId: number | null,
): Promise<{ ok: true } | { ok: false; warning: string }> {
  try {
    const { stdout, stderr } = await runCommand(scriptPath, [], {
      cwd: targetPath,
      timeout: 30_000,
      env: {
        ...process.env,
        BOTTEGA_TARGET_PATH: targetPath,
        BOTTEGA_PROJECT_ID: String(projectId),
        // Exactly one of these is non-empty for a worktree switch; both are
        // empty for a reset to the main checkout. `BOTTEGA_TASK_ID` keeps its
        // existing meaning, so hooks written before epics could be served
        // continue to work unchanged.
        BOTTEGA_TASK_ID: taskId === null ? '' : String(taskId),
        BOTTEGA_EPIC_ID: epicId === null ? '' : String(epicId),
      },
    });
    if (stdout) console.log(`[switch.sh stdout] ${stdout}`);
    if (stderr) console.log(`[switch.sh stderr] ${stderr}`);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const truncated = truncateForWarning(stderr, MAX_SCRIPT_STDERR_BYTES);
    const warning = truncated
      ? `Symlink updated but switch script failed: ${message}. Script stderr:\n${truncated}`
      : `Symlink updated but switch script failed: ${message}.`;
    return { ok: false, warning };
  }
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
  activeEpicId?: number | null;
  warning?: string;
}

/**
 * Switch the serving symlink to a ticket worktree, an epic's delivery worktree,
 * or back to the main checkout.
 *
 * Everything after "resolve the target path" is identical for all three, which
 * is the whole point: an epic preview is not a second mechanism, it is the same
 * one pointed somewhere else. Only the resolution differs — and the epic branch
 * of it is delegated to the epic layer through `EpicServeResolver`, because
 * this module may not import that domain.
 */
export async function switchServedTarget(
  projectId: number,
  target: ServeTarget,
  userId: number,
): Promise<SwitchWorktreeResult> {
  const taskId = target.kind === 'task' ? target.taskId : null;
  const epicId = target.kind === 'epic' ? target.epicId : null;
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

    // Validate ownership and resolve where the symlink should point.
    let targetPath: string;
    if (target.kind === 'task') {
      const task = tasksDb.getWithProject(target.taskId);
      if (!task) {
        return { success: false, error: 'Task not found' };
      }
      if (task.project_id !== projectId) {
        return { success: false, error: 'Task does not belong to this project' };
      }
      // Verify worktree exists
      const exists = await worktreeExists(project.repo_folder_path, target.taskId);
      if (!exists) {
        return {
          success: false,
          error:
            'Worktree does not exist for this task. The task may not have been created with worktree support.',
        };
      }
      targetPath = getTargetPath(project.repo_folder_path, target.taskId, project.subproject_path);
    } else if (target.kind === 'epic') {
      if (!epicServeResolver) {
        return { success: false, error: 'Epic serving is unavailable on this server' };
      }
      try {
        // Validates the epic against the project AND creates its delivery
        // worktree if this is the first time it is needed.
        const resolved = await epicServeResolver.resolveEpicServeTarget(target.epicId, projectId);
        targetPath = project.subproject_path
          ? path.join(resolved.worktreePath, project.subproject_path)
          : resolved.worktreePath;
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    } else {
      targetPath = getTargetPath(project.repo_folder_path, null, project.subproject_path);
    }

    // Verify target path exists
    try {
      await fs.promises.access(targetPath);
    } catch {
      return { success: false, error: `Target path does not exist: ${targetPath}` };
    }

    // No provisioning and no readiness gate here: the project's own
    // `post-checkout` hook ran synchronously inside `git worktree add`, so a
    // worktree that exists is as runnable as it will ever be. If it cannot
    // boot, that is the project's hook to fix, not Bottega's to paper over
    // (docs/agents/worktree-provisioning.md).

    // Update symlink atomically using `ln -sfn`. execFile means targetPath
    // and symlinkPath are argv elements; shell metacharacters are inert.
    try {
      await runCommand('ln', ['-sfn', targetPath, symlinkPath]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to update symlink: ${message}` };
    }

    // If the new target ships .bottega/switch.sh and it's executable, delegate
    // the entire build+restart sequence to it and skip systemctl entirely. The
    // script lives in the project repo, so it travels with the branch and can
    // express stack-specific steps (tailwind build, collectstatic, migrate,
    // multi-unit `systemctl restart <target>`) without Bottega needing per-
    // project knowledge.
    const scriptPath = path.join(targetPath, SWITCH_SCRIPT_RELPATH);
    let useScript = false;
    try {
      await fs.promises.access(scriptPath, fs.constants.X_OK);
      useScript = true;
    } catch {
      // ENOENT (no script) or EACCES (present but not +x) — fall back silently
      // to the legacy systemctl path below. A user who forgets `chmod +x` will
      // see "no change" rather than a confusing error.
    }

    if (useScript) {
      const scriptResult = await runSwitchScript(scriptPath, targetPath, projectId, taskId, epicId);
      projectsDb.updateActiveWorktree(projectId, userId, taskId, epicId);
      if (!scriptResult.ok) {
        return {
          success: true,
          activeTaskId: taskId,
          activeEpicId: epicId,
          warning: scriptResult.warning,
        };
      }
      return { success: true, activeTaskId: taskId, activeEpicId: epicId };
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
      projectsDb.updateActiveWorktree(projectId, userId, taskId, epicId);
      return {
        success: true,
        activeTaskId: taskId,
        activeEpicId: epicId,
        warning: `Symlink updated but service restart failed: ${message}. You may need to restart the service manually.`,
      };
    }

    projectsDb.updateActiveWorktree(projectId, userId, taskId, epicId);

    return { success: true, activeTaskId: taskId, activeEpicId: epicId };
  } catch (error) {
    console.error('Error switching worktree:', error);
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface ActiveWorktreeResult {
  success: boolean;
  activeTaskId?: number | null;
  activeEpicId?: number | null;
  /**
   * What to call whatever is being served — a ticket title or an epic name —
   * or null for the main checkout. Resolved here rather than in the client so
   * every surface says the same thing without having to hold both lists.
   */
  activeName?: string | null;
  /**
   * Who provisions this project's worktrees: its own `post-checkout` hook, or
   * nobody (`none` — worktrees are bare checkouts). Surfaced because "why is
   * my worktree missing its dependencies" is otherwise invisible.
   */
  worktreeProvisioning?: WorktreeProvisioning;
  serveSymlinkPath?: string | null;
  systemdServiceName?: string | null;
  appUrl?: string | null;
  isConfigured?: boolean;
  error?: string;
}

/**
 * Name of whatever is being served, for the "Serving: …" indicator. Falls back
 * to `#id` when the row exists but has no title, and to null when nothing is
 * being served (the main checkout) or the row has been deleted.
 */
function resolveActiveName(
  taskId: number | null,
  epicId: number | null,
): string | null {
  if (taskId !== null) {
    const task = tasksDb.getById(taskId);
    return task ? task.title || `Task #${taskId}` : `Task #${taskId}`;
  }
  if (epicId !== null) {
    return epicServeResolver?.epicName(epicId) ?? `Epic #${epicId}`;
  }
  return null;
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
      // `?? null` because the column arrived by ALTER: a row read from a
      // pre-migration snapshot has it undefined, and the contract says null.
      activeEpicId: project.active_worktree_epic_id ?? null,
      worktreeProvisioning: await worktreeProvisioningMode(project.repo_folder_path),
      activeName: resolveActiveName(
        project.active_worktree_task_id,
        project.active_worktree_epic_id,
      ),
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
