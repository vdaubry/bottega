import {
  useEffect,
  useState,
  useCallback,
  useRef,
  type ComponentType,
  type KeyboardEvent,
} from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Save,
  Trash2,
  CheckSquare,
  AlertTriangle,
  Clock,
  Loader2,
  CheckCircle2,
} from 'lucide-react';
import MDEditor from '@uiw/react-md-editor';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { MicButton } from '../components/MicButton';
import AgentAttachments from '../components/AgentAttachments';
import { useTaskContext } from '../contexts/TaskContext';
import { api } from '../utils/api';
import { cn } from '../lib/utils';
import type { ProjectRow, TaskRow, TaskStatus } from '../../shared/types/db';
import type { ApiError } from '../../shared/api/_common';
import type { AttachmentFile, ActionResult } from '../components/AgentAttachments';

interface StatusOption {
  value: TaskStatus;
  label: string;
  icon: ComponentType<{ className?: string | undefined }>;
  className: string;
}

const STATUS_OPTIONS: StatusOption[] = [
  {
    value: 'pending',
    label: 'Pending',
    icon: Clock,
    className: 'text-muted-foreground',
  },
  {
    value: 'in_progress',
    label: 'In Progress',
    icon: Loader2,
    className: 'text-yellow-600 dark:text-yellow-500',
  },
  {
    value: 'completed',
    label: 'Completed',
    icon: CheckCircle2,
    className: 'text-green-600 dark:text-green-500',
  },
];

