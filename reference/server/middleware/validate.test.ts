import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { validateBody, validateParams, validateQuery } from './validate.js';

// Each test below mounts a one-route Express app inline. That keeps the
// fixtures explicit, mirrors the style of the existing route tests
// (`server/routes/admin.test.ts`), and avoids cross-test global state.

interface BodyShape {
  name: string;
  count: number;
}

const BodySchema: z.ZodType<BodyShape> = z.object({
  name: z.string(),
  count: z.number().int(),
});

describe('validateBody', () => {
  it('passes valid bodies through and lands the parsed value on req.validated.body', async () => {
    const app = express();
    app.use(express.json());
    app.post('/echo', validateBody(BodySchema), (req, res) => {
      const body = req.validated!.body as BodyShape;
      res.json({ echoed: body });
    });

    const res = await request(app)
      .post('/echo')
      .send({ name: 'alice', count: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ echoed: { name: 'alice', count: 3 } });
  });

  it('returns 400 with "Validation failed" and an issues array on malformed body', async () => {
    const app = express();
    app.use(express.json());
    app.post('/echo', validateBody(BodySchema), (_req, res) => {
      res.json({ unreachable: true });
    });

    const res = await request(app)
      .post('/echo')
      .send({ name: 123, count: 'not-a-number' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues.length).toBeGreaterThanOrEqual(1);
    // Each zod issue carries a `path` array — verify our shape didn't
    // accidentally drop the field-level info.
    expect(res.body.issues[0]).toHaveProperty('path');
    expect(res.body.issues[0]).toHaveProperty('message');
  });

  it('validates nested object schemas deeply', async () => {
    const NestedSchema = z.object({
      user: z.object({
        id: z.number().int(),
        prefs: z.object({
          theme: z.enum(['dark', 'light']),
        }),
      }),
    });

    const app = express();
    app.use(express.json());
    app.post('/nested', validateBody(NestedSchema), (req, res) => {
      const body = req.validated!.body as z.infer<typeof NestedSchema>;
      res.json({ theme: body.user.prefs.theme });
    });

    const okRes = await request(app)
      .post('/nested')
      .send({ user: { id: 1, prefs: { theme: 'dark' } } });
    expect(okRes.status).toBe(200);
    expect(okRes.body).toEqual({ theme: 'dark' });

    const badRes = await request(app)
      .post('/nested')
      .send({ user: { id: 1, prefs: { theme: 'sepia' } } });
    expect(badRes.status).toBe(400);
    expect(badRes.body.error).toBe('Validation failed');
    // Path should reach the deeply-nested field.
    const issue = badRes.body.issues.find(
      (i: { path?: unknown[] }) =>
        Array.isArray(i.path) &&
        i.path.join('.') === 'user.prefs.theme',
    );
    expect(issue).toBeDefined();
  });
});

describe('validateParams', () => {
  it('parses path params, attaches to req.validated.params, and rejects bad input', async () => {
    const ParamsSchema = z.object({
      id: z.coerce.number().int().positive(),
    });

    const app = express();
    app.get('/items/:id', validateParams(ParamsSchema), (req, res) => {
      const params = req.validated!.params as z.infer<typeof ParamsSchema>;
      res.json({ id: params.id });
    });

    const okRes = await request(app).get('/items/42');
    expect(okRes.status).toBe(200);
    expect(okRes.body).toEqual({ id: 42 });

    const badRes = await request(app).get('/items/not-a-number');
    expect(badRes.status).toBe(400);
    expect(badRes.body.error).toBe('Validation failed');
    expect(Array.isArray(badRes.body.issues)).toBe(true);
  });
});

describe('validateQuery', () => {
  it('parses query strings, attaches to req.validated.query, and rejects bad input', async () => {
    const QuerySchema = z.object({
      limit: z.coerce.number().int().min(1).max(100),
    });

    const app = express();
    app.get('/search', validateQuery(QuerySchema), (req, res) => {
      const query = req.validated!.query as z.infer<typeof QuerySchema>;
      res.json({ limit: query.limit });
    });

    const okRes = await request(app).get('/search?limit=20');
    expect(okRes.status).toBe(200);
    expect(okRes.body).toEqual({ limit: 20 });

    const badRes = await request(app).get('/search?limit=999');
    expect(badRes.status).toBe(400);
    expect(badRes.body.error).toBe('Validation failed');
  });
});
