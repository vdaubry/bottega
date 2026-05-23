/**
 * ViewToggle.tsx - Toggle between Project and In Progress views
 */

import React from 'react';
import { LayoutGrid, Clock } from 'lucide-react';
import { cn } from '../../lib/utils';

export type DashboardViewMode = 'project' | 'in_progress';

export interface ViewToggleProps {
  viewMode: DashboardViewMode;
  onViewModeChange: (mode: DashboardViewMode) => void;
  inProgressCount?: number;
}

function ViewToggle({ viewMode, onViewModeChange, inProgressCount = 0 }: ViewToggleProps) {
  return (
    <div className="inline-flex items-center rounded-lg bg-muted p-1">
      <button
        onClick={() => onViewModeChange('project')}
        className={cn(
          'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors',
          viewMode === 'project'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        <LayoutGrid className="w-4 h-4" />
        By Project
      </button>
      <button
        onClick={() => onViewModeChange('in_progress')}
        className={cn(
          'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors',
          viewMode === 'in_progress'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        <Clock className="w-4 h-4" />
        In Progress
        {inProgressCount > 0 && (
          <span className="ml-1 px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 text-xs font-semibold">
            {inProgressCount}
          </span>
        )}
      </button>
    </div>
  );
}

export default ViewToggle;
