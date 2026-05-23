/**
 * Breadcrumb.tsx - Navigation Breadcrumb Component
 *
 * Displays a clickable navigation path for the task-driven workflow.
 * Shows: Project > Task > Conversation (when applicable)
 */

import React, { type ComponentType } from 'react';
import { ChevronRight, Home, FolderOpen, FileText, MessageSquare } from 'lucide-react';
import { cn } from '../lib/utils';
import type { ProjectRow, TaskRow, ConversationRow } from '../../shared/types/db';

export interface BreadcrumbProps {
  project?: Pick<ProjectRow, 'id' | 'name'> | null | undefined;
  task?: Pick<TaskRow, 'id' | 'title'> | null | undefined;
  conversation?: Pick<ConversationRow, 'id'> | null | undefined;
  onProjectClick?: (() => void) | undefined;
  onTaskClick?: (() => void) | undefined;
  onHomeClick?: (() => void) | undefined;
  className?: string | undefined;
}

interface BreadcrumbItem {
  key: string;
  label: string;
  icon: ComponentType<{ className?: string | undefined }>;
  onClick: (() => void) | null | undefined;
  isClickable: boolean;
}

function Breadcrumb({
  project,
  task,
  conversation,
  onProjectClick,
  onTaskClick,
  onHomeClick,
  className,
}: BreadcrumbProps) {
  const items: BreadcrumbItem[] = [];

  // Home/Projects link (always present)
  items.push({
    key: 'home',
    label: 'Projects',
    icon: Home,
    onClick: onHomeClick,
    isClickable: true,
  });

  // Project (if selected)
  if (project) {
    items.push({
      key: 'project',
      label: project.name,
      icon: FolderOpen,
      onClick: onProjectClick,
      isClickable: !!task || !!conversation,
    });
  }

  // Task (if selected)
  if (task) {
    items.push({
      key: 'task',
      label: task.title || `Task ${task.id}`,
      icon: FileText,
      onClick: onTaskClick,
      isClickable: !!conversation,
    });
  }

  // Conversation (if active)
  if (conversation) {
    items.push({
      key: 'conversation',
      label: 'Chat',
      icon: MessageSquare,
      onClick: null,
      isClickable: false,
    });
  }

  return (
    <nav className={cn('flex items-center text-sm', className)} aria-label="Breadcrumb">
      <ol className="flex items-center flex-wrap gap-1">
        {items.map((item, index) => {
          const Icon = item.icon;
          const isLast = index === items.length - 1;

          return (
            <li key={item.key} className="flex items-center">
              {index > 0 && (
                <ChevronRight className="w-4 h-4 text-muted-foreground mx-1 flex-shrink-0" />
              )}
              {item.isClickable ? (
                <button
                  onClick={item.onClick ?? undefined}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate max-w-[150px]">{item.label}</span>
                </button>
              ) : (
                <span
                  className={cn(
                    'flex items-center gap-1.5 px-2 py-1',
                    isLast ? 'text-foreground font-medium' : 'text-muted-foreground'
                  )}
                >
                  <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate max-w-[150px]">{item.label}</span>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export default Breadcrumb;
