interface StepIndicatorProps {
  currentStep: number;
  totalSteps: number;
}

/**
 * StepIndicator - Progress dots showing current step in wizard
 */
function StepIndicator({
  currentStep,
  totalSteps,
}: StepIndicatorProps) {
  if (totalSteps <= 1) return null;

  // Include the summary step in the count
  const total = totalSteps + 1;

  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`w-2 h-2 rounded-full transition-colors ${
            i === currentStep
              ? 'bg-blue-600 dark:bg-blue-400'
              : i < currentStep
                ? 'bg-blue-300 dark:bg-blue-700'
                : 'bg-gray-300 dark:bg-gray-600'
          }`}
        />
      ))}
      <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
        {currentStep < totalSteps
          ? `Step ${currentStep + 1} of ${totalSteps}`
          : 'Review'}
      </span>
    </div>
  );
}

export default StepIndicator;
