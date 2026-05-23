interface OptionButtonProps {
  option: { label: string; description?: string };
  isSelected: boolean;
  isMultiSelect: boolean;
  onToggle: () => void;
}

/**
 * OptionButton - Clickable radio/checkbox option for questions
 */
function OptionButton({
  option,
  isSelected,
  isMultiSelect,
  onToggle,
}: OptionButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full text-left p-3 rounded-lg border-2 transition-all min-h-[44px] ${
        isSelected
          ? 'border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-900/20'
          : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-600'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          {isMultiSelect ? (
            <div
              className={`w-4 h-4 rounded border-2 flex items-center justify-center ${
                isSelected
                  ? 'border-blue-500 dark:border-blue-400 bg-blue-500 dark:bg-blue-400'
                  : 'border-gray-400 dark:border-gray-500'
              }`}
            >
              {isSelected && (
                <svg
                  className="w-3 h-3 text-white"
                  viewBox="0 0 12 12"
                  fill="none"
                >
                  <path
                    d="M2 6L5 9L10 3"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>
          ) : (
            <div
              className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                isSelected
                  ? 'border-blue-500 dark:border-blue-400'
                  : 'border-gray-400 dark:border-gray-500'
              }`}
            >
              {isSelected && (
                <div className="w-2 h-2 rounded-full bg-blue-500 dark:bg-blue-400" />
              )}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div
            className={`text-sm font-medium ${
              isSelected
                ? 'text-blue-700 dark:text-blue-300'
                : 'text-gray-900 dark:text-gray-100'
            }`}
          >
            {option.label}
          </div>
          {option.description && (
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {option.description}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

export default OptionButton;
