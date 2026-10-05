import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type {
  AgentType,
  ConversationRow,
  EpicAgentRunRow,
  EpicAgentType,
  EpicRow,
  ProjectMemberRow,
  ProjectRow,
  TaskAgentRunRow,
  TaskArtifactRow,
  TaskArtifactSummaryRow,
  TaskRow,
  TaskStatus,
  UserRow,
} from '../../shared/types/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type DB = Database.Database;

// Mirrors database/conversations.ts: owner ids are derived via the link tables.
const SELECT_CONVERSATION_WITH_OWNER = `
  SELECT c.*, tc.task_id AS task_id, ec.epic_id AS epic_id
  FROM conversations c
  LEFT JOIN task_conversations tc ON tc.conversation_id = c.id
  LEFT JOIN epic_conversations ec ON ec.conversation_id = c.id`;

interface CountRow {
  count: number;
}

export interface CreatedTestUser {
  id: number;
  username: string;
}

export type SafeUserRow = Pick<
  UserRow,
  'id' | 'username' | 'created_at' | 'last_login' | 'is_admin'
>;

export type SafeUserRowWithActive = SafeUserRow & Pick<UserRow, 'is_active'>;

export interface UserUpdatesInput {
  username?: string;
  is_active?: boolean | 0 | 1;
  is_admin?: boolean | 0 | 1;
}

export interface TestUserDb {
  createUser: (username: string, passwordHash: string) => CreatedTestUser;
  getUserById: (userId: number) => SafeUserRow | undefined;
  hasUsers: () => boolean;
  getFirstUser: () => SafeUserRow | undefined;
  getUserByUsername: (username: string) => UserRow | undefined;
  updateLastLogin: (userId: number) => void;
  updateGitConfig: (userId: number, gitName: string | null, gitEmail: string | null) => void;
  getGitConfig: (userId: number) => Pick<UserRow, 'git_name' | 'git_email'> | undefined;
  completeOnboarding: (userId: number) => void;
  hasCompletedOnboarding: (userId: number) => boolean;
  getAllUsers: () => SafeUserRowWithActive[];
  isAdmin: (userId: number) => boolean;
  setAdmin: (userId: number, isAdmin: boolean) => boolean;
  updateUser: (userId: number, updates: UserUpdatesInput) => SafeUserRowWithActive | null | undefined;
  updatePassword: (userId: number, passwordHash: string) => boolean;
  deleteUser: (userId: number) => boolean;
}

export interface ProjectMemberWithUserRow {
  id: number;
  username: string;
  created_at: string;
  is_admin: 0 | 1;
  joined_at: string;
}

export interface ProjectWithJoinedRow extends ProjectRow {
  joined_at: string;
}

export interface TestProjectMembersDb {
  addMember: (projectId: number, userId: number) => boolean;
  removeMember: (projectId: number, userId: number) => boolean;
  isMember: (projectId: number, userId: number) => boolean;
  getProjectMembers: (projectId: number) => ProjectMemberWithUserRow[];
  getUserProjects: (userId: number) => ProjectWithJoinedRow[];
  getMemberCount: (projectId: number) => number;
}

export interface CreatedTestProject {
  id: number;
  userId: number;
  name: string;
  repoFolderPath: string;
}

export interface ProjectUpdatesInput {
  name?: string;
  repo_folder_path?: string;
}

export interface TestProjectsDb {
  create: (userId: number, name: string, repoFolderPath: string) => CreatedTestProject;
  getAll: (userId: number) => ProjectRow[];
  getById: (id: number, userId: number) => ProjectRow | undefined;
  update: (id: number, userId: number, updates: ProjectUpdatesInput) => ProjectRow | undefined | null;
  delete: (id: number, userId: number) => boolean;
}

export interface CreatedTestTask {
  id: number;
  projectId: number;
  user_id: number | null;
  title: string | null;
  status: TaskStatus;
  yolo_mode: 0 | 1;
}

