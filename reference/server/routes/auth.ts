import express, { type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { userDb, db } from '../database/db.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import type { ApiError } from '../../shared/api/_common.js';
import type {
  AuthStatusResponse,
  AuthSuccessResponse,
  GetCurrentUserResponse,
  LoginRequest,
  LogoutResponse,
  RegisterRequest,
  UpdateProfileRequest,
  UpdateProfileResponse,
} from '../../shared/api/auth.js';
import {
  LoginBodySchema,
  RegisterBodySchema,
  UpdateProfileBodySchema,
  type LoginBody,
  type RegisterBody,
  type UpdateProfileBody,
} from '../../shared/schemas/auth.js';

const router = express.Router();

// Per-IP brute-force throttle for the login / first-user-register flows.
// Limits are intentionally generous — humans fat-finger passwords, mobile
// devices retry on flaky networks. `skipSuccessfulRequests: true` means a
// correct login does not eat the budget. Tunable via env without redeploy.
const LOGIN_RATE_LIMIT_MAX = Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 20);
const LOGIN_RATE_LIMIT_WINDOW_MIN = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MIN ?? 15);

const loginRateLimiter = rateLimit({
  windowMs: LOGIN_RATE_LIMIT_WINDOW_MIN * 60 * 1000,
  max: LOGIN_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please try again later.' },
});

router.get(
  '/status',
  (_req: Request, res: Response<AuthStatusResponse | ApiError>) => {
    try {
      const hasUsers = userDb.hasUsers();
      res.json({
        needsSetup: !hasUsers,
        isAuthenticated: false,
      });
    } catch (error) {
      console.error('Auth status error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post(
  '/register',
  loginRateLimiter,
  validateBody(RegisterBodySchema),
  async (
    req: Request<unknown, AuthSuccessResponse | ApiError, RegisterRequest>,
    res: Response<AuthSuccessResponse | ApiError>,
  ) => {
    try {
      const { username, password } = req.validated!.body as RegisterBody;

      if (userDb.hasUsers()) {
        return res.status(403).json({
          error: 'Registration is closed. Ask an admin to create your account.',
        });
      }

      const saltRounds = 12;
      const passwordHash = await bcrypt.hash(password, saltRounds);

      db.prepare('BEGIN').run();
      try {
        if (userDb.hasUsers()) {
          db.prepare('ROLLBACK').run();
          return res.status(403).json({
            error: 'Registration is closed. Ask an admin to create your account.',
          });
        }

        const user = userDb.createUser(username, passwordHash);
        const adminUser = userDb.setAdmin(user.id, true);
        if (!adminUser) {
          throw new Error('Failed to grant admin access to bootstrap user');
        }
        userDb.updateLastLogin(user.id);
        const authUser = userDb.getUserById(user.id);
        if (!authUser) {
          throw new Error('Failed to load bootstrap user');
        }
        const token = generateToken(authUser);

        db.prepare('COMMIT').run();

        res.json({
          success: true,
          user: authUser,
          token,
        });
      } catch (error) {
        db.prepare('ROLLBACK').run();
        throw error;
      }
    } catch (error) {
      console.error('Registration error:', error);
      const code = (error as { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({ error: 'Username already exists' });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  },
);

router.post(
  '/login',
  loginRateLimiter,
  validateBody(LoginBodySchema),
  async (
    req: Request<unknown, AuthSuccessResponse | ApiError, LoginRequest>,
    res: Response<AuthSuccessResponse | ApiError>,
  ) => {
    try {
      const { username, password } = req.validated!.body as LoginBody;

      const user = userDb.getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      const isValidPassword = await bcrypt.compare(password, user.password_hash);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      const token = generateToken(user);
      userDb.updateLastLogin(user.id);
      const authUser = userDb.getUserById(user.id);
      if (!authUser) {
        throw new Error('Failed to load authenticated user');
      }

      res.json({
        success: true,
        user: authUser,
        token,
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.get(
  '/user',
  authenticateToken,
  (req: Request, res: Response<GetCurrentUserResponse>) => {
    res.json({ user: req.user! });
  },
);

router.put(
  '/profile',
  authenticateToken,
  validateBody(UpdateProfileBodySchema),
  (
    req: Request<unknown, UpdateProfileResponse | ApiError, UpdateProfileRequest>,
    res: Response<UpdateProfileResponse | ApiError>,
  ) => {
    try {
      const { isTechnical } = req.validated!.body as UpdateProfileBody;
      const user = userDb.updateIsTechnical(req.user!.id, isTechnical);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json({ user });
    } catch (error) {
      console.error('Profile update error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

router.post(
  '/logout',
  authenticateToken,
  (req: Request, res: Response<LogoutResponse>) => {
    // Bump the user's token_version so every JWT previously issued to them
    // (including the one we just authenticated) fails on next use. Clients
    // additionally drop the local copy, but the server-side bump is what
    // makes the old token unusable from any device.
    try {
      userDb.bumpTokenVersion(req.user!.id);
    } catch (error) {
      console.error('Logout token-version bump failed:', error);
    }
    res.json({ success: true, message: 'Logged out successfully' });
  },
);

export default router;
