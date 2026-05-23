// Request/response shapes for the auth-adjacent endpoints:
//  - /api/auth/*           (login, register, status, user, profile, logout)
//  - /api/account/api-key  (per-user API key lifecycle)
//  - /api/claude-auth/*    (Claude OAuth flow)

// ---- Public principal shape ------------------------------------------------
//
// What the JWT middleware attaches to `req.user`, and what `/api/auth/user`
// returns under the `user` key. A subset of `UserRow` — never includes
// `password_hash` or other sensitive fields.

export interface AuthenticatedUser {
  id: number;
  username: string;
  created_at: string;
  last_login: string | null;
  is_admin: 0 | 1;
  is_technical: 0 | 1;
}

// ---- /api/auth ------------------------------------------------------------

export interface AuthStatusResponse {
  needsSetup: boolean;
  isAuthenticated: boolean;
}

export interface RegisterRequest {
  username: string;
  password: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthSuccessResponse {
  success: true;
  user: AuthenticatedUser;
  token: string;
}

export interface GetCurrentUserResponse {
  user: AuthenticatedUser;
}

export interface UpdateProfileRequest {
  isTechnical: boolean;
}

export interface UpdateProfileResponse {
  user: AuthenticatedUser;
}

export interface LogoutResponse {
  success: true;
  message: string;
}

// ---- /api/account/api-key -------------------------------------------------

// Note camelCase: `userApiKey.getApiKeyStatus()` deliberately renames the
// underlying SQL columns (`api_key_hash`, `api_key_last_used_at`) before
// returning. There is no `created_at` here — the timestamps tracked are
// "any key exists?" and "when last used", not when generated.
export interface ApiKeyStatusResponse {
  hasKey: boolean;
  lastUsedAt: string | null;
}

export interface GenerateApiKeyResponse {
  key: string;
}

export interface RevokeApiKeyResponse {
  success: true;
}

// ---- /api/claude-auth -----------------------------------------------------
//
// `status` reflects the latest credential check ('valid', 'invalid',
// 'missing', etc.) — kept as `string` because the underlying
// `getClaudeAuthStatus` helper returns ad-hoc values and we don't need
// exhaustiveness over them at the boundary.

export interface ActiveClaudeAuthLogin {
  active: true;
  loginSessionId: string;
  authUrl: string | null;
  startedAt: string;
  expiresAt: string;
}

export interface ClaudeAuthStatusResponse {
  authenticated: boolean;
  status: string;
  authMethod: string | null;
  apiProvider: string | null;
  reason: string | null;
  login: ActiveClaudeAuthLogin | null;
}

export interface StartClaudeAuthResponse {
  loginSessionId: string;
  authUrl: string | null;
  startedAt: string;
  expiresAt: string;
}

export interface CompleteClaudeAuthRequest {
  loginSessionId: string;
  code: string;
}

export interface CompleteClaudeAuthResponse {
  authenticated: true;
  status: string;
  authMethod: string | null;
  apiProvider: string | null;
}

export interface CancelClaudeAuthResponse {
  cancelled: boolean;
}

// Disconnect: removes the per-user OAuth token file. `cleared` is false when
// there was no token to remove (already disconnected) — not an error.
export interface ClearClaudeAuthResponse {
  cleared: boolean;
}

// ---- Type-level smoke checks ----------------------------------------------
//
// Catch silent drift between this contract and the DB row shape.

import { expectType } from './_common';

expectType<AuthenticatedUser['id']>(0);
expectType<AuthenticatedUser['is_admin']>(0);