export interface TaskUpdatesInput {
  title?: string | null;
  status?: TaskStatus;
  workflow_complete?: 0 | 1;
  planification_complete?: 0 | 1;
  completed_at?: string | null;
  yolo_mode?: 0 | 1;
}

export interface TaskRowWithProject extends TaskRow {
  project_name: string;
  repo_folder_path: string;
}

export interface TaskRowWithProjectMeta extends TaskRow {
  project_user_id: number;
  project_name: string;
  repo_folder_path: string;
}

export interface TestTasksDb {
  create: (
    projectId: number,
    title?: string | null,
    yoloMode?: boolean,
    userId?: number | null,
  ) => CreatedTestTask;
  getAll: (userId: number, status?: TaskStatus | null) => TaskRowWithProject[];
  getByProject: (projectId: number) => TaskRow[];
  getById: (id: number) => TaskRow | undefined;
  getWithProject: (taskId: number) => TaskRowWithProjectMeta | undefined;
  update: (id: number, updates: TaskUpdatesInput) => TaskRow | null | undefined;
  updateStatus: (id: number, status: TaskStatus) => TaskRow | null | undefined;
  delete: (id: number) => boolean;
}

export interface CreatedTestAgentRun {
  id: number;
  task_id: number | null;
  epic_id: number | null;
  agent_type: AgentType | EpicAgentType;
  status: 'running';
  conversation_id: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface TestAgentRunsDb {
  create: (
    taskId: number,
    agentType: AgentType,
    conversationId?: number | null,
  ) => CreatedTestAgentRun;
  createForEpic: (
    epicId: number,
    agentType: EpicAgentType,
    conversationId?: number | null,
  ) => CreatedTestAgentRun;
  getByTask: (taskId: number) => TaskAgentRunRow[];
  getByEpic: (epicId: number) => EpicAgentRunRow[];
  getByStatus: (status: TaskAgentRunRow['status']) => TaskAgentRunRow[];
  getById: (id: number) => TaskAgentRunRow | undefined;
  getByTaskAndType: (taskId: number, agentType: AgentType) => TaskAgentRunRow | undefined;
  updateStatus: (id: number, status: TaskAgentRunRow['status']) => TaskAgentRunRow | undefined;
  linkConversation: (id: number, conversationId: number | null) => TaskAgentRunRow | undefined;
  delete: (id: number) => boolean;
}

export interface CreatedTestConversation {
  id: number;
  // Null for epic conversations — exactly one owner is set, as in the DB.
  taskId: number | null;
  claudeConversationId: null;
}

export interface TestConversationsDb {
  create: (taskId: number) => CreatedTestConversation;
  createForEpic: (epicId: number) => CreatedTestConversation;
  getByTask: (taskId: number) => ConversationRow[];
  getByEpic: (epicId: number) => ConversationRow[];
  getById: (id: number) => ConversationRow | undefined;
  updateClaudeId: (id: number, claudeConversationId: string) => boolean;
  setAtlasEnabled: (id: number) => boolean;
  delete: (id: number) => boolean;
}

export interface TestTaskArtifactsDb {
  get: (taskId: number, kind: string) => TaskArtifactRow | undefined;
  list: (taskId: number) => TaskArtifactSummaryRow[];
  upsert: (
    taskId: number,
    artifact: { kind: string; title: string | null; html: string },
  ) => void;
}

export interface TestEpicsDb {
  create: (args: {
    projectId: number;
    userId: number | null;
    name: string;
    slug?: string;
  }) => EpicRow;
  getById: (id: number) => EpicRow | undefined;
  listByProject: (projectId: number) => EpicRow[];
  setStageComplete: (id: number, stage: 'architecture' | 'specs' | 'stories') => EpicRow | undefined;
  delete: (id: number) => boolean;
}

export interface TestDatabase {
  db: DB;
  userDb: TestUserDb;
  projectsDb: TestProjectsDb;
  projectMembersDb: TestProjectMembersDb;
  tasksDb: TestTasksDb;
  conversationsDb: TestConversationsDb;
  taskArtifactsDb: TestTaskArtifactsDb;
  agentRunsDb: TestAgentRunsDb;
  epicsDb: TestEpicsDb;
  close: () => void;
}

const lastInsertId = (rowid: number | bigint): number => Number(rowid);

/**
 * Creates a fresh in-memory SQLite database for testing.
 * Returns the database instance and helper functions.
 */
export function createTestDatabase(): TestDatabase {
  // Create an in-memory database
  const db = new Database(':memory:');

  // Read and execute the init.sql to create all tables
  const initSqlPath = path.join(__dirname, '../database/init.sql');
  const initSql = fs.readFileSync(initSqlPath, 'utf8');
  db.exec(initSql);

  // Create helper functions that mirror the db.js operations but use this test db
  const userDb: TestUserDb = {
    createUser: (username, passwordHash) => {
      const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
      const result = stmt.run(username, passwordHash);
      return { id: lastInsertId(result.lastInsertRowid), username };
    },
    getUserById: (userId) => {
      return db
        .prepare(
          'SELECT id, username, created_at, last_login, is_admin FROM users WHERE id = ? AND is_active = 1',
        )
        .get(userId) as SafeUserRow | undefined;
    },
    hasUsers: () => {
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as CountRow;
      return row.count > 0;
    },
    getFirstUser: () => {
      return db
        .prepare(
          'SELECT id, username, created_at, last_login, is_admin FROM users WHERE is_active = 1 LIMIT 1',
        )
        .get() as SafeUserRow | undefined;
    },
    getUserByUsername: (username) => {
      return db
        .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
        .get(username) as UserRow | undefined;
    },
    updateLastLogin: (userId) => {
      db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    },
    updateGitConfig: (userId, gitName, gitEmail) => {
      db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(
        gitName,
        gitEmail,
        userId,
      );
    },
    getGitConfig: (userId) => {
      return db.prepare('SELECT git_name, git_email FROM users WHERE id = ?').get(userId) as
        | Pick<UserRow, 'git_name' | 'git_email'>
        | undefined;
    },
    completeOnboarding: (userId) => {
      db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?').run(userId);
    },
    hasCompletedOnboarding: (userId) => {
      const row = db
        .prepare('SELECT has_completed_onboarding FROM users WHERE id = ?')
        .get(userId) as Pick<UserRow, 'has_completed_onboarding'> | undefined;
      return row?.has_completed_onboarding === 1;
    },
    // Admin methods
    getAllUsers: () => {
      return db
        .prepare(
          'SELECT id, username, created_at, last_login, is_active, is_admin FROM users ORDER BY created_at DESC',
        )
        .all() as SafeUserRowWithActive[];
    },
    isAdmin: (userId) => {
      const row = db
        .prepare('SELECT is_admin FROM users WHERE id = ? AND is_active = 1')
        .get(userId) as Pick<UserRow, 'is_admin'> | undefined;
      return row?.is_admin === 1;
    },
    setAdmin: (userId, isAdmin) => {
      const stmt = db.prepare('UPDATE users SET is_admin = ? WHERE id = ?');
      const result = stmt.run(isAdmin ? 1 : 0, userId);
      return result.changes > 0;
    },
    updateUser: (userId, updates) => {
      const allowedFields: Array<keyof UserUpdatesInput> = ['username', 'is_active', 'is_admin'];
      const setClause: string[] = [];
      const values: Array<string | number> = [];

      for (const field of allowedFields) {
        const value = updates[field];
        if (value !== undefined) {
          setClause.push(`${field} = ?`);
          if (field === 'is_active' || field === 'is_admin') {
            values.push(value ? 1 : 0);
          } else {
            values.push(value as string);
          }
        }
      }

      if (setClause.length === 0) {
        return userDb.getUserById(userId) as SafeUserRowWithActive | undefined;
      }

      values.push(userId);
      const stmt = db.prepare(`UPDATE users SET ${setClause.join(', ')} WHERE id = ?`);
      const result = stmt.run(...values);

      if (result.changes === 0) {
        return null;
      }

      return db
        .prepare(
          'SELECT id, username, created_at, last_login, is_active, is_admin FROM users WHERE id = ?',
        )
        .get(userId) as SafeUserRowWithActive | undefined;
    },
    updatePassword: (userId, passwordHash) => {
      const stmt = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
      const result = stmt.run(passwordHash, userId);
      return result.changes > 0;
    },
    deleteUser: (userId) => {
      const stmt = db.prepare('DELETE FROM users WHERE id = ?');
      const result = stmt.run(userId);
      return result.changes > 0;
    },
  };

  const projectMembersDb: TestProjectMembersDb = {
    addMember: (projectId, userId) => {
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)',
      );
      const result = stmt.run(projectId, userId);
      return result.changes > 0;
    },
    removeMember: (projectId, userId) => {
      const stmt = db.prepare(
        'DELETE FROM project_members WHERE project_id = ? AND user_id = ?',
      );
      const result = stmt.run(projectId, userId);
      return result.changes > 0;
    },
    isMember: (projectId, userId) => {
      const row = db
        .prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?')
        .get(projectId, userId) as { 1: number } | undefined;
      return !!row;
    },
    getProjectMembers: (projectId) => {
      return db
        .prepare(
          `
        SELECT u.id, u.username, u.created_at, u.is_admin, pm.created_at as joined_at
        FROM project_members pm
        JOIN users u ON pm.user_id = u.id
        WHERE pm.project_id = ?
        ORDER BY pm.created_at ASC
      `,
        )
        .all(projectId) as ProjectMemberWithUserRow[];
    },
    getUserProjects: (userId) => {
      return db
        .prepare(
          `
        SELECT p.*, pm.created_at as joined_at
        FROM project_members pm
        JOIN projects p ON pm.project_id = p.id
        WHERE pm.user_id = ?
        ORDER BY p.updated_at DESC
      `,
        )
        .all(userId) as ProjectWithJoinedRow[];
    },
    getMemberCount: (projectId) => {
      const row = db
        .prepare('SELECT COUNT(*) as count FROM project_members WHERE project_id = ?')
        .get(projectId) as CountRow;
      return row.count;
    },
  };

  const projectsDb: TestProjectsDb = {
    create: (userId, name, repoFolderPath) => {
      const stmt = db.prepare(
        'INSERT INTO projects (user_id, name, repo_folder_path) VALUES (?, ?, ?)',
      );
      const result = stmt.run(userId, name, repoFolderPath);
      const projectId = lastInsertId(result.lastInsertRowid);
      // Auto-add creator as member
      db.prepare('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)').run(
        projectId,
        userId,
      );
      return { id: projectId, userId, name, repoFolderPath };
    },
    getAll: (userId) => {
      return db
        .prepare(
          `
        SELECT p.* FROM projects p
        JOIN project_members pm ON p.id = pm.project_id
        WHERE pm.user_id = ?
        ORDER BY p.updated_at DESC
      `,
        )
        .all(userId) as ProjectRow[];
    },
    getById: (id, userId) => {
      return db
        .prepare(
          `
        SELECT p.* FROM projects p
        JOIN project_members pm ON p.id = pm.project_id
        WHERE p.id = ? AND pm.user_id = ?
      `,
        )
        .get(id, userId) as ProjectRow | undefined;
    },
    update: (id, userId, updates) => {
      // First check membership
      if (!projectMembersDb.isMember(id, userId)) {
        return null;
      }

      const allowedFields: Array<keyof ProjectUpdatesInput> = ['name', 'repo_folder_path'];
      const setClause: string[] = [];
      const values: Array<string | number> = [];

      for (const field of allowedFields) {
        const value = updates[field];
        if (value !== undefined) {
          setClause.push(`${field} = ?`);
          values.push(value);
        }
      }

      if (setClause.length === 0) {
        return projectsDb.getById(id, userId);
      }

      setClause.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);

      const stmt = db.prepare(`UPDATE projects SET ${setClause.join(', ')} WHERE id = ?`);
      const result = stmt.run(...values);

      if (result.changes === 0) {
        return null;
      }

      return projectsDb.getById(id, userId);
    },
    delete: (id, userId) => {
      // First check membership
      if (!projectMembersDb.isMember(id, userId)) {
        return false;
      }
      const stmt = db.prepare('DELETE FROM projects WHERE id = ?');
      const result = stmt.run(id);
      return result.changes > 0;
    },
  };

  const tasksDb: TestTasksDb = {
    create: (projectId, title = null, yoloMode = false, userId = null) => {
      const stmt = db.prepare(
        'INSERT INTO tasks (project_id, user_id, title, status, yolo_mode) VALUES (?, ?, ?, ?, ?)',
      );
      const yoloFlag: 0 | 1 = yoloMode ? 1 : 0;
      const result = stmt.run(projectId, userId, title, 'pending', yoloFlag);
      return {
        id: lastInsertId(result.lastInsertRowid),
        projectId,
        user_id: userId,
        title,
        status: 'pending',
        yolo_mode: yoloFlag,
      };
    },
    getAll: (userId, status = null) => {
      let query = `
        SELECT t.*, p.name as project_name, p.repo_folder_path
        FROM tasks t
        JOIN projects p ON t.project_id = p.id
        JOIN project_members pm ON p.id = pm.project_id
        WHERE pm.user_id = ?
      `;
      const params: Array<string | number> = [userId];

      if (status) {
        query += ' AND t.status = ?';
        params.push(status);
      }

      query += ' ORDER BY t.updated_at DESC LIMIT 50';

      return db.prepare(query).all(...params) as TaskRowWithProject[];
    },
    getByProject: (projectId) => {
      return db
        .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC')
        .all(projectId) as TaskRow[];
    },
    getById: (id) => {
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    },
    getWithProject: (taskId) => {
      return db
        .prepare(
          `
        SELECT t.*,
               p.user_id AS project_user_id,
               p.name AS project_name,
               p.repo_folder_path
        FROM tasks t
        JOIN projects p ON t.project_id = p.id
        WHERE t.id = ?
      `,
        )
        .get(taskId) as TaskRowWithProjectMeta | undefined;
    },
    update: (id, updates) => {
      const allowedFields: Array<keyof TaskUpdatesInput> = [
        'title',
        'status',
        'workflow_complete',
        'planification_complete',
        'completed_at',
        'yolo_mode',
      ];
      const setClause: string[] = [];
      const values: Array<string | number | null> = [];

      // Get current task to detect status transitions
      const currentTask = tasksDb.getById(id);

      for (const field of allowedFields) {
        const value = updates[field];
        if (value !== undefined) {
          setClause.push(`${field} = ?`);
          values.push(value);
        }
      }

      // Auto-manage completed_at based on status changes
      if (updates.status !== undefined && currentTask) {
        if (updates.status === 'completed' && currentTask.status !== 'completed') {
          // Transitioning TO completed - set completed_at if not explicitly provided
          if (updates.completed_at === undefined) {
            setClause.push('completed_at = CURRENT_TIMESTAMP');
          }
        } else if (updates.status !== 'completed' && currentTask.status === 'completed') {
          // Transitioning FROM completed - clear completed_at
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
    updateStatus: (id, status) => {
      const validStatuses: TaskStatus[] = ['pending', 'in_progress', 'in_review', 'completed'];
      if (!validStatuses.includes(status)) {
        throw new Error(
          `Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`,
        );
      }
      return tasksDb.update(id, { status });
    },
    delete: (id) => {
      const stmt = db.prepare('DELETE FROM tasks WHERE id = ?');
      const result = stmt.run(id);
      return result.changes > 0;
    },
  };

  const agentRunsDb: TestAgentRunsDb = {
    create: (taskId, agentType, conversationId = null) => {
      const stmt = db.prepare(`
        INSERT INTO task_agent_runs (task_id, agent_type, status, conversation_id)
        VALUES (?, ?, 'running', ?)
      `);
      const result = stmt.run(taskId, agentType, conversationId);
      return {
        id: lastInsertId(result.lastInsertRowid),
        task_id: taskId,
        epic_id: null,
        agent_type: agentType,
        status: 'running',
        conversation_id: conversationId,
        created_at: new Date().toISOString(),
        completed_at: null,
      };
    },
    createForEpic: (epicId, agentType, conversationId = null) => {
      const stmt = db.prepare(`
        INSERT INTO epic_agent_runs (epic_id, agent_type, status, conversation_id)
        VALUES (?, ?, 'running', ?)
      `);
      const result = stmt.run(epicId, agentType, conversationId);
      return {
        id: lastInsertId(result.lastInsertRowid),
        task_id: null,
        epic_id: epicId,
        agent_type: agentType,
        status: 'running',
        conversation_id: conversationId,
        created_at: new Date().toISOString(),
        completed_at: null,
      };
    },
    getByEpic: (epicId) => {
      return db
        .prepare(
          `
        SELECT * FROM epic_agent_runs
        WHERE epic_id = ?
        ORDER BY created_at DESC
      `,
        )
        .all(epicId) as EpicAgentRunRow[];
    },
    getByTask: (taskId) => {
      return db
        .prepare(
          `
        SELECT * FROM task_agent_runs
        WHERE task_id = ?
        ORDER BY created_at DESC
      `,
        )
        .all(taskId) as TaskAgentRunRow[];
    },
    getByStatus: (status) => {
      return db
        .prepare(
          `
        SELECT * FROM task_agent_runs
        WHERE status = ?
        ORDER BY created_at DESC
      `,
        )
        .all(status) as TaskAgentRunRow[];
    },
    getById: (id) => {
      return db
        .prepare('SELECT * FROM task_agent_runs WHERE id = ?')
        .get(id) as TaskAgentRunRow | undefined;
    },
    getByTaskAndType: (taskId, agentType) => {
      return db
        .prepare(
          `
        SELECT * FROM task_agent_runs
        WHERE task_id = ? AND agent_type = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
        )
        .get(taskId, agentType) as TaskAgentRunRow | undefined;
    },
    updateStatus: (id, status) => {
      const validStatuses: Array<TaskAgentRunRow['status']> = [
        'pending',
        'running',
        'completed',
        'failed',
      ];
      if (!validStatuses.includes(status)) {
        throw new Error(
          `Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`,
        );
      }

      let stmt: Database.Statement;
      if (status === 'completed') {
        stmt = db.prepare(`
          UPDATE task_agent_runs
          SET status = ?, completed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `);
      } else {
        stmt = db.prepare(`
          UPDATE task_agent_runs
          SET status = ?, completed_at = NULL
          WHERE id = ?
        `);
      }
      stmt.run(status, id);
      return agentRunsDb.getById(id);
    },
    linkConversation: (id, conversationId) => {
      const stmt = db.prepare(`
        UPDATE task_agent_runs
        SET conversation_id = ?
        WHERE id = ?
      `);
      stmt.run(conversationId, id);
      return agentRunsDb.getById(id);
    },
    delete: (id) => {
      const stmt = db.prepare('DELETE FROM task_agent_runs WHERE id = ?');
      const result = stmt.run(id);
      return result.changes > 0;
    },
  };

  const conversationsDb: TestConversationsDb = {
    create: (taskId) => {
      const result = db
        .prepare(`INSERT INTO conversations (owner_kind) VALUES ('task')`)
        .run();
      const id = lastInsertId(result.lastInsertRowid);
      db.prepare('INSERT INTO task_conversations (conversation_id, task_id) VALUES (?, ?)').run(
        id,
        taskId,
      );
      return { id, taskId, claudeConversationId: null };
    },
    createForEpic: (epicId) => {
      const result = db
        .prepare(`INSERT INTO conversations (owner_kind) VALUES ('epic')`)
        .run();
      const id = lastInsertId(result.lastInsertRowid);
      db.prepare('INSERT INTO epic_conversations (conversation_id, epic_id) VALUES (?, ?)').run(
        id,
        epicId,
      );
      return { id, taskId: null, claudeConversationId: null };
    },
    getByTask: (taskId) => {
      return db
        .prepare(
          `${SELECT_CONVERSATION_WITH_OWNER} WHERE tc.task_id = ? ORDER BY c.created_at DESC`,
        )
        .all(taskId) as ConversationRow[];
    },
    getByEpic: (epicId) => {
      return db
        .prepare(
          `${SELECT_CONVERSATION_WITH_OWNER} WHERE ec.epic_id = ? ORDER BY c.created_at DESC`,
        )
        .all(epicId) as ConversationRow[];
    },
    getById: (id) => {
      return db
        .prepare(`${SELECT_CONVERSATION_WITH_OWNER} WHERE c.id = ?`)
        .get(id) as ConversationRow | undefined;
    },
    updateClaudeId: (id, claudeConversationId) => {
      const stmt = db.prepare(
        'UPDATE conversations SET claude_conversation_id = ? WHERE id = ?',
      );
      const result = stmt.run(claudeConversationId, id);
      return result.changes > 0;
    },
    setAtlasEnabled: (id) => {
      const result = db
        .prepare('UPDATE conversations SET atlas_enabled = 1 WHERE id = ?')
        .run(id);
      return result.changes > 0;
    },
    delete: (id) => {
      const stmt = db.prepare('DELETE FROM conversations WHERE id = ?');
      const result = stmt.run(id);
      return result.changes > 0;
    },
  };

  const taskArtifactsDb: TestTaskArtifactsDb = {
    get: (taskId, kind) => {
      return db
        .prepare('SELECT * FROM task_artifacts WHERE task_id = ? AND kind = ?')
        .get(taskId, kind) as TaskArtifactRow | undefined;
    },
    list: (taskId) => {
      return db
        .prepare(
          'SELECT task_id, kind, title, updated_at FROM task_artifacts WHERE task_id = ? ORDER BY kind',
        )
        .all(taskId) as TaskArtifactSummaryRow[];
    },
    upsert: (taskId, artifact) => {
      db.prepare(
        `INSERT INTO task_artifacts (task_id, kind, title, html, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(task_id, kind) DO UPDATE SET
           title = excluded.title,
           html = excluded.html,
           updated_at = CURRENT_TIMESTAMP`,
      ).run(taskId, artifact.kind, artifact.title, artifact.html);
    },
  };

  const epicsDb: TestEpicsDb = {
    create: (args) => {
      const stmt = db.prepare(`
        INSERT INTO epics (project_id, user_id, name, slug)
        VALUES (?, ?, ?, ?)
      `);
      const result = stmt.run(
        args.projectId,
        args.userId,
        args.name,
        args.slug ?? args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30),
      );
      return epicsDb.getById(lastInsertId(result.lastInsertRowid))!;
    },
    getById: (id) => {
      return db.prepare('SELECT * FROM epics WHERE id = ?').get(id) as EpicRow | undefined;
    },
    listByProject: (projectId) => {
      return db
        .prepare('SELECT * FROM epics WHERE project_id = ? ORDER BY created_at DESC, id DESC')
        .all(projectId) as EpicRow[];
    },
    setStageComplete: (id, stage) => {
      const column =
        stage === 'architecture'
          ? 'architecture_complete'
          : stage === 'specs'
            ? 'specs_complete'
            : stage === 'stories'
              ? 'stories_complete'
              : 'review_complete';
      db.prepare(`UPDATE epics SET ${column} = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
      return epicsDb.getById(id);
    },
    delete: (id) => {
      return db.prepare('DELETE FROM epics WHERE id = ?').run(id).changes > 0;
    },
  };

  return {
    db,
    userDb,
    projectsDb,
    projectMembersDb,
    tasksDb,
    conversationsDb,
    taskArtifactsDb,
    agentRunsDb,
    epicsDb,
    close: () => db.close(),
  };
}

// Re-export the row shape used by direct callers of the helpers.
export type { ProjectMemberRow };
