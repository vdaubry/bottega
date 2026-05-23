/**
 * StatusBadge.tsx - Clickable Status Count Badge
 *
 * Displays a task count badge with status-specific styling.
 * Clickable to navigate to board view filtered by status.
 */

import React from 'react';
import { cn } from '../../lib/utils';
import type { TaskStatus } from '../../../shared/types/db';

type StatusBadgeStatus = TaskStatus;

type SizeKey = 'xs' | 'sm' | 'md';

interface StatusConfig {
  label: string;
  bgColor: string;
  textColor: string;
  hoverBg: string;
  dotColor: string;
}

const statusConfig: Record<StatusBadgeStatus, StatusConfig> = {
  pending: {
    label: 'Pending',
    bgColor: 'bg-slate-500/10 dark:bg-slate-400/10',
    textColor: 'text-slate-600 dark:text-slate-400',
    hoverBg: 'hover:bg-slate-500/20 dark:hover:bg-slate-400/20',
    dotColor: 'bg-slate-500 dark:bg-slate-400'
  },
  in_progress: {
    label: 'In Progress',
    bgColor: 'bg-amber-500/10 dark:bg-amber-400/10',
    textColor: 'text-amber-600 dark:text-amber-400',
    hoverBg: 'hover:bg-amber-500/20 dark:hover:bg-amber-400/20',
    dotColor: 'bg-amber-500 dark:bg-amber-400'
  },
  in_review: {
    label: 'Review',
    bgColor: 'bg-blue-500/10 dark:bg-blue-400/10',
    textColor: 'text-blue-600 dark:text-blue-400',
    hoverBg: 'hover:bg-blue-500/20 dark:hover:bg-blue-400/20',
    dotColor: 'bg-blue-500 dark:bg-blue-400'
  },
  completed: {
    label: 'Done',
    bgColor: 'bg-emerald-500/10 dark:bg-emerald-400/10',
    textColor: 'text-emerald-600 dark:text-emerald-400',
    hoverBg: 'hover:bg-emerald-500/20 dark:hover:bg-emerald-400/20',
    dotColor: 'bg-emerald-500 dark:bg-emerald-400'
  }
};

export interface StatusBadgeProps {
  status: StatusBadgeStatus;
  count: number;
  onClick?: ((status: StatusBadgeStatus) => void) | undefined;
  showLabel?: boolean | undefined;
  size?: SizeKey | undefined;
  className?: string | undefined;
}

function StatusBadge({
  status,
  count,
  onClick,
  showLabel = false,
  size = 'sm',
  className
}: StatusBadgeProps) {
  const config = statusConfig[status] || statusConfig.pending;

  // Don't render if count is 0
  if (count === 0) return null;

  const sizeClasses: Record<SizeKey, string> = {
    xs: 'text-xs px-1.5 py-0.5 gap-1',
    sm: 'text-xs px-2 py-1 gap-1.5',
    md: 'text-sm px-2.5 py-1 gap-2'
  };

  const dotSizes: Record<SizeKey, string> = {
    xs: 'w-1.5 h-1.5',
    sm: 'w-2 h-2',
    md: 'w-2.5 h-2.5'
  };

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(status);
      }}
      className={cn(
        'inline-flex items-center rounded-full font-medium',
        'transition-all duration-150',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        config.bgColor,
        config.textColor,
        onClick && config.hoverBg,
        onClick && 'cursor-pointer hover:scale-105 active:scale-95',
        !onClick && 'cursor-default',
        sizeClasses[size],
        className
      )}
      disabled={!onClick}
    >
      <span className={cn('rounded-full', config.dotColor, dotSizes[size])} />
      <span>{count}</span>
      {showLabel && <span>{config.label}</span>}
    </button>
  );
}

export default StatusBadge;
