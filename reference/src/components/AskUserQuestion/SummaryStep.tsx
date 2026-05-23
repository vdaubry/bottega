import { Badge } from '../ui/badge';
import {
  getAnswerDisplay,
  type AnswersMap,
  type Question,
} from './answerUtils';

interface SummaryStepProps {
  questions: Question[];
  answers: AnswersMap;
}

/**
 * SummaryStep - Final review step showing all answers before submit
 */
function SummaryStep({ questions, answers }: SummaryStepProps) {
  return (
    <div>
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">
        Review Your Answers
      </p>
      <div className="space-y-3">
        {questions.map((q, idx) => (
          <div
            key={idx}
            className="flex items-start justify-between gap-3 p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg"
          >
            <div className="flex-1 min-w-0">
              <Badge
                variant="outline"
                className="text-xs px-2 py-0.5 bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 mb-1"
              >
                {q.header}
              </Badge>
              <p className="text-sm text-gray-900 dark:text-gray-100">
                {getAnswerDisplay(answers[idx], '(not answered)')}
              </p>
            </div>
            {answers[idx] != null && (
              <svg
                className="w-5 h-5 text-green-500 dark:text-green-400 flex-shrink-0 mt-1"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  clipRule="evenodd"
                />
              </svg>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default SummaryStep;
