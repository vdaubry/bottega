import express, {
  type Application,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from 'express';

import type { AuthenticatedUser } from '../../shared/api/auth.js';

export interface MountedRoute {
  module: Router;
  path: string;
}

// The mock middleware attaches a minimal principal: production handlers we
// exercise in tests only read `id` (and occasionally `username`). Cast to
// the full `AuthenticatedUser` shape so the augmented `Request.user` types
// line up — fields a handler under test happens to read are caller's
// problem and would surface as a runtime error.
const mockUser = (userId: number): AuthenticatedUser =>
  ({ id: userId, username: 'testuser' } as unknown as AuthenticatedUser);

/**
 * Creates a test Express app with mocked authentication middleware.
 * `req.user` is populated with `{ id: userId, username: 'testuser' }` so
 * downstream handlers see the same shape as production after `authenticateToken`.
 */
export function createTestApp(routeModule: Router, basePath: string, userId = 1): Application {
  const app = express();
  app.use(express.json());

  // Mock authentication middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = mockUser(userId);
    next();
  });

  app.use(basePath, routeModule);

  return app;
}

/**
 * Creates a test Express app with multiple route modules mounted under
 * their respective paths. Mirrors `createTestApp` for fixtures that need
 * cross-route assertions (e.g. tasks + projects).
 */
export function createTestAppWithMultipleRoutes(
  routes: MountedRoute[],
  userId = 1,
): Application {
  const app = express();
  app.use(express.json());

  // Mock authentication middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = mockUser(userId);
    next();
  });

  for (const { module, path } of routes) {
    app.use(path, module);
  }

  return app;
}
