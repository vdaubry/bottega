import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../database/db.js', () => ({
  conversationsDb: {
    getByEpic: vi.fn(),
    createForEpic: vi.fn(),
    getById: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../database/epics.js', () => ({
  epicsDb: {
    create: vi.fn(),
    getById: vi.fn(),
    getWithProject: vi.fn(),
    listByProject: vi.fn(),
    update: vi.fn(),
    setStageComplete: vi.fn(),
    setOrchestrationActive: vi.fn(),
    setOrchestrationBlocked: vi.fn(),
    delete: vi.fn(),
  },
  epicAgentRunsDb: {
    getByEpic: vi.fn(),
  },
  epicTicketsDb: {
    listTickets: vi.fn(),
  },
}));

vi.mock('../services/projectService.js', () => ({
  getProject: vi.fn(),
  hasProjectAccess: vi.fn(),
}));

vi.mock('../services/epics/epicAgentRunner.js', () => ({
  startEpicAgentRun: vi.fn(),
  getRunningAgentForEpic: vi.fn(),
  EpicQaFixConflictError: class EpicQaFixConflictError extends Error {},
}));

vi.mock('../services/epics/ticketService.js', () => ({
  createEpicTicket: vi.fn(),
  EpicNotInProjectError: class EpicNotInProjectError extends Error {},
}));

vi.mock('../services/epics/epicBranch.js', () => ({
  createEpicCompletionPR: vi.fn(),
  removeEpicDeliveryWorktree: vi.fn().mockResolvedValue({ removed: false }),
}));

vi.mock('../services/epics/orchestrator/bridge.js', () => ({
  resetBridgeCounters: vi.fn(),
}));

vi.mock('../services/epics/orchestrator/blocking.js', () => ({
  blockOrchestration: vi.fn(),
}));

vi.mock('../services/epics/orchestrator/sequencing.js', () => ({
  advance: vi.fn().mockResolvedValue(undefined),
  wakeOrchestrator: vi.fn(),
}));

vi.mock('../services/conversationAdapter.js', () => ({
  startConversation: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/conversation/sessionControl.js', () => ({
  abortSession: vi.fn().mockResolvedValue(true),
  getActiveStreamingByConversation: vi.fn().mockReturnValue(null),
}));

vi.mock('../services/conversationContentStore.js', () => ({
  purgeConversationMessages: vi.fn(),
}));

vi.mock('../services/epics/epicArchive.js', () => ({
  buildEpicContextPrompt: vi.fn().mockReturnValue('epic context'),
  deleteEpicArchive: vi.fn(),
  deleteEpicSpecFile: vi.fn(),
  ensureEpicDirs: vi.fn(),
  epicQaScenariosCsvExists: vi.fn().mockReturnValue(true),
  listEpicArchitectureDocs: vi.fn(),
  listEpicDocs: vi.fn(),
  listEpicQaFiles: vi.fn(),
  listEpicReviewDocs: vi.fn(),
  listEpicSpecFiles: vi.fn(),
  readEpicArchitectureDoc: vi.fn(),
  readEpicDoc: vi.fn(),
  readEpicQaFile: vi.fn(),
  readEpicReviewDoc: vi.fn(),
  readEpicSpecFile: vi.fn(),
  saveEpicSpecFile: vi.fn(),
}));

// Route code only needs the class identity for its instanceof check; mocking
// keeps the heavy provider/credential import chain out of this test.
vi.mock('../services/agentModelSettings.js', () => {
  class MissingUserAgentSettingsError extends Error {}
  return { MissingUserAgentSettingsError, loadAgentModelSettings: vi.fn() };
});

import epicsRoutes from './epics.js';
import { conversationsDb } from '../database/db.js';
import { epicsDb, epicAgentRunsDb, epicTicketsDb } from '../database/epics.js';
import { getProject, hasProjectAccess } from '../services/projectService.js';
import { startEpicAgentRun, getRunningAgentForEpic } from '../services/epics/epicAgentRunner.js';
import { createEpicCompletionPR } from '../services/epics/epicBranch.js';
import { createEpicTicket } from '../services/epics/ticketService.js';
import { blockOrchestration } from '../services/epics/orchestrator/blocking.js';
import { advance, wakeOrchestrator } from '../services/epics/orchestrator/sequencing.js';
import { sendMessage } from '../services/conversationAdapter.js';
import { getActiveStreamingByConversation } from '../services/conversation/sessionControl.js';
import {
  deleteEpicArchive,
  epicQaScenariosCsvExists,
  listEpicArchitectureDocs,
  listEpicDocs,
  listEpicQaFiles,
  listEpicReviewDocs,
  readEpicArchitectureDoc,
  readEpicDoc,
  readEpicQaFile,
  readEpicReviewDoc,
  saveEpicSpecFile,
} from '../services/epics/epicArchive.js';
import { MissingUserAgentSettingsError } from '../services/agentModelSettings.js';
import { ProviderCredentialsMissingError } from '../services/credentials/types.js';

const PROJECT = { id: 7, repo_folder_path: '/tmp/repo', name: 'Proj' };

const EPIC = {
  id: 42,
  project_id: 7,
  user_id: 1,
  name: 'Company Quests',
  slug: 'company-quests',
  status: 'active',
  architecture_complete: 0,
  specs_complete: 0,
  stories_complete: 0,
  review_complete: 0,
  feature_branch: null,
  created_at: '2026-08-03 10:00:00',
  updated_at: '2026-08-03 10:00:00',
  completed_at: null,
};

