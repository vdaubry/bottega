import { useState, useCallback } from 'react';
import StepIndicator from './StepIndicator';
import QuestionStep from './QuestionStep';
import SummaryStep from './SummaryStep';
import { formatAnswers } from './formatAnswers';
import {
  isOtherAnswer,
  getAnswerDisplay,
  type Answer,
  type AnswersMap,
  type Question,
  type StructuredAnswers,
} from './answerUtils';

export interface AskUserQuestionPanelProps {
  questions: Question[];
  onSubmit: (formatted: string, structured: StructuredAnswers) => void;
  onDismiss: () => void;
}

/**
 * AskUserQuestionPanel - Bottom wizard panel above MessageInput
 *
 * Guides the user through answering questions one at a time,
 * shows a summary/review step, then submits a formatted message.
 */
function AskUserQuestionPanel({
  questions,
  onSubmit,
  onDismiss,
}: AskUserQuestionPanelProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<AnswersMap>({});
  const totalQuestions = questions.length;
  const isSummaryStep = currentStep === totalQuestions;

  const handleAnswerChange = useCallback(
    (questionIndex: number, value: Answer) => {
      setAnswers((prev) => ({ ...prev, [questionIndex]: value }));
    },
    [],
  );

  const isCurrentStepValid = (): boolean => {
    if (isSummaryStep) return true;
    const answer = answers[currentStep];
    if (answer == null) return false;
    if (isOtherAnswer(answer)) return answer.other.trim().length > 0;
    if (Array.isArray(answer)) {
      if (answer.length === 0) return false;
      return answer.every((a) => {
        if (isOtherAnswer(a)) return a.other.trim().length > 0;
        return true;
      });
    }
    return true;
  };

  const handleNext = (): void => {
    if (currentStep < totalQuestions) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handlePrevious = (): void => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleEdit = (): void => {
    setCurrentStep(0);
  };

  const handleSubmit = (): void => {
    const formatted = formatAnswers(questions, answers);
    // SDK contract: updatedInput.answers is keyed by the question text.
    const structured: StructuredAnswers = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q) continue;
      const display = getAnswerDisplay(answers[i]);
      if (display) {
        structured[q.question || q.header || `Question ${i + 1}`] = display;
      }
    }
    if (formatted) {
      onSubmit(formatted, structured);
    }
  };

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
      <div className="max-w-2xl mx-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <StepIndicator
            currentStep={currentStep}
            totalSteps={totalQuestions}
          />
          <button
            onClick={onDismiss}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            aria-label="Dismiss"
          >
            <svg
              className="w-4 h-4"
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
          </button>
        </div>

        <div className="max-h-[40vh] overflow-y-auto">
          {isSummaryStep ? (
            <SummaryStep questions={questions} answers={answers} />
          ) : (
            <QuestionStep
              key={currentStep}
              question={questions[currentStep]!}
              answer={answers[currentStep]}
              onAnswerChange={(value) => handleAnswerChange(currentStep, value)}
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-gray-200 dark:border-gray-700">
          {isSummaryStep ? (
            <>
              <button
                onClick={handleEdit}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
              >
                Edit Answers
              </button>
              <button
                onClick={handleSubmit}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 rounded-lg transition-colors"
              >
                Submit
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handlePrevious}
                disabled={currentStep === 0}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>
              <button
                onClick={handleNext}
                disabled={!isCurrentStepValid()}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {currentStep === totalQuestions - 1 ? 'Review' : 'Next'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default AskUserQuestionPanel;
