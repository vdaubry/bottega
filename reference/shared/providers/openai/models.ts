// OpenAI / Codex model + effort metadata for the Settings UI.
//
// The canonical model + effort lists live in `shared/providers/models.ts`
// (`OPENAI_MODELS`, `OPENAI_EFFORTS`). This file only adds presentation
// labels.

import type { OpenAIModel, OpenAIEffort } from '../models.js';

export const OPENAI_MODEL_LABELS: Record<OpenAIModel, string> = {
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 mini',
};

export const OPENAI_EFFORT_LABELS: Record<OpenAIEffort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
};
