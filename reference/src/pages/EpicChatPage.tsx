/**
 * EpicChatPage — the chat view of an epic conversation. Mirrors ChatPage, with
 * the epic in place of the task: it subscribes to the epic channel (streaming
 * badges) while ChatInterface subscribes to the conversation channel for the
 * transcript itself.
 *
 * Route: /projects/:projectId/epics/:epicId/chat/:conversationId.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import ChatInterface from '../components/ChatInterface';
import Breadcrumb from '../components/Breadcrumb';
import ErrorBoundary from '../components/ErrorBoundary';
import { Button } from '../components/ui/button';
import { useEpicEvents } from '../hooks/useEpicEvents';
import { useTaskContext } from '../contexts/TaskContext';
import { api } from '../utils/api';
import useLocalStorage from '../hooks/useLocalStorage';
import type { ConversationRow, EpicRow, ProjectRow } from '@shared/types/db';

interface EpicChatRouteParams extends Record<string, string | undefined> {
  projectId: string;
  epicId: string;
  conversationId: string;
}

interface ChatLocationState {
  initialMessage?: string;
}

type ConversationWithInitialMessage = ConversationRow & {
  __initialMessage?: string;
};

function EpicChatPage() {
  const { projectId, epicId, conversationId } = useParams<EpicChatRouteParams>();
  const navigate = useNavigate();
  const location = useLocation();
  const { projects, loadProjects, isLoadingProjects } = useTaskContext();

  const numericEpicId = epicId ? parseInt(epicId, 10) : NaN;
  // Streaming start/end for this epic's conversations arrive on the epic
  // channel; the transcript itself flows on the conversation channel, which
  // ChatInterface subscribes to.
  useEpicEvents(Number.isFinite(numericEpicId) ? numericEpicId : null, {});

  const initialMessage = (location.state as ChatLocationState | null)?.initialMessage;

  const [autoExpandTools] = useLocalStorage<boolean>('autoExpandTools', false);
  const [showRawParameters] = useLocalStorage<boolean>('showRawParameters', false);
  const [showThinking] = useLocalStorage<boolean>('showThinking', true);

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [epic, setEpic] = useState<EpicRow | null>(null);
  const [conversation, setConversation] = useState<ConversationRow | null>(null);

  useEffect(() => {
    if (projects.length === 0 && !isLoadingProjects) void loadProjects();
  }, [projects.length, isLoadingProjects, loadProjects]);

  useEffect(() => {
    if (projects.length > 0 && projectId) {
      setProject(projects.find((p) => p.id === parseInt(projectId, 10)) ?? null);
    }
  }, [projects, projectId]);

  useEffect(() => {
    if (!Number.isFinite(numericEpicId)) return;
    let cancelled = false;
    const load = async () => {
      const response = await api.epics.get(numericEpicId);
      if (response.ok && !cancelled) setEpic(await response.json());
    };
    void load().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [numericEpicId]);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    const load = async () => {
      const response = await api.conversations.get(parseInt(conversationId, 10));
      if (response.ok) {
        if (!cancelled) setConversation((await response.json()));
      } else {
        navigate(`/projects/${projectId}/epics/${epicId}`, { replace: true });
      }
    };
    void load().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversationId, projectId, epicId, navigate]);

  const handleBack = useCallback(() => {
    navigate(`/projects/${projectId}/epics/${epicId}`);
  }, [navigate, projectId, epicId]);

  const activeConversation = useMemo<ConversationWithInitialMessage | null>(() => {
    if (!conversation) return null;
    if (initialMessage) return { ...conversation, __initialMessage: initialMessage };
    return conversation;
  }, [conversation, initialMessage]);

  if (!conversation) {
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
      <div className="bg-background border-b border-border p-2 sm:p-3 pwa-header-safe flex-shrink-0">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBack}
            className="h-8 w-8 p-0"
            title="Back to epic"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <Breadcrumb
            project={project}
            conversation={activeConversation}
            onProjectClick={() => navigate(`/projects/${projectId}`)}
            onHomeClick={() => navigate('/')}
          />
          {epic ? (
            <span className="ml-1 truncate text-sm text-muted-foreground">{epic.name}</span>
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <ErrorBoundary showDetails={true}>
          {/* `selectedTask` is nullable and unused beyond typing — an epic
              conversation has no task, by design. */}
          <ChatInterface
            selectedProject={project}
            selectedTask={null}
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

export default EpicChatPage;
