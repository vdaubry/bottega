/**
 * EmptyColumnIllustration.tsx - SVG Illustrations for Empty Board Columns
 *
 * Decorative illustrations displayed when a board column has no tasks.
 * Each status has its own unique illustration:
 * - pending: Empty clipboard
 * - in_progress: Progress indicator / working
 * - completed: Checkmark / trophy
 */

import React from 'react';
import { cn } from '../../lib/utils';
import type { TaskStatus } from '../../../shared/types/db';

type IllustrationStatus = 'pending' | 'in_progress' | 'completed';

interface Illustration {
  title: string;
  subtitle: string;
  svg: React.ReactNode;
}

const illustrations: Record<IllustrationStatus, Illustration> = {
  pending: {
    title: 'No pending tasks',
    subtitle: 'All clear! Add new tasks to get started.',
    svg: (
      <svg
        viewBox="0 0 120 120"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
      >
        {/* Clipboard body */}
        <rect
          x="30"
          y="25"
          width="60"
          height="75"
          rx="4"
          className="fill-slate-200 dark:fill-slate-700"
        />
        {/* Clipboard top clip */}
        <rect
          x="42"
          y="18"
          width="36"
          height="14"
          rx="3"
          className="fill-slate-300 dark:fill-slate-600"
        />
        {/* Inner paper area */}
        <rect
          x="38"
          y="38"
          width="44"
          height="54"
          rx="2"
          className="fill-white dark:fill-slate-800"
        />
        {/* Empty checkbox lines */}
        <rect
          x="44"
          y="46"
          width="8"
          height="8"
          rx="1"
          className="stroke-slate-300 dark:stroke-slate-600"
          strokeWidth="2"
          fill="none"
        />
        <line
          x1="56"
          y1="50"
          x2="76"
          y2="50"
          className="stroke-slate-200 dark:stroke-slate-700"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <rect
          x="44"
          y="62"
          width="8"
          height="8"
          rx="1"
          className="stroke-slate-300 dark:stroke-slate-600"
          strokeWidth="2"
          fill="none"
        />
        <line
          x1="56"
          y1="66"
          x2="76"
          y2="66"
          className="stroke-slate-200 dark:stroke-slate-700"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <rect
          x="44"
          y="78"
          width="8"
          height="8"
          rx="1"
          className="stroke-slate-300 dark:stroke-slate-600"
          strokeWidth="2"
          fill="none"
        />
        <line
          x1="56"
          y1="82"
          x2="70"
          y2="82"
          className="stroke-slate-200 dark:stroke-slate-700"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    )
  },
  in_progress: {
    title: 'No tasks in progress',
    subtitle: 'Pick a task to start working on.',
    svg: (
      <svg
        viewBox="0 0 120 120"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
      >
        {/* Gear/cog outer */}
        <circle
          cx="60"
          cy="60"
          r="35"
          className="fill-amber-100 dark:fill-amber-900/30"
        />
        {/* Gear center */}
        <circle
          cx="60"
          cy="60"
          r="20"
          className="fill-amber-200 dark:fill-amber-800/50"
        />
        {/* Gear teeth */}
        {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
          <rect
            key={angle}
            x="55"
            y="22"
            width="10"
            height="12"
            rx="2"
            className="fill-amber-300 dark:fill-amber-700"
            transform={`rotate(${angle} 60 60)`}
          />
        ))}
        {/* Center dot */}
        <circle
          cx="60"
          cy="60"
          r="8"
          className="fill-amber-400 dark:fill-amber-600"
        />
        {/* Progress arc */}
        <path
          d="M60 35 A25 25 0 0 1 85 60"
          className="stroke-amber-500 dark:stroke-amber-500"
          strokeWidth="4"
          strokeLinecap="round"
          fill="none"
        />
        {/* Dotted progress trail */}
        <path
          d="M85 60 A25 25 0 1 1 60 35"
          className="stroke-amber-200 dark:stroke-amber-800"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray="4 8"
          fill="none"
        />
      </svg>
    )
  },
  completed: {
    title: 'No completed tasks',
    subtitle: 'Finished tasks will appear here.',
    svg: (
      <svg
        viewBox="0 0 120 120"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
      >
        {/* Trophy base */}
        <rect
          x="45"
          y="90"
          width="30"
          height="10"
          rx="2"
          className="fill-emerald-300 dark:fill-emerald-700"
        />
        {/* Trophy stem */}
        <rect
          x="55"
          y="75"
          width="10"
          height="18"
          className="fill-emerald-200 dark:fill-emerald-800"
        />
        {/* Trophy cup */}
        <path
          d="M35 30 C35 30 35 65 60 75 C85 65 85 30 85 30 L35 30 Z"
          className="fill-emerald-100 dark:fill-emerald-900/50"
        />
        <path
          d="M40 35 C40 35 40 58 60 67 C80 58 80 35 80 35 L40 35 Z"
          className="fill-emerald-200 dark:fill-emerald-800/50"
        />
        {/* Trophy handles */}
        <path
          d="M35 35 C25 35 22 45 25 55 C28 60 35 60 35 55"
          className="stroke-emerald-300 dark:stroke-emerald-700"
          strokeWidth="4"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M85 35 C95 35 98 45 95 55 C92 60 85 60 85 55"
          className="stroke-emerald-300 dark:stroke-emerald-700"
          strokeWidth="4"
          strokeLinecap="round"
          fill="none"
        />
        {/* Star */}
        <polygon
          points="60,42 63,51 72,51 65,57 68,66 60,61 52,66 55,57 48,51 57,51"
          className="fill-emerald-400 dark:fill-emerald-500"
        />
      </svg>
    )
  }
};

export interface EmptyColumnIllustrationProps {
  status?: TaskStatus;
  className?: string;
}

function EmptyColumnIllustration({
  status = 'pending',
  className,
}: EmptyColumnIllustrationProps) {
  const illustration =
    (status in illustrations
      ? illustrations[status as IllustrationStatus]
      : illustrations.pending) ?? illustrations.pending;

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-10 px-4',
        className
      )}
    >
      <div className="w-28 h-28 mb-5 opacity-70 transition-opacity hover:opacity-90">
        {illustration.svg}
      </div>
      <p className="text-sm font-medium text-muted-foreground text-center">
        {illustration.title}
      </p>
      <p className="text-xs text-muted-foreground/60 text-center mt-1.5 max-w-[180px]">
        {illustration.subtitle}
      </p>
    </div>
  );
}

export default EmptyColumnIllustration;
