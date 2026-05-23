import { Badge } from '../ui/badge';
import {
  getAnswerDisplay,
  classifyAskUserToolResult,
  type Question,
  type StructuredAnswers,
  type ToolResultContent,
} from './answerUtils';

export interface AskUserQuestionCardProps {
  questions: Question[];
  isAnswered?: boolean | undefined;
  answers?: StructuredAnswers | null | undefined;
  toolResult?: ToolResultContent | undefined;
  onOpenPanel?: (() => void) | undefined;
}

/**
 * AskUserQuestionCard - Inline summary card shown in the message flow
 *
 * Renders one of four states based on (a) the SDK-written `toolResult` attached
 * to the tool_use, and (b) any locally-tracked answer state from the wizard.
 * In priority order:
 *   1. errored   — SDK rejected the call (e.g. >4 questions); no Answer button.
 *   2. dismissed — user canceled / SDK reported dismissal; no Answer button.
 *   3. answered  — either local state has answers, or the success tool_result
 *                  string parses cleanly. Renders headers + answers.
 *   4. unanswered — no terminal toolResult yet; shows the Answer button.
 */
function AskUserQuestionCard({
  questions,
  isAnswered,
  answers,
  toolResult,
  onOpenPanel,
}: AskUserQuestionCardProps) {
  if (!questions || !Array.isArray(questions) || questions.length === 0) {
    return null;
  }

  // Terminal state from JSONL takes precedence over local state.
  const terminal = classifyAskUserToolResult(toolResult);
  const effectiveAnswered = isAnswered || terminal?.kind === 'answered';
  const effectiveAnswers: StructuredAnswers | null =
    answers ?? (terminal?.kind === 'answered' ? terminal.answers : null);

  if (terminal?.kind === 'errored') {
    return (
      <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800 rounded-lg p-3 my-2">
        <div className="flex items-center gap-2 mb-2">
          <svg
            className="w-4 h-4 text-red-600 dark:text-red-400"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clipRule="evenodd"
            />
          </svg>
          <span className="text-sm font-medium text-red-800 dark:text-red-300">
            Question failed
          </span>
        </div>
        <div className="text-sm text-red-700 dark:text-red-300">
          {terminal.message}
        </div>
      </div>
    );
  }

  if (terminal?.kind === 'dismissed') {
    return (
      <div className="bg-slate-50 dark:bg-slate-900/30 border border-slate-200 dark:border-slate-700 rounded-lg p-3 my-2">
        <div className="flex items-center gap-2 mb-2">
          <svg
            className="w-4 h-4 text-slate-500 dark:text-slate-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Question dismissed
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {questions.map((q, idx) => (
            <Badge
              key={idx}
              variant="outline"
              className="text-xs px-2 py-0.5 bg-slate-100 dark:bg-slate-800/50 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-700"
            >
              {q.header}
            </Badge>
          ))}
        </div>
      </div>
    );
  }

  if (effectiveAnswered) {
    return (
      <div className="bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800 rounded-lg p-3 my-2">
        <div className="flex items-center gap-2 mb-2">
          <svg
            className="w-4 h-4 text-green-600 dark:text-green-400"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clipRule="evenodd"
            />
          </svg>
          <span className="text-sm font-medium text-green-800 dark:text-green-300">
            Questions answered
          </span>
        </div>
        <div className="space-y-1.5">
          {questions.map((q, idx) => {
            // Answers may be keyed by full question text (SDK tool_result parsing)
            // or by header (frontend-derived from a follow-up user message), so
            // try both before falling back to the positional label.
            const value =
              effectiveAnswers?.[q.question] ??
              (q.header ? effectiveAnswers?.[q.header] : undefined) ??
              effectiveAnswers?.[`Question ${idx + 1}`];
            return (
              <div key={idx} className="flex items-center gap-2 text-sm">
                <span className="text-gray-500 dark:text-gray-400 font-medium">
                  {q.header}:
                </span>
                <span className="text-gray-700 dark:text-gray-300">
                  {getAnswerDisplay(value, '')}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-lg p-3 my-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <svg
              className="w-4 h-4 text-blue-600 dark:text-blue-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span className="text-sm font-medium text-blue-800 dark:text-blue-300">
              Claude has {questions.length}{' '}
              {questions.length === 1 ? 'question' : 'questions'} for you
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {questions.map((q, idx) => (
              <Badge
                key={idx}
                variant="outline"
                className="text-xs px-2 py-0.5 bg-blue-100 dark:bg-blue-800/30 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700"
              >
                {q.header}
              </Badge>
            ))}
          </div>
        </div>
        <button
          onClick={onOpenPanel}
          className="flex-shrink-0 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 rounded-lg transition-colors"
        >
          Answer
        </button>
      </div>
    </div>
  );
}

export default AskUserQuestionCard;
