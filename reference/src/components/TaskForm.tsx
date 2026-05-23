/**
 * TaskForm.jsx - Task Create Modal
 *
 * Simple modal for creating a new task.
 * Only requires a title - markdown file is created blank.
 */

import {
  useState,
  useEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { X, FileText, Zap } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { MicButton } from './MicButton';
import { isCoarsePointer } from '../utils/isCoarsePointer';

export interface TaskFormSubmitData {
  title: string;
  documentation: string;
  yolo_mode?: boolean;
}

export interface TaskFormSubmitResult {
  success: boolean;
  error?: string | undefined;
}

export interface TaskFormProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: TaskFormSubmitData) => Promise<TaskFormSubmitResult>;
  projectName?: string | undefined;
  isSubmitting?: boolean | undefined;
}

function TaskForm({
  isOpen,
  onClose,
  onSubmit,
  projectName,
  isSubmitting = false,
}: TaskFormProps) {
  const [title, setTitle] = useState('');
  const [documentation, setDocumentation] = useState('');
  const [yoloMode, setYoloMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const documentationRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setDocumentation('');
      setYoloMode(false);
      setError(null);
    }
  }, [isOpen]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!title.trim()) {
      setError('Task title is required');
      return;
    }

    try {
      const result = await onSubmit({
        title: title.trim(),
        documentation,
        yolo_mode: yoloMode,
      });

      if (!result.success) {
        setError(result.error || 'Failed to create task');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create task';
      setError(message);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="relative bg-card rounded-lg shadow-xl border border-border w-full max-w-md mx-4"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">
              Create New Task
            </h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-8 w-8 p-0"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Project context */}
          {projectName && (
            <div className="text-sm text-muted-foreground">
              Creating task in: <span className="font-medium text-foreground">{projectName}</span>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          {/* Task title */}
          <div className="space-y-2">
            <label htmlFor="task-title" className="text-sm font-medium text-foreground">
              Task Title
            </label>
            <Input
              id="task-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter a descriptive title for this task"
              autoFocus
            />
          </div>

          {/* Task Documentation */}
          <div className="space-y-2">
            <label htmlFor="task-documentation" className="text-sm font-medium text-foreground">
              Task Documentation (optional)
            </label>
            <div className="flex gap-2 items-start">
              <Textarea
                ref={documentationRef}
                id="task-documentation"
                value={documentation}
                onChange={(e) => setDocumentation(e.target.value)}
                placeholder="Add context and details about this task for the coding agent..."
                rows={5}
                className="resize-y min-h-[100px] flex-1"
              />
              <MicButton
                onTranscript={(transcript) => {
                  setDocumentation(prev => {
                    if (!prev.trim()) return transcript;
                    return prev.trimEnd() + ' ' + transcript;
                  });
                  // Focus the textarea after transcription so desktop users can
                  // keep editing. Skip this on touch devices: focusing without
                  // a user gesture leaves the field focused with the keyboard
                  // closed, and iOS Safari then eats the next tap (e.g. on
                  // "Create Task") to open the keyboard instead of submitting.
                  if (!isCoarsePointer()) {
                    requestAnimationFrame(() => {
                      if (documentationRef.current) {
                        documentationRef.current.focus();
                      }
                    });
                  }
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              This documentation is saved to <code className="bg-muted px-1 rounded">~/.bottega/projects/{'{projectId}'}/tasks/task-{'{id}'}.md</code> (outside your repo, survives worktree cleanup) and provides context when starting conversations for this task.
            </p>
          </div>

          {/* YOLO mode - single-agent end-to-end workflow */}
          <div className="flex items-start gap-3 p-3 bg-muted/50 rounded-md border border-border">
            <input
              type="checkbox"
              id="yolo-mode"
              checked={yoloMode}
              onChange={(e) => setYoloMode(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
            />
            <div className="flex-1 min-w-0">
              <label htmlFor="yolo-mode" className="flex items-center gap-2 text-sm font-medium text-foreground cursor-pointer">
                <Zap className="w-4 h-4 text-muted-foreground" />
                YOLO mode
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                Skip the 5-step workflow. A single agent plans, implements, tests, and opens a PR in one pass — no clarifying questions. Best for typo fixes and trivial tasks.
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              className="flex-1"
              disabled={isSubmitting || !title.trim()}
            >
              {isSubmitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                  Creating...
                </>
              ) : (
                'Create Task'
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default TaskForm;
