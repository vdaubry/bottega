import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const mockDbPrepare = vi.hoisted(() => vi.fn());
const mockProjectsDb = vi.hoisted(() => ({
  getAll: vi.fn(),
}));
const mockTasksDb = vi.hoisted(() => ({
  getByProject: vi.fn(),
}));
const mockConversationsDb = vi.hoisted(() => ({
  getByTask: vi.fn(),
}));

vi.mock('../database/db.js', () => ({
  db: {
    prepare: (...args: unknown[]) => mockDbPrepare(...args),
  },
  projectsDb: mockProjectsDb,
  tasksDb: mockTasksDb,
  conversationsDb: mockConversationsDb,
}));

vi.mock('../services/conversationContentStore.js', () => ({
  resolveProjectKey: vi.fn((path: string | null | undefined) => {
    if (!path) return '';
    return path.replace(/[^a-zA-Z0-9]/g, '-');
  }),
}));

import exportRoutes from './export.js';

describe('GET /api/export/corpus', () => {
  let app: import('express').Application;
  const testUserId = 1;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbPrepare.mockReset();

    const express = require('express') as typeof import('express');
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: testUserId, username: 'testuser' } as never;
      next();
    });
    app.use('/api/export', exportRoutes);
  });

  it('returns all projects for the user', async () => {
    mockProjectsDb.getAll.mockReturnValue([
      {
        id: 1,
        user_id: testUserId,
        name: 'Project 1',
        repo_folder_path: '/home/proj1',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);
    mockTasksDb.getByProject.mockReturnValue([]);
    mockConversationsDb.getByTask.mockReturnValue([]);

    const res = await request(app).get('/api/export/corpus');

    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0].name).toBe('Project 1');
    expect(res.body.exported_by).toEqual({ id: 1, username: 'testuser' });
    expect(res.body.exported_at).toBeDefined();
  });

  it('nests tasks under each project', async () => {
    mockProjectsDb.getAll.mockReturnValue([
      {
        id: 1,
        user_id: testUserId,
        name: 'Project 1',
        repo_folder_path: '/home/proj1',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);
    mockTasksDb.getByProject.mockReturnValue([
      {
        id: 10,
        project_id: 1,
        title: 'Task A',
        status: 'completed',
        completed_at: '2024-01-03T00:00:00.000Z',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-03T00:00:00.000Z',
      },
    ]);
    mockConversationsDb.getByTask.mockReturnValue([]);

    const res = await request(app).get('/api/export/corpus');

    expect(res.status).toBe(200);
    expect(res.body.projects[0].tasks).toHaveLength(1);
    expect(res.body.projects[0].tasks[0].title).toBe('Task A');
    expect(res.body.projects[0].tasks[0].status).toBe('completed');
  });

  it('nests conversations under each task', async () => {
    mockProjectsDb.getAll.mockReturnValue([
      {
        id: 1,
        user_id: testUserId,
        name: 'Project 1',
        repo_folder_path: '/home/proj1',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);
    mockTasksDb.getByProject.mockReturnValue([
      {
        id: 10,
        project_id: 1,
        title: 'Task A',
        status: 'pending',
        completed_at: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);
    mockConversationsDb.getByTask.mockReturnValue([
      {
        id: 100,
        task_id: 10,
        name: 'Chat 1',
        provider: 'anthropic',
        model: 'opus',
        effort: null,
        created_at: '2024-01-01T12:00:00.000Z',
      },
    ]);

    const res = await request(app).get('/api/export/corpus');

    expect(res.status).toBe(200);
    expect(res.body.projects[0].tasks[0].conversations).toHaveLength(1);
    expect(res.body.projects[0].tasks[0].conversations[0].name).toBe('Chat 1');
  });

  it('omits messages when no includeMessageProjects param', async () => {
    mockProjectsDb.getAll.mockReturnValue([
      {
        id: 1,
        user_id: testUserId,
        name: 'Project 1',
        repo_folder_path: '/home/proj1',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);
    mockTasksDb.getByProject.mockReturnValue([
      {
        id: 10,
        project_id: 1,
        title: 'Task A',
        status: 'pending',
        completed_at: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);
    mockConversationsDb.getByTask.mockReturnValue([
      {
        id: 100,
        task_id: 10,
        name: 'Chat 1',
        provider: 'anthropic',
        model: 'opus',
        effort: null,
        created_at: '2024-01-01T12:00:00.000Z',
        claude_conversation_id: 'sess_123',
      },
    ]);

    const res = await request(app).get('/api/export/corpus');

    expect(res.status).toBe(200);
    expect(res.body.projects[0].tasks[0].conversations[0].messages).toBeUndefined();
    expect(mockDbPrepare).not.toHaveBeenCalled();
  });

  it('includes messages for requested projects', async () => {
    mockProjectsDb.getAll.mockReturnValue([
      {
        id: 1,
        user_id: testUserId,
        name: 'Project 1',
        repo_folder_path: '/home/proj1',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);
    mockTasksDb.getByProject.mockReturnValue([
      {
        id: 10,
        project_id: 1,
        title: 'Task A',
        status: 'pending',
        completed_at: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);
    mockConversationsDb.getByTask.mockReturnValue([
      {
        id: 100,
        task_id: 10,
        name: 'Chat 1',
        provider: 'anthropic',
        model: 'opus',
        effort: null,
        created_at: '2024-01-01T12:00:00.000Z',
        claude_conversation_id: 'sess_123',
      },
    ]);

    const mockStmt = { all: vi.fn() };
    mockStmt.all.mockReturnValue([
      { seq: 1, entry_json: Buffer.from(JSON.stringify({ type: 'text', text: 'Hello' })) },
      { seq: 2, entry_json: Buffer.from(JSON.stringify({ type: 'text', text: 'World' })) },
    ]);
    mockDbPrepare.mockReturnValue(mockStmt);

    const res = await request(app).get('/api/export/corpus?includeMessageProjects=1');

    expect(res.status).toBe(200);
    expect(res.body.projects[0].tasks[0].conversations[0].messages).toHaveLength(2);
    expect(res.body.projects[0].tasks[0].conversations[0].messages![0].text).toBe('Hello');
    expect(res.body.projects[0].tasks[0].conversations[0].messages![1].text).toBe('World');
    expect(mockDbPrepare).toHaveBeenCalled();
  });

  it('omits messages for non-requested projects in a mixed set', async () => {
    mockProjectsDb.getAll.mockReturnValue([
      {
        id: 1,
        user_id: testUserId,
        name: 'Project 1',
        repo_folder_path: '/home/proj1',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
      {
        id: 2,
        user_id: testUserId,
        name: 'Project 2',
        repo_folder_path: '/home/proj2',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);
    mockTasksDb.getByProject.mockImplementation((projectId: number) => {
      if (projectId === 1) {
        return [
          {
            id: 10,
            project_id: 1,
            title: 'Task A',
            status: 'pending',
            completed_at: null,
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-02T00:00:00.000Z',
          },
        ];
      }
      return [
        {
          id: 20,
          project_id: 2,
          title: 'Task B',
          status: 'pending',
          completed_at: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-02T00:00:00.000Z',
        },
      ];
    });
    mockConversationsDb.getByTask.mockImplementation((taskId: number) => {
      if (taskId === 10) {
        return [
          {
            id: 100,
            task_id: 10,
            name: 'Chat P1',
            provider: 'anthropic',
            model: 'opus',
            effort: null,
            created_at: '2024-01-01T12:00:00.000Z',
            claude_conversation_id: 'sess_1',
          },
        ];
      }
      return [
        {
          id: 200,
          task_id: 20,
          name: 'Chat P2',
          provider: 'anthropic',
          model: 'sonnet',
          effort: null,
          created_at: '2024-01-01T12:00:00.000Z',
          claude_conversation_id: 'sess_2',
        },
      ];
    });

    const mockStmt = { all: vi.fn() };
    mockStmt.all.mockReturnValue([
      { seq: 1, entry_json: Buffer.from(JSON.stringify({ type: 'text', text: 'Secret' })) },
    ]);
    mockDbPrepare.mockReturnValue(mockStmt);

    const res = await request(app).get('/api/export/corpus?includeMessageProjects=1');

    expect(res.status).toBe(200);
    expect(res.body.projects[0].tasks[0].conversations[0].messages).toHaveLength(1);
    expect(res.body.projects[1].tasks[0].conversations[0].messages).toBeUndefined();
  });

  it('returns 200 for a user with no projects', async () => {
    mockProjectsDb.getAll.mockReturnValue([]);

    const res = await request(app).get('/api/export/corpus');

    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
  });

  it('filters projects when projectIds param is provided', async () => {
    mockProjectsDb.getAll.mockReturnValue([
      {
        id: 1,
        user_id: testUserId,
        name: 'Project 1',
        repo_folder_path: '/home/proj1',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
      {
        id: 2,
        user_id: testUserId,
        name: 'Project 2',
        repo_folder_path: '/home/proj2',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);
    mockTasksDb.getByProject.mockReturnValue([]);
    mockConversationsDb.getByTask.mockReturnValue([]);

    const res = await request(app).get('/api/export/corpus?projectIds=2');

    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0].id).toBe(2);
    expect(res.body.projects[0].name).toBe('Project 2');
  });

  it('returns 200 for a project with no tasks', async () => {
    mockProjectsDb.getAll.mockReturnValue([
      {
        id: 1,
        user_id: testUserId,
        name: 'Empty Project',
        repo_folder_path: '/home/empty',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-02T00:00:00.000Z',
      },
    ]);
    mockTasksDb.getByProject.mockReturnValue([]);

    const res = await request(app).get('/api/export/corpus');

    expect(res.status).toBe(200);
    expect(res.body.projects[0].tasks).toEqual([]);
  });
});
