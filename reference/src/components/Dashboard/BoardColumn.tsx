/**
 * BoardColumn.tsx - Kanban Board Column
 *
 * Single column in the board view displaying tasks of a specific status.
 * Features:
 * - Header with icon, title, and task count
 * - Scrollable task list
 * - Empty state illustration when no tasks
 */

import React, { type ComponentType } from 'react';
import { Circle, Loader2, CheckCircle2, Eye } from 'lucide-react';
import { cn } from '../../lib/utils';
import { ScrollArea } from '../ui/scroll-area';
import BoardTaskCard from './BoardTaskCard';
import EmptyColumnIllustration from './EmptyColumnIllustration';
import type { TaskRow, TaskStatus } from '../../../shared/types/db';

type BoardColumnStatus = TaskStatus;

interface ColumnConfig {
  title: string;
  icon: ComponentType<{ className?: string | undefined }>;
  headerBg: string;
  headerText: string;
  dotColor: string;
  borderColor: string;
}

// Status configuration
const statusConfig: Record<BoardColumnStatus, ColumnConfig> = {
  pending: {
    title: 'Pending',
    icon: Circle,
    headerBg: 'from-slate-500/10 to-slate-500/5 dark:from-slate-400/10 dark:to-slate-400/5',
    headerText: 'text-slate-600 dark:text-slate-400',
    dotColor: 'bg-slate-500 dark:bg-slate-400',
    borderColor: 'border-slate-200 dark:border-slate-700/50'
  },
  in_progress: {
    title: 'In Progress',
    icon: Loader2,
    headerBg: 'from-amber-500/10 to-amber-500/5 dark:from-amber-400/10 dark:to-amber-400/5',
    headerText: 'text-amber-600 dark:text-amber-400',
    dotColor: 'bg-amber-500 dark:bg-amber-400',
    borderColor: 'border-amber-200 dark:border-amber-700/50'
  },
  in_review: {
    title: 'In Review',
    icon: Eye,
    headerBg: 'from-blue-500/10 to-blue-500/5 dark:from-blue-400/10 dark:to-blue-400/5',
    headerText: 'text-blue-600 dark:text-blue-400',
    dotColor: 'bg-blue-500 dark:bg-blue-400',
    borderColor: 'border-blue-200 dark:border-blue-700/50'
  },
  completed: {
    title: 'Completed',
    icon: CheckCircle2,
    headerBg: 'from-emerald-500/10 to-emerald-500/5 dark:from-emerald-400/10 dark:to-emerald-400/5',
    headerText: 'text-emerald-600 dark:text-emerald-400',
    dotColor: 'bg-emerald-500 dark:bg-emerald-400',
    borderColor: 'border-emerald-200 dark:border-emerald-700/50'
  }
};

export interface BoardColumnProps {
  status: BoardColumnStatus;
  tasks?: TaskRow[];
  taskDocs?: Record<number, string>;
  taskConversationCounts?: Record<number, number>;
  isTaskLive?: (taskId: number) => boolean;
  onTaskClick?: (task: TaskRow) => void;
  onTaskEdit?: (task: TaskRow) => void;
  onTaskDelete?: (task: TaskRow) => void;
  className?: string;
}

function BoardColumn({
  status,
  tasks = [],
  taskDocs = {},
  taskConversationCounts = {},
  isTaskLive,
  onTaskClick,
  onTaskEdit,
  onTaskDelete,
  className,
}: BoardColumnProps) {
  const config = statusConfig[status] || statusConfig.pending;
  const Icon = config.icon;

  return (
    <div
      data-testid={`board-column-${status}`}
      className={cn(
        // Mobile: fixed width for scroll-snap
        'flex-shrink-0 w-[calc(100vw-3rem)]',
        '[scroll-snap-align:start]',
        // Desktop: flexible width
        'md:w-auto md:flex-shrink md:flex-1',
        // Shared styles
        'flex flex-col',
        'bg-card rounded-lg border',
        config.borderColor,
        // Subtle shadow for depth
        'shadow-sm',
        'h-full min-h-[300px] max-h-[calc(100vh-200px)]',
        className
      )}
    >
      {/* Column header */}
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2.5 border-b',
          'rounded-t-lg',
          'bg-gradient-to-r',
          config.headerBg,
          config.borderColor
        )}
      >
        <div className={cn('w-2 h-2 rounded-full', config.dotColor)} />
        <Icon className={cn('w-4 h-4', config.headerText)} />
        <h3 className={cn('font-semibold text-sm', config.headerText)}>
          {config.title}
        </h3>
        <span className={cn(
          'ml-auto text-xs font-medium px-2 py-0.5 rounded-full',
          config.headerBg,
          config.headerText
        )}>
          {tasks.length}
        </span>
      </div>

      {/* Task list */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-2">
          {tasks.length === 0 ? (
            <EmptyColumnIllustration status={status} />
          ) : (
            tasks.map((task) => (
              <BoardTaskCard
                key={task.id}
                task={task}
                isLive={isTaskLive?.(task.id) ?? false}
                isBlocked={!!task.workflow_blocked}
                conversationCount={
                  taskConversationCounts[task.id] ??
                  (task as TaskRow & { conversation_count?: number }).conversation_count ??
                  0
                }
                docPreview={taskDocs[task.id] || ''}
                onClick={onTaskClick}
                onEditClick={onTaskEdit}
                onDeleteClick={onTaskDelete}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export default BoardColumn;
