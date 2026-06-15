// Runtime validation for `/api/user-agent-model-settings` (PUT body).
//
// Per-user replacement for the old global `agent_model_settings` blob. The
// body must carry ALL six agent types — a partial save would leave some
// agents unresolvable, which violates the deterministic-model rule (the
// runner fails loud rather than defaulting). The settings tab always sends
// the full set (load → merge → save).

import { z } from 'zod';
import { isModelForProvider, isEffortForProvider } from '../providers/models.js';
import { AGENT_TYPES_WITH_SETTINGS } from '../types/agentModelSettings.js';
import type { AgentType } from '../types/db.js';

// One (provider, model, effort) triple. `model`/`effort` are validated against
// the provider's catalog (reusing the same guards the loader uses) so a
// cross-provider mismatch (e.g. anthropic + gpt-5.5) is rejected at the
// boundary. effort is null when the provider has no reasoning dimension.
const AgentModelSettingSchema = z
  .object({
    provider: z.enum(['anthropic', 'openai', 'opencode', 'opencode-go']),
    model: z.string().min(1),
    effort: z.string().nullable(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (!isModelForProvider(s.provider, s.model)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid model '${s.model}' for provider '${s.provider}'`,
        path: ['model'],
      });
    }
    if (s.effort !== null && !isEffortForProvider(s.provider, s.effort)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid effort '${s.effort}' for provider '${s.provider}'`,
        path: ['effort'],
      });
    }
  });

export const PutUserAgentModelSettingsBodySchema = z
  .object(
    Object.fromEntries(
      AGENT_TYPES_WITH_SETTINGS.map((agent) => [agent, AgentModelSettingSchema]),
    ) as Record<AgentType, typeof AgentModelSettingSchema>,
  )
  .strict();

export type PutUserAgentModelSettingsBody = z.infer<typeof PutUserAgentModelSettingsBodySchema>;
