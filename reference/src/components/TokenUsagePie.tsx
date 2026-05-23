import React from 'react';

export interface TokenUsagePieProps {
  used: number | null | undefined;
  total: number | null | undefined;
  onClick?: (() => void) | undefined;
}

function TokenUsagePie({ used, total, onClick }: TokenUsagePieProps) {
  // Token usage visualization component
  // Only bail out on missing values or non-positive totals; allow used===0 to render 0%
  if (used == null || total == null || total <= 0) return null;

  const percentage = Math.min(100, (used / total) * 100);
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;

  // Color based on usage level
  const getColor = () => {
    if (percentage < 50) return '#3b82f6'; // blue
    if (percentage < 75) return '#f59e0b'; // orange
    return '#ef4444'; // red
  };

  const content = (
    <>
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        className="transform -rotate-90"
      >
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-gray-300 dark:text-gray-600"
        />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke={getColor()}
          strokeWidth="2"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <span
        title={`${used.toLocaleString()} / ${total.toLocaleString()} tokens — click for details`}
      >
        {percentage.toFixed(1)}%
      </span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label="Show context usage details"
        className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 rounded px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-200 transition-colors cursor-pointer"
      >
        {content}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
      {content}
    </div>
  );
}

export default TokenUsagePie;
