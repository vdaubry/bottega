// Express middleware factories that wrap zod schemas around the three
// "untyped" inputs on a request: body, params, and query. Each factory
// runs `schema.safeParse()` on its slice of `req`, attaches the parsed
// (and now strongly-typed) value to `req.validated`, and yields control
// to the next handler. On failure it short-circuits with HTTP 400.
//
// The shape on the wire is intentionally tiny:
//   { error: "Validation failed", issues: ZodIssue[] }
// Consumers (frontend, tests, curl) get one stable error envelope across
// every validated endpoint without us inventing a per-route format.
//
// `req.validated` is typed as `unknown` at the TypeScript level — see
// `server/types/express.d.ts`. Each route knows the schema it asked for,
// so handlers cast at the call site rather than threading generics
// through the middleware factory.

import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

interface ValidationErrorBody {
  error: 'Validation failed';
  issues: unknown;
}

const buildErrorBody = (issues: unknown): ValidationErrorBody => ({
  error: 'Validation failed',
  issues,
});

export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json(buildErrorBody(result.error.issues));
      return;
    }
    if (!req.validated) {
      req.validated = {};
    }
    req.validated.body = result.data;
    next();
  };
}

export function validateParams<T>(schema: ZodType<T>): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      res.status(400).json(buildErrorBody(result.error.issues));
      return;
    }
    if (!req.validated) {
      req.validated = {};
    }
    req.validated.params = result.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodType<T>): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json(buildErrorBody(result.error.issues));
      return;
    }
    if (!req.validated) {
      req.validated = {};
    }
    req.validated.query = result.data;
    next();
  };
}
