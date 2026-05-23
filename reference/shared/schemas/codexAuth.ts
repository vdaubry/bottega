// Runtime validation schemas for `/api/codex-auth/*` routes
// (`server/routes/codexAuth.ts`).
//
// Phase 10 part 1 ships Path B (paste-auth.json). Phase 10 part 2 will
// add the PTY-driven device-auth flow and additional `start` / `complete`
// schemas alongside.

import { z } from 'zod';

// Path B: user pastes the JSON content of ~/.codex/auth.json from a
// successful `codex login` run on a developer machine. We validate the
// shape (must be an object with at least an OAuth or API-key field) and
// persist verbatim with mode 0600.
export const PasteCodexAuthBodySchema = z
  .object({
    authJson: z
      .string()
      .min(1, 'auth.json content is required')
      .max(64 * 1024, 'auth.json content is too large'),
  })
  .strict();
export type PasteCodexAuthBody = z.infer<typeof PasteCodexAuthBodySchema>;
