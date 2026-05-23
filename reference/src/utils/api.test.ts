import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, authenticatedFetch } from './api';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock localStorage
const mockLocalStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
};
Object.defineProperty(global, 'localStorage', { value: mockLocalStorage });

describe('API Client - Phase 5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.getItem.mockReturnValue('test-token');
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
      headers: { get: vi.fn().mockReturnValue(null) },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('authenticatedFetch', () => {
    it('should include Authorization header when token exists', async () => {
      await authenticatedFetch('/api/test');

      expect(mockFetch).toHaveBeenCalledWith('/api/test', {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token',
        },
      });
    });

    it('should not include Authorization header when no token', async () => {
      mockLocalStorage.getItem.mockReturnValue(null);

      await authenticatedFetch('/api/test');

      expect(mockFetch).toHaveBeenCalledWith('/api/test', {
        headers: {
          'Content-Type': 'application/json',
        },
      });
    });

    it('should not set Content-Type for FormData', async () => {
      const formData = new FormData();
      formData.append('file', 'test');

      await authenticatedFetch('/api/test', { body: formData });

      expect(mockFetch).toHaveBeenCalledWith('/api/test', {
        body: formData,
        headers: {
          'Authorization': 'Bearer test-token',
        },
      });
    });
  });

  describe('api.projects', () => {
    it('list() should call GET /api/projects', async () => {
      await api.projects.list();

      expect(mockFetch).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-token',
        }),
      }));
    });

    it('create() should call POST /api/projects with name and repoFolderPath', async () => {
      await api.projects.create('My Project', '/path/to/repo');

      expect(mockFetch).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'My Project', repoFolderPath: '/path/to/repo' }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }));
    });

    it('get() should call GET /api/projects/:id', async () => {
      await api.projects.get(123);

      expect(mockFetch).toHaveBeenCalledWith('/api/projects/123', expect.any(Object));
    });

    it('update() should call PUT /api/projects/:id with data', async () => {
      await api.projects.update(123, { name: 'Updated Name' });

      expect(mockFetch).toHaveBeenCalledWith('/api/projects/123', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: 'Updated Name' }),
      }));
    });

    it('delete() should call DELETE /api/projects/:id', async () => {
      await api.projects.delete(123);

      expect(mockFetch).toHaveBeenCalledWith('/api/projects/123', expect.objectContaining({
        method: 'DELETE',
      }));
    });
  });

  describe('api.tasks', () => {
    it('listAll() should call GET /api/tasks', async () => {
      await api.tasks.listAll();

      expect(mockFetch).toHaveBeenCalledWith('/api/tasks', expect.any(Object));
    });

    it('listAll(\'in_progress\') should call GET /api/tasks?status=in_progress', async () => {
      await api.tasks.listAll('in_progress');

      expect(mockFetch).toHaveBeenCalledWith('/api/tasks?status=in_progress', expect.any(Object));
    });

    it('listAll(\'pending\') should call GET /api/tasks?status=pending', async () => {
      await api.tasks.listAll('pending');

      expect(mockFetch).toHaveBeenCalledWith('/api/tasks?status=pending', expect.any(Object));
    });

    it('listAll(\'completed\') should call GET /api/tasks?status=completed', async () => {
      await api.tasks.listAll('completed');

      expect(mockFetch).toHaveBeenCalledWith('/api/tasks?status=completed', expect.any(Object));
    });

    it('listAll(null) should call GET /api/tasks without query param', async () => {
      await api.tasks.listAll(null);

      expect(mockFetch).toHaveBeenCalledWith('/api/tasks', expect.any(Object));
    });

    it('list() should call GET /api/projects/:projectId/tasks', async () => {
      await api.tasks.list(456);

      expect(mockFetch).toHaveBeenCalledWith('/api/projects/456/tasks', expect.any(Object));
    });

    it('create() should call POST /api/projects/:projectId/tasks with title and description', async () => {
      await api.tasks.create(456, 'New Task Title', 'Task description');

      expect(mockFetch).toHaveBeenCalledWith('/api/projects/456/tasks', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'New Task Title', description: 'Task description' }),
      }));
    });

    it('get() should call GET /api/tasks/:id', async () => {
      await api.tasks.get(789);

      expect(mockFetch).toHaveBeenCalledWith('/api/tasks/789', expect.any(Object));
    });

    it('update() should call PUT /api/tasks/:id with data', async () => {
      await api.tasks.update(789, { title: 'Updated Task' });

      expect(mockFetch).toHaveBeenCalledWith('/api/tasks/789', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ title: 'Updated Task' }),
      }));
    });

    it('delete() should call DELETE /api/tasks/:id', async () => {
      await api.tasks.delete(789);

      expect(mockFetch).toHaveBeenCalledWith('/api/tasks/789', expect.objectContaining({
        method: 'DELETE',
      }));
    });

    it('getDoc() should call GET /api/tasks/:id/documentation', async () => {
      await api.tasks.getDoc(789);

      expect(mockFetch).toHaveBeenCalledWith('/api/tasks/789/documentation', expect.any(Object));
    });

    it('saveDoc() should call PUT /api/tasks/:id/documentation with content', async () => {
      await api.tasks.saveDoc(789, '# Task Description\n\nImplement feature X.');

      expect(mockFetch).toHaveBeenCalledWith('/api/tasks/789/documentation', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ content: '# Task Description\n\nImplement feature X.' }),
      }));
    });
  });

  describe('api.conversations', () => {
    it('list() should call GET /api/tasks/:taskId/conversations', async () => {
      await api.conversations.list(789);

      expect(mockFetch).toHaveBeenCalledWith('/api/tasks/789/conversations', expect.any(Object));
    });

    it('create() should call POST /api/tasks/:taskId/conversations', async () => {
      await api.conversations.create(789, 'anthropic', 'opus');

      expect(mockFetch).toHaveBeenCalledWith('/api/tasks/789/conversations', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ provider: 'anthropic', model: 'opus' }),
      }));
    });

    it('get() should call GET /api/conversations/:id', async () => {
      await api.conversations.get(101);

      expect(mockFetch).toHaveBeenCalledWith('/api/conversations/101', expect.any(Object));
    });

    it('delete() should call DELETE /api/conversations/:id', async () => {
      await api.conversations.delete(101);

      expect(mockFetch).toHaveBeenCalledWith('/api/conversations/101', expect.objectContaining({
        method: 'DELETE',
      }));
    });

    it('getMessages() should call GET /api/conversations/:id/messages', async () => {
      await api.conversations.getMessages(101);

      expect(mockFetch).toHaveBeenCalledWith('/api/conversations/101/messages', expect.any(Object));
    });

    it('getMessages() should include limit and offset query params', async () => {
      await api.conversations.getMessages(101, 50, 10);

      expect(mockFetch).toHaveBeenCalledWith('/api/conversations/101/messages?limit=50&offset=10', expect.any(Object));
    });

    it('getMessages() should include only limit when offset is 0', async () => {
      await api.conversations.getMessages(101, 100, 0);

      expect(mockFetch).toHaveBeenCalledWith('/api/conversations/101/messages?limit=100', expect.any(Object));
    });
  });

  describe('api.streamingSessions', () => {
    it('getActive() should call GET /api/streaming-sessions', async () => {
      await api.streamingSessions.getActive();

      expect(mockFetch).toHaveBeenCalledWith('/api/streaming-sessions', expect.any(Object));
    });
  });

  describe('api.auth', () => {
    it('status() should call GET /api/auth/status without auth header', async () => {
      await api.auth.status();

      // status() uses regular fetch, not authenticatedFetch
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/status');
    });

    it('login() should call POST /api/auth/login with credentials', async () => {
      await api.auth.login('testuser', 'testpass');

      expect(mockFetch).toHaveBeenCalledWith('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testuser', password: 'testpass' }),
      });
    });

    it('register() should call POST /api/auth/register with credentials', async () => {
      await api.auth.register('newuser', 'newpass');

      expect(mockFetch).toHaveBeenCalledWith('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'newuser', password: 'newpass' }),
      });
    });

    it('user() should call GET /api/auth/user with auth header', async () => {
      await api.auth.user();

      expect(mockFetch).toHaveBeenCalledWith('/api/auth/user', expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-token',
        }),
      }));
    });

    it('logout() should call POST /api/auth/logout with auth header', async () => {
      await api.auth.logout();

      expect(mockFetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-token',
        }),
      }));
    });
  });

  describe('api.claudeAuth', () => {
    it('status() should call GET /api/claude-auth/status', async () => {
      await api.claudeAuth.status();

      expect(mockFetch).toHaveBeenCalledWith('/api/claude-auth/status', expect.any(Object));
    });

    it('start() should call POST /api/claude-auth/start', async () => {
      await api.claudeAuth.start();

      expect(mockFetch).toHaveBeenCalledWith('/api/claude-auth/start', expect.objectContaining({
        method: 'POST',
      }));
    });

    it('complete() should submit login session and code', async () => {
      await api.claudeAuth.complete('login-123', 'oauth-code');

      expect(mockFetch).toHaveBeenCalledWith('/api/claude-auth/complete', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ loginSessionId: 'login-123', code: 'oauth-code' }),
      }));
    });

    it('cancel() should call POST /api/claude-auth/cancel', async () => {
      await api.claudeAuth.cancel();

      expect(mockFetch).toHaveBeenCalledWith('/api/claude-auth/cancel', expect.objectContaining({
        method: 'POST',
      }));
    });

    it('clear() should call DELETE /api/claude-auth', async () => {
      await api.claudeAuth.clear();

      expect(mockFetch).toHaveBeenCalledWith('/api/claude-auth', expect.objectContaining({
        method: 'DELETE',
      }));
    });
  });

  describe('api.getCommands', () => {
    it('should call POST /api/commands/list with projectPath', async () => {
      await api.getCommands('/path/to/project');

      expect(mockFetch).toHaveBeenCalledWith('/api/commands/list', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectPath: '/path/to/project' }),
      }));
    });

    it('should use empty string for projectPath when not provided', async () => {
      await api.getCommands();

      expect(mockFetch).toHaveBeenCalledWith('/api/commands/list', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ projectPath: '' }),
      }));
    });
  });

  describe('api.transcribe', () => {
    it('should call POST /api/transcribe with FormData and auth header', async () => {
      const formData = new FormData();
      formData.append('audio', 'test-audio-data');

      await api.transcribe(formData);

      expect(mockFetch).toHaveBeenCalledWith('/api/transcribe', expect.objectContaining({
        method: 'POST',
        body: formData,
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-token',
        }),
      }));
    });
  });

  describe('api.get', () => {
    it('should call GET /api/:endpoint', async () => {
      await api.get('/custom/endpoint');

      expect(mockFetch).toHaveBeenCalledWith('/api/custom/endpoint', expect.any(Object));
    });
  });

});
