// EPIC DOMAIN query helpers: the `epics` table, the epic-only
// `epic_agent_runs`, and `epic_tickets` (membership + position — epic-layer
// data since architecture-v2 step 5; `moveTicket`'s renumbering is a plain
// update here, never a rewrite of task rows).
//
// Import rule: only `server/services/epics/**` and `server/routes/epics.ts`
// may import this module (enforced by lint).

import { db, lastInsertId } from './connection.js';
import type {
  AgentRunStatus,
  EpicAgentRunRow,
  EpicAgentType,
  EpicRow,
  EpicStatus,
  EpicTicketRow,
  EpicTicketWithTask,
  Provider,
} from '../../shared/types/db.js';

// Result of getWithProject (joins project owner + name + paths), mirroring
// `TaskWithProject` so epic callers resolve a working directory the same way.
export type EpicWithProject = EpicRow & {
  project_user_id: number;
  project_name: string;
  repo_folder_path: string;
  subproject_path: string | null;
};

export interface EpicUpdates {
  name?: string | undefined;
  status?: EpicStatus | undefined;
}

// Stage flags, in pipeline order. The current stage is the first incomplete
// one; each stays independently re-runnable (mirrors the task workflow flags).
export type EpicStageFlag = 'architecture' | 'specs' | 'stories' | 'review' | 'qa';

const EPIC_STAGE_COLUMNS: Record<EpicStageFlag, string> = {
  architecture: 'architecture_complete',
  specs: 'specs_complete',
  stories: 'stories_complete',
  review: 'review_complete',
  qa: 'qa_complete',
};

