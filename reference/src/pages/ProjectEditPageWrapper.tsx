import {
  useEffect,
  useState,
  useCallback,
  useRef,
  type KeyboardEvent,
} from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Trash2, FolderOpen, AlertTriangle, Archive, Server } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useTaskContext } from '../contexts/TaskContext';
import { api } from '../utils/api';
import type { ProjectRow } from '../../shared/types/db';
import type { CleanupOldCompletedTasksResponse } from '../../shared/api/tasks';
import type { ApiError } from '../../shared/api/_common';

interface WebServerConfigState {
  serveSymlinkPath: string;
  systemdServiceName: string;
  appUrl: string;
}

function ProjectEditPageWrapper() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const {
    projects,
    loadProjects,
    updateProject,
    deleteProject,
    isLoadingProjects,
  } = useTaskContext();

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [name, setName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<CleanupOldCompletedTasksResponse | null>(null);

  const [subprojectPath, setSubprojectPath] = useState('');

  const [serveSymlinkPath, setServeSymlinkPath] = useState('');
  const [systemdServiceName, setSystemdServiceName] = useState('');
  const [appUrl, setAppUrl] = useState('');
  const [initialWebServerConfig, setInitialWebServerConfig] = useState<WebServerConfigState>({
    serveSymlinkPath: '',
    systemdServiceName: '',
    appUrl: '',
  });

  const nameInputRef = useRef<HTMLInputElement | null>(null);

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
      } else {
        navigate(`/`, { replace: true });
      }
    }
  }, [projects, projectId, navigate]);

  // Initialize form with project data
  useEffect(() => {
    if (project) {
      setName(project.name || '');
      setSubprojectPath(project.subproject_path || '');
      setHasChanges(false);
      setError(null);
    }
  }, [project]);

  useEffect(() => {
    const loadWebServerConfig = async () => {
      if (!project) return;
      try {
        const response = await api.projects.getWebServer(project.id);
        if (response.ok) {
          const data = await response.json();
          if (data.success) {
            setServeSymlinkPath(data.serveSymlinkPath || '');
            setSystemdServiceName(data.systemdServiceName || '');
            setAppUrl(data.appUrl || '');
            setInitialWebServerConfig({
              serveSymlinkPath: data.serveSymlinkPath || '',
              systemdServiceName: data.systemdServiceName || '',
              appUrl: data.appUrl || '',
            });
          }
        }
      } catch (error) {
        console.error('Error loading web server config:', error);
      }
    };
    void loadWebServerConfig();
  }, [project]);

  // Track changes
  useEffect(() => {
    if (!project) return;
    const nameChanged = name !== (project.name || '');
    const subprojectChanged = subprojectPath !== (project.subproject_path || '');
    const webServerChanged = serveSymlinkPath !== initialWebServerConfig.serveSymlinkPath ||
      systemdServiceName !== initialWebServerConfig.systemdServiceName ||
      appUrl !== initialWebServerConfig.appUrl;
    setHasChanges(nameChanged || subprojectChanged || webServerChanged);
  }, [name, project, subprojectPath, serveSymlinkPath, systemdServiceName, appUrl, initialWebServerConfig]);

  // Handle save
  const handleSave = useCallback(async () => {
    if (!project) return;
    if (!name.trim()) {
      setError('Project name is required');
      nameInputRef.current?.focus();
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const result = await updateProject(project.id, {
        name: name.trim(),
        subprojectPath: subprojectPath.trim() || undefined,
      });

      if (!result.success) {
        setError(result.error || 'Failed to save project');
        return;
      }

      const webServerChanged = serveSymlinkPath !== initialWebServerConfig.serveSymlinkPath ||
        systemdServiceName !== initialWebServerConfig.systemdServiceName ||
        appUrl !== initialWebServerConfig.appUrl;

      if (webServerChanged) {
        const webServerResponse = await api.projects.updateWebServerConfig(project.id, {
          serveSymlinkPath: serveSymlinkPath.trim() || undefined,
          systemdServiceName: systemdServiceName.trim() || undefined,
          appUrl: appUrl.trim() || undefined,
        });

        if (!webServerResponse.ok) {
          const data = (await webServerResponse.json()) as ApiError;
          setError(data.error || 'Failed to save web server config');
          return;
        }
      }

      navigate(`/projects/${projectId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save project';
      setError(message);
    } finally {
      setIsSaving(false);
    }
  }, [project, name, subprojectPath, serveSymlinkPath, systemdServiceName, appUrl, initialWebServerConfig, updateProject, navigate, projectId]);

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!project) return;

    setIsDeleting(true);
    setError(null);

    try {
      const result = await deleteProject(project.id);

      if (result.success) {
        navigate(`/`);
      } else {
        setError(result.error || 'Failed to delete project');
        setShowDeleteConfirm(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete project';
      setError(message);
      setShowDeleteConfirm(false);
    } finally {
      setIsDeleting(false);
    }
  }, [project, deleteProject, navigate]);

  // Handle cancel
  const handleCancel = useCallback(() => {
    navigate(`/projects/${projectId}`);
  }, [navigate, projectId]);

  // Handle cleanup old completed tasks
  const handleCleanupOldTasks = useCallback(async () => {
    if (!project) return;

    setIsCleaning(true);
    setError(null);
    setCleanupResult(null);

    try {
      const response = await api.tasks.cleanupOldCompleted(project.id);
      if (!response.ok) {
        const data = (await response.json()) as unknown as ApiError;
        throw new Error(data.error || 'Failed to cleanup old tasks');
      }
      const result = await response.json();
      setCleanupResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to cleanup old tasks';
      setError(message);
    } finally {
      setIsCleaning(false);
    }
  }, [project]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
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
  }, [showDeleteConfirm, handleCancel, handleSave]);

  // Loading state
  if (isLoading || isLoadingProjects || !project) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <div className="w-12 h-12 mx-auto mb-4">
            <div className="w-full h-full rounded-full border-4 border-muted border-t-primary animate-spin" />
          </div>
          <p>Loading project...</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full flex flex-col bg-background"
      onKeyDown={handleKeyDown}
      data-testid="project-edit-page"
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
            <FolderOpen className="w-5 h-5 text-primary flex-shrink-0" />
            <span className="font-semibold truncate">Edit Project</span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCancel}
              disabled={isSaving || isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={handleSave}
              disabled={isSaving || isDeleting || !hasChanges}
              data-testid="save-button"
            >
              <Save className="w-4 h-4 mr-1.5" />
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
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
          {/* Project name */}
          <div className="space-y-2">
            <label
              htmlFor="project-name"
              className="text-sm font-medium text-foreground"
            >
              Project Name
            </label>
            <Input
              id="project-name"
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter project name..."
              className="text-base"
              data-testid="name-input"
            />
          </div>

          {/* Folder path (read-only) */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Folder Path
            </label>
            <div className="px-3 py-2 bg-muted/50 border border-border rounded-md text-sm text-muted-foreground font-mono">
              {project.repo_folder_path || 'No folder path'}
            </div>
          </div>

          {/* Web Server Configuration */}
          <div className="pt-6 border-t border-border">
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-muted-foreground" />
                <h3 className="text-sm font-medium text-foreground">
                  Worktree Configuration
                </h3>
              </div>

              {/* Subproject Path (for monorepos) */}
              <div className="space-y-2">
                <label
                  htmlFor="subproject-path"
                  className="text-sm font-medium text-foreground"
                >
                  Subproject Path (for monorepos)
                </label>
                <Input
                  id="subproject-path"
                  type="text"
                  value={subprojectPath}
                  onChange={(e) => setSubprojectPath(e.target.value)}
                  placeholder="e.g., packages/my-app"
                  className="font-mono text-sm"
                  data-testid="subproject-path-input"
                />
                <p className="text-xs text-muted-foreground">
                  For monorepos only. Relative path from worktree root to the actual project folder.
                  Leave empty for simple repos where the project is at the git root.
                </p>
              </div>

              <div className="pt-4 border-t border-border/50">
                <h4 className="text-sm font-medium text-foreground mb-2">
                  Web Server Switching
                </h4>
                <p className="text-sm text-muted-foreground mb-4">
                  Configure how to switch between worktrees for live testing. When a task uses a worktree,
                  you can switch the web server to serve from that worktree's directory.
                </p>
              </div>

              {/* Symlink Path */}
              <div className="space-y-2">
                <label
                  htmlFor="symlink-path"
                  className="text-sm font-medium text-foreground"
                >
                  Symlink Path
                </label>
                <Input
                  id="symlink-path"
                  type="text"
                  value={serveSymlinkPath}
                  onChange={(e) => setServeSymlinkPath(e.target.value)}
                  placeholder="/var/www/my-project"
                  className="font-mono text-sm"
                  data-testid="symlink-path-input"
                />
                <p className="text-xs text-muted-foreground">
                  The symlink that points to the active directory. This is what your web server should use as the root.
                </p>
              </div>

              {/* Systemd Service Name */}
              <div className="space-y-2">
                <label
                  htmlFor="systemd-service"
                  className="text-sm font-medium text-foreground"
                >
                  Systemd User Service Name
                </label>
                <Input
                  id="systemd-service"
                  type="text"
                  value={systemdServiceName}
                  onChange={(e) => setSystemdServiceName(e.target.value)}
                  placeholder="puma@my-project"
                  className="font-mono text-sm"
                  data-testid="systemd-service-input"
                />
                <p className="text-xs text-muted-foreground">
                  The systemd user service to restart when switching worktrees (e.g., puma@project-name).
                </p>
              </div>

              {/* App URL */}
              <div className="space-y-2">
                <label
                  htmlFor="app-url"
                  className="text-sm font-medium text-foreground"
                >
                  App URL
                </label>
                <Input
                  id="app-url"
                  type="url"
                  value={appUrl}
                  onChange={(e) => setAppUrl(e.target.value)}
                  placeholder="https://my-project.example.com"
                  className="font-mono text-sm"
                  data-testid="app-url-input"
                />
                <p className="text-xs text-muted-foreground">
                  Public URL of the deployed app (the nginx subdomain). When set, "Switch Server"
                  opens this URL in a new tab. Leave empty to skip opening a tab.
                </p>
              </div>
            </div>
          </div>

          {/* Maintenance section */}
          <div className="pt-6 border-t border-border">
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-foreground">
                Maintenance
              </h3>
              <p className="text-sm text-muted-foreground">
                Clean up old completed tasks to reduce clutter. This will keep the 20 most recent completed tasks and delete older ones along with their documentation files.
              </p>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCleanupOldTasks}
                  disabled={isCleaning || isSaving || isDeleting}
                  data-testid="cleanup-button"
                >
                  <Archive className="w-4 h-4 mr-1.5" />
                  {isCleaning ? 'Cleaning...' : 'Delete Old Completed Tasks'}
                </Button>
                {cleanupResult && (
                  <span className="text-sm text-muted-foreground">
                    {cleanupResult.message}
                  </span>
                )}
              </div>
            </div>
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
                    Are you sure you want to delete this project? This will also
                    delete all tasks and conversations within this project.
                    This action cannot be undone.
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
                      {isDeleting ? 'Deleting...' : 'Yes, Delete Project'}
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
                  Delete Project
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

export default ProjectEditPageWrapper;
