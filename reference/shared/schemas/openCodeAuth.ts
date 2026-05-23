// Runtime validation schemas for `/api/opencode-auth/*` routes
// (`server/routes/openCodeAuth.ts`).
//
// Per R15 the OpenCode auth surface is single-key, paste-and-save —
// a Zen token issued at https://opencode.ai/zen unlocks the entire
// Zen catalog. No OAuth flow, no device-auth, no per-vendor keys.

import { z } from 'zod';

// Zen keys observed in the wild are ~67 chars (the dev box spike sat
// at 67). We allow 20–512 to give margin while still rejecting empty
// pastes or accidental whole-file dumps.
export const SetOpenCodeKeyBodySchema = z
  .object({
    apiKey: z
      .string()
      .min(20, 'OpenCode API key looks too short')
      .max(512, 'OpenCode API key looks too long'),
  })
  .strict();
export type SetOpenCodeKeyBody = z.infer<typeof SetOpenCodeKeyBodySchema>;
