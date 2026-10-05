// Runtime validation for the epic routes (`/api/projects/:projectId/epics`,
// `/api/epics/:id/...`).
//
// NOTE: `POST /projects/:projectId/epics` is multipart (multer runs
// imperatively inside the handler, after auth), so `validateBody` cannot guard
// it — the route validates `name` and the uploaded files manually against the
// constants exported here. Params reuse `IdParamsSchema` /
// `ProjectIdParamsSchema` from `_common.ts`.

import { z } from 'zod';
import { CreateConversationBodySchema } from './conversations.js';

// Spec files are read by the agent with the Read tool, so only plain-text
// formats are accepted (settled product decision: .md/.txt, plus .html for
// prototype pages — no PDF parsing).
export const ALLOWED_SPEC_EXTENSIONS = ['.md', '.txt', '.html'] as const;

export const EPIC_NAME_MAX = 200;

export const EPIC_STATUSES = ['active', 'completed', 'cancelled'] as const;

// POST /epics/:id/tasks — create one ticket for the epic (architecture-v2
// step 3: ticket creation is an epic-layer act; the plain task-creation route
// no longer accepts epic fields).
export const CreateEpicTicketBodySchema = z.object({
  title: z.string().nullable().optional(),
  description: z.string().optional(),
  // Position in the epic. Omitted = appended after the epic's last ticket.
  epic_order: z.number().int().positive().optional(),
});
export type CreateEpicTicketBody = z.infer<typeof CreateEpicTicketBodySchema>;

export const UpdateEpicBodySchema = z
  .object({
    name: z.string().trim().min(1).max(EPIC_NAME_MAX).optional(),
    status: z.enum(EPIC_STATUSES).optional(),
  })
  .strict()
  .refine((b) => b.name !== undefined || b.status !== undefined, {
    message: 'No update fields provided',
  });
export type UpdateEpicBody = z.infer<typeof UpdateEpicBodySchema>;

// Every epic agent type the DB accepts. The route gates which of them can
// actually be started (later phases open the remaining stages up), so an
// unimplemented stage answers 409 rather than 400.
export const EPIC_AGENT_TYPES = [
  'epic-architecture',
  'epic-specification',
  'epic-stories',
  'epic-spec-review',
  'epic-orchestrator',
  'epic-pr-review',
  'epic-delivery',
  'epic-qa-scenarios',
  'epic-qa-execution',
  'epic-qa-fix',
] as const;

export const CreateEpicAgentRunBodySchema = z
  .object({
    agentType: z.enum(EPIC_AGENT_TYPES),
  })
  .strict();
export type CreateEpicAgentRunBody = z.infer<typeof CreateEpicAgentRunBodySchema>;

// The pipeline's stage vocabulary — what the agents call the stages in
// `mark_stage_complete`, and what the human backstop route takes in its path.
// Server-side, `server/constants/epicStages.ts` maps these onto the `epics`
// flag columns.
export const EPIC_STAGE_NAMES = [
  'architecture',
  'specification',
  'stories',
  // The specification review: the consistency gate between the tickets and
  // autonomous implementation.
  'review',
  'implementation',
  // The QA scenario book: the epic-wide test scenarios the user approves
  // before the QA execution agent may run them.
  'qa',
] as const;
export type EpicStageName = (typeof EPIC_STAGE_NAMES)[number];

// `POST /epics/:id/stages/:stage/complete` — the human backstop for a stage an
// agent did not sign off itself.
export const EpicStageParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  stage: z.enum(EPIC_STAGE_NAMES),
});
export type EpicStageParams = z.infer<typeof EpicStageParamsSchema>;

// Manual epic conversations use the same provider-neutral boundary as tasks.
export const CreateEpicConversationBodySchema = CreateConversationBodySchema;
export type CreateEpicConversationBody = z.infer<typeof CreateEpicConversationBodySchema>;

// `POST /epics/:id/complete-pr` — the epic's final PR (feature branch ->
// repo default). Both fields are optional; the service falls back to
// "Epic: {name}".
export const CompleteEpicPRBodySchema = z
  .object({
    title: z.string().trim().min(1).max(EPIC_NAME_MAX).optional(),
    body: z.string().max(50_000).optional(),
  })
  .strict();
export type CompleteEpicPRBody = z.infer<typeof CompleteEpicPRBodySchema>;

// `POST /epics/:id/orchestrator/pause` — the user stepping in. The reason is
// theirs to write; it is what the epic page shows while orchestration is halted.
export const PauseOrchestrationBodySchema = z
  .object({
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type PauseOrchestrationBody = z.infer<typeof PauseOrchestrationBodySchema>;

// `/epics/:id/{architecture,docs,review,spec-files}/:filename`. The filename is a bare basename —
// the server strips any directory component again before touching disk.
export const EpicFileParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  filename: z.string().min(1).max(255),
});
export type EpicFileParams = z.infer<typeof EpicFileParamsSchema>;