const AGENT_RUN = {
  id: 9,
  epic_id: 42,
  ticket_task_id: null,
  agent_type: 'epic-architecture',
  status: 'running',
  conversation_id: 5,
  provider: 'anthropic',
  created_at: '2026-08-03 10:01:00',
  completed_at: null,
} as unknown as import('../../shared/types/db.js').EpicAgentRunRow;

describe('Epic Routes', () => {
  let app: import('express').Application;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProject).mockReturnValue(PROJECT as never);
    vi.mocked(hasProjectAccess).mockReturnValue(true);
    vi.mocked(epicsDb.getById).mockReturnValue(EPIC as never);
    vi.mocked(epicAgentRunsDb.getByEpic).mockReturnValue([]);
    vi.mocked(getActiveStreamingByConversation).mockReturnValue(null);

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 1, username: 'testuser' } as never;
      next();
    });
    app.use('/api', epicsRoutes);
  });

  describe('POST /api/projects/:projectId/epics', () => {
    it('creates an epic from multipart name + spec files (201) without starting an agent', async () => {
      vi.mocked(epicsDb.create).mockReturnValue(EPIC as never);

      const response = await request(app)
        .post('/api/projects/7/epics')
        .field('name', 'Company Quests')
        .attach('files', Buffer.from('# Spec'), 'spec.md')
        .attach('files', Buffer.from('<html></html>'), 'proto.html');

      expect(response.status).toBe(201);
      expect(response.body).toEqual(EPIC);
      expect(epicsDb.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 7, userId: 1, name: 'Company Quests' }),
      );
      expect(saveEpicSpecFile).toHaveBeenCalledTimes(2);
      expect(startEpicAgentRun).not.toHaveBeenCalled();
    });

    it('rejects an unsupported spec file extension (400)', async () => {
      const response = await request(app)
        .post('/api/projects/7/epics')
        .field('name', 'Company Quests')
        .attach('files', Buffer.from('%PDF'), 'spec.pdf');

      expect(response.status).toBe(400);
      expect(epicsDb.create).not.toHaveBeenCalled();
    });

    it('requires a name (400)', async () => {
      const response = await request(app)
        .post('/api/projects/7/epics')
        .attach('files', Buffer.from('# Spec'), 'spec.md');

      expect(response.status).toBe(400);
    });

    it('answers 404 for a project the user cannot see', async () => {
      vi.mocked(getProject).mockReturnValue(undefined);

      const response = await request(app)
        .post('/api/projects/7/epics')
        .field('name', 'Company Quests')
        .attach('files', Buffer.from('# Spec'), 'spec.md');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/epics/:id', () => {
    it('returns the epic', async () => {
      const response = await request(app).get('/api/epics/42');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(EPIC);
    });

    it('answers 404 (not 403) for an epic in a foreign project', async () => {
      vi.mocked(hasProjectAccess).mockReturnValue(false);
      const response = await request(app).get('/api/epics/42');
      expect(response.status).toBe(404);
    });

    it('answers 404 for an unknown epic', async () => {
      vi.mocked(epicsDb.getById).mockReturnValue(undefined);
      const response = await request(app).get('/api/epics/42');
      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/epics/:id', () => {
    it('updates the name', async () => {
      vi.mocked(epicsDb.update).mockReturnValue({ ...EPIC, name: 'Renamed' } as never);
      const response = await request(app).patch('/api/epics/42').send({ name: 'Renamed' });
      expect(response.status).toBe(200);
      expect(epicsDb.update).toHaveBeenCalledWith(42, { name: 'Renamed' });
    });

    it('rejects an empty body (400)', async () => {
      const response = await request(app).patch('/api/epics/42').send({});
      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/epics/:id/stages/:stage/complete', () => {
    it('sets the flag for the stage the pipeline calls by that name', async () => {
      vi.mocked(epicsDb.setStageComplete).mockReturnValue({
        ...EPIC,
        specs_complete: 1,
      } as never);

      const response = await request(app).post('/api/epics/42/stages/specification/complete');

      expect(response.status).toBe(200);
      // 'specification' is the pipeline's word; 'specs' is the column's.
      expect(epicsDb.setStageComplete).toHaveBeenCalledWith(42, 'specs');
      expect(response.body.specs_complete).toBe(1);
    });

    it('refuses a stage that is already signed off (409)', async () => {
      vi.mocked(epicsDb.getById).mockReturnValue({
        ...EPIC,
        architecture_complete: 1,
      } as never);

      const response = await request(app).post('/api/epics/42/stages/architecture/complete');

      expect(response.status).toBe(409);
      expect(epicsDb.setStageComplete).not.toHaveBeenCalled();
    });

    it("sets the review flag by hand — accepting the reviewer's findings as they stand", async () => {
      vi.mocked(epicsDb.setStageComplete).mockReturnValue({
        ...EPIC,
        review_complete: 1,
      } as never);

      const response = await request(app).post('/api/epics/42/stages/review/complete');

      expect(response.status).toBe(200);
      expect(epicsDb.setStageComplete).toHaveBeenCalledWith(42, 'review');
      expect(response.body.review_complete).toBe(1);
    });

    it('sets the qa flag by hand — the backstop for the scenario sign-off', async () => {
      vi.mocked(epicsDb.setStageComplete).mockReturnValue({
        ...EPIC,
        qa_complete: 1,
      } as never);

      const response = await request(app).post('/api/epics/42/stages/qa/complete');

      expect(response.status).toBe(200);
      expect(epicsDb.setStageComplete).toHaveBeenCalledWith(42, 'qa');
      expect(response.body.qa_complete).toBe(1);
    });

    it('refuses the implementation stage — it has no flag (400)', async () => {
      const response = await request(app).post('/api/epics/42/stages/implementation/complete');

      expect(response.status).toBe(400);
      expect(epicsDb.setStageComplete).not.toHaveBeenCalled();
    });

    it('rejects a stage name that is not in the pipeline (400)', async () => {
      const response = await request(app).post('/api/epics/42/stages/deployment/complete');

      expect(response.status).toBe(400);
    });

    it('answers 404 (not 403) for an epic in a foreign project', async () => {
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).post('/api/epics/42/stages/architecture/complete');

      expect(response.status).toBe(404);
      expect(epicsDb.setStageComplete).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/epics/:id', () => {
    it('purges conversations, deletes the rows and removes the archive', async () => {
      vi.mocked(conversationsDb.getByEpic).mockReturnValue([{ id: 5 }] as never);
      vi.mocked(epicsDb.delete).mockReturnValue(true);

      const response = await request(app).delete('/api/epics/42');

      expect(response.status).toBe(200);
      expect(epicsDb.delete).toHaveBeenCalledWith(42);
      expect(deleteEpicArchive).toHaveBeenCalledWith(7, 42);
    });
  });

  describe('GET /api/epics/:id/docs', () => {
    it('lists the technical-spec documents', async () => {
      vi.mocked(listEpicDocs).mockReturnValue([
        { name: '00-master.md', size: 12, mimeType: 'text/markdown', modifiedAtMs: 123 },
      ] as never);

      const response = await request(app).get('/api/epics/42/docs');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        { name: '00-master.md', size: 12, mimeType: 'text/markdown', modifiedAtMs: 123 },
      ]);
    });

    it('cannot be used to read outside the docs directory', async () => {
      vi.mocked(readEpicDoc).mockReturnValue(null);

      const response = await request(app).get(
        `/api/epics/42/docs/${encodeURIComponent('../../.env')}`,
      );

      // The service reduces the name to a basename, so the traversal simply
      // resolves to a file that isn't there.
      expect(response.status).toBe(404);
      expect(readEpicDoc).toHaveBeenCalledWith(7, 42, '../../.env');
    });
  });

  describe('GET /api/epics/:id/architecture', () => {
    it('lists the architecture document files', async () => {
      vi.mocked(listEpicArchitectureDocs).mockReturnValue([
        { name: 'architecture.md', size: 40, mimeType: 'text/markdown', modifiedAtMs: 456 },
      ] as never);

      const response = await request(app).get('/api/epics/42/architecture');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        { name: 'architecture.md', size: 40, mimeType: 'text/markdown', modifiedAtMs: 456 },
      ]);
      expect(listEpicArchitectureDocs).toHaveBeenCalledWith(7, 42);
    });

    it('reads one architecture file by name', async () => {
      vi.mocked(readEpicArchitectureDoc).mockReturnValue('# Topics\n\n```mermaid\nflowchart LR\n```');

      const response = await request(app).get('/api/epics/42/architecture/architecture.md');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        filename: 'architecture.md',
        content: '# Topics\n\n```mermaid\nflowchart LR\n```',
      });
      expect(readEpicArchitectureDoc).toHaveBeenCalledWith(7, 42, 'architecture.md');
    });

    it('answers 404 for a file that is not there', async () => {
      vi.mocked(readEpicArchitectureDoc).mockReturnValue(null);

      const response = await request(app).get('/api/epics/42/architecture/missing.md');

      expect(response.status).toBe(404);
    });

    it('cannot be used to read outside the architecture directory', async () => {
      vi.mocked(readEpicArchitectureDoc).mockReturnValue(null);

      const response = await request(app).get(
        `/api/epics/42/architecture/${encodeURIComponent('../../.env')}`,
      );

      expect(response.status).toBe(404);
      expect(readEpicArchitectureDoc).toHaveBeenCalledWith(7, 42, '../../.env');
    });
  });

  describe('GET /api/epics/:id/review', () => {
    it('lists the review report file(s)', async () => {
      vi.mocked(listEpicReviewDocs).mockReturnValue([
        { name: 'review.md', size: 10, mimeType: 'text/markdown', modifiedAtMs: 1 },
      ] as never);

      const response = await request(app).get('/api/epics/42/review');

      expect(response.status).toBe(200);
      expect(listEpicReviewDocs).toHaveBeenCalledWith(7, 42);
      expect(response.body[0].name).toBe('review.md');
    });

    it('reads the report by basename only, like the other document routes', async () => {
      vi.mocked(readEpicReviewDoc).mockReturnValue('# Specification review');

      const response = await request(app).get('/api/epics/42/review/..%2F..%2Freview.md');

      expect(response.status).toBe(200);
      expect(readEpicReviewDoc).toHaveBeenCalledWith(7, 42, '../../review.md');
      expect(response.body).toEqual({ filename: 'review.md', content: '# Specification review' });
    });

    it('answers 404 for a report that is not there', async () => {
      vi.mocked(readEpicReviewDoc).mockReturnValue(null);

      const response = await request(app).get('/api/epics/42/review/review.md');

      expect(response.status).toBe(404);
    });
  });

  describe('the QA file routes', () => {
    it('lists the qa files', async () => {
      vi.mocked(listEpicQaFiles).mockReturnValue([
        { name: 'scenarios.csv', size: 10, mimeType: 'text/csv', modifiedAtMs: 1 },
      ] as never);

      const response = await request(app).get('/api/epics/42/qa');

      expect(response.status).toBe(200);
      expect(listEpicQaFiles).toHaveBeenCalledWith(7, 42);
      expect(response.body[0].mimeType).toBe('text/csv');
    });

    it('reads the book by basename only, like the other document routes', async () => {
      vi.mocked(readEpicQaFile).mockReturnValue('id,feature\n');

      const response = await request(app).get('/api/epics/42/qa/..%2F..%2Fscenarios.csv');

      expect(response.status).toBe(200);
      expect(readEpicQaFile).toHaveBeenCalledWith(7, 42, '../../scenarios.csv');
      expect(response.body).toEqual({ filename: 'scenarios.csv', content: 'id,feature\n' });
    });

    it('answers 404 for a book that is not there', async () => {
      vi.mocked(readEpicQaFile).mockReturnValue(null);

      const response = await request(app).get('/api/epics/42/qa/scenarios.csv');

      expect(response.status).toBe(404);
    });

    it('serves the raw CSV bytes as an attachment on the download route', async () => {
      vi.mocked(readEpicQaFile).mockReturnValue('id,feature\nS-001,Login\n');

      const response = await request(app).get('/api/epics/42/qa/scenarios.csv/download');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="scenarios.csv"',
      );
      expect(response.text).toBe('id,feature\nS-001,Login\n');
    });

    it('answers 404 on the download route for a missing file', async () => {
      vi.mocked(readEpicQaFile).mockReturnValue(null);

      const response = await request(app).get('/api/epics/42/qa/scenarios.csv/download');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/epics/:id/tasks', () => {
    it('returns the epic tickets in execution order', async () => {
      vi.mocked(epicTicketsDb.listTickets).mockReturnValue([
        { id: 1, epic_id: 42, epic_order: 1 },
      ] as never);

      const response = await request(app).get('/api/epics/42/tasks');

      expect(response.status).toBe(200);
      expect(epicTicketsDb.listTickets).toHaveBeenCalledWith(42);
    });
  });

  describe('POST /api/epics/:id/tasks', () => {
    it('creates a ticket through the epic ticket service (201)', async () => {
      vi.mocked(createEpicTicket).mockResolvedValue({
        success: true,
        task: { id: 5, title: 'Ticket', epic_id: 42, epic_order: 2 },
        baseBranch: 'epic/42-nimbus',
        warning: 'the feature branch is local-only',
      } as never);

      const response = await request(app)
        .post('/api/epics/42/tasks')
        .send({ title: 'Ticket', description: 'Do it', epic_order: 2 });

      expect(response.status).toBe(201);
      expect(createEpicTicket).toHaveBeenCalledWith(
        42,
        { title: 'Ticket', description: 'Do it', epicOrder: 2 },
        1,
      );
      expect(response.body.base_branch).toBe('epic/42-nimbus');
      expect(response.body.warning).toContain('local-only');
    });

    it('answers 500 with the service error when creation fails', async () => {
      vi.mocked(createEpicTicket).mockResolvedValue({
        success: false,
        error: 'Failed to create worktree: no origin',
      });

      const response = await request(app).post('/api/epics/42/tasks').send({ title: 'T' });

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('no origin');
    });

    it('hides an inaccessible epic as 404', async () => {
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).post('/api/epics/42/tasks').send({ title: 'T' });

      expect(response.status).toBe(404);
      expect(createEpicTicket).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/epics/:id/agent-runs', () => {
    it('starts the architecture stage (201)', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
      vi.mocked(startEpicAgentRun).mockResolvedValue({ agentRun: AGENT_RUN } as never);

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-architecture' });

      expect(response.status).toBe(201);
      expect(response.body).toEqual(AGENT_RUN);
      expect(startEpicAgentRun).toHaveBeenCalledWith(
        42,
        'epic-architecture',
        expect.objectContaining({ userId: 1 }),
      );
    });

    it('rejects an unknown agent type (400)', async () => {
      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'planification' });

      expect(response.status).toBe(400);
      expect(startEpicAgentRun).not.toHaveBeenCalled();
    });

    it('answers 409 while another stage is running', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(AGENT_RUN);

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-architecture' });

      expect(response.status).toBe(409);
      expect(response.body.runningAgent).toMatchObject({ id: 9 });
      expect(startEpicAgentRun).not.toHaveBeenCalled();
    });

    it('gates the specification stage behind the architecture stage (409)', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-specification' });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/architecture stage first/i);
      expect(startEpicAgentRun).not.toHaveBeenCalled();
    });

    it('starts the specification stage once the diagrams exist (201)', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
      vi.mocked(epicsDb.getById).mockReturnValue({ ...EPIC, architecture_complete: 1 } as never);

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-specification' });

      expect(response.status).toBe(201);
      expect(startEpicAgentRun).toHaveBeenCalledWith(
        42,
        'epic-specification',
        expect.objectContaining({ userId: 1 }),
      );
    });

    it('gates the stories stage behind the approved specification (409)', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
      vi.mocked(epicsDb.getById).mockReturnValue({ ...EPIC, architecture_complete: 1 } as never);

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-stories' });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/technical specification first/i);
      expect(startEpicAgentRun).not.toHaveBeenCalled();
    });

    it('starts the stories stage once the specification is signed off (201)', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
      vi.mocked(epicsDb.getById).mockReturnValue({
        ...EPIC,
        architecture_complete: 1,
        specs_complete: 1,
      } as never);

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-stories' });

      expect(response.status).toBe(201);
      expect(startEpicAgentRun).toHaveBeenCalledWith(
        42,
        'epic-stories',
        expect.objectContaining({ userId: 1 }),
      );
    });

    it('gates the specification review behind the approved ticket list (409)', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
      vi.mocked(epicsDb.getById).mockReturnValue({
        ...EPIC,
        architecture_complete: 1,
        specs_complete: 1,
      } as never);

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-spec-review' });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/approve the epic tickets first/i);
      expect(startEpicAgentRun).not.toHaveBeenCalled();
    });

    it('starts the specification review once the stories stage is signed off (201)', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
      vi.mocked(epicsDb.getById).mockReturnValue({
        ...EPIC,
        architecture_complete: 1,
        specs_complete: 1,
        stories_complete: 1,
      } as never);

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-spec-review' });

      expect(response.status).toBe(201);
      expect(startEpicAgentRun).toHaveBeenCalledWith(
        42,
        'epic-spec-review',
        expect.objectContaining({ userId: 1 }),
      );
    });

    it('still refuses the orchestrator, even with its gate open', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
      vi.mocked(epicsDb.getById).mockReturnValue({
        ...EPIC,
        architecture_complete: 1,
        specs_complete: 1,
        stories_complete: 1,
      } as never);

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-orchestrator' });

      expect(response.status).toBe(409);
      expect(startEpicAgentRun).not.toHaveBeenCalled();
    });

    it('refuses the PR reviewer too — it is started per ticket by the orchestration', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
      vi.mocked(epicsDb.getById).mockReturnValue({
        ...EPIC,
        architecture_complete: 1,
        specs_complete: 1,
        stories_complete: 1,
      } as never);

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-pr-review' });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/started per ticket/);
      expect(startEpicAgentRun).not.toHaveBeenCalled();
    });

    // Delivery is not a stage: no predecessor flag gates it, and a comment can
    // land on the final pull request at any point, so it deliberately does NOT
    // wait for every ticket to merge. The one precondition is the branch.
    it('starts delivery without any stage flag once the feature branch exists (201)', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
      vi.mocked(epicsDb.getById).mockReturnValue({
        ...EPIC,
        architecture_complete: 0,
        specs_complete: 0,
        stories_complete: 0,
        review_complete: 0,
        feature_branch: 'epic/42-nimbus',
      } as never);

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-delivery' });

      expect(response.status).toBe(201);
      expect(startEpicAgentRun).toHaveBeenCalledWith(
        42,
        'epic-delivery',
        expect.objectContaining({ userId: 1 }),
      );
    });

    it('refuses delivery before the epic has a feature branch (409)', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
      vi.mocked(epicsDb.getById).mockReturnValue({ ...EPIC, feature_branch: null } as never);

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-delivery' });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/no feature branch yet/i);
      expect(startEpicAgentRun).not.toHaveBeenCalled();
    });

    it('gates the QA scenario writer behind the signed-off review (409)', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
      vi.mocked(epicsDb.getById).mockReturnValue({ ...EPIC, review_complete: 0 } as never);

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-qa-scenarios' });

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/specification review/i);
      expect(startEpicAgentRun).not.toHaveBeenCalled();
    });

    it('starts the QA scenario writer once the review is signed off (201)', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
      vi.mocked(epicsDb.getById).mockReturnValue({ ...EPIC, review_complete: 1 } as never);

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-qa-scenarios' });

      expect(response.status).toBe(201);
      expect(startEpicAgentRun).toHaveBeenCalledWith(
        42,
        'epic-qa-scenarios',
        expect.objectContaining({ userId: 1 }),
      );
    });

    describe('the QA execution gate', () => {
      const qaReadyEpic = {
        ...EPIC,
        review_complete: 1,
        qa_complete: 1,
        feature_branch: 'epic/42-nimbus',
      };

      beforeEach(() => {
        vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
        vi.mocked(epicTicketsDb.listTickets).mockReturnValue([
          { id: 101, status: 'completed' },
          { id: 102, status: 'completed' },
        ] as never);
        vi.mocked(epicQaScenariosCsvExists).mockReturnValue(true);
      });

      it('starts once the book is approved, every ticket merged and the CSV on disk (201)', async () => {
        vi.mocked(epicsDb.getById).mockReturnValue(qaReadyEpic as never);

        const response = await request(app)
          .post('/api/epics/42/agent-runs')
          .send({ agentType: 'epic-qa-execution' });

        expect(response.status).toBe(201);
        expect(startEpicAgentRun).toHaveBeenCalledWith(
          42,
          'epic-qa-execution',
          expect.objectContaining({ userId: 1 }),
        );
      });

      it('refuses before the scenario book is approved (409)', async () => {
        vi.mocked(epicsDb.getById).mockReturnValue({ ...qaReadyEpic, qa_complete: 0 } as never);

        const response = await request(app)
          .post('/api/epics/42/agent-runs')
          .send({ agentType: 'epic-qa-execution' });

        expect(response.status).toBe(409);
        expect(response.body.error).toMatch(/approve the QA scenarios/i);
        expect(startEpicAgentRun).not.toHaveBeenCalled();
      });

      it('refuses while any ticket is unmerged, naming them (409)', async () => {
        vi.mocked(epicsDb.getById).mockReturnValue(qaReadyEpic as never);
        vi.mocked(epicTicketsDb.listTickets).mockReturnValue([
          { id: 101, status: 'completed' },
          { id: 102, status: 'in_progress' },
        ] as never);

        const response = await request(app)
          .post('/api/epics/42/agent-runs')
          .send({ agentType: 'epic-qa-execution' });

        expect(response.status).toBe(409);
        expect(response.body.error).toContain('#102');
        expect(startEpicAgentRun).not.toHaveBeenCalled();
      });

      it('refuses when the flag was backstopped but no CSV exists (409)', async () => {
        vi.mocked(epicsDb.getById).mockReturnValue(qaReadyEpic as never);
        vi.mocked(epicQaScenariosCsvExists).mockReturnValue(false);

        const response = await request(app)
          .post('/api/epics/42/agent-runs')
          .send({ agentType: 'epic-qa-execution' });

        expect(response.status).toBe(409);
        expect(response.body.error).toMatch(/no scenarios\.csv/i);
        expect(startEpicAgentRun).not.toHaveBeenCalled();
      });

      it('refuses before the epic has a feature branch (409)', async () => {
        vi.mocked(epicsDb.getById).mockReturnValue({
          ...qaReadyEpic,
          feature_branch: null,
        } as never);

        const response = await request(app)
          .post('/api/epics/42/agent-runs')
          .send({ agentType: 'epic-qa-execution' });

        expect(response.status).toBe(409);
        expect(response.body.error).toMatch(/no feature branch yet/i);
        expect(startEpicAgentRun).not.toHaveBeenCalled();
      });
    });

    describe('the epic-qa-fix gate', () => {
      const fixReadyEpic = {
        ...EPIC,
        review_complete: 1,
        qa_complete: 1,
        feature_branch: 'epic/42-nimbus',
        orchestration_active: 0,
      };
      const BOOK_WITH_FAILS =
        'id,feature,title,steps,expected,status,confidence,notes\n' +
        'S-001,Login,Happy path,1. Log in,Dashboard,pass,3,\n' +
        'S-002,Login,Wrong password,1. Log in wrong,Error,fail,3,observed nothing\n';
      const CLEAN_BOOK =
        'id,feature,title,steps,expected,status,confidence,notes\n' +
        'S-001,Login,Happy path,1. Log in,Dashboard,pass,3,\n';

      beforeEach(() => {
        vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
        vi.mocked(epicsDb.getById).mockReturnValue(fixReadyEpic as never);
        vi.mocked(readEpicQaFile).mockReturnValue(BOOK_WITH_FAILS);
      });

      it('starts when the book records failures (201)', async () => {
        const response = await request(app)
          .post('/api/epics/42/agent-runs')
          .send({ agentType: 'epic-qa-fix' });

        expect(response.status).toBe(201);
        expect(startEpicAgentRun).toHaveBeenCalledWith(
          42,
          'epic-qa-fix',
          expect.objectContaining({ userId: 1 }),
        );
      });

      it('refuses a clean book — nothing to fix (409)', async () => {
        vi.mocked(readEpicQaFile).mockReturnValue(CLEAN_BOOK);

        const response = await request(app)
          .post('/api/epics/42/agent-runs')
          .send({ agentType: 'epic-qa-fix' });

        expect(response.status).toBe(409);
        expect(response.body.error).toMatch(/no failed scenario/i);
        expect(startEpicAgentRun).not.toHaveBeenCalled();
      });

      it('refuses a missing or unparseable book (409)', async () => {
        vi.mocked(readEpicQaFile).mockReturnValue(null);
        let response = await request(app)
          .post('/api/epics/42/agent-runs')
          .send({ agentType: 'epic-qa-fix' });
        expect(response.status).toBe(409);
        expect(response.body.error).toMatch(/no QA scenario book/i);

        vi.mocked(readEpicQaFile).mockReturnValue('not,a,book\n');
        response = await request(app)
          .post('/api/epics/42/agent-runs')
          .send({ agentType: 'epic-qa-fix' });
        expect(response.status).toBe(409);
        expect(response.body.error).toMatch(/does not parse/i);
        expect(startEpicAgentRun).not.toHaveBeenCalled();
      });

      it('refuses while orchestration is active — one supervisor at a time (409)', async () => {
        vi.mocked(epicsDb.getById).mockReturnValue({
          ...fixReadyEpic,
          orchestration_active: 1,
        } as never);

        const response = await request(app)
          .post('/api/epics/42/agent-runs')
          .send({ agentType: 'epic-qa-fix' });

        expect(response.status).toBe(409);
        expect(response.body.error).toMatch(/being orchestrated/i);
        expect(startEpicAgentRun).not.toHaveBeenCalled();
      });
    });

    it('maps missing agent-model settings to 409', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
      vi.mocked(startEpicAgentRun).mockRejectedValue(
        new MissingUserAgentSettingsError(1, 'unseeded'),
      );

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-architecture' });

      expect(response.status).toBe(409);
    });

    it('maps missing provider credentials to 403 with the provider', async () => {
      vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
      vi.mocked(startEpicAgentRun).mockRejectedValue(
        new ProviderCredentialsMissingError('anthropic', 'no token'),
      );

      const response = await request(app)
        .post('/api/epics/42/agent-runs')
        .send({ agentType: 'epic-architecture' });

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: 'PROVIDER_CREDENTIALS_MISSING',
        provider: 'anthropic',
      });
    });
  });

  describe('the orchestrator endpoints', () => {
    /** An epic whose stories stage and specification review are signed off and which has tickets. */
    function ready(overrides: Record<string, unknown> = {}) {
      vi.mocked(epicsDb.getById).mockReturnValue({
        ...EPIC,
        stories_complete: 1,
        review_complete: 1,
        orchestration_active: 0,
        orchestration_blocked: 0,
        ...overrides,
      } as never);
      vi.mocked(epicTicketsDb.listTickets).mockReturnValue([{ id: 51, status: 'pending' }] as never);
    }

    describe('start', () => {
      it('sets the flag and hands off to the sequencer', async () => {
        ready();
        vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
        vi.mocked(epicsDb.setOrchestrationActive).mockReturnValue({
          ...EPIC,
          orchestration_active: 1,
        } as never);

        const res = await request(app).post('/api/epics/42/orchestrator/start');

        expect(res.status).toBe(200);
        expect(res.body.orchestration_active).toBe(1);
        expect(epicsDb.setOrchestrationActive).toHaveBeenCalledWith(42, true);
        expect(advance).toHaveBeenCalledWith(42);
      });

      it('refuses while another epic stage is still running', async () => {
        ready();
        vi.mocked(getRunningAgentForEpic).mockReturnValue({
          ...AGENT_RUN,
          agent_type: 'epic-stories',
        });

        const res = await request(app).post('/api/epics/42/orchestrator/start');

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/stories.*still running/i);
        expect(epicsDb.setOrchestrationActive).not.toHaveBeenCalled();
        expect(advance).not.toHaveBeenCalled();
      });

      it('pauses and reports an asynchronous startup failure', async () => {
        ready();
        vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
        vi.mocked(epicsDb.setOrchestrationActive).mockReturnValue({
          ...EPIC,
          orchestration_active: 1,
        } as never);
        vi.mocked(advance).mockRejectedValueOnce(new Error('credentials unavailable'));

        const res = await request(app).post('/api/epics/42/orchestrator/start');

        expect(res.status).toBe(200);
        await vi.waitFor(() =>
          expect(blockOrchestration).toHaveBeenCalledWith(
            42,
            expect.stringMatching(/credentials unavailable/i),
            expect.objectContaining({ userId: 1 }),
          ),
        );
      });

      it('refuses before the stories stage is signed off', async () => {
        ready({ stories_complete: 0 });

        const res = await request(app).post('/api/epics/42/orchestrator/start');

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/tickets first/i);
        expect(epicsDb.setOrchestrationActive).not.toHaveBeenCalled();
      });

      it('refuses before the specification review has passed — the gate this endpoint sits behind', async () => {
        ready({ review_complete: 0 });

        const res = await request(app).post('/api/epics/42/orchestrator/start');

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/specification review first/i);
        expect(epicsDb.setOrchestrationActive).not.toHaveBeenCalled();
        expect(advance).not.toHaveBeenCalled();
      });

      it('refuses an epic with no tickets', async () => {
        ready();
        vi.mocked(epicTicketsDb.listTickets).mockReturnValue([] as never);

        const res = await request(app).post('/api/epics/42/orchestrator/start');

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/no tickets/i);
      });

      it('refuses when it is already running', async () => {
        ready({ orchestration_active: 1 });

        const res = await request(app).post('/api/epics/42/orchestrator/start');

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already being orchestrated/i);
      });

      it('requires the resume path when an epic is paused', async () => {
        ready({ orchestration_active: 1, orchestration_blocked: 1 });

        const res = await request(app).post('/api/epics/42/orchestrator/start');

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/resume orchestration/i);
        expect(advance).not.toHaveBeenCalled();
      });

      it('refuses when every ticket is already merged', async () => {
        ready();
        vi.mocked(epicTicketsDb.listTickets).mockReturnValue([{ id: 51, status: 'completed' }] as never);

        const res = await request(app).post('/api/epics/42/orchestrator/start');

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already merged/i);
      });
    });

    describe('pause', () => {
      it('blocks through the shared path and aborts nothing when idle', async () => {
        ready({ orchestration_active: 1 });
        vi.mocked(getRunningAgentForEpic).mockReturnValue(null);
        vi.mocked(blockOrchestration).mockReturnValue({
          ...EPIC,
          orchestration_blocked: 1,
        } as never);

        const res = await request(app)
          .post('/api/epics/42/orchestrator/pause')
          .send({ reason: 'Let me look at ticket 3.' });

        expect(res.status).toBe(200);
        expect(blockOrchestration).toHaveBeenCalledWith(
          42,
          'Let me look at ticket 3.',
          expect.anything(),
        );
      });

      it('refuses for an epic that is not orchestrated', async () => {
        ready({ orchestration_active: 0 });

        const res = await request(app).post('/api/epics/42/orchestrator/pause').send({});

        expect(res.status).toBe(409);
        expect(blockOrchestration).not.toHaveBeenCalled();
      });
    });

    describe('resume', () => {
      it('clears the block and wakes the orchestrator with a snapshot', async () => {
        ready({ orchestration_active: 1, orchestration_blocked: 1 });
        vi.mocked(epicsDb.setOrchestrationBlocked).mockReturnValue({
          ...EPIC,
          orchestration_active: 1,
          orchestration_blocked: 0,
        } as never);

        const res = await request(app).post('/api/epics/42/orchestrator/resume');

        expect(res.status).toBe(200);
        expect(epicsDb.setOrchestrationBlocked).toHaveBeenCalledWith(42, false);
        expect(wakeOrchestrator).toHaveBeenCalledWith(42, 'resumed');
      });

      it('resumes a manually blocked reviewer in the same conversation', async () => {
        ready({ orchestration_active: 1, orchestration_blocked: 1 });
        vi.mocked(epicAgentRunsDb.getByEpic).mockReturnValue([
          {
            ...AGENT_RUN,
            id: 17,
            agent_type: 'epic-pr-review',
            status: 'blocked',
            conversation_id: 91,
          },
        ] as never);

        const res = await request(app).post('/api/epics/42/orchestrator/resume');

        expect(res.status).toBe(200);
        await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
        expect(sendMessage).toHaveBeenCalledWith(
          91,
          expect.stringContaining('user-resumed'),
          expect.objectContaining({ userId: 1 }),
        );
        expect(epicsDb.setOrchestrationBlocked).not.toHaveBeenCalled();
        expect(wakeOrchestrator).not.toHaveBeenCalled();
      });

      it('does not mistake a blocked planning run for the interrupted orchestrator', async () => {
        ready({ orchestration_active: 1, orchestration_blocked: 1 });
        vi.mocked(epicAgentRunsDb.getByEpic).mockReturnValue([
          {
            ...AGENT_RUN,
            id: 16,
            agent_type: 'epic-planification',
            status: 'blocked',
            conversation_id: 90,
          },
        ] as never);
        vi.mocked(epicsDb.setOrchestrationBlocked).mockReturnValue({
          ...EPIC,
          orchestration_active: 1,
          orchestration_blocked: 0,
        } as never);

        const res = await request(app).post('/api/epics/42/orchestrator/resume');

        expect(res.status).toBe(200);
        expect(sendMessage).not.toHaveBeenCalled();
        expect(epicsDb.setOrchestrationBlocked).toHaveBeenCalledWith(42, false);
        expect(wakeOrchestrator).toHaveBeenCalledWith(42, 'resumed');
      });

      it('waits for the aborted turn to finish before resuming its conversation', async () => {
        ready({ orchestration_active: 1, orchestration_blocked: 1 });
        vi.mocked(epicAgentRunsDb.getByEpic).mockReturnValue([
          {
            ...AGENT_RUN,
            id: 17,
            agent_type: 'epic-pr-review',
            status: 'blocked',
            conversation_id: 91,
          },
        ] as never);
        vi.mocked(getActiveStreamingByConversation).mockReturnValue({
          sessionId: 'review-session',
          epicId: 42,
          conversationId: 91,
        });

        const res = await request(app).post('/api/epics/42/orchestrator/resume');

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/still stopping/i);
        expect(sendMessage).not.toHaveBeenCalled();
      });

      it('refuses when it was never paused', async () => {
        ready({ orchestration_active: 1, orchestration_blocked: 0 });

        const res = await request(app).post('/api/epics/42/orchestrator/resume');

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/not paused/i);
      });

      it('404s a foreign epic, like every other epic route', async () => {
        vi.mocked(hasProjectAccess).mockReturnValue(false);

        const res = await request(app).post('/api/epics/42/orchestrator/resume');

        expect(res.status).toBe(404);
      });
    });
  });

  describe('POST /api/epics/:id/complete-pr', () => {
    it('opens the feature-branch -> default PR', async () => {
      vi.mocked(createEpicCompletionPR).mockResolvedValue({
        success: true,
        url: 'https://github.com/o/r/pull/42',
      });

      const response = await request(app)
        .post('/api/epics/42/complete-pr')
        .send({ title: 'Ship pricing', body: 'All tickets merged.' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, url: 'https://github.com/o/r/pull/42' });
      expect(createEpicCompletionPR).toHaveBeenCalledWith(42, {
        title: 'Ship pricing',
        body: 'All tickets merged.',
      });
    });

    it('accepts an empty body and lets the service pick the defaults', async () => {
      vi.mocked(createEpicCompletionPR).mockResolvedValue({ success: true, url: 'https://pr/1' });

      const response = await request(app).post('/api/epics/42/complete-pr').send({});

      expect(response.status).toBe(200);
      expect(createEpicCompletionPR).toHaveBeenCalledWith(42, {
        title: undefined,
        body: undefined,
      });
    });

    it('passes a git failure through as 200 { success:false }', async () => {
      vi.mocked(createEpicCompletionPR).mockResolvedValue({
        success: false,
        error: 'No changes to create a PR',
      });

      const response = await request(app).post('/api/epics/42/complete-pr').send({});

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: false, error: 'No changes to create a PR' });
    });

    it('404s for an epic the user cannot see', async () => {
      vi.mocked(hasProjectAccess).mockReturnValue(false);

      const response = await request(app).post('/api/epics/42/complete-pr').send({});

      expect(response.status).toBe(404);
      expect(createEpicCompletionPR).not.toHaveBeenCalled();
    });
  });
});
