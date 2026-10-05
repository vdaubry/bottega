// OpenAI / Codex model + effort metadata for the Settings UI.
//
// The canonical model + effort lists live in `shared/providers/models.ts`
// (`OPENAI_MODELS`, `OPENAI_EFFORTS`). This file only adds presentation
// labels.

import type { OpenAIModel, OpenAIEffort } from '../models.js';

export const OPENAI_MODEL_LABELS: Record<OpenAIModel, string> = {
  'gpt-6-astra': 'GPT-6 Astra',
  'gpt-6.1-sol': 'GPT-6.1 Sol',
};

export const OPENAI_EFFORT_LABELS: Record<OpenAIEffort, string> = {
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
};
