/**
 * EpicDetailPage — one epic, in two tabs.
 * Route: /projects/:projectId/epics/:epicId.
 *
 * **Main** is the work, split the way the pipeline is: **Framing** (the four
 * preparation stages — architecture, technical specification, stories,
 * specification review — each a conversation the user signs off),
 * **Implementation** (the orchestration controls plus the tickets in execution
 * order, one expandable row each, carrying the ticket's own orchestration and
 * PR-review conversations) and **Delivery** (the epic's final pull request and
 * the conversations that land it — the user's, and the ones a GitHub comment
 * on that pull request starts). **Artifacts** is what the pipeline produced: the
 * functional spec, the architecture document, the technical specification and
 * the review report, each folded until asked for — the tab opens as an index,
 * and a section only fetches file bytes when expanded.
 *
 * A stage's conversation IS its live view — starting a stage navigates into the
 * chat, where follow-up messages refine its output (the architecture and
 * specification agents rewrite their documents in the epic archive in place,
 * the specification reviewer rewrites its report;
 * the stories agent revises tickets through its tools). This page is the
 * observation deck over that: every refetch re-lists the archive directories,
 * and the document browsers reload a file whose size or mtime moved.
 *
 * Liveness has two sources. The epic channel carries the epic's own events
 * (stage runs, the row's flags, conversations). The ticket cards need the TASK
 * channel, so the page also subscribes to its tickets' ids — that is what makes
 * a ticket's LIVE dot light up here while its implementation agent works. A 10s
 * poll backstops a silently dropped socket while a stage is running.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import Breadcrumb from '../components/Breadcrumb';
import CollapsibleSection from '../components/epic/CollapsibleSection';
import EpicDeliverySection from '../components/epic/EpicDeliverySection';
import EpicFileBrowser from '../components/epic/EpicFileBrowser';
import EpicQaSection from '../components/epic/EpicQaSection';
import QaScenariosTable from '../components/epic/QaScenariosTable';
import EpicImplementationSection from '../components/epic/EpicImplementationSection';
import EpicMarkdownBrowser from '../components/epic/EpicMarkdownBrowser';
import EpicSpecFilesSection from '../components/epic/EpicSpecFilesSection';
import EpicStageRail from '../components/epic/EpicStageRail';
import { type OrchestrationAction } from '../components/epic/orchestrationAction';
import { Button } from '../components/ui/button';
import { useEpicEvents } from '../hooks/useEpicEvents';
import { useTasksLiveSubscriptions } from '../hooks/useTasksLiveSubscriptions';
import { useTaskContext } from '../contexts/TaskContext';
import { api } from '../utils/api';
import { countQaProgress, parseQaScenarios } from '@shared/schemas/qa';
import type { EpicStageName } from '@shared/schemas/epics';
import type { EpicAgentType } from '@shared/websocket/messages';
import type { EpicFileInfo } from '@shared/api/epics';
import type { WebServerStatusSuccess } from '@shared/api/projects';
import type {
  EpicAgentRunRow,
  ConversationRow,
  EpicRow,
  ProjectRow,
  EpicTicketWithTask,
} from '@shared/types/db';

const RUNNING_POLL_INTERVAL_MS = 10_000;

/** One titled block on the page — the epic's sections all look the same. */
function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {subtitle ? <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p> : null}
      <div className="mt-2">{children}</div>
    </section>
  );
}

