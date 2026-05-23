/**
 * answerUtils.ts - Shared utilities and types for AskUserQuestion answer values
 *
 * Centralizes the answer-type-checking logic used across all
 * AskUserQuestion components (Card, Panel, QuestionStep, SummaryStep, formatAnswers).
 */

// ---- Shared types ----

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

export interface OtherAnswer {
  other: string;
}

export type SingleAnswer = string | OtherAnswer;
export type Answer = SingleAnswer | SingleAnswer[] | null | undefined;

/** Wizard state: question index → user's selection */
export type AnswersMap = Record<number, Answer>;

/** SDK contract: answers keyed by question text/header for the tool_result */
export type StructuredAnswers = Record<string, string>;

export type ToolResultContent =
  | string
  | Array<string | { text?: string }>
  | null
  | undefined;

export type ToolResultClassification =
  | { kind: 'errored'; message: string }
  | { kind: 'dismissed' }
  | { kind: 'answered'; answers: StructuredAnswers }
  | null;

// ---- Type guards ----

/** Check if an answer value is an "Other" free-text answer ({ other: "..." }) */
export const isOtherAnswer = (val: unknown): val is OtherAnswer =>
  val != null &&
  typeof val === 'object' &&
  !Array.isArray(val) &&
  typeof (val as { other?: unknown }).other === 'string';

/** Extract display text from an individual answer entry (handles Other objects) */
export const getOtherText = (val: SingleAnswer): string =>
  isOtherAnswer(val) ? val.other : val;

/**
 * Format an answer value for display.
 */
export function getAnswerDisplay(answer: Answer, fallback = ''): string {
  if (answer == null) return fallback;
  if (isOtherAnswer(answer)) return answer.other || fallback;
  if (Array.isArray(answer)) {
    return answer.map((a) => getOtherText(a)).join(', ');
  }
  return String(answer);
}

const ANSWERED_PREFIX = 'User has answered your questions:';

/** Normalize a tool_result `content` field (may be string or [{text}] array) into a string. */
function normalizeResultContent(content: ToolResultContent): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        return b?.text ?? '';
      })
      .join('');
  }
  return '';
}

/**
 * Parse the AskUserQuestion success tool_result that the Claude Agent SDK writes,
 * recovering the user's answers keyed by question text.
 *
 * The SDK's format (see node_modules/@anthropic-ai/claude-agent-sdk/cli.js, the
 * AskUserQuestion mapToolResultToToolResultBlockParam) is:
 *   `User has answered your questions: "Q1"="A1", "Q2"="A2". You can now continue
 *    with the user's answers in mind.`
 * Per-entry annotation lines (`selected preview:\n…`, `user notes: …`) may be
 * appended after an answer; they are ignored here.
 */
export function parseAnsweredToolResult(
  content: ToolResultContent,
): StructuredAnswers | null {
  const text = normalizeResultContent(content);
  const prefixIdx = text.indexOf(ANSWERED_PREFIX);
  if (prefixIdx < 0) return null;

  let body = text.slice(prefixIdx + ANSWERED_PREFIX.length).trim();
  const tailIdx = body.lastIndexOf('. You can now continue');
  if (tailIdx >= 0) body = body.slice(0, tailIdx);

  const result: StructuredAnswers = {};
  const pairRe = /"([^"]*)"="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(body)) !== null) {
    if (m[1] !== undefined && m[2] !== undefined) {
      result[m[1]] = m[2];
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Classify an AskUserQuestion tool_result into a terminal state for the UI.
 *
 *   - { kind: 'errored', message }       — SDK validation or other tool error
 *   - { kind: 'dismissed' }              — user dismissed / canceled
 *   - { kind: 'answered', answers }      — successfully answered (parsed from content)
 *   - null                                — no terminal state (still pending)
 */
export function classifyAskUserToolResult(
  toolResult: ToolResultContent,
): ToolResultClassification {
  if (toolResult == null) return null;
  const text = normalizeResultContent(toolResult);
  if (!text) return null;

  if (
    text.includes('<tool_use_error>') ||
    text.includes('InputValidationError')
  ) {
    let message =
      'The question could not be asked (the agent’s input was rejected).';
    if (
      /Too big.*expected array.*<=\s*4/i.test(text) ||
      /maximum.*4/i.test(text)
    ) {
      message =
        'Claude tried to ask more than 4 questions at once — the SDK rejected the call.';
    }
    return { kind: 'errored', message };
  }

  if (
    /^User dismissed/i.test(text) ||
    text.includes('User declined to answer')
  ) {
    return { kind: 'dismissed' };
  }

  const answers = parseAnsweredToolResult(text);
  if (answers) return { kind: 'answered', answers };

  return null;
}
