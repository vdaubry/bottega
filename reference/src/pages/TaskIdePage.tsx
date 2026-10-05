/**
 * TaskIdePage.tsx - Full-screen Explore (code-atlas) view for a task
 *
 * Left: lazy file tree of the task's workspace (worktree if it exists, else
 * the project repo — same resolution as conversations). Center: a pinned Schema
 * (interactive diagram) tab plus closable read-only file tabs. Reached via the
 * Explore button on the task page.
 *
 * On entry the Schema tab auto-generates the task's `plan` artifact when none
 * exists yet (showing a waiting indicator), or shows the existing one
 * immediately on re-entry. The schema-generation model comes from Settings →
 * Agent Models → Schema (Anthropic-only); there is no in-page model picker.
 */

import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useParams, useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Compass, FolderTree, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui/button';
import Breadcrumb from '../components/Breadcrumb';
import AtlasFileTree from '../components/atlas/AtlasFileTree';
import AtlasTabs from '../components/atlas/AtlasTabs';
import AtlasFileViewer from '../components/atlas/AtlasFileViewer';
import AtlasArtifactView from '../components/atlas/AtlasArtifactView';
import AtlasArtifactSwitcher from '../components/atlas/AtlasArtifactSwitcher';
import AtlasChatPanel from '../components/atlas/AtlasChatPanel';
import useAtlasEvents from '../components/atlas/useAtlasEvents';
import { useTaskSubscription } from '../hooks/useTaskSubscription';
import { useWebSocket } from '../contexts/WebSocketContext';
import {
  atlasViewReducer,
  initialAtlasViewState,
  pathOfTabId,
  SCHEMA_TAB_ID,
} from '../components/atlas/atlasTabsReducer';
import { decideSchemaEntry } from '../components/atlas/schemaEntryDecision';
import { useTaskContext } from '../contexts/TaskContext';
import { useTheme } from '../contexts/ThemeContext';
import { api } from '../utils/api';
import { cn } from '../lib/utils';
import { MODELS_FOR_UI } from '../../shared/types/agentModelSettings';
import type { ConversationRow, ProjectRow, TaskRow } from '../../shared/types/db';
import { ARTIFACT_KINDS, type ArtifactKind, type TaskArtifact } from '../../shared/types/atlas';
import type { ServerMessageOf } from '../../shared/websocket/messages';

// The regenerate widget offers the concrete artifact kinds only — `auto` is no
// longer surfaced in the UI (initial generation is hardwired to `plan`).
const GENERATE_KIND_LABELS: Record<ArtifactKind, string> = {
  plan: 'Plan',
  flowchart: 'Flowchart',
  architecture: 'Architecture',
};

type ArtifactMap = Partial<Record<ArtifactKind, TaskArtifact>>;

