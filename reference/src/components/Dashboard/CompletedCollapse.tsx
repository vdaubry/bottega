/**
 * CompletedCollapse.tsx - Collapsible Completed Tasks Section
 */

import React, { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import type { TaskRow } from '../../../shared/types/db';

export interface CompletedCollapseProps {
  tasks?: TaskRow[];
  onTaskClick?: (task: TaskRow) => void;
  showProject?: boolean;
}

function CompletedCollapse({
  tasks = [],
}: CompletedCollapseProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (tasks.length === 0) return null;

  return (
    <div className="border-t border-border">
      {/* Collapse Header */}
      <button
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-accent/50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex-shrink-0 text-muted-foreground">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </div>
        <CheckCircle2 className="w-4 h-4 text-green-500" />
        <span className="text-sm font-medium text-muted-foreground">
          Completed
        </span>
        <span className="text-xs text-muted-foreground">
          ({tasks.length})
        </span>
        {!isExpanded && tasks.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground truncate max-w-[200px]">
            {tasks.slice(0, 3).map(t => t.title).join(', ')}
            {tasks.length > 3 && '...'}
          </span>
        )}
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="divide-y divide-border bg-muted/30">
          {tasks.map(task => (
            <div
              key={task.id}
              className="flex items-center gap-3 px-4 py-2 text-muted-foreground"
            >
              <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
              <span className="text-sm truncate">{task.title || `Task ${task.id}`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default CompletedCollapse;
