/**
 * derivedState.ts - Derive AskUserQuestion widget UI state from displayMessages
 *
 * The AskUserQuestion tool now uses the SDK's canonical canUseTool pattern:
 * the server parks on a Promise until the user submits via the wizard panel,
 * then the SDK writes a real tool_result with the user's answers. So:
 *   - "answered" is whether the matching tool_result is present and parses
 *     as the SDK's "User has answered your questions: ..." format. Parsed
 *     answers come back keyed by question text.
 *   - "duplicate" is the historic dedup behavior: same set of question headers
 *     fingerprints to the same widget; only the last one renders, all earlier
 *     ones collapse to null.
 *
 * No backend state, no localStorage — page reload rebuilds everything from
 * the SQLite messages the user is already looking at.
 */

import {
  classifyAskUserToolResult,
  type Question,
  type StructuredAnswers,
  type ToolResultContent,
} from './answerUtils';

// ChatInterface's DisplayMessage is wider than what we need here. toolResult
// stays `unknown` at the boundary — classifyAskUserToolResult narrows it.
export interface AskWidgetDisplayMessage {
  type?: string;
  isToolUse?: boolean;
  toolName?: string;
  toolId?: string;
  toolInput?: string | { questions?: unknown } | unknown;
  toolResult?: unknown;
  content?: unknown;
}

export interface AskWidgetEntry {
  index: number;
  questions: Question[];
  fingerprint: string;
  isDuplicate: boolean;
}

export interface AskWidgetState {
  isAnswered: boolean;
  answers: StructuredAnswers | null;
  isDuplicate: boolean;
}

function parseToolInput(toolInput: unknown): unknown {
  try {
    return typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
  } catch {
    return null;
  }
}

function getQuestions(msg: AskWidgetDisplayMessage): Question[] | null {
  const parsed = parseToolInput(msg.toolInput) as
    | { questions?: unknown }
    | null;
  let questions = parsed?.questions;
  if (typeof questions === 'string') {
    try {
      questions = JSON.parse(questions);
    } catch {
      questions = null;
    }
  }
  return Array.isArray(questions) ? (questions as Question[]) : null;
}

function fingerprint(questions: Question[]): string {
  return questions.map((q) => q.header || q.question || '').join('|');
}

/**
 * Build an index of all AskUserQuestion tool calls in the message stream.
 * Returns a Map of toolId -> { index, questions, fingerprint, isDuplicate }.
 *
 * "Duplicate" means an earlier tool call shares the same fingerprint as a
 * later one — only the last in chronological order is canonical.
 */
export function indexAskWidgets(
  displayMessages: AskWidgetDisplayMessage[],
): Map<string, AskWidgetEntry> {
  const byToolId = new Map<string, AskWidgetEntry>();
  const lastByFingerprint = new Map<string, string>();

  for (let i = 0; i < displayMessages.length; i++) {
    const msg = displayMessages[i];
    if (
      msg?.type !== 'tool' ||
      !msg.isToolUse ||
      msg.toolName !== 'AskUserQuestion' ||
      !msg.toolId
    )
      continue;

    const questions = getQuestions(msg);
    if (!questions) continue;

    const fp = fingerprint(questions);
    byToolId.set(msg.toolId, {
      index: i,
      questions,
      fingerprint: fp,
      isDuplicate: false,
    });

    const prev = lastByFingerprint.get(fp);
    if (prev) {
      const prevEntry = byToolId.get(prev);
      if (prevEntry) prevEntry.isDuplicate = true;
    }
    lastByFingerprint.set(fp, msg.toolId);
  }

  return byToolId;
}

/**
 * Compute the per-widget UI state for one AskUserQuestion tool call.
 */
export function getAskWidgetState(
  toolId: string,
  questions: Question[],
  displayMessages: AskWidgetDisplayMessage[],
  index?: Map<string, AskWidgetEntry>,
): AskWidgetState {
  const idx = index || indexAskWidgets(displayMessages);
  const entry = idx.get(toolId);
  if (!entry) {
    return { isAnswered: false, answers: null, isDuplicate: false };
  }
  if (entry.isDuplicate) {
    return { isAnswered: false, answers: null, isDuplicate: true };
  }

  const message = displayMessages[entry.index];
  const terminal = classifyAskUserToolResult(
    message?.toolResult as ToolResultContent,
  );
  if (terminal?.kind === 'answered') {
    return {
      isAnswered: true,
      answers: terminal.answers,
      isDuplicate: false,
    };
  }

  return { isAnswered: false, answers: null, isDuplicate: false };
}
