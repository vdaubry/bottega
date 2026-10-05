/**
 * TaskContext.tsx - State Management for Task-Driven Workflow
 *
 * This context manages the task-driven architecture:
 * - Projects: User-created projects pointing to repo folders
 * - Tasks: Work items belonging to projects
 * - Conversations: Claude sessions linked to tasks
 *
 * All state is fetched from /api/ endpoints.
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { api } from '../utils/api';
import { useWebSocket } from './WebSocketContext';
import type {
  ProjectRow,
  TaskRow,
  ConversationRow,
  TaskAgentRunRow,
} from '../../shared/types/db';
import type {
  UpdateProjectRequest,
} from '../../shared/api/projects';
import type {
  CreateTaskRequest,
  UpdateTaskRequest,
  UnsavedWorktreeWorkResponse,
} from '../../shared/api/tasks';
import { UNSAVED_WORKTREE_WORK } from '../../shared/api/tasks';
import type { ServerMessageOf } from '../../shared/websocket/messages';
import type { Provider } from '../../shared/providers/types';

// Loose row aliases — the server occasionally returns extra fields the contract
// doesn't model (e.g. `task_counts` on the project list, agent-run join shapes
// on conversations). Use the row types as the floor; consumers tolerate the
// extras structurally.
export type Project = ProjectRow;
export type Task = TaskRow;
export type Conversation = ConversationRow;
export type AgentRun = TaskAgentRunRow;

export type CurrentView =
  | 'empty'
  | 'board'
  | 'task-detail'
  | 'chat'
  | 'project-edit'
  | 'task-edit';

interface ActionResult {
  success: boolean;
  error?: string;
}

/**
 * Deleting a task destroys its worktree, so it can come back 409 with the
 * unsaved-work report rather than a plain error string.
 */
export interface DeleteTaskResult extends ActionResult {
  conflict?: UnsavedWorktreeWorkResponse;
}

export interface CreateProjectResult extends ActionResult {
  project?: Project;
}

export interface UpdateProjectResult extends ActionResult {
  project?: Project;
}

export interface CreateTaskResult extends ActionResult {
  task?: Task;
}

export interface UpdateTaskResult extends ActionResult {
  task?: Task;
}

export interface CreateConversationResult extends ActionResult {
  conversation?: Conversation;
}

export interface DocResult extends ActionResult {
  content?: string;
}

export interface TaskContextValue {
  // Projects
  projects: Project[];
  isLoadingProjects: boolean;
  projectsError: string | null;
  loadProjects: () => Promise<void>;
  createProject: (
    name: string,
    repoFolderPath: string,
    sensitiveAreas?: string,
  ) => Promise<CreateProjectResult>;
  updateProject: (
    id: number,
    data: UpdateProjectRequest,
  ) => Promise<UpdateProjectResult>;
  deleteProject: (id: number) => Promise<ActionResult>;

  // Tasks
  tasks: Task[];
  isLoadingTasks: boolean;
  tasksError: string | null;
  loadTasks: (projectId: number | null) => Promise<void>;
  createTask: (
    projectId: number,
    title: string,
    documentation?: string,
    options?: Omit<CreateTaskRequest, 'title' | 'documentation'>,
  ) => Promise<CreateTaskResult>;
  updateTask: (id: number, data: UpdateTaskRequest) => Promise<UpdateTaskResult>;
  deleteTask: (id: number, force?: boolean) => Promise<DeleteTaskResult>;
  /** Retry a failed worktree setup; the row goes back to 'provisioning'. */
  retryWorktreeSetup: (id: number) => Promise<ActionResult>;

  // Task Documentation
  taskDoc: string;
  isLoadingTaskDoc: boolean;
  loadTaskDoc: (taskId: number) => Promise<DocResult>;
  saveTaskDoc: (taskId: number, content: string) => Promise<ActionResult>;

  // Agent Runs
  agentRuns: AgentRun[];
  setAgentRuns: React.Dispatch<React.SetStateAction<AgentRun[]>>;
  isLoadingAgentRuns: boolean;
  loadAgentRuns: (taskId: number | null) => Promise<void>;

  // Conversations
  conversations: Conversation[];
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
  isLoadingConversations: boolean;
  conversationsError: string | null;
  loadConversations: (taskId: number | null) => Promise<void>;
  createConversation: (
    taskId: number,
    provider: Provider,
    model: string,
  ) => Promise<CreateConversationResult>;
  deleteConversation: (id: number) => Promise<ActionResult>;
  renameConversation: (id: number, name: string) => Promise<ActionResult>;

