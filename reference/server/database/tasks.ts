// TASK DOMAIN query helpers: the `tasks` table and the task-only
// `task_agent_runs`. Epic membership and epic runs live in
// `server/database/epics.ts` — nothing here knows epics exist
// (architecture-v2 step 5).

import { db, lastInsertId } from './connection.js';
import type {
  AgentRunDriver,
  AgentRunStatus,
  AgentType,
  Provider,
  TaskAgentRunRow,
  TaskLandingRow,
  TaskRow,
  TaskStatus,
  TaskWorktreeState,
} from '../../shared/types/db.js';

export interface CreatedTask {
  id: number;
  projectId: number;
  user_id: number | null;
  title: string | null;
  status: 'pending';
  yolo_mode: 0 | 1;
  base_branch: string | null;
  worktree_state: TaskWorktreeState;
}

// Result of getAll (joins project name + repo path).
export type TaskWithProjectSummary = TaskRow & {
  project_name: string;
  repo_folder_path: string;
};

// Result of getWithProject (joins project owner + name + paths).
export type TaskWithProject = TaskRow & {
  project_user_id: number;
  project_name: string;
  repo_folder_path: string;
  subproject_path: string | null;
  // The project's non-technical guardrail list (see ProjectRow).
  sensitive_areas: string | null;
};

export interface TaskUpdates {
  title?: string | null;
  status?: TaskStatus;
  workflow_complete?: 0 | 1 | boolean;
  planification_complete?: 0 | 1 | boolean;
  refinement_complete?: 0 | 1 | boolean;
  completed_at?: string | null;
  yolo_mode?: 0 | 1 | boolean;
}

export interface TaskLandingIdentity {
  prUrl: string;
  headBranch: string;
  baseBranch: string;
}

export interface FinalizeTaskLandingResult {
  task: TaskRow;
  previousStatus: TaskStatus;
  transitioned: boolean;
}

/**
 * Thrown when something tries to start a conversation on a task whose worktree
 * is not set up: still 'provisioning', or 'failed'. Nothing may run in a
 * worktree that is missing or half-built.
 */
export class TaskWorktreeNotReadyError extends Error {
  constructor(
    readonly taskId: number,
    readonly state: Exclude<TaskWorktreeState, 'ready'>,
  ) {
    super(
      state === 'provisioning'
        ? `Task ${taskId}'s worktree is still being set up. Wait until it is ready.`
        : `Task ${taskId}'s worktree setup failed. Retry the setup or delete the task.`,
    );
    this.name = 'TaskWorktreeNotReadyError';
  }
}

