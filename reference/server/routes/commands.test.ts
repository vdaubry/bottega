import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import commandsRoutes from './commands.js';

describe('Commands Routes', () => {
  let app: import("express").Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/commands', commandsRoutes);
  });

  describe('POST /api/commands/list', () => {
    it('returns an empty builtIn array (built-ins are not wired to the SDK pipeline)', async () => {
      const res = await request(app)
        .post('/api/commands/list')
        .send({ projectPath: '' });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.builtIn)).toBe(true);
      expect(res.body.builtIn).toHaveLength(0);
      expect(Array.isArray(res.body.custom)).toBe(true);
    });

    it('surfaces user-level commands written under ~/.claude/commands/', async () => {
      const userDir = path.join(os.homedir(), '.claude', 'commands');
      const testFile = path.join(userDir, '__commands_route_test__.md');
      await fs.mkdir(userDir, { recursive: true });
      await fs.writeFile(testFile, '---\ndescription: a fixture\n---\nbody');

      try {
        const res = await request(app)
          .post('/api/commands/list')
          .send({ projectPath: '/tmp/does-not-exist' });

        expect(res.status).toBe(200);
        const names = res.body.custom.map((c: { name: string }) => c.name);
        expect(names).toContain('/__commands_route_test__');
      } finally {
        await fs.unlink(testFile).catch(() => {});
      }
    });
  });
});
