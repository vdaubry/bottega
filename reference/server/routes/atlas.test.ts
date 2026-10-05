import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const {
  mockGetWithProject,
  mockArtifactsList,
  mockArtifactGet,
  mockGetWorkspaceForTask,
  mockConversationsDb,
  mockStartConversation,
  mockGetOngoingAtlasGeneration,
  mockValidateClaudeCredentials,
  mockRenderPrompt,
  mockLoadAgentModelSettings,
} = vi.hoisted(() => ({
  mockGetWithProject: vi.fn(),
  mockArtifactsList: vi.fn(),
  mockArtifactGet: vi.fn(),
  mockGetWorkspaceForTask: vi.fn(),
  mockConversationsDb: {
    create: vi.fn(),
    setAtlasEnabled: vi.fn(),
    getById: vi.fn(),
    delete: vi.fn(),
  },
  mockStartConversation: vi.fn(),
  mockGetOngoingAtlasGeneration: vi.fn(),
  mockValidateClaudeCredentials: vi.fn(),
  mockRenderPrompt: vi.fn(),
  mockLoadAgentModelSettings: vi.fn(),
}));

vi.mock('../database/db.js', () => ({
  tasksDb: { getWithProject: mockGetWithProject },
  TaskWorktreeNotReadyError: class TaskWorktreeNotReadyError extends Error {},
  taskArtifactsDb: { list: mockArtifactsList, get: mockArtifactGet },
  conversationsDb: mockConversationsDb,
}));

// MissingUserAgentSettingsError must be the REAL class so `instanceof` in the
// route matches; only loadAgentModelSettings is stubbed.
vi.mock('../services/agentModelSettings.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../services/agentModelSettings.js')>();
  return {
    ...original,
    loadAgentModelSettings: mockLoadAgentModelSettings,
  };
});

vi.mock('../services/projectService.js', () => ({
  hasProjectAccess: vi.fn(),
}));

vi.mock('../services/atlas/workspace.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/atlas/workspace.js')>();
  return {
    ...original,
    getWorkspaceForTask: mockGetWorkspaceForTask,
  };
});

vi.mock('../services/claudeCredentials.js', () => ({
  validateClaudeCredentials: mockValidateClaudeCredentials,
}));

vi.mock('../services/conversationAdapter.js', () => ({
  startConversation: mockStartConversation,
  getOngoingAtlasGenerationConversationId: mockGetOngoingAtlasGeneration,
}));

vi.mock('../services/documentation.js', () => ({
  buildContextPrompt: vi.fn().mockReturnValue('context prompt'),
  getTaskDocPath: vi.fn().mockReturnValue('/home/u/.bottega/projects/3/tasks/task-42.md'),
}));

vi.mock('../services/promptRenderer.js', () => ({
  renderPrompt: mockRenderPrompt,
  getAtlasStyleRefsDir: vi.fn().mockReturnValue('/abs/server/constants/atlas-style-refs'),
}));

import atlasRoutes from './atlas.js';
import { hasProjectAccess } from '../services/projectService.js';
import { WorkspaceError } from '../services/atlas/workspace.js';
import { MissingUserAgentSettingsError } from '../services/agentModelSettings.js';

const TASK = { id: 42, project_id: 3, repo_folder_path: '/repos/demo', subproject_path: null };

