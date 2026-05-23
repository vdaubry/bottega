/**
 * TaskRow.tsx - Individual Task Row
 *
 * Displays a task with:
 * - Status indicator (filled/empty dot)
 * - Task title
 * - Status badge (LIVE, In Progress, Pending)
 * - View button
 */

import React, { useState } from 'react';
import { FileText, Trash2, ChevronRight, Circle, CheckCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useTaskContext } from '../../contexts/TaskContext';
import type { TaskRow as TaskRowDb, ProjectRow } from '../../../shared/types/db';

// Tasks shown in the row may carry server-side decorated fields not in the
// raw DB row (live indicator, conversation count, joined project name).
export interface DisplayTask extends TaskRowDb {
  is_live?: boolean;
  conversation_count?: number;
  has_conversations?: boolean;
  project_name?: string;
}

// Format relative time
function formatTimeAgo(dateString: string | null | undefined): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();

  if (isNaN(date.getTime())) return '';

  const diffInMs = now.getTime() - date.getTime();
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
  const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

  if (diffInMinutes < 1) return 'Just now';
  if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
  if (diffInHours < 24) return `${diffInHours}h ago`;
  if (diffInDays === 1) return 'Yesterday';
  if (diffInDays < 7) return `${diffInDays}d ago`;
  return date.toLocaleDateString();
}

export interface TaskRowProps {
  task: DisplayTask;
  project?: Pick<ProjectRow, 'name'> | null | undefined;
  onClick?: (() => void) | undefined;
  onDelete?: (() => void | Promise<unknown>) | undefined;
  onComplete?: (() => void | Promise<unknown>) | undefined;
  showProject?: boolean | undefined;
}

function TaskRow({
  task,
  project,
  onClick,
  onDelete,
  onComplete,
  showProject = false,
}: TaskRowProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const { isTaskLive } = useTaskContext();

  // Determine task status from context's live task tracking
  const hasConversations =
    (task.conversation_count ?? 0) > 0 || !!task.has_conversations;
  const isLive = task.is_live || isTaskLive(task.id);

  const handleDelete = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this task?')) {
      return;
    }
    setIsDeleting(true);
    try {
      await onDelete?.();
    } finally {
      setIsDeleting(false);
    }
  };

  const handleComplete = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!confirm('Mark this task as completed?')) {
      return;
    }
    setIsCompleting(true);
    try {
      await onComplete?.();
    } finally {
      setIsCompleting(false);
    }
  };

  // Status badge component to avoid duplication
  const StatusBadge = () => {
    if (isLive) {
      return (
        <span
          data-testid="live-badge"
          className="flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full bg-red-500/10 text-red-500"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          LIVE
        </span>
      );
    }
    if (task.status === 'completed') {
      return (
        <span className="text-xs px-2 py-1 rounded-full bg-green-500/10 text-green-600 dark:text-green-400">
          Completed
        </span>
      );
    }
    if (task.status === 'in_progress') {
      return (
        <span className="text-xs px-2 py-1 rounded-full bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
          In Progress
        </span>
      );
    }
    return (
      <span className="text-xs px-2 py-1 rounded-full bg-muted text-muted-foreground">
        Pending
      </span>
    );
  };

  // Action buttons component to avoid duplication
  const ActionButtons = () => (
    <>
      {/* Complete Button - only show if onComplete is provided */}
      {onComplete && (
        <button
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-green-500/10 rounded"
          onClick={handleComplete}
          title="Mark as completed"
        >
          {isCompleting ? (
            <div className="w-3.5 h-3.5 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
          ) : (
            <CheckCircle className="w-3.5 h-3.5 text-muted-foreground hover:text-green-500" />
          )}
        </button>
      )}

      {/* Delete Button */}
      <button
        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-500/10 rounded"
        onClick={handleDelete}
      >
        {isDeleting ? (
          <div className="w-3.5 h-3.5 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
        ) : (
          <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-red-500" />
        )}
      </button>

      {/* View Arrow */}
      <ChevronRight className="w-4 h-4 text-muted-foreground" />
    </>
  );

  // Mobile layout when showProject is true - two-line stacked layout
  if (showProject) {
    return (
      <div
        data-testid={`task-row-${task.id}`}
        className={cn(
          'group p-3 hover:bg-accent/50 cursor-pointer transition-colors',
          isLive && 'bg-red-500/5'
        )}
        onClick={onClick}
      >
        {/* First row: Status indicator, icon, task title */}
        <div className="flex items-center gap-3">
          {/* Status Indicator */}
          <div className="flex-shrink-0">
            {hasConversations ? (
              <div className={cn(
                'w-2.5 h-2.5 rounded-full',
                isLive ? 'bg-red-500 animate-pulse' : 'bg-primary'
              )} />
            ) : (
              <Circle className="w-2.5 h-2.5 text-muted-foreground" />
            )}
          </div>

          {/* Task Icon */}
          <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />

          {/* Task Title - full width */}
          <span className="font-medium text-foreground truncate flex-1 min-w-0">
            {task.title || `Task ${task.id}`}
          </span>

          {/* Desktop only: show badges and actions inline */}
          <div className="hidden sm:flex flex-shrink-0 items-center gap-2">
            <StatusBadge />
            <ActionButtons />
          </div>
        </div>

        {/* Second row: Project name, status, time, and action buttons */}
        <div className="flex items-center justify-between mt-2 pl-[calc(0.625rem+0.75rem+1rem+0.75rem)]">
          {/* Left side: Project name, status (mobile only), time */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {(project?.name || task.project_name) && (
              <span className="text-xs text-muted-foreground truncate max-w-[120px] sm:max-w-[150px]">
                {project?.name || task.project_name}
              </span>
            )}
            {/* Mobile: show status badge */}
            <div className="sm:hidden">
              <StatusBadge />
            </div>
            <span className="text-xs text-muted-foreground">
              {formatTimeAgo(task.updated_at || task.created_at)}
            </span>
          </div>

          {/* Mobile only: action buttons */}
          <div className="flex sm:hidden items-center gap-2 flex-shrink-0">
            <ActionButtons />
          </div>
        </div>
      </div>
    );
  }

  // Default single-line layout (when showProject is false)
  return (
    <div
      data-testid={`task-row-${task.id}`}
      className={cn(
        'group flex items-center gap-3 p-3 hover:bg-accent/50 cursor-pointer transition-colors',
        isLive && 'bg-red-500/5'
      )}
      onClick={onClick}
    >
      {/* Status Indicator */}
      <div className="flex-shrink-0">
        {hasConversations ? (
          <div className={cn(
            'w-2.5 h-2.5 rounded-full',
            isLive ? 'bg-red-500 animate-pulse' : 'bg-primary'
          )} />
        ) : (
          <Circle className="w-2.5 h-2.5 text-muted-foreground" />
        )}
      </div>

      {/* Task Icon */}
      <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />

      {/* Task Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground truncate">
            {task.title || `Task ${task.id}`}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {formatTimeAgo(task.updated_at || task.created_at)}
        </div>
      </div>

      {/* Status Badge and Actions */}
      <div className="flex-shrink-0 flex items-center gap-2">
        <StatusBadge />
        <ActionButtons />
      </div>
    </div>
  );
}

export default TaskRow;
