import React, { useState, useEffect } from 'react';
import { cn } from '../lib/utils';
import type { ClaudeStatusPayload } from '../../shared/websocket/messages';

export interface ClaudeStatusProps {
  status: ClaudeStatusPayload | null | undefined;
  onAbort?: () => void;
  isLoading: boolean;
  /** Currently informational only — kept for forward-compatibility with other providers. */
  provider?: string;
}

function ClaudeStatus({ status, onAbort, isLoading, provider }: ClaudeStatusProps) {
  const providerLabel =
    provider === 'codex'
      ? 'Codex'
      : provider === 'opencode'
        ? 'OpenCode'
        : 'Claude';
  const [elapsedTime, setElapsedTime] = useState(0);
  const [animationPhase, setAnimationPhase] = useState(0);

  // Update elapsed time every second
  useEffect(() => {
    if (!isLoading) {
      setElapsedTime(0);
      return;
    }

    const startTime = Date.now();

    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      setElapsedTime(elapsed);
    }, 1000);

    return () => clearInterval(timer);
  }, [isLoading]);

  // Animate the status indicator
  useEffect(() => {
    if (!isLoading) return;

    const timer = setInterval(() => {
      setAnimationPhase((prev) => (prev + 1) % 4);
    }, 500);

    return () => clearInterval(timer);
  }, [isLoading]);

  // Don't show if loading is false
  // Note: showThinking only controls the reasoning accordion in messages, not this processing indicator
  if (!isLoading) return null;

  // Clever action words that cycle
  const actionWords = [
    'Thinking',
    'Processing',
    'Analyzing',
    'Working',
    'Computing',
    'Reasoning',
  ];
  const actionIndex = Math.floor(elapsedTime / 3) % actionWords.length;

  // Parse status data
  const statusText = status?.text || actionWords[actionIndex];
  const tokens = status?.tokens || 0;
  const canInterrupt = status?.can_interrupt !== false;

  // Animation characters
  const spinners = ['✻', '✹', '✸', '✶'];
  const currentSpinner = spinners[animationPhase];

  return (
    <div className="w-full mb-3 sm:mb-6 animate-in slide-in-from-bottom duration-300">
      <div className="flex items-center justify-between max-w-4xl mx-auto bg-gray-800 dark:bg-gray-900 text-white rounded-lg shadow-lg px-2.5 py-2 sm:px-4 sm:py-3 border border-gray-700 dark:border-gray-800">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Animated spinner */}
            <span
              className={cn(
                'text-base sm:text-xl transition-all duration-500 flex-shrink-0',
                animationPhase % 2 === 0
                  ? 'text-blue-400 scale-110'
                  : 'text-blue-300',
              )}
            >
              {currentSpinner}
            </span>

            {/* Status text - compact for mobile */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <span className="font-medium text-xs sm:text-sm truncate">
                  {providerLabel} {(statusText ?? 'thinking').toLowerCase()}...
                </span>
                <span className="text-gray-400 text-xs sm:text-sm flex-shrink-0">
                  ({elapsedTime}s)
                </span>
                {tokens > 0 && (
                  <>
                    <span className="text-gray-500 hidden sm:inline">·</span>
                    <span className="text-gray-300 text-xs sm:text-sm hidden sm:inline flex-shrink-0">
                      ⚒ {tokens.toLocaleString()}
                    </span>
                  </>
                )}
                <span className="text-gray-500 hidden sm:inline">·</span>
                <span className="text-gray-400 text-xs sm:text-sm hidden sm:inline">
                  esc to stop
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Interrupt button */}
        {canInterrupt && onAbort && (
          <button
            onClick={onAbort}
            className="ml-2 sm:ml-3 text-xs bg-red-600 hover:bg-red-700 active:bg-red-800 text-white px-2 py-1 sm:px-3 sm:py-1.5 rounded-md transition-colors flex items-center gap-1 sm:gap-1.5 flex-shrink-0 font-medium"
          >
            <svg
              className="w-3 h-3"
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
            <span className="hidden sm:inline">Stop</span>
          </button>
        )}
      </div>
    </div>
  );
}

export default ClaudeStatus;