function EpicDetailPage() {
  const { projectId, epicId } = useParams<{ projectId: string; epicId: string }>();
  const navigate = useNavigate();
  const { projects, loadProjects, isLoadingProjects, isTaskLive } = useTaskContext();

  const numericEpicId = epicId ? parseInt(epicId, 10) : NaN;
  const [epic, setEpic] = useState<EpicRow | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [architectureDocs, setArchitectureDocs] = useState<EpicFileInfo[]>([]);
  const [agentRuns, setAgentRuns] = useState<EpicAgentRunRow[]>([]);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [docs, setDocs] = useState<EpicFileInfo[]>([]);
  const [reviewDocs, setReviewDocs] = useState<EpicFileInfo[]>([]);
  const [qaFiles, setQaFiles] = useState<EpicFileInfo[]>([]);
  const [qaCsv, setQaCsv] = useState<string | null>(null);
  const [specFiles, setSpecFiles] = useState<EpicFileInfo[]>([]);
  const [tickets, setTickets] = useState<EpicTicketWithTask[]>([]);
  const [startingStage, setStartingStage] = useState<EpicAgentType | null>(null);
  const [markingStage, setMarkingStage] = useState<EpicStageName | null>(null);
  const [orchestrationAction, setOrchestrationAction] = useState<OrchestrationAction | null>(null);
  const [isOpeningPR, setIsOpeningPR] = useState(false);
  const [webServerStatus, setWebServerStatus] = useState<WebServerStatusSuccess | null>(null);
  const [isSwitchingServer, setIsSwitchingServer] = useState(false);
  const [activeTab, setActiveTab] = useState<'main' | 'artifacts'>('main');
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectRow | null>(null);

  // Breadcrumb project resolution — non-blocking, the epic renders without it.
  useEffect(() => {
    if (projects.length === 0 && !isLoadingProjects) void loadProjects();
  }, [projects.length, isLoadingProjects, loadProjects]);
  useEffect(() => {
    if (projects.length > 0 && projectId) {
      setProject(projects.find((p) => p.id === parseInt(projectId, 10)) ?? null);
    }
  }, [projects, projectId]);

  // Which worktree the project's public URL is serving. Non-blocking: the epic
  // renders without it, and the Switch Server control simply does not appear
  // until (and unless) the project has a serving symlink configured.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const load = async () => {
      const response = await api.projects.getWebServer(parseInt(projectId, 10));
      if (!response.ok || cancelled) return;
      const status = await response.json();
      if (!cancelled && status.success) setWebServerStatus(status);
    };
    void load().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const refetch = useCallback(async () => {
    if (!Number.isFinite(numericEpicId)) return;
    const [
      epicRes,
      architectureRes,
      runsRes,
      conversationsRes,
      docsRes,
      reviewRes,
      qaRes,
      specRes,
      tasksRes,
      qaCsvRes,
    ] = await Promise.all([
      api.epics.get(numericEpicId),
      api.epics.listArchitectureDocs(numericEpicId),
      api.epics.listAgentRuns(numericEpicId),
      api.epics.listConversations(numericEpicId),
      api.epics.listDocs(numericEpicId),
      api.epics.listReviewDocs(numericEpicId),
      api.epics.listQaFiles(numericEpicId),
      api.epics.listSpecFiles(numericEpicId),
      api.epics.listTasks(numericEpicId),
      api.epics.getQaFile(numericEpicId, 'scenarios.csv'),
    ]);
    if (epicRes.status === 404) {
      setNotFound(true);
      return;
    }
    if (epicRes.ok) setEpic(await epicRes.json());
    if (architectureRes.ok) setArchitectureDocs(await architectureRes.json());
    if (runsRes.ok) setAgentRuns(await runsRes.json());
    if (conversationsRes.ok) setConversations(await conversationsRes.json());
    if (docsRes.ok) setDocs(await docsRes.json());
    if (reviewRes.ok) setReviewDocs(await reviewRes.json());
    if (qaRes.ok) setQaFiles(await qaRes.json());
    if (specRes.ok) setSpecFiles(await specRes.json());
    if (tasksRes.ok) setTickets(await tasksRes.json());
    // No book yet is a normal state (404), not an error.
    setQaCsv(qaCsvRes.ok ? (await qaCsvRes.json()).content : null);
  }, [numericEpicId]);

  useEffect(() => {
    setEpic(null);
    setNotFound(false);
    void refetch().catch(() => undefined);
  }, [numericEpicId, refetch]);

  useEpicEvents(Number.isFinite(numericEpicId) ? numericEpicId : null, {
    onSubscribed: () => void refetch().catch(() => undefined),
    onAgentRunUpdated: () => void refetch().catch(() => undefined),
    onEpicUpdated: () => void refetch().catch(() => undefined),
    onStreamingEnded: () => void refetch().catch(() => undefined),
    // A delivery conversation the GitHub webhook started belongs to no click
    // of the user's: without this the Delivery list would only pick it up on
    // the next unrelated event.
    onConversationAdded: () => void refetch().catch(() => undefined),
    onConversationNameUpdated: () => void refetch().catch(() => undefined),
  });

  // The epic channel says nothing about the tickets' own agents; their task
  // channels do. Memoized so the hook only diffs the set when it really changes.
  const ticketIds = useMemo(() => tickets.map((t) => t.id), [tickets]);
  useTasksLiveSubscriptions(ticketIds);

  const isRunning = agentRuns.some((run) => run.status === 'running');

  // Failed scenarios in the book, or null while there is no parseable book —
  // what gates the "Fix failures" button (the server gate stays authoritative).
  const qaFailCount = useMemo(() => {
    if (qaCsv === null) return null;
    const parsed = parseQaScenarios(qaCsv);
    return parsed.ok ? countQaProgress(parsed.rows).fail : null;
  }, [qaCsv]);

  // Poll fallback while a stage is running, in case the socket drops silently.
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      void refetch().catch(() => undefined);
    }, RUNNING_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isRunning, refetch]);

  const openConversation = (conversationId: number) => {
    navigate(`/projects/${projectId}/epics/${numericEpicId}/chat/${conversationId}`);
  };

  /** Start a stage and jump into its conversation — the chat IS the live view. */
  const startStage = async (agentType: EpicAgentType) => {
    if (!epic || startingStage) return;
    setError(null);
    setStartingStage(agentType);
    try {
      const response = await api.epics.startAgentRun(epic.id, agentType);
      if (response.ok) {
        const run = await response.json();
        await refetch().catch(() => undefined);
        if (run.conversation_id) openConversation(run.conversation_id);
      } else {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Failed to start the stage (HTTP ${response.status})`);
      }
    } catch {
      setError('Failed to start the stage');
    } finally {
      setStartingStage(null);
    }
  };

  /** The backstop: record a stage as approved without asking its agent to. */
  const markStageComplete = async (stage: EpicStageName) => {
    if (!epic || markingStage) return;
    setError(null);
    setMarkingStage(stage);
    try {
      const response = await api.epics.completeStage(epic.id, stage);
      if (response.ok) {
        setEpic(await response.json());
      } else {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Failed to mark the stage complete (HTTP ${response.status})`);
      }
    } catch {
      setError('Failed to mark the stage complete');
    } finally {
      setMarkingStage(null);
    }
  };

  /**
   * Enter, pause or resume the autonomous implementation stage. All three
   * answer the updated epic row, so the panel re-renders from one shape; the
   * work they trigger server-side reaches the page over the epic channel.
   */
  const runOrchestrationAction = async (action: OrchestrationAction) => {
    if (!epic || orchestrationAction) return;
    setError(null);
    setOrchestrationAction(action);
    try {
      const response =
        action === 'start'
          ? await api.epics.startOrchestration(epic.id)
          : action === 'pause'
            ? await api.epics.pauseOrchestration(epic.id)
            : await api.epics.resumeOrchestration(epic.id);
      if (response.ok) {
        setEpic(await response.json());
      } else {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Failed to ${action} orchestration (HTTP ${response.status})`);
      }
    } catch {
      setError(`Failed to ${action} orchestration`);
    } finally {
      setOrchestrationAction(null);
    }
  };

  /**
   * The epic's final pull request. Idempotent server-side — an existing open
   * one is returned rather than a second created — so this is both "open" and
   * "view". Merging it stays the user's act on GitHub.
   */
  const openFinalPR = async () => {
    if (!epic || isOpeningPR) return;
    setError(null);
    setIsOpeningPR(true);
    try {
      const response = await api.epics.completePR(epic.id);
      const body = (await response.json().catch(() => null)) as
        | { success: true; url: string }
        | { success: false; error: string }
        | { error?: string }
        | null;
      if (response.ok && body && 'success' in body && body.success) {
        window.open(body.url, '_blank', 'noopener,noreferrer');
      } else {
        setError(
          (body && 'error' in body ? body.error : undefined) ??
            `Failed to open the final pull request (HTTP ${response.status})`,
        );
      }
    } catch {
      setError('Failed to open the final pull request');
    } finally {
      setIsOpeningPR(false);
    }
  };

  /**
   * Point the project's served symlink at this epic's delivery worktree — its
   * feature branch, i.e. every merged ticket together.
   *
   * The app tab is opened synchronously inside the click gesture (the switch
   * awaits a systemd restart, well past the point where the gesture still
   * counts as one), then navigated when the switch lands or closed if it fails.
   * `noopener` cannot be used because it makes `window.open` return null and we
   * need the handle — so the opener is severed by hand. Same reasoning, same
   * shape as `TaskDetailView`.
   */
  const switchServerToEpic = async () => {
    if (!epic || !project || isSwitchingServer) return;
    const appUrl = webServerStatus?.appUrl;
    let appTab: Window | null = null;
    if (appUrl) {
      appTab = window.open('about:blank', '_blank');
      if (appTab) appTab.opener = null;
    }

    setError(null);
    setIsSwitchingServer(true);
    try {
      const response = await api.projects.switchWebServer(project.id, null, epic.id);
      const body = (await response.json().catch(() => null));
      if (response.ok && body && body.success) {
        setWebServerStatus((prev) =>
          prev ? { ...prev, activeTaskId: null, activeEpicId: epic.id, activeName: epic.name } : prev,
        );
        if (body.warning) setError(body.warning);
        if (appTab && appUrl) appTab.location.href = appUrl;
      } else {
        appTab?.close();
        setError((body && !body.success ? body.error : undefined) ?? 'Failed to switch the web server');
      }
    } catch {
      appTab?.close();
      setError('Failed to switch the web server');
    } finally {
      setIsSwitchingServer(false);
    }
  };

  /** Re-open the served app. A direct response to the click, so no popup risk. */
  const openServedApp = () => {
    const appUrl = webServerStatus?.appUrl;
    if (appUrl) window.open(appUrl, '_blank', 'noopener,noreferrer');
  };

  /** Serve the project's main checkout again. */
  const resetServer = async () => {
    if (!project || isSwitchingServer) return;
    setError(null);
    setIsSwitchingServer(true);
    try {
      const response = await api.projects.switchWebServer(project.id, null, null);
      const body = (await response.json().catch(() => null)) as
        | { success: true; warning?: string }
        | { success: false; error: string }
        | null;
      if (response.ok && body && body.success) {
        setWebServerStatus((prev) =>
          prev ? { ...prev, activeTaskId: null, activeEpicId: null, activeName: null } : prev,
        );
        if (body.warning) setError(body.warning);
      } else {
        setError(
          (body && !body.success ? body.error : undefined) ??
            'Failed to switch the web server back to main',
        );
      }
    } catch {
      setError('Failed to switch the web server back to main');
    } finally {
      setIsSwitchingServer(false);
    }
  };

  if (notFound) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="mb-2">Epic not found.</p>
          <Button variant="outline" size="sm" onClick={() => navigate('/')}>
            Back to dashboard
          </Button>
        </div>
      </div>
    );
  }

  if (!epic) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <div className="w-12 h-12 mx-auto mb-4">
            <div className="w-full h-full rounded-full border-4 border-muted border-t-primary animate-spin" />
          </div>
          <p>Loading epic...</p>
        </div>
      </div>
    );
  }

  // The three markdown browsers only need bytes; which archive directory they
  // come from is decided here, per section.
  const loadArchitectureDoc = async (filename: string): Promise<string> => {
    const response = await api.epics.getArchitectureDoc(epic.id, filename);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).content;
  };
  const loadDoc = async (filename: string): Promise<string> => {
    const response = await api.epics.getDoc(epic.id, filename);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).content;
  };
  const loadReviewDoc = async (filename: string): Promise<string> => {
    const response = await api.epics.getReviewDoc(epic.id, filename);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).content;
  };
  const loadQaFile = async (filename: string): Promise<string> => {
    const response = await api.epics.getQaFile(epic.id, filename);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).content;
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl p-4 md:p-6">
        <Breadcrumb
          project={project}
          onHomeClick={() => navigate('/')}
          onProjectClick={() => project && navigate(`/projects/${project.id}`)}
          className="mb-4"
        />

        <div className="mb-6 flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/projects/${epic.project_id}/epics`)}
            className="h-8 w-8 p-0"
            title="Back to epics"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">{epic.name}</h1>
            <p className="text-sm text-muted-foreground">
              Epic #{epic.id} · {epic.status}
              {epic.feature_branch ? ` · ${epic.feature_branch}` : ''}
            </p>
          </div>
        </div>

        <div className="mb-6 border-b border-border">
          <div className="flex">
            {(
              [
                ['main', 'Main'],
                ['artifacts', 'Artifacts'],
              ] as const
            ).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

        {activeTab === 'main' ? (
          <>
            <Section
              title="Framing"
              subtitle="Prepare the work: four stages, each a conversation whose result you sign off."
            >
              <EpicStageRail
                epic={epic}
                agentRuns={agentRuns}
                conversations={conversations}
                isEpicBusy={isRunning}
                startingStage={startingStage}
                markingStage={markingStage}
                onStart={(agentType) => void startStage(agentType)}
                onOpenConversation={openConversation}
                onMarkComplete={(stage) => void markStageComplete(stage)}
              />
            </Section>

            <Section
              title="Implementation"
              subtitle="The tickets in execution order, driven by the orchestrator; each ticket carries its own conversations."
            >
              <EpicImplementationSection
                epic={epic}
                tickets={tickets}
                agentRuns={agentRuns}
                isTaskLive={isTaskLive}
                isEpicBusy={isRunning}
                pendingAction={orchestrationAction}
                onAction={(action) => void runOrchestrationAction(action)}
                onOpenConversation={openConversation}
                onOpenTicket={(task) => navigate(`/projects/${epic.project_id}/tasks/${task.id}`)}
              />
            </Section>

            <Section
              title="Delivery"
              subtitle="The epic's final pull request, and the conversations that land it — yours, and the ones a GitHub comment on it starts."
            >
              <EpicDeliverySection
                epic={epic}
                tickets={tickets}
                agentRuns={agentRuns}
                conversations={conversations}
                isEpicBusy={isRunning}
                isStartingConversation={startingStage === 'epic-delivery'}
                isOpeningPR={isOpeningPR}
                onStartConversation={() => void startStage('epic-delivery')}
                onOpenPR={() => void openFinalPR()}
                onOpenConversation={openConversation}
                webServerStatus={webServerStatus}
                isSwitchingServer={isSwitchingServer}
                onSwitchServer={() => void switchServerToEpic()}
                onOpenApp={openServedApp}
                onResetServer={() => void resetServer()}
              />
            </Section>

            <Section
              title="QA"
              subtitle="The scenario book derived from the epic's documents, the agent that executes it against the delivered branch, and the fix mission for what fails."
            >
              <EpicQaSection
                epic={epic}
                tickets={tickets}
                agentRuns={agentRuns}
                conversations={conversations}
                isEpicBusy={isRunning}
                isStartingScenarios={startingStage === 'epic-qa-scenarios'}
                isStartingExecution={startingStage === 'epic-qa-execution'}
                isStartingFixes={startingStage === 'epic-qa-fix'}
                isMarkingComplete={markingStage === 'qa'}
                qaFailCount={qaFailCount}
                onStartScenarios={() => void startStage('epic-qa-scenarios')}
                onStartExecution={() => void startStage('epic-qa-execution')}
                onStartFixes={() => void startStage('epic-qa-fix')}
                onMarkQaComplete={() => void markStageComplete('qa')}
                onOpenConversation={openConversation}
              />
            </Section>
          </>
        ) : (
          <>
            <CollapsibleSection title="Functional specification" count={specFiles.length}>
              <EpicSpecFilesSection epicId={epic.id} specFiles={specFiles} />
            </CollapsibleSection>

            <CollapsibleSection title="Architecture document" count={architectureDocs.length}>
              <EpicMarkdownBrowser
                files={architectureDocs}
                loadFile={loadArchitectureDoc}
                emptyNote="No architecture document yet. Start the architecture stage — it writes the document into the epic's archive; refine it by replying in its conversation."
              />
            </CollapsibleSection>

            <CollapsibleSection title="Technical specification" count={docs.length}>
              <EpicMarkdownBrowser
                files={docs}
                loadFile={loadDoc}
                emptyNote="No technical-specification documents yet. Run the specification stage — it writes them into the epic's archive."
              />
            </CollapsibleSection>

            <CollapsibleSection title="Specification review report" count={reviewDocs.length}>
              <EpicMarkdownBrowser
                files={reviewDocs}
                loadFile={loadReviewDoc}
                emptyNote="No review report yet. Run the specification review once the tickets are approved — it checks every document and ticket against each other and the code, writes its findings here, and applies the ones you approve."
              />
            </CollapsibleSection>

            <CollapsibleSection title="QA scenarios" count={qaFiles.length}>
              <EpicFileBrowser
                files={qaFiles}
                loadFile={loadQaFile}
                emptyNote="No QA scenarios yet. Start the QA scenarios stage once the specification review is signed off — it derives every test scenario from the epic's documents and tickets into one CSV, read (and downloaded) here."
                render={(content, filename) => (
                  <QaScenariosTable
                    content={content}
                    filename={filename}
                    downloadUrl={api.epics.qaFileDownloadUrl(epic.id, filename)}
                  />
                )}
              />
            </CollapsibleSection>
          </>
        )}
      </div>
    </div>
  );
}

export default EpicDetailPage;