  // Selection
  selectedProject: Project | null;
  selectedTask: Task | null;
  activeConversation: Conversation | null;
  selectProject: (project: Project | null) => Promise<void>;
  selectTask: (task: Task | null) => Promise<void>;
  selectConversation: (conversation: Conversation | null) => void;
  navigateBack: () => void;
  clearSelection: () => void;

  // Board navigation
  navigateToBoard: (project: Project | null) => Promise<void>;
  navigateToProjectEdit: (project: Project | null) => Promise<void>;
  navigateToTaskEdit: (task: Task | null) => Promise<void>;
  exitEditMode: () => void;

  // Edit mode state
  editingProject: Project | null;
  editingTask: Task | null;

  // View state
  currentView: CurrentView;
  getCurrentView: () => CurrentView;

  // Live task tracking
  liveTaskIds: Set<number>;
  isTaskLive: (taskId: number) => boolean;
}

const TaskContext = createContext<TaskContextValue | null>(null);

export function useTaskContext(): TaskContextValue {
  const context = useContext(TaskContext);
  if (!context) {
    throw new Error('useTaskContext must be used within a TaskContextProvider');
  }
  return context;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

export function TaskContextProvider({ children }: { children: ReactNode }) {
  const ws = useWebSocket();
  const { subscribe, unsubscribe, isConnected } = ws ?? {};

  // Projects state
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  // Tasks state (for currently selected project)
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);

  // Live task tracking
  const [liveTaskIds, setLiveTaskIds] = useState<Set<number>>(new Set());
  const liveTaskIdsRef = useRef<Set<number>>(new Set());

  // Conversations state (for currently selected task)
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(null);

  // Selection state
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);

  // Edit mode state
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  // Documentation state
  const [taskDoc, setTaskDoc] = useState('');
  const [isLoadingTaskDoc, setIsLoadingTaskDoc] = useState(false);

  // Agent runs state
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [isLoadingAgentRuns, setIsLoadingAgentRuns] = useState(false);

  const getCurrentView = useCallback((): CurrentView => {
    if (activeConversation) return 'chat';
    if (editingTask) return 'task-edit';
    if (editingProject) return 'project-edit';
    if (selectedTask) return 'task-detail';
    if (selectedProject) return 'board';
    return 'empty';
  }, [activeConversation, selectedTask, selectedProject, editingTask, editingProject]);

  // ========== Projects API ==========

  const loadProjects = useCallback(async () => {
    setIsLoadingProjects(true);
    setProjectsError(null);
    try {
      const response = await api.projects.list();
      if (response.ok) {
        const data = await response.json();
        // Server returns ProjectRow[] directly; legacy callers tolerated a
        // wrapped { projects: [] } shape, kept here defensively.
        const list = Array.isArray(data)
          ? data
          : ((data as unknown as { projects?: Project[] }).projects ?? []);
        setProjects(list);
      } else {
        const err = (await response.json()) as unknown as { error?: string };
        setProjectsError(err.error || 'Failed to load projects');
      }
    } catch (err) {
      console.error('Error loading projects:', err);
      setProjectsError(errorMessage(err, 'Failed to load projects'));
    } finally {
      setIsLoadingProjects(false);
    }
  }, []);

  const createProject = useCallback(
    async (
      name: string,
      repoFolderPath: string,
      sensitiveAreas?: string,
    ): Promise<CreateProjectResult> => {
      try {
        const response = await api.projects.create(name, repoFolderPath, sensitiveAreas);
        if (response.ok) {
          const newProject = await response.json();
          setProjects((prev) => [...prev, newProject]);
          return { success: true, project: newProject };
        }
        const err = (await response.json()) as unknown as { error?: string };
        return { success: false, error: err.error || 'Failed to create project' };
      } catch (err) {
        console.error('Error creating project:', err);
        return { success: false, error: errorMessage(err, 'Failed to create project') };
      }
    },
    [],
  );

  const updateProject = useCallback(
    async (
      id: number,
      data: UpdateProjectRequest,
    ): Promise<UpdateProjectResult> => {
      try {
        const response = await api.projects.update(id, data);
        if (response.ok) {
          const updatedProject = (await response.json());
          setProjects((prev) => prev.map((p) => (p.id === id ? updatedProject : p)));
          if (selectedProject?.id === id) {
            setSelectedProject(updatedProject);
          }
          return { success: true, project: updatedProject };
        }
        const err = (await response.json()) as unknown as { error?: string };
        return { success: false, error: err.error || 'Failed to update project' };
      } catch (err) {
        console.error('Error updating project:', err);
        return { success: false, error: errorMessage(err, 'Failed to update project') };
      }
    },
    [selectedProject],
  );

  const deleteProject = useCallback(
    async (id: number): Promise<ActionResult> => {
      try {
        const response = await api.projects.delete(id);
        if (response.ok) {
          setProjects((prev) => prev.filter((p) => p.id !== id));
          if (selectedProject?.id === id) {
            setSelectedProject(null);
            setTasks([]);
            setSelectedTask(null);
            setConversations([]);
            setActiveConversation(null);
          }
          return { success: true };
        }
        const err = (await response.json()) as unknown as { error?: string };
        return { success: false, error: err.error || 'Failed to delete project' };
      } catch (err) {
        console.error('Error deleting project:', err);
        return { success: false, error: errorMessage(err, 'Failed to delete project') };
      }
    },
    [selectedProject],
  );

  // ========== Tasks API ==========

  const loadTasks = useCallback(async (projectId: number | null) => {
    if (!projectId) {
      setTasks([]);
      return;
    }
    setIsLoadingTasks(true);
    setTasksError(null);
    try {
      const response = await api.tasks.list(projectId);
      if (response.ok) {
        const data = await response.json();
        const list = Array.isArray(data)
          ? data
          : ((data as unknown as { tasks?: Task[] }).tasks ?? []);
        setTasks(list);
      } else {
        const err = (await response.json()) as unknown as { error?: string };
        setTasksError(err.error || 'Failed to load tasks');
      }
    } catch (err) {
      console.error('Error loading tasks:', err);
      setTasksError(errorMessage(err, 'Failed to load tasks'));
    } finally {
      setIsLoadingTasks(false);
    }
  }, []);

  const createTask = useCallback(
    async (
      projectId: number,
      title: string,
      documentation = '',
      options: Omit<CreateTaskRequest, 'title' | 'documentation'> = {},
    ): Promise<CreateTaskResult> => {
      try {
        const response = await api.tasks.create(projectId, title, documentation, options);
        if (response.ok) {
          const newTask = (await response.json());
          setTasks((prev) => [newTask, ...prev]);

          return { success: true, task: newTask };
        }
        const err = (await response.json()) as unknown as { error?: string };
        return { success: false, error: err.error || 'Failed to create task' };
      } catch (err) {
        console.error('Error creating task:', err);
        return { success: false, error: errorMessage(err, 'Failed to create task') };
      }
    },
    [],
  );

  const updateTask = useCallback(
    async (id: number, data: UpdateTaskRequest): Promise<UpdateTaskResult> => {
      try {
        const response = await api.tasks.update(id, data);
        if (response.ok) {
          const updatedTask = (await response.json());
          setTasks((prev) => prev.map((t) => (t.id === id ? updatedTask : t)));
          if (selectedTask?.id === id) {
            setSelectedTask(updatedTask);
          }
          return { success: true, task: updatedTask };
        }
        const err = (await response.json()) as unknown as { error?: string };
        return { success: false, error: err.error || 'Failed to update task' };
      } catch (err) {
        console.error('Error updating task:', err);
        return { success: false, error: errorMessage(err, 'Failed to update task') };
      }
    },
    [selectedTask],
  );

  /**
   * Delete a task and its worktree.
   *
   * Answers `conflict` instead of `error` on the server's 409 when the worktree
   * still holds uncommitted or unpushed work, so callers can hand it to
   * `useWorktreeGuard` and re-issue with `force` if the user chooses to discard.
   */
  const deleteTask = useCallback(
    async (id: number, force = false): Promise<DeleteTaskResult> => {
      try {
        const response = await api.tasks.delete(id, force);
        if (response.ok) {
          setTasks((prev) => prev.filter((t) => t.id !== id));
          if (selectedTask?.id === id) {
            setSelectedTask(null);
            setConversations([]);
            setActiveConversation(null);
          }
          return { success: true };
        }
        const err = (await response.json()) as unknown as {
          error?: string;
        } & Partial<UnsavedWorktreeWorkResponse>;
        if (response.status === 409 && err.error === UNSAVED_WORKTREE_WORK) {
          return { success: false, conflict: err as UnsavedWorktreeWorkResponse };
        }
        return { success: false, error: err.error || 'Failed to delete task' };
      } catch (err) {
        console.error('Error deleting task:', err);
        return { success: false, error: errorMessage(err, 'Failed to delete task') };
      }
    },
    [selectedTask],
  );

  const retryWorktreeSetup = useCallback(async (id: number): Promise<ActionResult> => {
    try {
      const response = await api.tasks.retryWorktreeSetup(id);
      if (response.ok) {
        const updated = await response.json();
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
        return { success: true };
      }
      const err = (await response.json().catch(() => ({}))) as { error?: string };
      return { success: false, error: err.error || 'Failed to retry the worktree setup' };
    } catch (err) {
      console.error('Error retrying worktree setup:', err);
      return { success: false, error: errorMessage(err, 'Failed to retry the worktree setup') };
    }
  }, []);

  // ========== Task Documentation API ==========

  const loadTaskDoc = useCallback(async (taskId: number): Promise<DocResult> => {
    setIsLoadingTaskDoc(true);
    try {
      const response = await api.tasks.getDoc(taskId);
      if (response.ok) {
        const data = await response.json();
        setTaskDoc(data.content || '');
        return { success: true, content: data.content || '' };
      }
      setTaskDoc('');
      return { success: false, error: 'Failed to load documentation' };
    } catch (err) {
      console.error('Error loading task doc:', err);
      setTaskDoc('');
      return { success: false, error: errorMessage(err, 'Failed to load documentation') };
    } finally {
      setIsLoadingTaskDoc(false);
    }
  }, []);

  const saveTaskDoc = useCallback(
    async (taskId: number, content: string): Promise<ActionResult> => {
      try {
        const response = await api.tasks.saveDoc(taskId, content);
        if (response.ok) {
          setTaskDoc(content);
          return { success: true };
        }
        const err = (await response.json()) as unknown as { error?: string };
        return { success: false, error: err.error || 'Failed to save documentation' };
      } catch (err) {
        console.error('Error saving task doc:', err);
        return { success: false, error: errorMessage(err, 'Failed to save documentation') };
      }
    },
    [],
  );

  // ========== Agent Runs API ==========

  const loadAgentRuns = useCallback(async (taskId: number | null) => {
    if (!taskId) {
      setAgentRuns([]);
      return;
    }
    setIsLoadingAgentRuns(true);
    try {
      const response = await api.agentRuns.list(taskId);
      if (response.ok) {
        const data = await response.json();
        setAgentRuns(data);
      } else {
        setAgentRuns([]);
      }
    } catch (err) {
      console.error('Error loading agent runs:', err);
      setAgentRuns([]);
    } finally {
      setIsLoadingAgentRuns(false);
    }
  }, []);

  // ========== Conversations API ==========

  const loadConversations = useCallback(async (taskId: number | null) => {
    if (!taskId) {
      setConversations([]);
      return;
    }
    setIsLoadingConversations(true);
    setConversationsError(null);
    try {
      const response = await api.conversations.list(taskId);
      if (response.ok) {
        const data = await response.json();
        const list = Array.isArray(data)
          ? data
          : ((data as unknown as { conversations?: Conversation[] }).conversations ?? []);
        setConversations(list);
      } else {
        const err = (await response.json()) as unknown as { error?: string };
        setConversationsError(err.error || 'Failed to load conversations');
      }
    } catch (err) {
      console.error('Error loading conversations:', err);
      setConversationsError(errorMessage(err, 'Failed to load conversations'));
    } finally {
      setIsLoadingConversations(false);
    }
  }, []);

  const createConversation = useCallback(
    async (
      taskId: number,
      provider: Provider,
      model: string,
    ): Promise<CreateConversationResult> => {
      try {
        const response = await api.conversations.create(taskId, provider, model);
        if (response.ok) {
          const newConversation = (await response.json());
          setConversations((prev) => [newConversation, ...prev]);
          return { success: true, conversation: newConversation };
        }
        const err = (await response.json()) as unknown as { error?: string };
        return { success: false, error: err.error || 'Failed to create conversation' };
      } catch (err) {
        console.error('Error creating conversation:', err);
        return { success: false, error: errorMessage(err, 'Failed to create conversation') };
      }
    },
    [],
  );

  const deleteConversation = useCallback(
    async (id: number): Promise<ActionResult> => {
      try {
        const response = await api.conversations.delete(id);
        if (response.ok) {
          setConversations((prev) => prev.filter((c) => c.id !== id));
          if (activeConversation?.id === id) {
            setActiveConversation(null);
          }
          return { success: true };
        }
        const err = (await response.json()) as unknown as { error?: string };
        return { success: false, error: err.error || 'Failed to delete conversation' };
      } catch (err) {
        console.error('Error deleting conversation:', err);
        return { success: false, error: errorMessage(err, 'Failed to delete conversation') };
      }
    },
    [activeConversation],
  );

  const renameConversation = useCallback(
    async (id: number, name: string): Promise<ActionResult> => {
      try {
        const response = await api.conversations.update(id, { name });
        if (response.ok) {
          const updated = (await response.json());
          setConversations((prev) =>
            prev.map((c) => (c.id === id ? { ...c, name: updated.name } : c)),
          );
          return { success: true };
        }
        const err = (await response.json()) as unknown as { error?: string };
        return { success: false, error: err.error || 'Failed to rename conversation' };
      } catch (err) {
        console.error('Error renaming conversation:', err);
        return { success: false, error: errorMessage(err, 'Failed to rename conversation') };
      }
    },
    [],
  );

  // ========== Selection Handlers ==========

  const selectProject = useCallback(
    async (project: Project | null) => {
      setSelectedProject(project);
      setSelectedTask(null);
      setActiveConversation(null);
      setTasks([]);
      setConversations([]);
      setTaskDoc('');

      if (project) {
        await loadTasks(project.id);
      }
    },
    [loadTasks],
  );

  const selectTask = useCallback(
    async (task: Task | null) => {
      setSelectedTask(task);
      setActiveConversation(null);
      setConversations([]);
      setTaskDoc('');
      setAgentRuns([]);

      if (task) {
        await Promise.all([
          loadConversations(task.id),
          loadTaskDoc(task.id),
          loadAgentRuns(task.id),
        ]);
      }
    },
    [loadConversations, loadTaskDoc, loadAgentRuns],
  );

  const selectConversation = useCallback((conversation: Conversation | null) => {
    setActiveConversation(conversation);
  }, []);

  const navigateBack = useCallback(() => {
    if (activeConversation) {
      setActiveConversation(null);
    } else if (selectedTask) {
      setSelectedTask(null);
      setConversations([]);
      setTaskDoc('');
      setAgentRuns([]);
    } else if (selectedProject) {
      setSelectedProject(null);
      setTasks([]);
    }
  }, [activeConversation, selectedTask, selectedProject]);

  const clearSelection = useCallback(() => {
    setSelectedProject(null);
    setSelectedTask(null);
    setActiveConversation(null);
    setEditingProject(null);
    setEditingTask(null);
    setTasks([]);
    setConversations([]);
    setTaskDoc('');
    setAgentRuns([]);
  }, []);

  // ========== Board Navigation ==========

  const navigateToBoard = useCallback(
    async (project: Project | null) => {
      setEditingProject(null);
      setEditingTask(null);
      setSelectedTask(null);
      setActiveConversation(null);
      setSelectedProject(project);
      setConversations([]);
      setTaskDoc('');
      setAgentRuns([]);

      if (project) {
        await loadTasks(project.id);
      }
    },
    [loadTasks],
  );

  const navigateToProjectEdit = useCallback(
    async (project: Project | null) => {
      setEditingProject(project);
      setEditingTask(null);
    },
    [],
  );

  const navigateToTaskEdit = useCallback(
    async (task: Task | null) => {
      setEditingTask(task);
      setEditingProject(null);
      if (task && (!selectedTask || selectedTask.id !== task.id)) {
        await loadTaskDoc(task.id);
      }
    },
    [selectedTask, loadTaskDoc],
  );

  const exitEditMode = useCallback(() => {
    setEditingProject(null);
    setEditingTask(null);
  }, []);

  // ========== Effects ==========

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Reconcile the frontend `liveTaskIds` against the authoritative
  // `/api/streaming-sessions` endpoint. Overwriting the whole set is correct:
  // the endpoint is the source of truth, so this clears any stale-ON entry
  // (Bug #1, once the backend cleanup has run) AND restores any stale-OFF
  // entry the client missed (Bug #2 — a `streaming-started` that never
  // arrived). The only race — a `streaming-started` landing mid-fetch being
  // overwritten by a slightly stale response — self-corrects on the next
  // reconcile/event, so the full overwrite is intentional.
  const reconcileLiveTaskIds = useCallback(async () => {
    try {
      const response = await api.streamingSessions.getActive();
      if (!response.ok) return;
      const data = await response.json();
      const taskIds = new Set<number>(
        data.sessions
          .map((s) => s.taskId)
          .filter((id): id is number => typeof id === 'number'),
      );
      setLiveTaskIds(taskIds);
      liveTaskIdsRef.current = taskIds;
    } catch (err) {
      console.error('Error reconciling active streaming sessions:', err);
    }
  }, []);

  // Reconcile on mount and on every WebSocket (re)connect. A reconnect
  // re-bootstraps liveness after any events missed while disconnected.
  useEffect(() => {
    void reconcileLiveTaskIds();
  }, [isConnected, reconcileLiveTaskIds]);

  // Reconcile when a backgrounded tab regains focus. Browser timers are
  // throttled in hidden tabs, so the periodic resync below can stall; this
  // self-heals the dot immediately on refocus.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void reconcileLiveTaskIds();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [reconcileLiveTaskIds]);

  // Light periodic resync so a stale dot self-corrects within ≤30s even on a
  // stable connection that never reconnects (covers a missed event with no
  // subsequent reconnect or tab refocus).
  useEffect(() => {
    const interval = setInterval(() => {
      void reconcileLiveTaskIds();
    }, 30000);
    return () => {
      clearInterval(interval);
    };
  }, [reconcileLiveTaskIds]);

  // Subscribe to streaming events via WebSocket
  useEffect(() => {
    if (!subscribe || !unsubscribe) return;

    // Add/remove a single task id, keeping the `liveTaskIdsRef` mirror in sync
    // so the synchronous `isTaskLive` reader sees the change immediately.
    const setTaskLive = (taskId: number | undefined, live: boolean) => {
      if (!taskId) return;
      setLiveTaskIds((prev) => {
        const next = new Set(prev);
        if (live) next.add(taskId);
        else next.delete(taskId);
        liveTaskIdsRef.current = next;
        return next;
      });
    };

    const handleStreamingStarted = (message: ServerMessageOf<'streaming-started'>) => {
      setTaskLive(message.taskId, true);
    };

    const handleStreamingEnded = (message: ServerMessageOf<'streaming-ended'>) => {
      setTaskLive(message.taskId, false);
    };

    // The background worktree setup moved (task channel): patch the row so the
    // board badge and the task page's banner / disabled actions follow it.
    const handleWorktreeUpdated = (message: ServerMessageOf<'task-worktree-updated'>) => {
      setTasks((prev) =>
        prev.map((task) =>
          task.id === message.taskId
            ? {
                ...task,
                worktree_state: message.worktreeState,
                worktree_error: message.worktreeError,
              }
            : task,
        ),
      );
    };

    subscribe('streaming-started', handleStreamingStarted);
    subscribe('streaming-ended', handleStreamingEnded);
    subscribe('task-worktree-updated', handleWorktreeUpdated);

    return () => {
      unsubscribe('streaming-started', handleStreamingStarted);
      unsubscribe('streaming-ended', handleStreamingEnded);
      unsubscribe('task-worktree-updated', handleWorktreeUpdated);
    };
  }, [subscribe, unsubscribe]);

  const isTaskLive = useCallback((taskId: number): boolean => {
    return liveTaskIdsRef.current.has(taskId);
  }, []);

  // ========== Context Value ==========

  const value: TaskContextValue = {
    // Projects
    projects,
    isLoadingProjects,
    projectsError,
    loadProjects,
    createProject,
    updateProject,
    deleteProject,

    // Tasks
    tasks,
    isLoadingTasks,
    tasksError,
    loadTasks,
    createTask,
    updateTask,
    deleteTask,
    retryWorktreeSetup,

    // Task Documentation
    taskDoc,
    isLoadingTaskDoc,
    loadTaskDoc,
    saveTaskDoc,

    // Agent Runs
    agentRuns,
    setAgentRuns,
    isLoadingAgentRuns,
    loadAgentRuns,

    // Conversations
    conversations,
    setConversations,
    isLoadingConversations,
    conversationsError,
    loadConversations,
    createConversation,
    deleteConversation,
    renameConversation,

    // Selection
    selectedProject,
    selectedTask,
    activeConversation,
    selectProject,
    selectTask,
    selectConversation,
    navigateBack,
    clearSelection,

    // Board navigation
    navigateToBoard,
    navigateToProjectEdit,
    navigateToTaskEdit,
    exitEditMode,

    // Edit mode state
    editingProject,
    editingTask,

    // View state
    currentView: getCurrentView(),
    getCurrentView,

    // Live task tracking
    liveTaskIds,
    isTaskLive,
  };

  return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>;
}

export default TaskContext;
