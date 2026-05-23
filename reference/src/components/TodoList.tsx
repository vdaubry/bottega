/*
 * TodoList.tsx - Todo List Widget Component
 *
 * Renders a visual todo list from TodoWrite tool calls.
 * Features:
 * - Status icons (CheckCircle2, Clock, Circle)
 * - Color-coded status badges
 * - Priority badges (when provided)
 * - Strike-through for completed items
 * - Dark mode support
 */

import { Badge } from './ui/badge';
import { CheckCircle2, Clock, Circle } from 'lucide-react';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type TodoPriority = 'low' | 'medium' | 'high';

export interface TodoItem {
  id?: string | number;
  content?: string;
  activeForm?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
}

interface TodoListProps {
  todos?: TodoItem[] | null;
  isResult?: boolean;
}

function TodoList({ todos, isResult = false }: TodoListProps) {
  if (!todos || !Array.isArray(todos)) {
    return null;
  }

  const getStatusIcon = (status: TodoStatus | undefined) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 text-green-500 dark:text-green-400" />;
      case 'in_progress':
        return <Clock className="w-4 h-4 text-blue-500 dark:text-blue-400" />;
      case 'pending':
      case undefined:
      default:
        return <Circle className="w-4 h-4 text-gray-400 dark:text-gray-500" />;
    }
  };

  const getStatusColor = (status: TodoStatus | undefined): string => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200 border-green-200 dark:border-green-800';
      case 'in_progress':
        return 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-800';
      case 'pending':
      case undefined:
      default:
        return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700';
    }
  };

  const getPriorityColor = (priority: TodoPriority | undefined): string => {
    switch (priority) {
      case 'high':
        return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800';
      case 'medium':
        return 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800';
      case 'low':
      case undefined:
      default:
        return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700';
    }
  };

  return (
    <div className="space-y-3">
      {isResult && (
        <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
          Todo List ({todos.length} {todos.length === 1 ? 'item' : 'items'})
        </div>
      )}

      {todos.map((todo, index) => (
        <div
          key={todo.id || `todo-${index}`}
          className="flex items-start gap-3 p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm hover:shadow-md dark:shadow-gray-900/50 transition-shadow"
        >
          <div className="flex-shrink-0 mt-0.5">
            {getStatusIcon(todo.status)}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2 mb-1">
              <p className={`text-sm font-medium ${todo.status === 'completed' ? 'line-through text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}>
                {todo.content || todo.activeForm}
              </p>

              <div className="flex gap-1 flex-shrink-0">
                {todo.priority && (
                  <Badge
                    variant="outline"
                    className={`text-xs px-2 py-0.5 ${getPriorityColor(todo.priority)}`}
                  >
                    {todo.priority}
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className={`text-xs px-2 py-0.5 ${getStatusColor(todo.status)}`}
                >
                  {(todo.status || 'pending').replace('_', ' ')}
                </Badge>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default TodoList;
