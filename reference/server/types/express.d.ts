// Module augmentation for Express's `Request` interface. The
// `authenticateToken` middleware (`server/middleware/auth.js`) attaches
// `req.user` after successfully resolving a JWT or API key — this file is
// the single source of truth for what that object looks like.
//
// `req.user` is typed as `AuthenticatedUser | undefined` because handlers
// behind `authenticateToken` will always have it set, but unauthenticated
// routes (e.g. /api/auth/login) won't. Handlers that mount behind the
// middleware can narrow with a non-null assertion or an explicit guard.

import type { AuthenticatedUser } from '../../shared/api/auth.js';

// Container the `validate*` middleware factories
// (`server/middleware/validate.ts`) attach parsed request data to. Each
// slot is `unknown` here because the middleware is generic over the zod
// schema — handlers know their own schema and cast at the call site.
interface ValidatedRequestData {
  body?: unknown;
  params?: unknown;
  query?: unknown;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      validated?: ValidatedRequestData;
    }
  }
}

export {};
