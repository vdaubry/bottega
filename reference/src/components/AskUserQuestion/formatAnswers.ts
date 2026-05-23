/**
 * formatAnswers.ts - Format question answers into a user message
 *
 * Takes questions and user answers, produces a formatted markdown string
 * suitable for sending as a chat message.
 */

import {
  getAnswerDisplay,
  type AnswersMap,
  type Question,
} from './answerUtils';

/**
 * Format answers into a markdown user message.
 *
 * Answer encoding (by question index):
 *   - Single-select: { 0: "PostgreSQL (Recommended)", 1: "JWT" }
 *   - Multi-select:  { 0: ["Option A", "Option B"], 1: "Single choice" }
 *   - "Other":       { 0: { other: "Custom text" } }
 */
export function formatAnswers(
  questions: Question[] | null | undefined,
  answers: AnswersMap,
): string {
  if (!questions || !Array.isArray(questions) || questions.length === 0) {
    return '';
  }

  const lines: string[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q) continue;
    const answer = answers[i];
    const label = q.header || `Question ${i + 1}`;

    if (answer == null) continue;

    lines.push(`**${label}:** ${getAnswerDisplay(answer)}`);
  }

  return lines.join('\n');
}