function TaskIdePage() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>();
  const navigate = useNavigate();
  const {
    projects,
    tasks,
    conversations,
    loadProjects,
    loadTasks,
    loadConversations,
    isLoadingProjects,
  } = useTaskContext();

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [task, setTask] = useState<TaskRow | null>(null);
  const [showTree, setShowTree] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | undefined>(undefined);

  const [view, dispatch] = useReducer(atlasViewReducer, initialAtlasViewState);
  const scrollTopsRef = useRef(new Map<string, number>());
  const { isDarkMode } = useTheme();

  // ---- Schema (artifact) state ----
  // One artifact per kind can coexist; `activeKind` selects which is shown.
  const [artifacts, setArtifacts] = useState<ArtifactMap>({});
  const [activeKind, setActiveKind] = useState<ArtifactKind | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  // The regenerate widget's kind dropdown — concrete kinds only. Initial entry
  // always generates `plan`; this default is overridden once an artifact shows.
  const [generateKind, setGenerateKind] = useState<ArtifactKind>('plan');

  // New manual conversations in the chat panel run on Claude; the in-page model
  // picker is gone, so default to the first Anthropic UI model.
  const chatModel = MODELS_FOR_UI.anthropic[0] ?? 'sonnet';

  // Tracks the conversation a generation was started on, so a streaming-ended
  // event that arrives without an artifact can be recognized as a failed run.
  const generatingConversationIdRef = useRef<number | null>(null);
  // Guards the one-shot auto-generate so React strict-mode double effects (or
  // re-renders) can't fire two generations for the same mount.
  const autoGenDecidedRef = useRef(false);

  const availableKinds = ARTIFACT_KINDS.filter((k) => artifacts[k] !== undefined);
  const activeArtifact = activeKind ? artifacts[activeKind] : undefined;

  // ---- Chat panel ----
  const [activeConversation, setActiveConversation] = useState<ConversationRow | null>(null);
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);

  // ---- Bootstrap (same pattern as TaskShowPage) ----
  useEffect(() => {
    if (projects.length === 0 && !isLoadingProjects) {
      void loadProjects();
    }
  }, [loadProjects, projects.length, isLoadingProjects]);

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

  useEffect(() => {
    if (tasks.length > 0 && project && taskId) {
      const foundTask = tasks.find((t) => t.id === parseInt(taskId, 10));
      if (foundTask) {
        setTask(foundTask);
        void loadConversations(foundTask.id);
      } else {
        navigate(`/projects/${projectId}`, { replace: true });
      }
    }
  }, [tasks, taskId, project, projectId, loadConversations, navigate]);

  // Task-channel subscription: keeps the conversation list live
  // (conversation-added) and feeds streaming-started/ended to the chat panel.
  useTaskSubscription(task?.id ?? null);

  /** Transient, non-modal message (port of CodeAtlas's Preview.notify). */
  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 4000);
  }, []);

  // Single open-file path shared by tree clicks, diagram node clicks and agent
  // events. Always re-fetches so the content is fresh. `preview` (single click)
  // opens a reusable tab; pinned opens (double click, agent) default to false.
  const openFile = useCallback(
    async (path: string, opts?: { line?: number | undefined; preview?: boolean }) => {
      if (!task) return;
      try {
        const response = await api.atlas.file(task.id, path);
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || `Failed to open ${path}`);
        }
        const file = await response.json();
        dispatch({
          type: 'open-file',
          path: file.path,
          content: file.content,
          lineCount: file.lineCount,
          line: opts?.line,
          preview: opts?.preview ?? false,
        });
      } catch (error) {
        showNotice(error instanceof Error ? error.message : String(error));
      }
    },
    [task, showNotice],
  );

  const handleBack = useCallback(() => {
    navigate(`/projects/${projectId}/tasks/${taskId}`);
  }, [navigate, projectId, taskId]);

  // ---- Persisted artifacts ----
  // List the kinds that exist, then lazily load each kind's html. The list is
  // cheap (no html blob); the html for each kind is fetched once and cached in
  // the artifacts map. Returns the kinds that now exist so callers can decide
  // whether to auto-generate.
  const fetchArtifacts = useCallback(async (): Promise<ArtifactKind[]> => {
    if (!task) return [];
    try {
      const response = await api.atlas.getArtifacts(task.id);
      if (!response.ok) return [];
      const { artifacts: summaries } = await response.json();
      if (summaries.length === 0) return [];

      const loaded = await Promise.all(
        summaries.map(async (summary) => {
          const artifactRes = await api.atlas.getArtifact(task.id, summary.kind);
          if (!artifactRes.ok) return null;
          const { artifact } = await artifactRes.json();
          return artifact;
        }),
      );

      setArtifacts((prev) => {
        const next: ArtifactMap = { ...prev };
        for (const artifact of loaded) {
          if (artifact) next[artifact.kind] = artifact;
        }
        return next;
      });
      // Default the active kind to the first available if none is selected.
      const firstKind = ARTIFACT_KINDS.find((k) => summaries.some((s) => s.kind === k));
      if (firstKind) setActiveKind((cur) => cur ?? firstKind);
      return summaries.map((s) => s.kind);
    } catch (error) {
      console.error('[atlas] Failed to fetch artifacts:', error);
      return [];
    }
  }, [task]);

  // Fire a generation for `kind`, binding the chat panel + generating state to
  // the new conversation. Model-less — the route resolves the Anthropic schema
  // model from Settings. Surfaces a loud error (Schema-tab panel) on failure.
  const startGeneration = useCallback(
    async (kind: ArtifactKind) => {
      if (!task) return;
      setGenerateError(null);
      setIsGenerating(true);
      try {
        const response = await api.atlas.generateArtifact(task.id, { kind });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || 'Failed to start schema generation');
        }
        const conversation = await response.json();
        generatingConversationIdRef.current = conversation.id;
        // Bind the chat panel to the generation conversation so refinements
        // ("redo as a flowchart") happen right here.
        setActiveConversation(conversation);
        void loadConversations(task.id);
      } catch (error) {
        setIsGenerating(false);
        generatingConversationIdRef.current = null;
        setGenerateError(error instanceof Error ? error.message : String(error));
      }
    },
    [task, loadConversations],
  );

  // ---- Entry: show the existing plan, else auto-generate it ----
  // Runs once per mount when the artifact list is known. Strict-mode/re-render
  // double-fires are guarded by `autoGenDecidedRef`.
  useEffect(() => {
    if (!task || autoGenDecidedRef.current) return;
    autoGenDecidedRef.current = true;
    void (async () => {
      const kinds = await fetchArtifacts();
      const decision = decideSchemaEntry(kinds);
      if (decision.action === 'show') {
        setActiveKind((cur) => cur ?? decision.kind);
      } else {
        await startGeneration('plan');
      }
    })();
  }, [task, fetchArtifacts, startGeneration]);

  // ---- Agent-driven UI commands (ack only after the change is applied) ----
  useAtlasEvents(task?.id, {
    onOpenFile: (msg) => {
      dispatch({
        type: 'open-file',
        path: msg.path,
        content: msg.content,
        lineCount: msg.content.length === 0 ? 1 : msg.content.split('\n').length,
        line: msg.line,
      });
    },
    onHighlight: (msg) => {
      dispatch({
        type: 'highlight-file',
        path: msg.path,
        content: msg.content,
        lineCount: msg.content.length === 0 ? 1 : msg.content.split('\n').length,
        ranges: msg.ranges,
        color: msg.color,
      });
    },
    onRenderArtifact: (msg) => {
      const rendered: TaskArtifact = {
        taskId: msg.taskId,
        kind: msg.kind,
        title: msg.title ?? null,
        html: msg.html,
        updatedAt: new Date().toISOString(),
      };
      // Store the artifact for its kind, make it active, and surface the Schema
      // tab. flushSync so the iframe mounts before we ack the render.
      flushSync(() => {
        setArtifacts((prev) => ({ ...prev, [msg.kind]: rendered }));
        setActiveKind(msg.kind);
        setIsGenerating(false);
        setGenerateError(null);
        dispatch({ type: 'show-schema' });
      });
      // The artifact arrived — this generation succeeded, so a later
      // streaming-ended for it is not a failure.
      generatingConversationIdRef.current = null;
      return Promise.resolve(JSON.stringify({ ok: true }));
    },
    onSubscribed: () => {
      // An agent may have rendered while this client was disconnected.
      void fetchArtifacts();
    },
  });

  // Loud-fail: if the generating conversation ends without ever emitting an
  // artifact (onRenderArtifact would have cleared the ref), surface an error so
  // the Schema tab doesn't spin forever.
  const { subscribe, unsubscribe } = useWebSocket();
  useEffect(() => {
    const onStreamingEnded = (msg: ServerMessageOf<'streaming-ended'>) => {
      if (
        generatingConversationIdRef.current !== null &&
        msg.conversationId === generatingConversationIdRef.current
      ) {
        generatingConversationIdRef.current = null;
        setIsGenerating(false);
        setGenerateError(
          'Schema generation finished without producing a diagram. Try again.',
        );
      }
    };
    subscribe('streaming-ended', onStreamingEnded);
    return () => unsubscribe('streaming-ended', onStreamingEnded);
  }, [subscribe, unsubscribe]);

  // Keep the regenerate dropdown defaulted to the currently-displayed kind.
  useEffect(() => {
    if (activeKind) setGenerateKind(activeKind);
  }, [activeKind]);

  // Regenerate from the toolbar — model-less (the route uses the Schema setting).
  const handleGenerateArtifact = useCallback(() => {
    if (isGenerating) return;
    void startGeneration(generateKind);
  }, [isGenerating, generateKind, startGeneration]);

  // Pre-create an empty atlas-flagged conversation; the first message typed
  // in the panel starts its session (with the code-atlas tools attached).
  const handleNewConversation = useCallback(async () => {
    if (!task || isCreatingConversation) return;
    setIsCreatingConversation(true);
    try {
      const response = await api.conversations.create(task.id, 'anthropic', chatModel, {
        atlas: true,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || 'Failed to create conversation');
      }
      const conversation = (await response.json());
      setActiveConversation(conversation);
      void loadConversations(task.id);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCreatingConversation(false);
    }
  }, [task, isCreatingConversation, chatModel, showNotice, loadConversations]);

  const getScrollTop = useCallback(
    (path: string) => scrollTopsRef.current.get(path),
    [],
  );
  const setScrollTop = useCallback((path: string, top: number) => {
    scrollTopsRef.current.set(path, top);
  }, []);

  if (isLoadingProjects || !project || !task) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <div className="mx-auto mb-4 h-12 w-12">
            <div className="h-full w-full animate-spin rounded-full border-4 border-muted border-t-primary" />
          </div>
          <p>Loading task...</p>
        </div>
      </div>
    );
  }

  const activeFilePath = pathOfTabId(view.activeTabId);
  const activeFile = activeFilePath ? view.files[activeFilePath] : undefined;

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <Button variant="ghost" size="sm" onClick={handleBack} className="h-8 w-8 p-0">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Breadcrumb
          project={project}
          task={task}
          onProjectClick={() => navigate(`/projects/${projectId}`)}
          onHomeClick={() => navigate(`/`)}
        />
        <span className="flex items-center gap-1 text-sm text-muted-foreground">
          <Compass className="h-4 w-4" />
          Explore
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-8 w-8 p-0 md:hidden"
          onClick={() => setShowTree((v) => !v)}
          aria-label="Toggle file tree"
        >
          <FolderTree className="h-4 w-4" />
        </Button>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* File tree */}
        <div
          className={cn(
            'max-h-48 flex-shrink-0 overflow-y-auto border-b border-border md:max-h-none md:w-64 md:border-b-0 md:border-r',
            showTree ? 'block' : 'hidden md:block',
          )}
        >
          <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Files
          </div>
          <AtlasFileTree
            taskId={task.id}
            activePath={activeFilePath}
            onOpenFile={(path, preview) => void openFile(path, { preview })}
            onError={showNotice}
          />
        </div>

        {/* Tabs + content */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <AtlasTabs
            filePaths={view.filePaths}
            activeTabId={view.activeTabId}
            previewPath={view.previewPath}
            onSelect={(id) => dispatch({ type: 'select-tab', id })}
            onPin={(path) => dispatch({ type: 'pin-file', path })}
            onCloseFile={(path) => dispatch({ type: 'close-file', path })}
          />

          <div className="min-h-0 flex-1">
            {/* Schema stays mounted (hidden) so its render state survives tab
                switches; file viewers mount per file. */}
            <div className={cn('h-full', view.activeTabId !== SCHEMA_TAB_ID && 'hidden')}>
              <div className="relative flex h-full min-w-0 flex-col">
                {activeArtifact === undefined ? (
                  generateError !== null ? (
                    // Loud-fail: settings/credentials error or a generation that
                    // ended without an artifact. Offer a retry.
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center text-muted-foreground">
                      <AlertCircle className="h-12 w-12 text-destructive opacity-70" />
                      <p className="text-lg text-foreground">Couldn't generate the schema</p>
                      <p className="max-w-md text-sm">{generateError}</p>
                      <Button onClick={() => void startGeneration('plan')} disabled={isGenerating}>
                        {isGenerating ? (
                          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="mr-1 h-4 w-4" />
                        )}
                        Try again
                      </Button>
                    </div>
                  ) : (
                    // Waiting indicator while the first generation is in flight.
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-muted-foreground">
                      <Loader2 className="h-12 w-12 animate-spin opacity-70" />
                      <p className="text-lg">Generating plan schema…</p>
                      <p className="max-w-sm text-center text-sm">
                        The agent is reading the plan and rendering an interactive diagram.
                      </p>
                    </div>
                  )
                ) : (
                  <>
                    <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
                      {activeKind && (
                        <AtlasArtifactSwitcher
                          available={availableKinds}
                          activeKind={activeKind}
                          onSelect={setActiveKind}
                        />
                      )}
                      <div className="ml-auto flex items-center gap-2">
                        <select
                          className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
                          value={generateKind}
                          onChange={(e) => setGenerateKind(e.target.value as ArtifactKind)}
                          aria-label="Artifact type"
                        >
                          {ARTIFACT_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {GENERATE_KIND_LABELS[k]}
                            </option>
                          ))}
                        </select>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleGenerateArtifact}
                          disabled={isGenerating}
                        >
                          {isGenerating ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="mr-1 h-3.5 w-3.5" />
                          )}
                          Generate
                        </Button>
                      </div>
                    </div>
                    <div className="min-h-0 flex-1">
                      <AtlasArtifactView
                        key={activeArtifact.kind}
                        html={activeArtifact.html}
                        isDarkMode={isDarkMode}
                        onOpenSource={(path, line) => void openFile(path, { line, preview: true })}
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
            {activeFilePath && activeFile && (
              <AtlasFileViewer
                key={activeFilePath}
                path={activeFilePath}
                content={activeFile.content}
                lineCount={activeFile.lineCount}
                highlight={view.highlights[activeFilePath] ?? null}
                reveal={
                  view.reveal && view.reveal.path === activeFilePath
                    ? { line: view.reveal.line, nonce: view.reveal.nonce }
                    : null
                }
                getScrollTop={getScrollTop}
                onScrollTop={setScrollTop}
              />
            )}
          </div>

          {/* Transient notice */}
          {notice && (
            <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md">
              {notice}
            </div>
          )}
        </div>
      </div>

      {/* Conversation panel (the CodeAtlas terminal pane, Bottega-style) */}
      <AtlasChatPanel
        project={project}
        task={task}
        conversations={conversations}
        activeConversation={activeConversation}
        onSelectConversation={setActiveConversation}
        onNewConversation={() => void handleNewConversation()}
        isCreating={isCreatingConversation}
      />
    </div>
  );
}

export default TaskIdePage;