function TaskEditPageWrapper() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>();
  const navigate = useNavigate();
  const {
    projects,
    tasks,
    taskDoc,
    isLoadingTaskDoc,
    loadProjects,
    loadTasks,
    loadTaskDoc,
    updateTask,
    deleteTask,
    saveTaskDoc,
    isLoadingProjects,
  } = useTaskContext();

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [task, setTask] = useState<TaskRow | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<TaskStatus>('pending');
  const [documentation, setDocumentation] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentFile[]>([]);
  const [isLoadingAttachments, setIsLoadingAttachments] = useState(false);

  const titleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        if (projects.length === 0 && !isLoadingProjects) {
          await loadProjects();
        }
      } finally {
        setIsLoading(false);
      }
    };

    void loadData();
  }, [projectId, loadProjects, projects.length, isLoadingProjects]);

  useEffect(() => {
    if (projects.length > 0 && projectId) {
      const foundProject = projects.find((p) => p.id === parseInt(projectId, 10));
      if (foundProject) {
        setProject(foundProject);
        void loadTasks(foundProject.id);
      } else {
        navigate(`/`, { replace: true });
      }
    }
  }, [projects, projectId, loadTasks, navigate]);

  const loadAttachments = useCallback(async (id: number) => {
    setIsLoadingAttachments(true);
    try {
      const response = await api.tasks.listAttachments(id);
      if (response.ok) {
        const data = await response.json();
        setAttachments(Array.isArray(data) ? (data as unknown as AttachmentFile[]) : []);
      } else {
        setAttachments([]);
      }
    } catch (err) {
      console.error('Failed to load attachments:', err);
      setAttachments([]);
    } finally {
      setIsLoadingAttachments(false);
    }
  }, []);

  useEffect(() => {
    if (tasks.length > 0 && project && taskId) {
      const foundTask = tasks.find((t) => t.id === parseInt(taskId, 10));
      if (foundTask) {
        setTask(foundTask);
        void loadTaskDoc(foundTask.id);
        void loadAttachments(foundTask.id);
      } else {
        navigate(`/projects/${projectId}`, { replace: true });
      }
    }
  }, [tasks, taskId, project, projectId, loadTaskDoc, navigate, loadAttachments]);

  useEffect(() => {
    if (task) {
      setTitle(task.title || '');
      setStatus((task.status) || 'pending');
      setDocumentation(taskDoc || '');
      setHasChanges(false);
      setError(null);
    }
  }, [task, taskDoc]);

  useEffect(() => {
    if (!task) return;
    const titleChanged = title !== (task.title || '');
    const statusChanged = status !== ((task.status) || 'pending');
    const docChanged = documentation !== (taskDoc || '');
    setHasChanges(titleChanged || statusChanged || docChanged);
  }, [title, status, documentation, task, taskDoc]);

  const handleUploadAttachment = useCallback(async (file: File): Promise<ActionResult> => {
    if (!task) return { success: false, error: 'No task loaded' };
    try {
      const response = await api.tasks.uploadAttachment(task.id, file);
      if (response.ok) {
        const data = await response.json();
        setAttachments((prev) => [...prev, data.file]);
        return { success: true };
      }
      const errBody = (await response.json().catch(() => null)) as ApiError | null;
      return { success: false, error: errBody?.error || 'Failed to upload attachment' };
    } catch (err) {
      console.error('Failed to upload attachment:', err);
      const message = err instanceof Error ? err.message : 'Failed to upload attachment';
      return { success: false, error: message };
    }
  }, [task]);

  const handleDeleteAttachment = useCallback(async (filename: string): Promise<ActionResult> => {
    if (!task) return { success: false, error: 'No task loaded' };
    try {
      const response = await api.tasks.deleteAttachment(task.id, filename);
      if (response.ok) {
        setAttachments((prev) => prev.filter((f) => f.name !== filename));
        return { success: true };
      }
      const errBody = (await response.json().catch(() => null)) as ApiError | null;
      return { success: false, error: errBody?.error || 'Failed to delete attachment' };
    } catch (err) {
      console.error('Failed to delete attachment:', err);
      const message = err instanceof Error ? err.message : 'Failed to delete attachment';
      return { success: false, error: message };
    }
  }, [task]);

  // Handle save
  const handleSave = useCallback(async () => {
    if (!task) return;
    if (!title.trim()) {
      setError('Task title is required');
      titleInputRef.current?.focus();
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const taskResult = await updateTask(task.id, {
        title: title.trim(),
        status,
      });

      if (!taskResult.success) {
        setError(taskResult.error || 'Failed to save task');
        setIsSaving(false);
        return;
      }

      const docResult = await saveTaskDoc(task.id, documentation);

      if (docResult.success) {
        navigate(`/projects/${projectId}/tasks/${taskId}`);
      } else {
        setError(docResult.error || 'Task saved but failed to save documentation');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save task';
      setError(message);
    } finally {
      setIsSaving(false);
    }
  }, [task, title, status, documentation, updateTask, saveTaskDoc, navigate, projectId, taskId]);

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!task) return;

    setIsDeleting(true);
    setError(null);

    try {
      const result = await deleteTask(task.id);

      if (result.success) {
        navigate(`/projects/${projectId}`);
      } else {
        setError(result.error || 'Failed to delete task');
        setShowDeleteConfirm(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete task';
      setError(message);
      setShowDeleteConfirm(false);
    } finally {
      setIsDeleting(false);
    }
  }, [task, deleteTask, navigate, projectId]);

  const handleCancel = useCallback(() => {
    navigate(`/projects/${projectId}/tasks/${taskId}`);
  }, [navigate, projectId, taskId]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        if (showDeleteConfirm) {
          setShowDeleteConfirm(false);
        } else {
          handleCancel();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void handleSave();
      }
    },
    [showDeleteConfirm, handleCancel, handleSave]
  );

  // Loading state
  if (isLoading || isLoadingProjects || !project || !task) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <div className="w-12 h-12 mx-auto mb-4">
            <div className="w-full h-full rounded-full border-4 border-muted border-t-primary animate-spin" />
          </div>
          <p>Loading task...</p>
        </div>
      </div>
    );
  }

  const currentStatus = STATUS_OPTIONS.find((s) => s.value === status) ?? STATUS_OPTIONS[0]!;
  const StatusIcon = currentStatus.icon;

  return (
    <div
      className="h-full flex flex-col bg-background"
      onKeyDown={handleKeyDown}
      data-testid="task-edit-page"
    >
      {/* Header */}
      <div className="flex-shrink-0 bg-background border-b border-border p-3 sm:p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancel}
              className="h-8 w-8 p-0 flex-shrink-0"
              title="Back"
              data-testid="back-button"
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <CheckSquare className="w-5 h-5 text-primary flex-shrink-0" />
            <span className="font-semibold truncate">Edit Task</span>
          </div>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div
          className="mx-4 mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive flex items-center gap-2"
          data-testid="error-message"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Form content */}
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Task title */}
          <div className="space-y-2">
            <label
              htmlFor="task-title"
              className="text-sm font-medium text-foreground"
            >
              Task Title
            </label>
            <Input
              id="task-title"
              ref={titleInputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter task title..."
              className="text-base"
              data-testid="title-input"
            />
          </div>

          {/* Project context (read-only) */}
          {project && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Project
              </label>
              <div className="px-3 py-2 bg-muted/50 border border-border rounded-md text-sm text-muted-foreground">
                {project.name}
              </div>
            </div>
          )}

          {/* Status dropdown */}
          <div className="space-y-2">
            <label
              htmlFor="task-status"
              className="text-sm font-medium text-foreground"
            >
              Status
            </label>
            <div className="relative">
              <select
                id="task-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
                className={cn(
                  'w-full h-10 pl-10 pr-4 appearance-none',
                  'bg-background border border-input rounded-md',
                  'text-sm font-medium',
                  'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                  'cursor-pointer',
                  currentStatus.className
                )}
                data-testid="status-select"
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
                <StatusIcon className={cn('w-4 h-4', currentStatus.className)} />
              </div>
              <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                <svg
                  className="w-4 h-4 text-muted-foreground"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </div>
            </div>
          </div>

          {/* Documentation */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label
                htmlFor="task-documentation"
                className="text-sm font-medium text-foreground"
              >
                Documentation
              </label>
              <MicButton
                onTranscript={(transcript) => {
                  setDocumentation((prev) => {
                    if (!prev.trim()) return transcript;
                    return prev.trimEnd() + ' ' + transcript;
                  });
                }}
              />
            </div>
            {isLoadingTaskDoc ? (
              <div className="animate-pulse space-y-2 p-4 border border-border rounded-md">
                <div className="h-4 bg-muted rounded w-3/4" />
                <div className="h-4 bg-muted rounded w-1/2" />
                <div className="h-4 bg-muted rounded w-5/6" />
              </div>
            ) : (
              <div data-color-mode="auto">
                <MDEditor
                  value={documentation}
                  onChange={(val) => setDocumentation(val || '')}
                  preview="edit"
                  height={300}
                  visibleDragbar={true}
                  hideToolbar={false}
                  data-testid="documentation-editor"
                  textareaProps={{
                    placeholder: 'Add task documentation in markdown format...'
                  }}
                />
              </div>
            )}
          </div>

          {/* Attachments */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Attachments</label>
            <div className="border border-border rounded-md overflow-hidden">
              <AgentAttachments
                attachments={attachments}
                isLoading={isLoadingAttachments}
                onUpload={handleUploadAttachment}
                onDelete={handleDeleteAttachment}
              />
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-3 pt-4">
            <Button
              variant="default"
              onClick={handleSave}
              disabled={isSaving || isDeleting || !hasChanges}
              data-testid="save-button"
            >
              <Save className="w-4 h-4 mr-1.5" />
              {isSaving ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={isSaving || isDeleting}
            >
              Cancel
            </Button>
          </div>

          {/* Danger zone */}
          <div className="pt-6 border-t border-border">
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-destructive">
                Danger Zone
              </h3>

              {showDeleteConfirm ? (
                <div
                  className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg space-y-3"
                  data-testid="delete-confirmation"
                >
                  <p className="text-sm text-foreground">
                    Are you sure you want to delete this task? This will also
                    delete all conversations within this task. This action
                    cannot be undone.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleDelete}
                      disabled={isDeleting}
                      data-testid="confirm-delete-button"
                    >
                      <Trash2 className="w-4 h-4 mr-1.5" />
                      {isDeleting ? 'Deleting...' : 'Yes, Delete Task'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowDeleteConfirm(false)}
                      disabled={isDeleting}
                      data-testid="cancel-delete-button"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
                  data-testid="delete-button"
                >
                  <Trash2 className="w-4 h-4 mr-1.5" />
                  Delete Task
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Keyboard hints */}
      <div className="flex-shrink-0 px-4 py-2 border-t border-border text-xs text-muted-foreground flex items-center gap-4 bg-muted/30">
        <span>
          <kbd className="px-1.5 py-0.5 bg-muted rounded">Ctrl</kbd>+
          <kbd className="px-1.5 py-0.5 bg-muted rounded">S</kbd> Save
        </span>
        <span>
          <kbd className="px-1.5 py-0.5 bg-muted rounded">Esc</kbd> Cancel
        </span>
      </div>
    </div>
  );
}

export default TaskEditPageWrapper;
