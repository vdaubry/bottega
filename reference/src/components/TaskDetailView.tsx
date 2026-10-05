/**
 * TaskDetailView.tsx - Task Detail Page
 *
 * Displays task details including:
 * - Breadcrumb navigation
 * - Task title, status, and metadata
 * - Task documentation (editable markdown)
 * - Conversation history with +/Resume buttons
 */

import React, { useState, useCallback, useEffect } from 'react';
import { FileText, ArrowLeft, ChevronDown, Check, CheckCircle2, GitBranch, ExternalLink, GitMerge, Copy, ArrowUpRight, ArrowDownLeft, Upload, ArrowDownToLine, Loader2, AlertCircle } from 'lucide-react';
import { Button } from './ui/button';
import ServeSwitchButton from './ServeSwitchButton';
import Breadcrumb from './Breadcrumb';
import MarkdownEditor from './MarkdownEditor';
import ConversationList from './ConversationList';
import AgentSection from './AgentSection';
import ReviewRecording from './ReviewRecording';
import WorktreeSetupBanner from './WorktreeSetupBanner';
import PRFixModal, { type PRFixKind } from './PRFixModal';
import { cn } from '../lib/utils';
import { api } from '../utils/api';
import { useWorktreeGuard } from '../hooks/useWorktreeGuard';
import { useWebSocket } from '../contexts/WebSocketContext';
import { useClaudeAuth } from '../contexts/ClaudeAuthContext';
import type { Provider } from '../../shared/providers/types';
import type {
  ProjectRow,
  TaskRow,
  ConversationRow,
  TaskAgentRunRow,
  TaskStatus,
  AgentType,
} from '../../shared/types/db';

// ---- Local helper types ---------------------------------------------------

interface StatusOption {
  value: TaskStatus;
  label: string;
  color: string;
}

interface WorktreeSuccess {
  success: true;
  branch: string | null;
  ahead: number;
  behind: number;
  mainBranch: string;
  worktreePath: string;
  // Unsaved-work counters. Optional so a response from an older server (or a
  // test fixture) still renders — the badge simply stays hidden.
  dirtyFiles?: number;
  unpushed?: number;
}

interface CICheck {
  bucket: string;
  name: string;
  state: string;
  link: string;
}

interface CIStatusDetails {
  status: 'none' | 'passed' | 'failed' | 'pending' | 'unknown';
  checks: CICheck[];
}

interface PRStatus {
  exists?: boolean;
  url?: string;
  state?: string;
  mergeable?: string;
  baseBranch?: string;
  ciStatus?: CIStatusDetails;
}

interface WebServerStatus {
  success: true;
  activeTaskId: number | null;
  serveSymlinkPath: string | null;
  systemdServiceName: string | null;
  appUrl: string | null;
  isConfigured: boolean;
}

export interface SaveDocResult {
  success: boolean;
  error?: string;
}

export interface TaskDetailViewProps {
  project: ProjectRow | null | undefined;
  task: TaskRow | null | undefined;
  taskDoc?: string;
  conversations?: ConversationRow[];
  activeConversationId?: number | null;
  isLoadingDoc?: boolean;
  isLoadingConversations?: boolean;
  agentRuns?: TaskAgentRunRow[];
  isLoadingAgentRuns?: boolean;
  onRunAgent: (agentType: AgentType) => void | Promise<void>;
  onBack: () => void;
  onProjectClick: () => void;
  onHomeClick: () => void;
  onSaveTaskDoc?: (content: string) => Promise<SaveDocResult>;
  onEditDocumentation?: () => void;
  onShowDocumentation?: () => void;
  onExploreDocumentation?: () => void;
  onStatusChange?: (taskId: number, newStatus: TaskStatus) => Promise<unknown>;
  onWorkflowCompleteChange?: (taskId: number, value: boolean) => Promise<unknown>;
  onResumeWorkflow?: (taskId: number) => Promise<unknown>;
  onNewConversation: () => void;
  onResumeConversation: (conversation: ConversationRow) => void;
  onDeleteConversation: (conversationId: number) => void | Promise<unknown>;
  onRenameConversation?: (conversationId: number, name: string) => void | Promise<unknown>;
  onFixConversationCreated?: (conversation: Record<string, unknown> & { __initialMessage?: string }) => void;
  /** Retry a failed worktree setup (shown on the failed-setup banner). */
  onRetryWorktreeSetup?: () => Promise<unknown>;
  /** Delete the task (offered on the failed-setup banner). */
  onDeleteTask?: () => void;
  className?: string;
}