const epicsDb = {
  create: (args: {
    projectId: number;
    userId: number | null;
    name: string;
    slug: string;
  }): EpicRow => {
    const stmt = db.prepare(
      `INSERT INTO epics (project_id, user_id, name, slug)
       VALUES (?, ?, ?, ?)`
    );
    const result = stmt.run(args.projectId, args.userId, args.name, args.slug);
    return epicsDb.getById(lastInsertId(result.lastInsertRowid))!;
  },

  getById: (id: number): EpicRow | undefined => {
    return db.prepare('SELECT * FROM epics WHERE id = ?').get(id) as EpicRow | undefined;
  },

  getWithProject: (id: number): EpicWithProject | undefined => {
    return db
      .prepare(
        `SELECT e.*,
                p.user_id AS project_user_id,
                p.name AS project_name,
                p.repo_folder_path,
                p.subproject_path
         FROM epics e
         JOIN projects p ON e.project_id = p.id
         WHERE e.id = ?`
      )
      .get(id) as EpicWithProject | undefined;
  },

  listByProject: (projectId: number): EpicRow[] => {
    return db
      .prepare(
        `SELECT * FROM epics
         WHERE project_id = ?
         ORDER BY created_at DESC, id DESC`
      )
      .all(projectId) as EpicRow[];
  },

  update: (id: number, updates: EpicUpdates): EpicRow | undefined => {
    const setClause: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) {
      setClause.push('name = ?');
      values.push(updates.name);
    }
    if (updates.status !== undefined) {
      setClause.push('status = ?');
      values.push(updates.status);
      // completed_at tracks the container lifecycle, exactly like tasks.
      setClause.push("completed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END");
      values.push(updates.status);
    }
    if (setClause.length === 0) return epicsDb.getById(id);

    setClause.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    db.prepare(`UPDATE epics SET ${setClause.join(', ')} WHERE id = ?`).run(...values);
    return epicsDb.getById(id);
  },

  setFeatureBranch: (id: number, featureBranch: string | null): EpicRow | undefined => {
    db.prepare(
      'UPDATE epics SET feature_branch = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    ).run(featureBranch, id);
    return epicsDb.getById(id);
  },

  // Flip one stage flag. Every stage is flipped by the bottega MCP
  // `mark_stage_complete` tool (the stage's own agent signing off) or by the
  // human backstop button.
  setStageComplete: (
    id: number,
    stage: EpicStageFlag,
    complete: boolean = true,
  ): EpicRow | undefined => {
    const column = EPIC_STAGE_COLUMNS[stage];
    db.prepare(
      `UPDATE epics SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(complete ? 1 : 0, id);
    return epicsDb.getById(id);
  },

  // Enter or leave autonomous implementation. Entering also clears any stale
  // block, so starting orchestration after an escalation is a clean slate.
  setOrchestrationActive: (id: number, active: boolean): EpicRow | undefined => {
    db.prepare(
      `UPDATE epics
       SET orchestration_active = ?,
           orchestration_blocked = 0,
           orchestration_blocked_reason = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(active ? 1 : 0, id);
    return epicsDb.getById(id);
  },

  // Halt (or release) the event bridge. Blocking keeps `orchestration_active`
  // set: the epic is still under orchestration, just waiting on a human.
  setOrchestrationBlocked: (
    id: number,
    blocked: boolean,
    reason: string | null = null,
  ): EpicRow | undefined => {
    db.prepare(
      `UPDATE epics
       SET orchestration_blocked = ?,
           orchestration_blocked_reason = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(blocked ? 1 : 0, blocked ? reason : null, id);
    return epicsDb.getById(id);
  },

  // Every epic the boot reconciliation has to wake. Deliberately unfiltered by
  // project or user: a restart concerns all of them.
  listOrchestrating: (): EpicRow[] => {
    return db
      .prepare(
        `SELECT * FROM epics
         WHERE orchestration_active = 1 AND orchestration_blocked = 0
         ORDER BY id ASC`,
      )
      .all() as EpicRow[];
  },

  delete: (id: number): boolean => {
    const result = db.prepare('DELETE FROM epics WHERE id = ?').run(id);
    return result.changes > 0;
  },
};

// ---------------------------------------------------------------------------
// epicTicketsDb — membership + position (replaces tasks.epic_id/epic_order)
// ---------------------------------------------------------------------------

const epicTicketsDb = {
  /** Record a task as a ticket of an epic, at `position`. */
  attach: (epicId: number, taskId: number, position: number): EpicTicketRow => {
    db.prepare(
      'INSERT INTO epic_tickets (epic_id, task_id, position) VALUES (?, ?, ?)',
    ).run(epicId, taskId, position);
    return { epic_id: epicId, task_id: taskId, position };
  },

  /** The epic a task belongs to, or null. One indexed read. */
  epicOf: (taskId: number): number | null => {
    const row = db
      .prepare('SELECT epic_id FROM epic_tickets WHERE task_id = ?')
      .get(taskId) as Pick<EpicTicketRow, 'epic_id'> | undefined;
    return row?.epic_id ?? null;
  },

  /** One membership row, or undefined. */
  get: (taskId: number): EpicTicketRow | undefined => {
    return db
      .prepare('SELECT * FROM epic_tickets WHERE task_id = ?')
      .get(taskId) as EpicTicketRow | undefined;
  },

  /**
   * Every ticket of one epic, in execution order: the task row plus its
   * position. The epic surfaces (the page, the orchestrator, the sequencer)
   * all read this one list.
   */
  listTickets: (epicId: number): EpicTicketWithTask[] => {
    return db
      .prepare(
        `SELECT t.*, et.position AS position
         FROM epic_tickets et
         JOIN tasks t ON t.id = et.task_id
         WHERE et.epic_id = ?
         ORDER BY et.position ASC, t.id ASC`,
      )
      .all(epicId) as EpicTicketWithTask[];
  },

  setPosition: (taskId: number, position: number): void => {
    db.prepare('UPDATE epic_tickets SET position = ? WHERE task_id = ?').run(position, taskId);
  },
};

// ---------------------------------------------------------------------------
// epicAgentRunsDb — the epic-only agent runs table
// ---------------------------------------------------------------------------

const epicAgentRunsDb = {
  // Same lifecycle as a task run (the completion handler, the orphan sweep
  // and abort are all conversation-keyed), only the owner differs.
  create: (
    epicId: number,
    agentType: EpicAgentType,
    conversationId: number | null = null,
    provider: Provider = 'anthropic',
    ticketTaskId: number | null = null,
  ): EpicAgentRunRow => {
    const stmt = db.prepare(
      `INSERT INTO epic_agent_runs (epic_id, agent_type, status, conversation_id, provider, ticket_task_id)
       VALUES (?, ?, 'running', ?, ?, ?)`
    );
    const result = stmt.run(epicId, agentType, conversationId, provider, ticketTaskId);
    return {
      id: lastInsertId(result.lastInsertRowid),
      epic_id: epicId,
      agent_type: agentType,
      status: 'running',
      conversation_id: conversationId,
      provider,
      ticket_task_id: ticketTaskId,
      created_at: new Date().toISOString(),
      completed_at: null,
    };
  },

  getByEpic: (epicId: number): EpicAgentRunRow[] => {
    return db
      .prepare(
        `SELECT * FROM epic_agent_runs
         WHERE epic_id = ?
         ORDER BY created_at DESC`
      )
      .all(epicId) as EpicAgentRunRow[];
  },

  getByEpicAndType: (epicId: number, agentType: EpicAgentType): EpicAgentRunRow | undefined => {
    return db
      .prepare(
        `SELECT * FROM epic_agent_runs
         WHERE epic_id = ? AND agent_type = ?
         ORDER BY id DESC
         LIMIT 1`
      )
      .get(epicId, agentType) as EpicAgentRunRow | undefined;
  },

  getById: (id: number): EpicAgentRunRow | undefined => {
    return db
      .prepare('SELECT * FROM epic_agent_runs WHERE id = ?')
      .get(id) as EpicAgentRunRow | undefined;
  },

  getByStatus: (status: AgentRunStatus): EpicAgentRunRow[] => {
    return db
      .prepare(
        `SELECT * FROM epic_agent_runs
         WHERE status = ?
         ORDER BY created_at DESC`
      )
      .all(status) as EpicAgentRunRow[];
  },

  updateStatus: (id: number, status: AgentRunStatus): EpicAgentRunRow | undefined => {
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
            `UPDATE epic_agent_runs
             SET status = ?, completed_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
        : db.prepare(
            `UPDATE epic_agent_runs
             SET status = ?, completed_at = NULL
             WHERE id = ?`
          );
    stmt.run(status, id);
    return epicAgentRunsDb.getById(id);
  },

  linkConversation: (id: number, conversationId: number | null): EpicAgentRunRow | undefined => {
    db.prepare(
      `UPDATE epic_agent_runs
       SET conversation_id = ?
       WHERE id = ?`
    ).run(conversationId, id);
    return epicAgentRunsDb.getById(id);
  },

  /**
   * Stamp the ticket a run supervises AFTER the run created it — the QA fix
   * agent's run row exists before its fix ticket does, and this stamp is what
   * routes the ticket's events to that run's conversation.
   */
  setTicketTask: (id: number, ticketTaskId: number | null): EpicAgentRunRow | undefined => {
    db.prepare(
      `UPDATE epic_agent_runs
       SET ticket_task_id = ?
       WHERE id = ?`
    ).run(ticketTaskId, id);
    return epicAgentRunsDb.getById(id);
  },

  /** Distinct epic ids holding at least one run of this type (boot recovery). */
  listEpicIdsWithAgentType: (agentType: EpicAgentType): number[] => {
    return (
      db
        .prepare('SELECT DISTINCT epic_id FROM epic_agent_runs WHERE agent_type = ?')
        .all(agentType) as Array<{ epic_id: number }>
    ).map((row) => row.epic_id);
  },

  getByConversationId: (conversationId: number): EpicAgentRunRow | undefined => {
    return db
      .prepare(
        `SELECT * FROM epic_agent_runs
         WHERE conversation_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(conversationId) as EpicAgentRunRow | undefined;
  },

  /**
   * Persist a user interruption before the provider abort lands. The run row
   * identifies the exact conversation to resume; orchestrated turns also
   * close the event bridge. One transaction keeps those two facts aligned.
   */
  interruptConversation: (
    conversationId: number,
    reason: string,
  ): { run: EpicAgentRunRow; epic: EpicRow | null } | null =>
    db.transaction(() => {
      const linked = epicAgentRunsDb.getByConversationId(conversationId);
      if (!linked) return null;

      const run = epicAgentRunsDb.updateStatus(linked.id, 'blocked')!;
      let epic: EpicRow | null = null;
      if (
        linked.agent_type === 'epic-orchestrator' ||
        linked.agent_type === 'epic-pr-review'
      ) {
        const current = epicsDb.getById(linked.epic_id);
        if (current?.orchestration_active) {
          epic = current.orchestration_blocked
            ? current
            : (epicsDb.setOrchestrationBlocked(linked.epic_id, true, reason) ?? null);
        }
      }
      return { run, epic };
    })(),

  /**
   * Mark a provider turn live. A manually interrupted orchestration is
   * released only when that exact conversation has successfully registered a
   * new active session; escalation blocks (whose run is not `blocked`) remain.
   */
  beginConversationTurn: (
    conversationId: number,
  ): { run: EpicAgentRunRow; epic: EpicRow | null; resumed: boolean } | null =>
    db.transaction(() => {
      const linked = epicAgentRunsDb.getByConversationId(conversationId);
      if (!linked) return null;

      // Final synchronous reviewer check. The pre-provider owner check gives
      // callers a cheap refusal; this transaction closes the race between two
      // different historical reviewer conversations resuming concurrently.
      if (linked.agent_type === 'epic-pr-review') {
        const otherReviewer = epicAgentRunsDb
          .getByEpic(linked.epic_id)
          .find(
            (run) =>
              run.id !== linked.id &&
              run.agent_type === 'epic-pr-review' &&
              (run.status === 'running' || run.status === 'blocked'),
          );
        if (otherReviewer) {
          throw new Error(
            `Epic ${linked.epic_id} already has an active PR reviewer ` +
              `(run ${otherReviewer.id}, status ${otherReviewer.status})`,
          );
        }
      }

      const resumed = linked.status === 'blocked';
      const run =
        linked.status === 'running'
          ? linked
          : epicAgentRunsDb.updateStatus(linked.id, 'running')!;
      let epic: EpicRow | null = null;
      if (
        resumed &&
        (linked.agent_type === 'epic-orchestrator' ||
          linked.agent_type === 'epic-pr-review')
      ) {
        const current = epicsDb.getById(linked.epic_id);
        if (current?.orchestration_active && current.orchestration_blocked) {
          epic = epicsDb.setOrchestrationBlocked(linked.epic_id, false) ?? null;
        }
      }
      return { run, epic, resumed };
    })(),

  delete: (id: number): boolean => {
    const result = db.prepare('DELETE FROM epic_agent_runs WHERE id = ?').run(id);
    return result.changes > 0;
  },
};

export { epicsDb, epicTicketsDb, epicAgentRunsDb };
