// Runtime validation schemas for auth-adjacent routes:
// - `/api/auth/*` (`server/routes/auth.ts`)
// - `/api/claude-auth/*` (`server/routes/claudeAuth.ts`)

import { z } from 'zod';

export const RegisterBodySchema = z.object({
  username: z.string().trim().min(3, 'Username must be at least 3 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});
export type RegisterBody = z.infer<typeof RegisterBodySchema>;

export const LoginBodySchema = z.object({
  username: z.string().trim().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

export const UpdateProfileBodySchema = z.object({
  isTechnical: z.boolean(),
});
export type UpdateProfileBody = z.infer<typeof UpdateProfileBodySchema>;

export const CompleteClaudeAuthBodySchema = z.object({
  loginSessionId: z.string().min(1),
  code: z.string().min(1),
});
export type CompleteClaudeAuthBody = z.infer<typeof CompleteClaudeAuthBodySchema>;
