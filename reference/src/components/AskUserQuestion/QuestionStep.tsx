import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Badge } from '../ui/badge';
import OptionButton from './OptionButton';
import {
  isOtherAnswer,
  type Answer,
  type Question,
  type SingleAnswer,
} from './answerUtils';

interface QuestionStepProps {
  question: Question;
  answer: Answer;
  onAnswerChange: (value: Answer) => void;
}

/**
 * QuestionStep - Single question with options (radio or checkbox)
 * Includes an "Other" free-text option at the end.
 */
function QuestionStep({
  question,
  answer,
  onAnswerChange,
}: QuestionStepProps) {
  const isMultiSelect = question.multiSelect === true;
  const [otherText, setOtherText] = useState('');
  const [showOtherInput, setShowOtherInput] = useState(false);

  // Sync otherText from existing answer
  useEffect(() => {
    if (isMultiSelect && Array.isArray(answer)) {
      const otherEntry = answer.find((a) => isOtherAnswer(a));
      if (otherEntry && isOtherAnswer(otherEntry)) {
        setOtherText(otherEntry.other);
        setShowOtherInput(true);
      } else {
        setShowOtherInput(false);
      }
    } else if (answer && isOtherAnswer(answer)) {
      setOtherText(answer.other);
      setShowOtherInput(true);
    } else {
      setShowOtherInput(false);
    }
  }, [answer, isMultiSelect]);

  const isOptionSelected = (optionLabel: string): boolean => {
    if (isMultiSelect && Array.isArray(answer)) {
      return answer.includes(optionLabel);
    }
    return answer === optionLabel;
  };

  const isOtherSelected = (): boolean => {
    if (isMultiSelect && Array.isArray(answer)) {
      return answer.some((a) => isOtherAnswer(a));
    }
    return answer != null && !Array.isArray(answer) && isOtherAnswer(answer);
  };

  const handleOptionToggle = (optionLabel: string): void => {
    if (isMultiSelect) {
      const current: SingleAnswer[] = Array.isArray(answer) ? [...answer] : [];
      const idx = current.indexOf(optionLabel);
      if (idx >= 0) {
        current.splice(idx, 1);
      } else {
        current.push(optionLabel);
      }
      onAnswerChange(current.length > 0 ? current : undefined);
    } else {
      // Single select: toggle or set
      if (answer === optionLabel) {
        onAnswerChange(undefined);
      } else {
        onAnswerChange(optionLabel);
        setShowOtherInput(false);
      }
    }
  };

  const handleOtherToggle = (): void => {
    if (isMultiSelect) {
      const current: SingleAnswer[] = Array.isArray(answer) ? [...answer] : [];
      const otherIdx = current.findIndex((a) => isOtherAnswer(a));
      if (otherIdx >= 0) {
        current.splice(otherIdx, 1);
        setShowOtherInput(false);
        setOtherText('');
        onAnswerChange(current.length > 0 ? current : undefined);
      } else {
        setShowOtherInput(true);
        if (otherText.trim()) {
          current.push({ other: otherText.trim() });
          onAnswerChange(current);
        }
      }
    } else {
      if (isOtherSelected()) {
        setShowOtherInput(false);
        setOtherText('');
        onAnswerChange(undefined);
      } else {
        setShowOtherInput(true);
        onAnswerChange(
          otherText.trim() ? { other: otherText.trim() } : { other: '' },
        );
      }
    }
  };

  const handleOtherTextChange = (text: string): void => {
    setOtherText(text);
    if (isMultiSelect) {
      const current: SingleAnswer[] = Array.isArray(answer) ? [...answer] : [];
      const otherIdx = current.findIndex((a) => isOtherAnswer(a));
      if (otherIdx >= 0) {
        current[otherIdx] = { other: text };
      } else {
        current.push({ other: text });
      }
      onAnswerChange(current);
    } else {
      onAnswerChange({ other: text });
    }
  };

  return (
    <div>
      <div className="mb-3">
        <Badge
          variant="outline"
          className="text-xs px-2 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-700 mb-2"
        >
          {question.header}
        </Badge>
        <div className="text-sm text-gray-900 dark:text-gray-100 font-medium prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {question.question}
          </ReactMarkdown>
        </div>
      </div>

      <div className="space-y-2">
        {question.options?.map((option, idx) => (
          <OptionButton
            key={idx}
            option={option}
            isSelected={isOptionSelected(option.label)}
            isMultiSelect={isMultiSelect}
            onToggle={() => handleOptionToggle(option.label)}
          />
        ))}

        {/* Other option */}
        <OptionButton
          option={{ label: 'Other...', description: 'Provide a custom answer' }}
          isSelected={isOtherSelected()}
          isMultiSelect={isMultiSelect}
          onToggle={handleOtherToggle}
        />

        {/* Other text input (multi-line textarea, Enter = new line) */}
        {showOtherInput && (
          <div className="ml-7 mt-1">
            <textarea
              value={otherText}
              onChange={(e) => handleOtherTextChange(e.target.value)}
              placeholder="Type your answer..."
              autoFocus
              rows={3}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y min-h-[60px]"
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default QuestionStep;