const tasksDb = {
  // `baseBranch` is what this task forks from and merges into; null = the
  // repo's default branch, resolved at use. Epic membership is NOT set here —
  // the epic layer records it in its own `epic_tickets` table.
  create: (
    projectId: number,
    title: string | null = null,
    yoloMode: boolean = false,
    userId: number | null = null,
    baseBranch: string | null = null,
    worktreeState: TaskWorktreeState = 'ready',
  ): CreatedTask => {
    const stmt = db.prepare(
      `INSERT INTO tasks (project_id, user_id, title, status, yolo_mode, base_branch, worktree_state)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const yoloFlag: 0 | 1 = yoloMode ? 1 : 0;
    const result = stmt.run(projectId, userId, title, 'pending', yoloFlag, baseBranch, worktreeState);
    return {
      id: lastInsertId(result.lastInsertRowid),
      projectId,
      user_id: userId,
      title,
      status: 'pending',
      yolo_mode: yoloFlag,
      base_branch: baseBranch,
      worktree_state: worktreeState,
    };
  },

  /**
   * Throw {@link TaskWorktreeNotReadyError} unless the task's worktree is
   * ready. A missing task passes: callers report "not found" their own way.
   */
  assertWorktreeReady: (id: number): void => {
    const row = db.prepare('SELECT worktree_state FROM tasks WHERE id = ?').get(id) as
      | { worktree_state: TaskWorktreeState }
      | undefined;
    if (row && row.worktree_state !== 'ready') {
      throw new TaskWorktreeNotReadyError(id, row.worktree_state);
    }
  },

  /**
   * Record where the task's worktree setup stands. `error` is stored only for
   * 'failed' and cleared otherwise.
   */
  setWorktreeState: (
    id: number,
    state: TaskWorktreeState,
    error: string | null = null,
  ): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET worktree_state = ?, worktree_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(state, state === 'failed' ? error : null, id);
    return tasksDb.getById(id);
  },

  /**
   * Fail every setup left 'provisioning' — crash recovery, for the server that
   * owns the database. The process that was running those setups is gone, so
   * none of them can finish. Returns the ids it failed.
   */
  failInterruptedWorktreeSetups: (error: string): number[] => {
    const rows = db
      .prepare(
        `UPDATE tasks
         SET worktree_state = 'failed', worktree_error = ?, updated_at = CURRENT_TIMESTAMP
         WHERE worktree_state = 'provisioning'
         RETURNING id`
      )
      .all(error) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  },

  getAll: (userId: number, status: TaskStatus | null = null): TaskWithProjectSummary[] => {
    let query = `
      SELECT t.*, p.name as project_name, p.repo_folder_path
      FROM tasks t
      JOIN projects p ON t.project_id = p.id
      JOIN project_members pm ON p.id = pm.project_id
      WHERE pm.user_id = ?
    `;
    const params: unknown[] = [userId];

    if (status) {
      query += ' AND t.status = ?';
      params.push(status);
    }

    query += ' ORDER BY t.updated_at DESC LIMIT 50';

    return db.prepare(query).all(...params) as TaskWithProjectSummary[];
  },

  getByProject: (projectId: number): TaskRow[] => {
    return db
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as TaskRow[];
  },

  getById: (id: number): TaskRow | undefined => {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  },

  getWithProject: (taskId: number): TaskWithProject | undefined => {
    return db
      .prepare(
        `SELECT t.*,
                p.user_id AS project_user_id,
                p.name AS project_name,
                p.repo_folder_path,
                p.subproject_path,
                p.sensitive_areas
         FROM tasks t
         JOIN projects p ON t.project_id = p.id
         WHERE t.id = ?`
      )
      .get(taskId) as TaskWithProject | undefined;
  },

  update: (id: number, updates: TaskUpdates): TaskRow | null | undefined => {
    const allowedFields: ReadonlyArray<keyof TaskUpdates> = [
      'title',
      'status',
      'workflow_complete',
      'planification_complete',
      'refinement_complete',
      'completed_at',
      'yolo_mode',
    ];
    const setClause: string[] = [];
    const values: unknown[] = [];

    const currentTask = tasksDb.getById(id);

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClause.push(`${field} = ?`);
        values.push(updates[field]);
      }
    }

    if (updates.status !== undefined && currentTask) {
      if (updates.status === 'completed' && currentTask.status !== 'completed') {
        if (updates.completed_at === undefined) {
          setClause.push('completed_at = CURRENT_TIMESTAMP');
        }
      } else if (updates.status !== 'completed' && currentTask.status === 'completed') {
        setClause.push('completed_at = NULL');
      }
    }

    if (setClause.length === 0) {
      return tasksDb.getById(id);
    }

    setClause.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`UPDATE tasks SET ${setClause.join(', ')} WHERE id = ?`);
    const result = stmt.run(...values);

    if (result.changes === 0) {
      return null;
    }

    return tasksDb.getById(id);
  },

  updateStatus: (id: number, status: TaskStatus): TaskRow | null | undefined => {
    const validStatuses: TaskStatus[] = ['pending', 'in_progress', 'in_review', 'completed'];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
    }
    return tasksDb.update(id, { status });
  },

  /**
   * Write the remote merge intent before calling GitHub. Repeating a request
   * may refresh PR identity while it is pending, but can never rewrite or
   * downgrade an observed merge.
   */
  requestLanding: (taskId: number, identity: TaskLandingIdentity): TaskLandingRow => {
    db.prepare(
      `INSERT INTO task_landings (
         task_id, pr_url, head_branch, base_branch, state, cleanup_state,
         merge_requested_at, updated_at
       ) VALUES (?, ?, ?, ?, 'merge_requested', 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(task_id) DO UPDATE SET
         pr_url = CASE
           WHEN task_landings.state = 'merged' THEN task_landings.pr_url
           ELSE excluded.pr_url
         END,
         head_branch = CASE
           WHEN task_landings.state = 'merged' THEN task_landings.head_branch
           ELSE excluded.head_branch
         END,
         base_branch = CASE
           WHEN task_landings.state = 'merged' THEN task_landings.base_branch
           ELSE excluded.base_branch
         END,
         state = CASE
           WHEN task_landings.state = 'merged' THEN task_landings.state
           ELSE 'merge_requested'
         END,
         merge_requested_at = CASE
           WHEN task_landings.state = 'merged' THEN task_landings.merge_requested_at
           ELSE CURRENT_TIMESTAMP
         END,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(taskId, identity.prUrl, identity.headBranch, identity.baseBranch);
    return tasksDb.getLanding(taskId)!;
  },

  getLanding: (taskId: number): TaskLandingRow | undefined => {
    return db
      .prepare('SELECT * FROM task_landings WHERE task_id = ?')
      .get(taskId) as TaskLandingRow | undefined;
  },

  listLandingsToReconcile: (): TaskLandingRow[] => {
    return db
      .prepare(
        `SELECT * FROM task_landings
         WHERE state = 'merge_requested'
            OR (cleanup_retryable = 1 AND cleanup_state != 'completed')
         ORDER BY merge_requested_at, task_id`,
      )
      .all() as TaskLandingRow[];
  },

  /**
   * Record GitHub's merge and the product-facing task completion atomically.
   * External notifications/events happen after this transaction and may be
   * replayed; the authoritative state itself cannot be half-written.
   */
  finalizeLanding: (
    taskId: number,
    mergeCommitSha: string | null,
    mergedAt: string | null,
  ): FinalizeTaskLandingResult | null => {
    return db.transaction(() => {
      const task = tasksDb.getById(taskId);
      if (!task) return null;
      const previousStatus = task.status;

      const landingUpdate = db.prepare(
        `UPDATE task_landings
         SET state = 'merged',
             merge_commit_sha = COALESCE(?, merge_commit_sha),
             merged_at = COALESCE(?, merged_at, CURRENT_TIMESTAMP),
             cleanup_state = CASE
               WHEN cleanup_state = 'completed' THEN 'completed'
               ELSE 'pending'
             END,
             cleanup_error = CASE
               WHEN cleanup_state = 'completed' THEN cleanup_error
               ELSE NULL
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE task_id = ?`,
      ).run(mergeCommitSha, mergedAt, taskId);
      if (landingUpdate.changes !== 1) {
        throw new Error(`Task ${taskId} has no durable landing to finalize`);
      }

      db.prepare(
        `UPDATE tasks
         SET status = 'completed',
             pr_agent_complete = 1,
             completed_at = CASE
               WHEN status = 'completed' THEN completed_at
               ELSE CURRENT_TIMESTAMP
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      ).run(taskId);

      return {
        task: tasksDb.getById(taskId)!,
        previousStatus,
        transitioned: previousStatus !== 'completed',
      };
    })();
  },

  markLandingCleanup: (
    taskId: number,
    success: boolean,
    error?: string,
  ): TaskLandingRow | undefined => {
    db.prepare(
      `UPDATE task_landings
       SET cleanup_state = ?, cleanup_error = ?, cleanup_updated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE task_id = ?`,
    ).run(success ? 'completed' : 'failed', success ? null : (error ?? 'unknown error'), taskId);
    return tasksDb.getLanding(taskId);
  },

  preserveLandingWorktree: (taskId: number, reason: string): TaskLandingRow | undefined => {
    db.prepare(
      `UPDATE task_landings
       SET cleanup_state = 'failed', cleanup_retryable = 0, cleanup_error = ?,
           cleanup_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE task_id = ?`,
    ).run(reason, taskId);
    return tasksDb.getLanding(taskId);
  },

  delete: (id: number): boolean => {
    const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return result.changes > 0;
  },

  getOldCompletedTasks: (projectId: number, keepCount: number = 20): number[] => {
    const rows = db
      .prepare(
        `SELECT id FROM tasks
         WHERE project_id = ? AND status = 'completed'
         ORDER BY completed_at DESC
         LIMIT -1 OFFSET ?`
      )
      .all(projectId, keepCount) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  },

  /**
   * Block the workflow, recording WHY. The reason is what the epic
   * orchestrator is woken with, so a block reports rather than merely stops;
   * `null` overwrites nothing — a re-block with no reason keeps the first one.
   */
  blockWorkflow: (id: number, reason?: string | null): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET workflow_blocked = 1,
           workflow_blocked_reason = COALESCE(?, workflow_blocked_reason),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(reason?.trim() || null, id);
    return tasksDb.getById(id);
  },

  unblockWorkflow: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET workflow_blocked = 0, workflow_blocked_reason = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },

  incrementRunCount: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET workflow_run_count = workflow_run_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },

  resetRunCount: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET workflow_run_count = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },

  markPrAgentComplete: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET pr_agent_complete = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },

  resetPrAgentComplete: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET pr_agent_complete = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },

  markRefinementComplete: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET refinement_complete = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },

  resetRefinementComplete: (id: number): TaskRow | undefined => {
    db.prepare(
      `UPDATE tasks
       SET refinement_complete = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(id);
    return tasksDb.getById(id);
  },
};

// ---------------------------------------------------------------------------
// taskAgentRunsDb — the task-only agent runs table
// ---------------------------------------------------------------------------

const taskAgentRunsDb = {
  create: (
    taskId: number,
    agentType: AgentType,
    conversationId: number | null = null,
    provider: Provider = 'anthropic',
    driver: AgentRunDriver = 'human',
  ): TaskAgentRunRow => {
    const stmt = db.prepare(
      `INSERT INTO task_agent_runs (task_id, agent_type, status, conversation_id, provider, driver)
       VALUES (?, ?, 'running', ?, ?, ?)`
    );
    const result = stmt.run(taskId, agentType, conversationId, provider, driver);
    return {
      id: lastInsertId(result.lastInsertRowid),
      task_id: taskId,
      agent_type: agentType,
      status: 'running',
      conversation_id: conversationId,
      provider,
      driver,
      created_at: new Date().toISOString(),
      completed_at: null,
    };
  },

  getByTask: (taskId: number): TaskAgentRunRow[] => {
    return db
      .prepare(
        `SELECT * FROM task_agent_runs
         WHERE task_id = ?
         ORDER BY created_at DESC`
      )
      .all(taskId) as TaskAgentRunRow[];
  },

  getById: (id: number): TaskAgentRunRow | undefined => {
    return db
      .prepare('SELECT * FROM task_agent_runs WHERE id = ?')
      .get(id) as TaskAgentRunRow | undefined;
  },

  getByTaskAndType: (taskId: number, agentType: AgentType): TaskAgentRunRow | undefined => {
    return db
      .prepare(
        `SELECT * FROM task_agent_runs
         WHERE task_id = ? AND agent_type = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(taskId, agentType) as TaskAgentRunRow | undefined;
  },

  getByStatus: (status: AgentRunStatus): TaskAgentRunRow[] => {
    return db
      .prepare(
        `SELECT * FROM task_agent_runs
         WHERE status = ?
         ORDER BY created_at DESC`
      )
      .all(status) as TaskAgentRunRow[];
  },

  updateStatus: (id: number, status: AgentRunStatus): TaskAgentRunRow | undefined => {
    const validStatuses: AgentRunStatus[] = [
      'pending',
      'running',
      'completed',
      'failed',
      'blocked',
    ];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
    }

    const stmt =
      status === 'completed' || status === 'blocked'
        ? db.prepare(
            `UPDATE task_agent_runs
             SET status = ?, completed_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
        : db.prepare(
            `UPDATE task_agent_runs
             SET status = ?, completed_at = NULL
             WHERE id = ?`
          );
    stmt.run(status, id);
    return taskAgentRunsDb.getById(id);
  },

  linkConversation: (id: number, conversationId: number | null): TaskAgentRunRow | undefined => {
    db.prepare(
      `UPDATE task_agent_runs
       SET conversation_id = ?
       WHERE id = ?`
    ).run(conversationId, id);
    return taskAgentRunsDb.getById(id);
  },

  // Look up the agent run that owns a given conversation. Used to keep
  // follow-up messages on the same model+effort the agent was started with.
  getByConversationId: (conversationId: number): TaskAgentRunRow | undefined => {
    return db
      .prepare(
        `SELECT * FROM task_agent_runs
         WHERE conversation_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(conversationId) as TaskAgentRunRow | undefined;
  },

  delete: (id: number): boolean => {
    const result = db.prepare('DELETE FROM task_agent_runs WHERE id = ?').run(id);
    return result.changes > 0;
  },
};

export { tasksDb, taskAgentRunsDb };
