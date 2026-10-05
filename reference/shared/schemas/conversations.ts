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
import { GENERATED_IMAGE_FILE_NAME } from '../providers/generatedImage.js';

export const CreateConversationBodySchema = z
  .object({
    // Empty/omitted = pre-create only (no LLM session is started).
    message: z.string().optional(),
    // Custom cwd override; defaults to the project's repo_folder_path.
    projectPath: z.string().optional(),
    // Defaults to 'bypassPermissions' server-side.
    permissionMode: z.string().optional(),
    // Which backend runs this conversation. Always explicit.
    provider: z.enum(['anthropic', 'openai', 'opencode']),
    // Provider-specific model identifier (e.g. 'opus', 'gpt-6.1-sol',
    // 'opencode/kimi-k2.7-code'). Always explicit.
    model: z.string().min(1),
    // Explore-initiated conversation: attaches the in-process code-atlas MCP
    // server (open_file/highlight/render_artifact). Anthropic-only — the SDK
    // hosts the server in-process; other providers can't.
    atlas: z.boolean().optional(),
  })
  .refine((b) => isModelForProvider(b.provider, b.model), {
    message: 'model does not belong to the selected provider',
    path: ['model'],
  })
  .refine((b) => !b.atlas || b.provider === 'anthropic', {
    message: 'atlas conversations require the anthropic provider',
    path: ['atlas'],
  });

export type CreateConversationBody = z.infer<typeof CreateConversationBodySchema>;

// ---- Post message to an existing conversation -----------------------------
//
// Body for `POST /api/tasks/:taskId/conversations/:conversationId/messages` —
// the REST bridge to the WS `claude-command` resume path. Resume reads
// provider/model off the conversation row (`sendMessage`), so the body needs
// only the message text plus the optional permission mode and inline images.

// Inline image attachment — mirrors `ConversationImage`
// (`server/services/conversation/types.ts`): base64 data + MIME type.
const PostMessageImageSchema = z.object({
  data: z.string().min(1),
  mimeType: z.string().min(1),
});

export const PostMessageBodySchema = z.object({
  // Non-empty — an empty resume turn has nothing to send.
  message: z.string().min(1),
  // Defaults to 'bypassPermissions' server-side when omitted.
  permissionMode: z.string().optional(),
  images: z.array(PostMessageImageSchema).optional(),
});
export type PostMessageBody = z.infer<typeof PostMessageBodySchema>;

// ---- Conversation-detail message pagination -------------------------------
//
// Query for `GET /api/tasks/:taskId/conversations/:conversationId` — the
// nested detail route validates limit/offset via this schema rather than the
// hand-rolled `parseInt` the legacy `/conversations/:id/messages` route uses.

export const MessagesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});
export type MessagesQuery = z.infer<typeof MessagesQuerySchema>;

// ---- Generated image ------------------------------------------------------
//
// Params for `GET /api/conversations/:id/images/:fileName`. The name is
// constrained to what the conversation image store can hold, so a request can
// never address a file outside the conversation's folder.

export const ConversationImageParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  fileName: z.string().regex(GENERATED_IMAGE_FILE_NAME),
});
export type ConversationImageParams = z.infer<typeof ConversationImageParamsSchema>;