describe('Atlas Routes', () => {
  let app: import('express').Application;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasProjectAccess).mockReturnValue(true);
    mockGetWithProject.mockReturnValue(TASK);
    mockGetWorkspaceForTask.mockResolvedValue({
      listDir: vi.fn().mockResolvedValue([
        { name: 'src', path: 'src', type: 'dir' },
        { name: 'README.md', path: 'README.md', type: 'file' },
      ]),
      readFile: vi.fn().mockResolvedValue({
        path: 'src/index.ts',
        absPath: '/repos/demo/src/index.ts',
        content: 'a\nb\nc',
        lineCount: 3,
      }),
    });

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 1, username: 'testuser' } as never;
      next();
    });
    app.use('/api', atlasRoutes);
  });

  describe('membership / existence (all endpoints)', () => {
    it.each([
      ['/api/tasks/42/atlas/tree'],
      ['/api/tasks/42/atlas/file?path=src/index.ts'],
      ['/api/tasks/42/atlas/artifacts'],
      ['/api/tasks/42/atlas/artifact/plan'],
    ])('404s %s for a missing task', async (url) => {
      mockGetWithProject.mockReturnValue(undefined);
      const res = await request(app).get(url);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Task not found' });
    });

    it.each([
      ['/api/tasks/42/atlas/tree'],
      ['/api/tasks/42/atlas/file?path=src/index.ts'],
      ['/api/tasks/42/atlas/artifacts'],
      ['/api/tasks/42/atlas/artifact/plan'],
    ])('404s %s for a foreign task (no membership)', async (url) => {
      vi.mocked(hasProjectAccess).mockReturnValue(false);
      const res = await request(app).get(url);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Task not found' });
    });

    it('400s a non-numeric task id', async () => {
      const res = await request(app).get('/api/tasks/abc/atlas/tree');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('GET /tasks/:id/atlas/tree', () => {
    it('lists the workspace root when no path is given', async () => {
      const res = await request(app).get('/api/tasks/42/atlas/tree');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { name: 'src', path: 'src', type: 'dir' },
        { name: 'README.md', path: 'README.md', type: 'file' },
      ]);
      const ws = await mockGetWorkspaceForTask.mock.results[0]!.value;
      expect(ws.listDir).toHaveBeenCalledWith('');
    });

    it('passes the requested subdirectory through', async () => {
      await request(app).get('/api/tasks/42/atlas/tree?path=src');
      const ws = await mockGetWorkspaceForTask.mock.results[0]!.value;
      expect(ws.listDir).toHaveBeenCalledWith('src');
    });

    it('maps containment violations to 400', async () => {
      mockGetWorkspaceForTask.mockResolvedValue({
        listDir: vi
          .fn()
          .mockRejectedValue(new WorkspaceError('Path "../x" is outside the project root')),
      });
      const res = await request(app).get('/api/tasks/42/atlas/tree?path=../x');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('outside the project root');
    });
  });

  describe('GET /tasks/:id/atlas/file', () => {
    it('returns the file payload without leaking the absolute path', async () => {
      const res = await request(app).get('/api/tasks/42/atlas/file?path=src/index.ts');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ path: 'src/index.ts', content: 'a\nb\nc', lineCount: 3 });
      expect(res.body.absPath).toBeUndefined();
    });

    it('400s when path is missing', async () => {
      const res = await request(app).get('/api/tasks/42/atlas/file');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('maps missing files to 404 and other workspace errors to 400', async () => {
      const readFile = vi
        .fn()
        .mockRejectedValueOnce(new WorkspaceError('File not found: nope.ts'))
        .mockRejectedValueOnce(new WorkspaceError('"big.bin" appears to be a binary file'));
      mockGetWorkspaceForTask.mockResolvedValue({ readFile });

      const missing = await request(app).get('/api/tasks/42/atlas/file?path=nope.ts');
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe('File not found: nope.ts');

      const binary = await request(app).get('/api/tasks/42/atlas/file?path=big.bin');
      expect(binary.status).toBe(400);
      expect(binary.body.error).toContain('binary file');
    });

    it('500s on unexpected errors', async () => {
      mockGetWorkspaceForTask.mockRejectedValue(new Error('disk on fire'));
      const res = await request(app).get('/api/tasks/42/atlas/file?path=src/index.ts');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to read file');
    });
  });

  describe('GET /tasks/:id/atlas/artifacts', () => {
    it('returns the per-kind summaries (no html)', async () => {
      mockArtifactsList.mockReturnValue([
        { task_id: 42, kind: 'flowchart', title: 'Flow', updated_at: '2026-06-12 10:00:00' },
        { task_id: 42, kind: 'plan', title: 'Plan', updated_at: '2026-06-12 11:00:00' },
      ]);
      const res = await request(app).get('/api/tasks/42/atlas/artifacts');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        artifacts: [
          { taskId: 42, kind: 'flowchart', title: 'Flow', updatedAt: '2026-06-12 10:00:00' },
          { taskId: 42, kind: 'plan', title: 'Plan', updatedAt: '2026-06-12 11:00:00' },
        ],
      });
    });

    it('returns an empty list when the task has no artifacts', async () => {
      mockArtifactsList.mockReturnValue([]);
      const res = await request(app).get('/api/tasks/42/atlas/artifacts');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ artifacts: [] });
    });
  });

  describe('GET /tasks/:id/atlas/artifact/:kind', () => {
    it('returns the artifact incl. html', async () => {
      mockArtifactGet.mockReturnValue({
        task_id: 42,
        kind: 'plan',
        title: 'Plan',
        html: '<!doctype html><html></html>',
        updated_at: '2026-06-12 10:00:00',
      });
      const res = await request(app).get('/api/tasks/42/atlas/artifact/plan');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        artifact: {
          taskId: 42,
          kind: 'plan',
          title: 'Plan',
          html: '<!doctype html><html></html>',
          updatedAt: '2026-06-12 10:00:00',
        },
      });
      expect(mockArtifactGet).toHaveBeenCalledWith(42, 'plan');
    });

    it('returns null when the kind has no artifact', async () => {
      mockArtifactGet.mockReturnValue(undefined);
      const res = await request(app).get('/api/tasks/42/atlas/artifact/architecture');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ artifact: null });
    });

    it('400s an unknown kind param', async () => {
      const res = await request(app).get('/api/tasks/42/atlas/artifact/nope');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('POST /tasks/:id/atlas/generate-artifact', () => {
    // A full settings map whose `schema` entry is what the route should use.
    const SETTINGS_WITH_SCHEMA = {
      planification: { provider: 'anthropic', model: 'sonnet', effort: 'high' },
      implementation: { provider: 'anthropic', model: 'sonnet', effort: 'high' },
      refinement: { provider: 'anthropic', model: 'sonnet', effort: 'high' },
      review: { provider: 'anthropic', model: 'sonnet', effort: 'high' },
      pr: { provider: 'anthropic', model: 'sonnet', effort: 'high' },
      yolo: { provider: 'anthropic', model: 'sonnet', effort: 'high' },
      schema: { provider: 'anthropic', model: 'opus', effort: 'max' },
    };

    beforeEach(() => {
      // Default: no generation already in flight for this task.
      mockGetOngoingAtlasGeneration.mockReturnValue(null);
      mockConversationsDb.create.mockReturnValue({ id: 99, task_id: 42 });
      mockConversationsDb.getById.mockReturnValue({
        id: 99,
        task_id: 42,
        atlas_enabled: 1,
        provider: 'anthropic',
        model: 'opus',
      });
      mockRenderPrompt.mockReturnValue('rendered atlas prompt');
      mockStartConversation.mockResolvedValue({
        conversationId: 99,
        claudeSessionId: 'sess-1',
      });
      mockLoadAgentModelSettings.mockReturnValue(SETTINGS_WITH_SCHEMA);
    });

    it('creates an atlas-flagged conversation using the schema setting model+effort', async () => {
      const res = await request(app)
        .post('/api/tasks/42/atlas/generate-artifact')
        .send({ kind: 'auto' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: 99, claude_conversation_id: 'sess-1' });

      expect(mockValidateClaudeCredentials).toHaveBeenCalledWith(1);
      expect(mockLoadAgentModelSettings).toHaveBeenCalledWith(1);
      // Model + effort come from the user's `schema` setting, not the body.
      expect(mockConversationsDb.create).toHaveBeenCalledWith(42, 'anthropic', 'opus', 'max');
      // Stamped BEFORE the session starts so SDK injection sees the flag.
      expect(mockConversationsDb.setAtlasEnabled).toHaveBeenCalledWith(99);
      expect(mockRenderPrompt).toHaveBeenCalledWith('atlas-artifact', {
        taskDocPath: '/home/u/.bottega/projects/3/tasks/task-42.md',
        taskId: 42,
        kind: 'auto',
        styleRefsDir: '/abs/server/constants/atlas-style-refs',
      });
      expect(mockStartConversation).toHaveBeenCalledWith(
        { kind: 'task', taskId: 42 },
        'rendered atlas prompt',
        expect.objectContaining({
          userId: 1,
          conversationId: 99,
          provider: 'anthropic',
          model: 'opus',
          effort: 'max',
          permissionMode: 'bypassPermissions',
          customSystemPrompt: 'context prompt',
        }),
      );
    });

    it('binds to an ongoing generation instead of spawning a duplicate (idempotent re-entry)', async () => {
      // Simulate the bug scenario: a plan generation is already streaming for
      // this task (conversation 77). Re-opening the Explore view re-fires the
      // POST; it must return the running conversation, not start a second turn.
      mockGetOngoingAtlasGeneration.mockReturnValue(77);
      mockConversationsDb.getById.mockReturnValue({
        id: 77,
        task_id: 42,
        atlas_enabled: 1,
        provider: 'anthropic',
        model: 'opus',
        claude_conversation_id: 'sess-running',
      });

      const res = await request(app)
        .post('/api/tasks/42/atlas/generate-artifact')
        .send({ kind: 'plan' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: 77, claude_conversation_id: 'sess-running' });
      expect(mockGetOngoingAtlasGeneration).toHaveBeenCalledWith(42);
      // No second generation: nothing created, no session started.
      expect(mockConversationsDb.create).not.toHaveBeenCalled();
      expect(mockStartConversation).not.toHaveBeenCalled();
      // Short-circuits before credential/settings work too.
      expect(mockValidateClaudeCredentials).not.toHaveBeenCalled();
    });

    it('passes a concrete forced kind through to the prompt', async () => {
      await request(app)
        .post('/api/tasks/42/atlas/generate-artifact')
        .send({ kind: 'flowchart' });

      expect(mockRenderPrompt).toHaveBeenCalledWith(
        'atlas-artifact',
        expect.objectContaining({ kind: 'flowchart' }),
      );
    });

    it('rejects an unknown kind', async () => {
      const res = await request(app)
        .post('/api/tasks/42/atlas/generate-artifact')
        .send({ kind: 'mindmap' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(mockConversationsDb.create).not.toHaveBeenCalled();
    });

    it('fails loud (409) when the user has no valid schema settings — no fallback model', async () => {
      mockLoadAgentModelSettings.mockImplementationOnce(() => {
        throw new MissingUserAgentSettingsError(1, 'no settings row');
      });
      const res = await request(app)
        .post('/api/tasks/42/atlas/generate-artifact')
        .send({ kind: 'auto' });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('Schema model');
      expect(mockConversationsDb.create).not.toHaveBeenCalled();
    });

    it('fails before creating anything when Claude credentials are missing', async () => {
      // `…Once` so the throwing implementation doesn't leak into later cases
      // (clearAllMocks resets call history, not implementations).
      mockValidateClaudeCredentials.mockImplementationOnce(() => {
        throw new Error('No Claude OAuth token');
      });
      const res = await request(app)
        .post('/api/tasks/42/atlas/generate-artifact')
        .send({ kind: 'auto' });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('No Claude OAuth token');
      expect(mockConversationsDb.create).not.toHaveBeenCalled();
    });

    it('cleans up the conversation when the session fails to start', async () => {
      mockStartConversation.mockRejectedValue(new Error('boom'));
      const res = await request(app)
        .post('/api/tasks/42/atlas/generate-artifact')
        .send({ kind: 'auto' });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('boom');
      expect(mockConversationsDb.delete).toHaveBeenCalledWith(99);
    });
  });
});
