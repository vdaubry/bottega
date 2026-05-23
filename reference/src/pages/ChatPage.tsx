/**
 * ChatPage.tsx - Chat Page Wrapper
 *
 * Loads project, task, and conversation from URL params.
 * Renders ChatInterface with header and breadcrumb.
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import ChatInterface from '../components/ChatInterface';
import Breadcrumb from '../components/Breadcrumb';
import ErrorBoundary from '../components/ErrorBoundary';
import { Button } from '../components/ui/button';
import { useTaskContext } from '../contexts/TaskContext';
import { api } from '../utils/api';
import useLocalStorage from '../hooks/useLocalStorage';
import { useTaskSubscription } from '../hooks/useTaskSubscription';
import type {
  ProjectRow,
  TaskRow,
  ConversationRow,
} from '../../shared/types/db';

interface ChatPageRouteParams extends Record<string, string | undefined> {
  projectId: string;
  taskId: string;
  conversationId: string;
}

interface ChatLocationState {
  initialMessage?: string;
}

type ConversationWithInitialMessage = ConversationRow & {
  __initialMessage?: string;
};

function ChatPage() {
  const { projectId, taskId, conversationId } = useParams<ChatPageRouteParams>();
  const navigate = useNavigate();
  const location = useLocation();

  // Subscribe to task-channel events so the chat page receives
  // `streaming-started` / `streaming-ended` (drives the "is responding" UI)
  // and the task-channel copy of `conversation-name-updated`. The
  // ChatInterface child also subscribes to the conversation channel via
  // `useConversationSubscription`.
  const numericTaskId = taskId ? parseInt(taskId, 10) : null;
  useTaskSubscription(
    numericTaskId && Number.isFinite(numericTaskId) ? numericTaskId : null,
  );

  // Get initial message from navigation state (passed from NewConversationModal)
  const initialMessage = (location.state as ChatLocationState | null)
    ?.initialMessage;
  const {
    projects,
    tasks,
    loadProjects,
    loadTasks,
    isLoadingProjects,
    isLoadingTasks,
  } = useTaskContext();

  // Display settings
  const [autoExpandTools] = useLocalStorage<boolean>('autoExpandTools', false);
  const [showRawParameters] = useLocalStorage<boolean>(
    'showRawParameters',
    false,
  );
  const [showThinking] = useLocalStorage<boolean>('showThinking', true);

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [task, setTask] = useState<TaskRow | null>(null);
  const [conversation, setConversation] = useState<ConversationRow | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);

  // Load project data
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

  // Find project and load tasks
  useEffect(() => {
    if (projects.length > 0 && projectId) {
      const foundProject = projects.find((p) => p.id === parseInt(projectId));
      if (foundProject) {
        setProject(foundProject);
        void loadTasks(foundProject.id);
      } else {
        navigate(`/`, { replace: true });
      }
    }
  }, [projects, projectId, loadTasks, navigate]);

  // Find task
  useEffect(() => {
    if (tasks.length > 0 && project && taskId) {
      const foundTask = tasks.find((t) => t.id === parseInt(taskId));
      if (foundTask) {
        setTask(foundTask);
      } else {
        navigate(`/projects/${projectId}`, { replace: true });
      }
    }
  }, [tasks, taskId, project, projectId, navigate]);

  // Load conversation
  useEffect(() => {
    const loadConversation = async () => {
      if (!task || !conversationId) return;

      try {
        const response = await api.conversations.get(parseInt(conversationId));
        if (response.ok) {
          const data = await response.json();
          setConversation(data);
        } else {
          navigate(`/projects/${projectId}/tasks/${taskId}`, { replace: true });
        }
      } catch (error) {
        console.error('Error loading conversation:', error);
        navigate(`/projects/${projectId}/tasks/${taskId}`, { replace: true });
      }
    };

    void loadConversation();
  }, [conversationId, task, projectId, taskId, navigate]);

  // Navigation handlers
  const handleBack = useCallback(() => {
    navigate(`/projects/${projectId}/tasks/${taskId}`);
  }, [navigate, projectId, taskId]);

  const handleProjectClick = useCallback(() => {
    navigate(`/projects/${projectId}`);
  }, [navigate, projectId]);

  const handleTaskClick = useCallback(() => {
    navigate(`/projects/${projectId}/tasks/${taskId}`);
  }, [navigate, projectId, taskId]);

  const handleHomeClick = useCallback(() => {
    navigate(`/`);
  }, [navigate]);

  // Create conversation object with initial message for ChatInterface
  const activeConversation = useMemo<ConversationWithInitialMessage | null>(
    () => {
      if (!conversation) return null;
      if (initialMessage) {
        return { ...conversation, __initialMessage: initialMessage };
      }
      return conversation;
    },
    [conversation, initialMessage],
  );

  const isLoadingEntities =
    isLoading ||
    isLoadingProjects ||
    isLoadingTasks ||
    !project ||
    !task ||
    !conversation;

  if (isLoadingEntities) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <div className="w-12 h-12 mx-auto mb-4">
            <div className="w-full h-full rounded-full border-4 border-muted border-t-primary animate-spin" />
          </div>
          <p>Loading conversation...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-background border-b border-border p-2 sm:p-3 pwa-header-safe flex-shrink-0">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBack}
            className="h-8 w-8 p-0"
            title="Back to Task"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <Breadcrumb
            project={project}
            task={task}
            conversation={activeConversation}
            onProjectClick={handleProjectClick}
            onTaskClick={handleTaskClick}
            onHomeClick={handleHomeClick}
          />
        </div>
      </div>

      {/* Chat Interface */}
      <div className="flex-1 overflow-hidden">
        <ErrorBoundary showDetails={true}>
          <ChatInterface
            selectedProject={project}
            selectedTask={task}
            activeConversation={activeConversation}
            onShowSettings={() => window.openSettings?.()}
            autoExpandTools={autoExpandTools}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}

export default ChatPage;
