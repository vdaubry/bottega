import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

import settingsRoutes from './settings.js';

interface PromptListItem {
  name: string;
  label: string;
  kind: string;
  isCustomized: boolean;
}

describe('Settings Routes - /api/settings/prompts', () => {
  let app: import("express").Application;
  let archiveRoot: string;

  beforeEach(() => {
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 1, username: 'testuser' } as never;
      next();
    });
    app.use('/api/settings', settingsRoutes);
  });

  afterEach(() => {
    if (archiveRoot && fs.existsSync(archiveRoot)) {
      fs.rmSync(archiveRoot, { recursive: true, force: true });
    }
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
  });

  describe('GET /api/settings/prompts', () => {
    it('lists every registered prompt with name, label, kind, customization', async () => {
      const res = await request(app).get('/api/settings/prompts');
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(9);
      expect(res.body.every((p: PromptListItem) => p.name && p.label && typeof p.isCustomized === 'boolean')).toBe(true);
      expect(res.body.every((p: PromptListItem) => p.kind === 'prompt' || p.kind === 'template')).toBe(true);
    });

    it('exposes plan-template under kind="template"', async () => {
      const res = await request(app).get('/api/settings/prompts');
      const tmpl = res.body.find((p: PromptListItem) => p.name === 'plan-template');
      expect(tmpl).toBeDefined();
      expect(tmpl.kind).toBe('template');
    });

    it('reflects customization state', async () => {
      const before = (await request(app).get('/api/settings/prompts')).body
        .find((p: PromptListItem) => p.name === 'planification');
      expect(before.isCustomized).toBe(false);

      await request(app)
        .put('/api/settings/prompts/planification')
        .send({ content: 'CUSTOM {{taskDocPath}} {{taskId}}' });

      const after = (await request(app).get('/api/settings/prompts')).body
        .find((p: PromptListItem) => p.name === 'planification');
      expect(after.isCustomized).toBe(true);
    });
  });

  describe('GET /api/settings/prompts/:name', () => {
    it('returns content, defaultContent, variables, mtime', async () => {
      const res = await request(app).get('/api/settings/prompts/implementation');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('implementation');
      expect(res.body.content).toContain('@agent-Implement');
      expect(res.body.defaultContent).toContain('@agent-Implement');
      expect(res.body.variables).toEqual(['taskDocPath', 'taskId']);
      expect(res.body.isCustomized).toBe(false);
      expect(res.body.mtime).toBeNull();
    });

    it('returns 404 for unknown prompt', async () => {
      const res = await request(app).get('/api/settings/prompts/nonsense');
      expect(res.status).toBe(404);
    });

    it('blocks path traversal', async () => {
      const res = await request(app).get('/api/settings/prompts/..%2F..%2Fetc%2Fpasswd');
      expect(res.status).toBe(404);
    });

    it('returns kind="template" with no variables for plan-template', async () => {
      const res = await request(app).get('/api/settings/prompts/plan-template');
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('template');
      expect(res.body.variables).toEqual([]);
      expect(res.body.content).toContain('## Original Request');
    });
  });

  describe('PUT /api/settings/prompts/:name', () => {
    it('saves a valid override', async () => {
      const res = await request(app)
        .put('/api/settings/prompts/implementation')
        .send({ content: 'NEW IMPL {{taskDocPath}} {{taskId}}' });
      expect(res.status).toBe(200);
      expect(res.body.isCustomized).toBe(true);
      expect(typeof res.body.mtime).toBe('number');

      const saved = fs.readFileSync(
        path.join(archiveRoot, 'prompts', 'implementation.md'),
        'utf8'
      );
      expect(saved).toBe('NEW IMPL {{taskDocPath}} {{taskId}}');
    });

    it('rejects unknown variables with 400', async () => {
      const res = await request(app)
        .put('/api/settings/prompts/implementation')
        .send({ content: 'hi {{taskDocPath}} {{bogus}} {{nope}}' });
      expect(res.status).toBe(400);
      expect(res.body.unknownVariables).toEqual(['bogus', 'nope']);
      expect(res.body.allowedVariables).toContain('taskDocPath');
    });

    it('rejects missing content with 400', async () => {
      const res = await request(app)
        .put('/api/settings/prompts/implementation')
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown prompt', async () => {
      const res = await request(app)
        .put('/api/settings/prompts/nonsense')
        .send({ content: 'x' });
      expect(res.status).toBe(404);
    });

    it('returns 409 when expectedMtime does not match', async () => {
      const first = await request(app)
        .put('/api/settings/prompts/implementation')
        .send({ content: 'v1 {{taskId}}' });
      const initialMtime = first.body.mtime;

      // wait a moment so a subsequent write produces a different mtime
      await new Promise(r => setTimeout(r, 20));

      const concurrent = await request(app)
        .put('/api/settings/prompts/implementation')
        .send({ content: 'v2 {{taskId}}' });
      expect(concurrent.body.mtime).not.toBe(initialMtime);

      const stale = await request(app)
        .put('/api/settings/prompts/implementation')
        .send({ content: 'v3 {{taskId}}', expectedMtime: initialMtime });
      expect(stale.status).toBe(409);
      expect(stale.body.currentMtime).toBe(concurrent.body.mtime);
    });

    it('accepts when expectedMtime matches', async () => {
      const first = await request(app)
        .put('/api/settings/prompts/implementation')
        .send({ content: 'v1 {{taskId}}' });

      const second = await request(app)
        .put('/api/settings/prompts/implementation')
        .send({ content: 'v2 {{taskId}}', expectedMtime: first.body.mtime });
      expect(second.status).toBe(200);
    });

    it('accepts pr-feedback with all valid {{vars}}', async () => {
      const content = `hi {{taskDocPath}} {{taskId}} {{prUrl}} {{feedbackSection}}`;
      const res = await request(app)
        .put('/api/settings/prompts/pr-feedback')
        .send({ content });
      expect(res.status).toBe(200);
    });

    it('accepts a template body containing literal {{ … }} markers without a 400', async () => {
      const content = '# Custom plan template\n\n## Original Request\n\n> {{ user message }}\n';
      const res = await request(app)
        .put('/api/settings/prompts/plan-template')
        .send({ content });
      expect(res.status).toBe(200);
      expect(res.body.isCustomized).toBe(true);

      const saved = fs.readFileSync(
        path.join(archiveRoot, 'templates', 'plan-template.md'),
        'utf8'
      );
      expect(saved).toBe(content);
    });
  });

  describe('DELETE /api/settings/prompts/:name', () => {
    it('removes an existing override', async () => {
      await request(app)
        .put('/api/settings/prompts/implementation')
        .send({ content: 'CUSTOM {{taskId}}' });

      const overridePath = path.join(archiveRoot, 'prompts', 'implementation.md');
      expect(fs.existsSync(overridePath)).toBe(true);

      const res = await request(app).delete('/api/settings/prompts/implementation');
      expect(res.status).toBe(204);
      expect(fs.existsSync(overridePath)).toBe(false);
    });

    it('is idempotent — 204 even when no override exists', async () => {
      const res = await request(app).delete('/api/settings/prompts/implementation');
      expect(res.status).toBe(204);
    });

    it('returns 404 for unknown prompt', async () => {
      const res = await request(app).delete('/api/settings/prompts/nonsense');
      expect(res.status).toBe(404);
    });
  });
});
