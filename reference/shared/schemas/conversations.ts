// Runtime validation schema for the create-conversation route
// (`POST /api/tasks/:taskId/conversations`, handled by
// `server/routes/conversationHandlers.ts`).
//
// Historically this route read `req.body` without a zod gate. Every
// conversation now picks an explicit backend + model (manual conversations
// are no longer hardwired to Claude and nothing is ever defaulted): `provider`
// must be one of the three known backends and `model` must belong to that
// provider's namespace (anthropic/openai use a static enum; opencode is
// prefix-checked since the Zen catalog is owned upstream — see
// `shared/providers/models.ts`).

import { z } from 'zod';
import { isModelForProvider } from '../providers/models.js';

export const CreateConversationBodySchema = z
  .object({
    // Empty/omitted = pre-create only (no LLM session is started).
    message: z.string().optional(),
    // Custom cwd override; defaults to the project's repo_folder_path.
    projectPath: z.string().optional(),
    // Defaults to 'bypassPermissions' server-side.
    permissionMode: z.string().optional(),
    // Which backend runs this conversation. Always explicit.
    provider: z.enum(['anthropic', 'openai', 'opencode', 'opencode-go']),
    // Provider-specific model identifier (e.g. 'opus', 'gpt-5.5',
    // 'opencode/kimi-k2.6'). Always explicit.
    model: z.string().min(1),
  })
  .refine((b) => isModelForProvider(b.provider, b.model), {
    message: 'model does not belong to the selected provider',
    path: ['model'],
  });

export type CreateConversationBody = z.infer<typeof CreateConversationBodySchema>;
