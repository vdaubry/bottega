/**
 * InProgressSection.tsx - Display In-Progress Tasks
 *
 * Shows all tasks with status 'in_progress' across all projects.
 * Tasks can have a "live" indicator if they have an active streaming conversation.
 */

import React from 'react';
import { Clock, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import TaskRow, { type DisplayTask } from './TaskRow';
import { cn } from '../../lib/utils';

export interface InProgressSectionProps {
  tasks?: DisplayTask[] | undefined;
  isLoading?: boolean | undefined;
  onTaskClick: (task: DisplayTask) => void;
  onDeleteTask: (taskId: number) => void | Promise<unknown>;
  onCompleteTask: (taskId: number) => void | Promise<unknown>;
  onRefresh?: (() => void) | undefined;
}

function InProgressSection({
  tasks = [],
  isLoading = false,
  onTaskClick,
  onDeleteTask,
  onCompleteTask,
  onRefresh,
}: InProgressSectionProps) {
  if (isLoading && tasks.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <div className="w-8 h-8 mx-auto border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
        <p className="mt-4">Loading in-progress tasks...</p>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Clock className="w-12 h-12 mx-auto mb-4 opacity-50" />
        <p className="text-lg font-medium">No tasks in progress</p>
        <p className="text-sm mt-1">Tasks move here when you start a conversation</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-yellow-600 dark:text-yellow-400">
          <Clock className="w-5 h-5" />
          <span className="font-semibold">In Progress</span>
          <span className="text-sm text-muted-foreground">({tasks.length})</span>
        </div>
        {onRefresh && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={isLoading}
            className="text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
          </Button>
        )}
      </div>

      {/* Tasks list */}
      <div className="rounded-lg border border-border bg-card overflow-hidden divide-y divide-border">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            showProject
            onClick={() => onTaskClick(task)}
            onDelete={() => onDeleteTask(task.id)}
            onComplete={() => onCompleteTask(task.id)}
          />
        ))}
      </div>
    </div>
  );
}

export default InProgressSection;
