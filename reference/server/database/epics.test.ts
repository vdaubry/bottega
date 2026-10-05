import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db-helper.js';

describe('Epics schema', () => {
  let testDb: TestDatabase;
  let projectId: number;
  let userId: number;

  beforeEach(() => {
    testDb = createTestDatabase();
    userId = testDb.userDb.createUser('testuser', 'hash').id;
    projectId = testDb.projectsDb.create(userId, 'Proj', '/tmp/repo').id;
  });

  afterEach(() => {
    testDb.close();
  });

  describe('epics', () => {
    it('creates an epic with the pipeline flags cleared', () => {
      const epic = testDb.epicsDb.create({ projectId, userId, name: 'Company Quests' });

      expect(epic.id).toBeGreaterThan(0);
      expect(epic.status).toBe('active');
      expect(epic.architecture_complete).toBe(0);
      expect(epic.specs_complete).toBe(0);
      expect(epic.stories_complete).toBe(0);
      expect(epic.feature_branch).toBeNull();
    });

    it('flips one stage flag at a time', () => {
      const epic = testDb.epicsDb.create({ projectId, userId, name: 'E' });

      const updated = testDb.epicsDb.setStageComplete(epic.id, 'architecture')!;

      expect(updated.architecture_complete).toBe(1);
      expect(updated.specs_complete).toBe(0);
      expect(updated.stories_complete).toBe(0);
    });

    it('rejects an unknown status (CHECK constraint)', () => {
      const epic = testDb.epicsDb.create({ projectId, userId, name: 'E' });

      expect(() =>
        testDb.db.prepare('UPDATE epics SET status = ? WHERE id = ?').run('blocked', epic.id),
      ).toThrow();
    });

    it('cascades its LINKS (ownership, membership) but never a ticket or a base conversation row', () => {
      // Explicit-delete semantics (architecture-v2 step 5): the FKs point
      // from the domain link tables at the infrastructure, so deleting the
      // epic removes only its membership and ownership rows — the epic
      // delete SERVICE removes the base conversation rows itself, and a
      // ticket (a plain task) outlives the container entirely.
      const epic = testDb.epicsDb.create({ projectId, userId, name: 'E' });
      const conversation = testDb.conversationsDb.createForEpic(epic.id);
      const task = testDb.tasksDb.create(projectId, 'Ticket', false, userId);
      testDb.db
        .prepare('INSERT INTO epic_tickets (epic_id, task_id, position) VALUES (?, ?, 1)')
        .run(epic.id, task.id);

      testDb.epicsDb.delete(epic.id);

      expect(testDb.conversationsDb.getByEpic(epic.id)).toHaveLength(0);
      const orphan = testDb.conversationsDb.getById(conversation.id)!;
      expect(orphan.epic_id).toBeNull();
      expect(orphan.owner_kind).toBe('epic');
      expect(
        testDb.db.prepare('SELECT * FROM epic_tickets WHERE epic_id = ?').all(epic.id),
      ).toHaveLength(0);
      expect(testDb.tasksDb.getById(task.id)).toBeDefined();
    });
  });

  describe('conversations', () => {
    it('accepts a task-scoped and an epic-scoped conversation', () => {
      const task = testDb.tasksDb.create(projectId, 'T', false, userId);
      const epic = testDb.epicsDb.create({ projectId, userId, name: 'E' });

      const taskConversation = testDb.conversationsDb.create(task.id);
      const epicConversation = testDb.conversationsDb.createForEpic(epic.id);

      expect(testDb.conversationsDb.getById(taskConversation.id)!.epic_id).toBeNull();
      expect(testDb.conversationsDb.getById(epicConversation.id)!.task_id).toBeNull();
      expect(testDb.conversationsDb.getByEpic(epic.id)).toHaveLength(1);
      expect(testDb.conversationsDb.getByTask(task.id)).toHaveLength(1);
    });

    it('rejects a conversation without an owner kind', () => {
      expect(() => testDb.db.prepare('INSERT INTO conversations DEFAULT VALUES').run()).toThrow();
    });

    it('a conversation can be linked to its owner exactly once (link-table PK)', () => {
      const task = testDb.tasksDb.create(projectId, 'T', false, userId);
      const conversation = testDb.conversationsDb.create(task.id);

      expect(() =>
        testDb.db
          .prepare('INSERT INTO task_conversations (conversation_id, task_id) VALUES (?, ?)')
          .run(conversation.id, task.id),
      ).toThrow();
    });
  });

  describe('the split run tables', () => {
    it('keeps task runs and epic runs in separate tables with separate sequences', () => {
      const task = testDb.tasksDb.create(projectId, 'T', false, userId);
      const epic = testDb.epicsDb.create({ projectId, userId, name: 'E' });
      const conversation = testDb.conversationsDb.createForEpic(epic.id);

      testDb.agentRunsDb.create(task.id, 'planification');
      const epicRun = testDb.agentRunsDb.createForEpic(
        epic.id,
        'epic-architecture',
        conversation.id,
      );

      expect(testDb.agentRunsDb.getByEpic(epic.id).map((r) => r.id)).toEqual([epicRun.id]);
      expect(testDb.agentRunsDb.getByTask(task.id)).toHaveLength(1);
    });

    it('narrows the CHECKs per table: no epic type in task runs, no task type in epic runs', () => {
      const task = testDb.tasksDb.create(projectId, 'T', false, userId);
      const epic = testDb.epicsDb.create({ projectId, userId, name: 'E' });

      expect(() =>
        testDb.db
          .prepare(`INSERT INTO task_agent_runs (task_id, agent_type) VALUES (?, 'epic-architecture')`)
          .run(task.id),
      ).toThrow(/CHECK/);
      expect(() =>
        testDb.db
          .prepare(`INSERT INTO epic_agent_runs (epic_id, agent_type) VALUES (?, 'planification')`)
          .run(epic.id),
      ).toThrow(/CHECK/);
    });

    it('accepts every epic agent type (the CHECK is widened for later phases)', () => {
      const epic = testDb.epicsDb.create({ projectId, userId, name: 'E' });

      for (const agentType of [
        'epic-architecture',
        'epic-specification',
        'epic-stories',
        'epic-orchestrator',
      ] as const) {
        expect(() => testDb.agentRunsDb.createForEpic(epic.id, agentType)).not.toThrow();
      }
    });

    it('rejects a task run without a task (task_id is NOT NULL now)', () => {
      expect(() =>
        testDb.db
          .prepare("INSERT INTO task_agent_runs (agent_type) VALUES ('planification')")
          .run(),
      ).toThrow();
    });
  });

  describe('epic_tickets (membership + position)', () => {
    it('returns tickets in position order, and keeps one epic per task', () => {
      const epic = testDb.epicsDb.create({ projectId, userId, name: 'E' });
      const other = testDb.epicsDb.create({ projectId, userId, name: 'F' });
      const second = testDb.tasksDb.create(projectId, 'Second', false, userId);
      const first = testDb.tasksDb.create(projectId, 'First', false, userId);
      const attach = testDb.db.prepare(
        'INSERT INTO epic_tickets (epic_id, task_id, position) VALUES (?, ?, ?)',
      );
      attach.run(epic.id, second.id, 2);
      attach.run(epic.id, first.id, 1);

      const ordered = testDb.db
        .prepare(
          `SELECT t.id FROM epic_tickets et JOIN tasks t ON t.id = et.task_id
           WHERE et.epic_id = ? ORDER BY et.position ASC, t.id ASC`,
        )
        .all(epic.id) as Array<{ id: number }>;
      expect(ordered.map((t) => t.id)).toEqual([first.id, second.id]);

      // UNIQUE(task_id): a task belongs to at most one epic.
      expect(() => attach.run(other.id, first.id, 1)).toThrow();
    });
  });
});