// Status configuration
const STATUS_OPTIONS: StatusOption[] = [
  { value: 'pending', label: 'Pending', color: 'bg-gray-500/10 text-gray-600 dark:text-gray-400' },
  { value: 'in_progress', label: 'In Progress', color: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400' },
  { value: 'in_review', label: 'In Review', color: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  { value: 'completed', label: 'Completed', color: 'bg-green-500/10 text-green-600 dark:text-green-400' },
];

/**
 * The pre-defined message that seeds a repair conversation. Deliberately not an
 * editable agent prompt: these are one-shot fixes, not a workflow stage.
 */
function buildFixPrompt(
  kind: PRFixKind,
  pr: { url: string; baseBranch?: string | undefined },
): string {
  const base = pr.baseBranch ? `\`${pr.baseBranch}\`` : 'its base branch';
  if (kind === 'conflicts') {
    return `The git worktree for this task contains a complete implementation.

The PR cannot be merged — it conflicts with ${base}: ${pr.url}

Please:
1. Fetch the latest ${base} and merge it into this task's branch
2. Resolve every conflict, preserving the intent of both sides
3. Run the project's unit tests to confirm the resolution is sound
4. Commit and push the resolution
5. Monitor the PR status and iterate until GitHub reports no conflicts and all checks pass`;
  }
  return `The git worktree for this task contains a complete implementation.

CI is failing for the PR: ${pr.url}

Please:
1. Retrieve the CI failures from the GitHub Action
2. Analyze what's causing the failures
3. Fix the issues in the codebase
4. Push the changes
5. Monitor the PR status and iterate until all checks pass`;
}

function TaskDetailView({
  project,
  task,
  taskDoc = '',
  conversations = [],
  activeConversationId,
  isLoadingDoc = false,
  isLoadingConversations = false,
  // Agent runs props
  agentRuns = [],
  isLoadingAgentRuns = false,
  onRunAgent,
  // Callbacks
  onBack,
  onProjectClick,
  onHomeClick,
  onSaveTaskDoc,
  onEditDocumentation,
  onShowDocumentation,
  onExploreDocumentation,
  onStatusChange,
  onWorkflowCompleteChange,
  onResumeWorkflow,
  onNewConversation,
  onResumeConversation,
  onDeleteConversation,
  onRenameConversation,
  onFixConversationCreated,
  onRetryWorktreeSetup,
  onDeleteTask,
  className
}: TaskDetailViewProps) {
  const { requireClaudeAuth } = useClaudeAuth();
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [isUpdatingWorkflow, setIsUpdatingWorkflow] = useState(false);
  const [isResumingWorkflow, setIsResumingWorkflow] = useState(false);

  // Every worktree-destroying action on this page routes through the guard, so
  // the "unsaved work" prompt is identical whichever button the user pressed.
  const { guard, guardModal } = useWorktreeGuard();
  const { subscribe, unsubscribe } = useWebSocket();
  const taskId = task?.id ?? null;

  // Worktree state
  const [worktreeStatus, setWorktreeStatus] = useState<WorktreeSuccess | null>(null);
  const [prStatus, setPrStatus] = useState<PRStatus | null>(null);
  const [, setIsLoadingWorktree] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isCreatingPR, setIsCreatingPR] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isCreatingFixConversation, setIsCreatingFixConversation] = useState(false);
  // Which repair the modal is collecting a provider/model for — null = closed.
  const [fixModalKind, setFixModalKind] = useState<PRFixKind | null>(null);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);

  // Web server state
  const [webServerStatus, setWebServerStatus] = useState<WebServerStatus | null>(null);
  const [isSwitchingServer, setIsSwitchingServer] = useState(false);

  /**
   * Load worktree + PR status. Extracted from the mount effect because several
   * things invalidate it mid-session: a push, a guard-modal save, and — the one
   * that used to go unnoticed — an agent turn ending, which is exactly when the
   * worktree acquires uncommitted work while the user is live-testing it.
   */
  const refreshWorktreeStatus = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (!taskId) return;

    if (!options.quiet) {
      setIsLoadingWorktree(true);
      setWorktreeError(null);
    }
    try {
      const response = await api.tasks.getWorktree(taskId);
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setWorktreeStatus(data);
          const prResponse = await api.tasks.getPR(taskId);
          if (prResponse.ok) {
            const prData = await prResponse.json();
            setPrStatus(prData as PRStatus);
          }
        } else {
          setWorktreeStatus(null);
        }
      } else {
        setWorktreeStatus(null);
      }
    } catch (err) {
      console.error('Error loading worktree status:', err);
      setWorktreeStatus(null);
    } finally {
      if (!options.quiet) setIsLoadingWorktree(false);
    }
  }, [taskId]);

  // Fetch worktree status when task changes — and once more when the
  // background setup finishes, since the worktree only exists from then on.
  const worktreeState = task?.worktree_state;
  useEffect(() => {
    void refreshWorktreeStatus();
  }, [refreshWorktreeStatus, worktreeState]);

  // A finished turn is the moment the worktree most often goes dirty — refresh
  // quietly so the "uncommitted / unpushed" badge is true while live-testing.
  useEffect(() => {
    if (!taskId) return;
    const onStreamingEnded = () => {
      void refreshWorktreeStatus({ quiet: true });
    };
    subscribe('streaming-ended', onStreamingEnded);
    return () => unsubscribe('streaming-ended', onStreamingEnded);
  }, [taskId, subscribe, unsubscribe, refreshWorktreeStatus]);

  // Fetch web server status when project changes
  useEffect(() => {
    const loadWebServerStatus = async () => {
      if (!project?.id) return;

      try {
        const response = await api.projects.getWebServer(project.id);
        if (response.ok) {
          const data = await response.json();
          if (data.success) {
            setWebServerStatus(data);
          } else {
            setWebServerStatus(null);
          }
        } else {
          setWebServerStatus(null);
        }
      } catch (err) {
        console.error('Error loading web server status:', err);
        setWebServerStatus(null);
      }
    };

    void loadWebServerStatus();
  }, [project?.id]);

  // Web server handlers
  const handleSwitchServer = async () => {
    if (!task?.id || !project?.id || isSwitchingServer) return;

    // Open the tab synchronously, inside the click gesture, so the browser
    // doesn't treat the post-await window.open() as a popup and block it — the
    // switch awaits a systemd restart that takes seconds, well past the point
    // where the gesture still counts. We navigate the tab once the switch
    // succeeds (or close it if it fails). `noopener` can't be used here because
    // it makes window.open() return null and we need the handle to set its
    // location, so we sever the opener manually instead.
    const appUrl = webServerStatus?.appUrl;
    let appTab: Window | null = null;
    if (appUrl) {
      appTab = window.open('about:blank', '_blank');
      if (appTab) appTab.opener = null;
    }

    setIsSwitchingServer(true);
    setWorktreeError(null);
    try {
      const response = await api.projects.switchWebServer(project.id, task.id);
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setWebServerStatus(prev => (prev ? { ...prev, activeTaskId: task.id } : prev));
          if (data.warning) {
            setWorktreeError(data.warning);
          }
          if (appTab && appUrl) {
            appTab.location.href = appUrl;
          }
        } else {
          appTab?.close();
          setWorktreeError((data as { error?: string }).error || 'Failed to switch web server');
        }
      } else {
        appTab?.close();
        const data = await response.json() as { error?: string };
        setWorktreeError(data.error || 'Failed to switch web server');
      }
    } catch (err) {
      appTab?.close();
      setWorktreeError((err as Error).message);
    } finally {
      setIsSwitchingServer(false);
    }
  };

  // Re-open the deployed app for the worktree that's already the active server.
  // This is a direct response to the click (no await), so a plain window.open
  // with noopener is fine and won't be popup-blocked.
  const handleOpenApp = () => {
    const appUrl = webServerStatus?.appUrl;
    if (!appUrl) return;
    window.open(appUrl, '_blank', 'noopener,noreferrer');
  };

  // Switch the web server back to serving the main repo (mirrors the close
  // button on the project board's "Serving" indicator).
  const handleResetServer = async () => {
    if (!project?.id || isSwitchingServer) return;
    setIsSwitchingServer(true);
    setWorktreeError(null);
    try {
      const response = await api.projects.switchWebServer(project.id, null);
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setWebServerStatus(prev => (prev ? { ...prev, activeTaskId: null } : prev));
          if (data.warning) {
            setWorktreeError(data.warning);
          }
        } else {
          setWorktreeError((data as { error?: string }).error || 'Failed to switch web server back to main');
        }
      } else {
        const data = await response.json() as { error?: string };
        setWorktreeError(data.error || 'Failed to switch web server back to main');
      }
    } catch (err) {
      setWorktreeError((err as Error).message);
    } finally {
      setIsSwitchingServer(false);
    }
  };

  // Worktree handlers
  const handleSyncWorktree = async () => {
    if (!task?.id) return;
    setIsSyncing(true);
    setWorktreeError(null);
    try {
      const response = await api.tasks.syncWorktree(task.id);
      if (response.ok) {
        const data = await response.json();
        if (!data.success) {
          setWorktreeError((data as { error?: string }).error || 'Sync failed');
        } else {
          // Refresh status
          const statusResponse = await api.tasks.getWorktree(task.id);
          if (statusResponse.ok) {
            const statusData = await statusResponse.json();
            if (statusData.success) {
              setWorktreeStatus(statusData);
            }
          }
        }
      }
    } catch (err) {
      setWorktreeError((err as Error).message);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleCreatePR = async () => {
    if (!task?.id) return;
    setIsCreatingPR(true);
    setWorktreeError(null);
    try {
      const title = task.title || `Task ${task.id}`;
      const body = `## Task\n\n${task.title || 'No title'}\n\n## Description\n\nImplemented as part of task #${task.id}`;
      const response = await api.tasks.createPR(task.id, title, body);
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setPrStatus({ exists: true, url: data.url, state: 'OPEN' });
          // Open the PR URL (files tab)
          if (data.url) {
            window.open(`${data.url}/files`, '_blank');
          }
          // Fetch full PR status to get mergeable flag after a short delay
          // (GitHub needs time to compute mergeability)
          setTimeout(async () => {
            try {
              const prResponse = await api.tasks.getPR(task.id);
              if (prResponse.ok) {
                const prData = await prResponse.json();
                if (prData.success) {
                  setPrStatus(prData);
                }
              }
            } catch (err) {
              console.error('Failed to refresh PR status:', err);
            }
          }, 2000);
        } else {
          setWorktreeError((data as { error?: string }).error || 'Failed to create PR');
        }
      }
    } catch (err) {
      setWorktreeError((err as Error).message);
    } finally {
      setIsCreatingPR(false);
    }
  };

  const handleMergeAndCleanup = async () => {
    if (!task?.id) return;
    if (!confirm('This will merge the PR, mark the task as completed, and return to the project dashboard. Worktree cleanup runs after the merge and may finish asynchronously. Continue?')) {
      return;
    }
    setIsMerging(true);
    setWorktreeError(null);
    try {
      const outcome = await guard({
        taskId: task.id,
        intent: 'merge',
        run: (force) => api.tasks.mergeAndCleanup(task.id, force),
      });

      if (outcome.status === 'saved') {
        // The user chose to push instead of merge — the PR moved, CI is
        // re-running, and the worktree is still here to keep testing against.
        await refreshWorktreeStatus();
        return;
      }
      if (outcome.status === 'cancelled') return;
      if (outcome.status === 'error') {
        setWorktreeError(outcome.error);
        return;
      }
      if (outcome.data?.success === false) {
        setWorktreeError(outcome.data.error || 'Merge failed');
        return;
      }

      setWorktreeStatus(null);
      setPrStatus(null);

      // Navigate to project dashboard
      if (onBack) {
        onBack();
      }
    } catch (err) {
      setWorktreeError((err as Error).message);
    } finally {
      setIsMerging(false);
    }
  };

  const handleFixConversation = async (provider: Provider, model: string) => {
    if (!task?.id || !prStatus?.url || !fixModalKind) return;
    // The Claude-connection gate only applies to the Anthropic backend;
    // OpenAI/OpenCode validate their own credentials server-side.
    if (provider === 'anthropic' && !requireClaudeAuth()) return;

    setIsCreatingFixConversation(true);
    setWorktreeError(null);

    try {
      const message = buildFixPrompt(fixModalKind, {
        url: prStatus.url,
        baseBranch: prStatus.baseBranch,
      });

      // Create conversation with the pre-filled message on the explicitly
      // chosen (provider, model).
      const response = await api.conversations.createWithMessage(task.id, {
        message,
        projectPath: worktreeStatus?.worktreePath,
        permissionMode: 'bypassPermissions',
        provider,
        model,
      });

      if (!response.ok) {
        const errorData = await response.json() as { error?: string };
        throw new Error(errorData.error || 'Failed to create conversation');
      }

      const conversation = await response.json();

      setFixModalKind(null);

      // Navigate to the chat page with the initial message
      if (onFixConversationCreated) {
        onFixConversationCreated({
          ...(conversation as unknown as Record<string, unknown>),
          __initialMessage: message
        });
      }
    } catch (err) {
      setWorktreeError((err as Error).message);
    } finally {
      setIsCreatingFixConversation(false);
    }
  };

  const copyWorktreePath = () => {
    if (worktreeStatus?.worktreePath) {
      void navigator.clipboard.writeText(worktreeStatus.worktreePath);
    }
  };

  const handleMergeWithoutPR = async () => {
    if (!task?.id) return;
    if (!confirm('Merge without PR? This will clean up the worktree and the task will continue using the main repo.')) {
      return;
    }
    setIsDiscarding(true);
    setWorktreeError(null);
    try {
      const outcome = await guard({
        taskId: task.id,
        intent: 'discard',
        run: (force) => api.tasks.discardWorktree(task.id, force),
      });

      if (outcome.status === 'saved') {
        await refreshWorktreeStatus();
        return;
      }
      if (outcome.status === 'cancelled') return;
      if (outcome.status === 'error') {
        setWorktreeError(outcome.error);
        return;
      }
      if (outcome.data?.success === false) {
        setWorktreeError(outcome.data.error || 'Failed to merge without PR');
        return;
      }

      setWorktreeStatus(null);
      setPrStatus(null);
    } catch (err) {
      setWorktreeError((err as Error).message);
    } finally {
      setIsDiscarding(false);
    }
  };

  const handlePushChanges = async () => {
    if (!task?.id) return;
    setIsPushing(true);
    setWorktreeError(null);
    try {
      const response = await api.tasks.pushChanges(task.id);
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          // Refresh so ahead/behind and the unsaved-work badge both settle.
          await refreshWorktreeStatus({ quiet: true });
        } else {
          setWorktreeError((data as { error?: string }).error || 'Failed to push changes');
        }
      } else {
        setWorktreeError('Failed to push changes');
      }
    } catch (err) {
      setWorktreeError((err as Error).message);
    } finally {
      setIsPushing(false);
    }
  };

  // Handle resuming an agent's linked conversation. The `if (!task) return null`
  // guard below breaks the rules-of-hooks order; hoisting this hook above the
  // guard keeps the order stable.
  const handleResumeAgent = useCallback((conversationId: number) => {
    if (!conversationId || !onResumeConversation) return;
    const conversation = conversations.find(c => c.id === conversationId);
    if (conversation) {
      onResumeConversation(conversation);
    }
  }, [conversations, onResumeConversation]);

  if (!task) return null;

  // No conversation — chat, agent, Explore — may start before the worktree is set up.
  const notReadyReason =
    task.worktree_state === 'provisioning'
      ? 'The worktree is still being set up'
      : task.worktree_state === 'failed'
        ? 'The worktree setup failed — retry it or delete the task'
        : null;

  const currentStatus = STATUS_OPTIONS.find(s => s.value === task.status) ?? STATUS_OPTIONS[0]!;

  const handleStatusChange = async (newStatus: TaskStatus) => {
    if (newStatus === task.status || !onStatusChange) return;

    // Close the dropdown before anything can bail out. It renders a full-screen
    // click-outside catcher, and leaving that behind (e.g. when the user cancels
    // the guard prompt) makes the whole page unclickable.
    setShowStatusDropdown(false);

    // Completing a task deletes its worktree, so it is as destructive as Merge
    // or Delete and takes the same prompt.
    if (newStatus === 'completed') {
      const outcome = await guard({
        taskId: task.id,
        intent: 'complete',
        run: (force) => api.tasks.discardWorktree(task.id, force),
      });
      if (outcome.status !== 'ok') {
        if (outcome.status === 'saved') {
          await refreshWorktreeStatus();
        } else if (outcome.status === 'error') {
          setWorktreeError(outcome.error);
        }
        return;
      }
      setWorktreeStatus(null);
      setPrStatus(null);
    }

    setIsUpdatingStatus(true);
    try {
      await onStatusChange(task.id, newStatus);
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const handleWorkflowCompleteToggle = async () => {
    if (!onWorkflowCompleteChange) return;

    setIsUpdatingWorkflow(true);
    try {
      await onWorkflowCompleteChange(task.id, !task.workflow_complete);
    } finally {
      setIsUpdatingWorkflow(false);
    }
  };

  const handleResumeWorkflow = async () => {
    if (!onResumeWorkflow) return;

    setIsResumingWorkflow(true);
    try {
      await onResumeWorkflow(task.id);
    } finally {
      setIsResumingWorkflow(false);
    }
  };

  return (
    <div className={cn('min-h-full md:h-full flex flex-col', className)}>
      {/* Header with breadcrumb */}
      <div className="p-4 border-b border-border">
        {/* Back button and breadcrumb */}
        <div className="flex items-center gap-2 mb-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="h-8 w-8 p-0"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <Breadcrumb
            project={project}
            task={task}
            onProjectClick={onProjectClick}
            onHomeClick={onHomeClick}
          />
        </div>

        {/* Task header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0">
            <FileText className="w-5 h-5 text-blue-500" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-foreground truncate">
              {task.title || `Task ${task.id}`}
            </h1>
            <p className="text-sm text-muted-foreground">
              Task #{task.id} in {project?.name || 'Unknown Project'}
            </p>
          </div>

          {/* Workflow control: Resume (if blocked) or Mark Done */}
          {task.workflow_blocked ? (
            <button
              onClick={handleResumeWorkflow}
              disabled={isResumingWorkflow}
              title={task.workflow_blocked_reason || 'Workflow is blocked - click to resume agent loop'}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors flex-shrink-0',
                'bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20',
                isResumingWorkflow && 'opacity-50 cursor-not-allowed'
              )}
            >
              {isResumingWorkflow ? (
                <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : (
                <AlertCircle className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">Resume</span>
            </button>
          ) : (
            <button
              onClick={handleWorkflowCompleteToggle}
              disabled={isUpdatingWorkflow}
              title={task.workflow_complete ? 'Workflow complete - click to resume agent loop' : 'Click to mark workflow as complete'}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors flex-shrink-0',
                task.workflow_complete
                  ? 'bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20'
                  : 'bg-gray-500/10 text-gray-500 dark:text-gray-400 hover:bg-gray-500/20',
                isUpdatingWorkflow && 'opacity-50 cursor-not-allowed'
              )}
            >
              {isUpdatingWorkflow ? (
                <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : (
                <CheckCircle2 className={cn(
                  'w-4 h-4',
                  task.workflow_complete && 'fill-green-500/20'
                )} />
              )}
              <span className="hidden sm:inline">
                {task.workflow_complete ? 'Done' : 'Mark Done'}
              </span>
            </button>
          )}

          {/* Status selector */}
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setShowStatusDropdown(!showStatusDropdown)}
              disabled={isUpdatingStatus}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                currentStatus.color,
                'hover:opacity-80',
                isUpdatingStatus && 'opacity-50 cursor-not-allowed'
              )}
            >
              {isUpdatingStatus ? (
                <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : (
                currentStatus.label
              )}
              <ChevronDown className="w-3.5 h-3.5" />
            </button>

            {/* Dropdown */}
            {showStatusDropdown && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowStatusDropdown(false)}
                />
                <div className="absolute right-0 top-full mt-1 z-20 bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[140px]">
                  {STATUS_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => handleStatusChange(option.value)}
                      className={cn(
                        'w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-accent transition-colors',
                        option.value === task.status && 'bg-accent/50'
                      )}
                    >
                      <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', option.color)}>
                        {option.label}
                      </span>
                      {option.value === task.status && (
                        <Check className="w-4 h-4 text-primary" />
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Why the workflow is blocked, in the agent's own words — an escalation
          to a technical user, a review block. Whoever opens the task sees what
          it is waiting for; Resume stays available to everyone. */}
      {task.workflow_blocked && task.workflow_blocked_reason ? (
        <div
          className="px-4 py-2 border-b border-border bg-amber-500/10 flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400"
          data-testid="workflow-blocked-reason"
        >
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span className="min-w-0 break-words">Paused: {task.workflow_blocked_reason}</span>
        </div>
      ) : null}

      {/* The worktree is set up in the background after creation; until it is
          ready nothing can start a conversation here. */}
      <WorktreeSetupBanner
        state={task.worktree_state ?? 'ready'}
        error={task.worktree_error ?? null}
        onRetry={onRetryWorktreeSetup ?? (() => Promise.resolve())}
        onDelete={onDeleteTask}
      />

      {/* Worktree section - only show if worktree exists, and is set up: a
          half-built one (its hook still running) is nothing to pull, PR or merge. */}
      {worktreeStatus && !notReadyReason && (
        <div className="px-4 py-3 border-b border-border bg-muted/30">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
            {/* Branch info */}
            <div className="flex items-center gap-2 min-w-0">
              <GitBranch className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm font-mono bg-muted px-2 py-0.5 rounded truncate">
                {worktreeStatus.branch}
              </span>
            </div>

            {/* Ahead/behind indicators */}
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              {worktreeStatus.ahead > 0 && (
                <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  {worktreeStatus.ahead} ahead
                </span>
              )}
              {worktreeStatus.behind > 0 && (
                <span className="flex items-center gap-1 text-yellow-600 dark:text-yellow-400">
                  <ArrowDownLeft className="w-3.5 h-3.5" />
                  {worktreeStatus.behind} behind
                </span>
              )}
              {worktreeStatus.ahead === 0 && worktreeStatus.behind === 0 && (
                <span className="text-muted-foreground">Up to date with {worktreeStatus.mainBranch}</span>
              )}
            </div>

            {/*
              Unsaved-work badge. `ahead`/`behind` are measured against the base
              branch, so they look identical whether or not the work reached the
              PR — these two are the only signal that says "what you are testing
              is not on the pull request yet".
            */}
            {((worktreeStatus.dirtyFiles ?? 0) > 0 || (worktreeStatus.unpushed ?? 0) > 0) && (
              <div
                className="flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400"
                title="This work is not on the remote — pushing it updates the pull request"
              >
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>
                  {[
                    worktreeStatus.dirtyFiles
                      ? `${worktreeStatus.dirtyFiles} uncommitted`
                      : null,
                    worktreeStatus.unpushed ? `${worktreeStatus.unpushed} unpushed` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              {/* Pull button - syncs with main branch */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleSyncWorktree}
                disabled={isSyncing}
                className="h-7 text-xs"
              >
                {isSyncing ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <ArrowDownToLine className="w-3.5 h-3.5 mr-1.5" />
                )}
                Pull
              </Button>

              {/* Create PR / View PR / Merge without PR */}
              {!prStatus?.exists ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCreatePR}
                    disabled={isCreatingPR}
                    className="h-7 text-xs"
                    title="Commit changes, push branch, and create pull request"
                  >
                    {isCreatingPR ? (
                      <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin mr-1.5" />
                    ) : (
                      <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    Create PR
                  </Button>
                  {/* Merge without PR button - only when no commits to push */}
                  {worktreeStatus.ahead === 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleMergeWithoutPR}
                      disabled={isDiscarding}
                      className="h-7 text-xs"
                      title="Clean up worktree without creating a PR"
                    >
                      {isDiscarding ? (
                        <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin mr-1.5" />
                      ) : (
                        <GitMerge className="w-3.5 h-3.5 mr-1.5" />
                      )}
                      Merge without PR
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePushChanges}
                    disabled={isPushing}
                    className="h-7 text-xs"
                    title="Commit all changes and push to update the PR"
                  >
                    {isPushing ? (
                      <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin mr-1.5" />
                    ) : (
                      <Upload className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    Push
                  </Button>
                  <a
                    href={`${prStatus.url}/files`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-md border border-border bg-background hover:bg-accent transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    View PR
                  </a>
                  {/* Merge & Cleanup button - appearance based on conflicts, then CI status */}
                  {(() => {
                    // Conflicts come first: GitHub reports no meaningful CI
                    // verdict for a branch that cannot be merged, and the
                    // conflict is what blocks the merge either way.
                    if (prStatus.mergeable === 'CONFLICTING') {
                      return (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => setFixModalKind('conflicts')}
                          disabled={isCreatingFixConversation}
                          className="h-7 text-xs bg-amber-600 hover:bg-amber-700"
                          title="The PR conflicts with its base branch - click to pick a model and create a fix conversation"
                        >
                          {isCreatingFixConversation ? (
                            <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin mr-1.5" />
                          ) : (
                            <GitMerge className="w-3.5 h-3.5 mr-1.5" />
                          )}
                          Fix conflicts
                        </Button>
                      );
                    }

                    // Mergeability still being computed (UNKNOWN) — no verdict
                    // to act on, so no button at all.
                    if (prStatus.mergeable !== 'MERGEABLE') return null;

                    const ciStatus = prStatus.ciStatus?.status || 'none';

                    // Yellow/Amber disabled state for pending CI
                    if (ciStatus === 'pending') {
                      return (
                        <Button
                          variant="default"
                          size="sm"
                          disabled={true}
                          className="h-7 text-xs bg-yellow-500 hover:bg-yellow-500 cursor-not-allowed"
                          title="CI checks are still running"
                        >
                          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                          CI Running...
                        </Button>
                      );
                    }

                    // Red state with error indicator - clicking creates fix conversation
                    if (ciStatus === 'failed') {
                      return (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => setFixModalKind('ci')}
                          disabled={isCreatingFixConversation}
                          className="h-7 text-xs bg-red-600 hover:bg-red-700"
                          title="CI checks failed - click to pick a model and create a fix conversation"
                        >
                          {isCreatingFixConversation ? (
                            <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin mr-1.5" />
                          ) : (
                            <AlertCircle className="w-3.5 h-3.5 mr-1.5" />
                          )}
                          Fix CI
                        </Button>
                      );
                    }

                    // Default: green merge button (no CI, passed, or unknown)
                    return (
                      <Button
                        variant="default"
                        size="sm"
                        onClick={handleMergeAndCleanup}
                        disabled={isMerging}
                        className="h-7 text-xs bg-green-600 hover:bg-green-700"
                      >
                        {isMerging ? (
                          <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin mr-1.5" />
                        ) : (
                          <GitMerge className="w-3.5 h-3.5 mr-1.5" />
                        )}
                        Merge & Cleanup
                      </Button>
                    );
                  })()}
                </>
              )}

              {/* Switch Web Server button - only show if web server is configured */}
              {webServerStatus?.isConfigured && (
                <ServeSwitchButton
                  isActive={webServerStatus.activeTaskId === task.id}
                  isSwitching={isSwitchingServer}
                  onSwitch={() => void handleSwitchServer()}
                  onOpenApp={handleOpenApp}
                  onReset={() => void handleResetServer()}
                  switchTitle="Switch web server to serve this worktree"
                />
              )}

              {/* Copy path */}
              <Button
                variant="ghost"
                size="sm"
                onClick={copyWorktreePath}
                className="h-7 w-7 p-0"
                title={`Copy path: ${worktreeStatus.worktreePath}`}
              >
                <Copy className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

          {/* Error message */}
          {worktreeError && (
            <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-700 dark:text-red-300">
              {worktreeError}
            </div>
          )}
        </div>
      )}

      {/* Content - Split view */}
      <div className="flex-1 flex flex-col md:flex-row overflow-auto md:overflow-hidden">
        {/* Left panel - Conversations */}
        <div className="w-full md:w-80 lg:w-96 flex flex-col min-h-0 border-b md:border-b-0 md:border-r border-border flex-shrink-0">
          <ConversationList
            conversations={conversations}
            isLoading={isLoadingConversations}
            onNewConversation={onNewConversation}
            newConversationDisabledReason={notReadyReason}
            onResumeConversation={onResumeConversation}
            onDeleteConversation={onDeleteConversation}
            onRenameConversation={onRenameConversation}
            activeConversationId={activeConversationId}
            className="h-full"
          />
        </div>

        {/* Right panel - Documentation and Agents */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0 md:overflow-y-auto flex-shrink-0">
          <MarkdownEditor
            content={taskDoc}
            onSave={onSaveTaskDoc}
            onEditClick={onEditDocumentation}
            onShowClick={onShowDocumentation}
            onExploreClick={notReadyReason ? undefined : onExploreDocumentation}
            isLoading={isLoadingDoc}
            placeholder="No task documentation yet. Click Edit to describe what needs to be done."
            className="md:flex-1 md:min-h-0"
          />
          <AgentSection
            agentRuns={agentRuns}
            isLoading={isLoadingAgentRuns}
            onRunAgent={onRunAgent}
            onResumeAgent={handleResumeAgent}
            yoloMode={task.yolo_mode === 1}
            disabledReason={notReadyReason}
            className="flex-shrink-0"
          />
          <ReviewRecording taskId={task.id} className="flex-shrink-0" />
        </div>
      </div>

      <PRFixModal
        kind={fixModalKind}
        onClose={() => setFixModalKind(null)}
        onSubmit={handleFixConversation}
        prUrl={prStatus?.url}
        isSubmitting={isCreatingFixConversation}
      />

      {guardModal}
    </div>
  );
}

export default TaskDetailView;
