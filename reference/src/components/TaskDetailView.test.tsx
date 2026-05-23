import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TaskDetailView, { type TaskDetailViewProps } from './TaskDetailView';
import type { ProjectRow, TaskRow, ConversationRow } from '../../shared/types/db';
import { api } from '../utils/api';

// Mock child components
vi.mock('./ui/button', () => ({
  Button: ({
    children,
    onClick,
    className,
    disabled,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    variant?: string;
    size?: string;
    className?: string;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} className={className} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock('./Breadcrumb', () => ({
  default: ({
    project,
    task,
    onProjectClick,
    onHomeClick,
  }: {
    project?: { id?: number; name?: string };
    task?: { title?: string | null };
    onProjectClick?: (p: unknown) => void;
    onHomeClick?: () => void;
  }) => (
    <div data-testid="breadcrumb">
      <button data-testid="home-click" onClick={onHomeClick}>Home</button>
      <button data-testid="project-click" onClick={() => onProjectClick?.(project)}>
        {project?.name}
      </button>
      <span>{task?.title}</span>
    </div>
  ),
}));

vi.mock('./MarkdownEditor', () => ({
  default: ({
    content,
    onSave,
    isLoading,
    placeholder,
  }: {
    content?: string | null;
    onSave?: (next: string) => void;
    isLoading?: boolean;
    placeholder?: string;
  }) => (
    <div data-testid="markdown-editor">
      <span data-testid="doc-content">{content || placeholder}</span>
      {isLoading && <span data-testid="doc-loading">Loading...</span>}
      <button data-testid="save-doc" onClick={() => onSave?.('Updated docs')}>Save</button>
    </div>
  ),
}));

vi.mock('./ConversationList', () => ({
  default: ({
    conversations,
    isLoading,
    onNewConversation,
    onResumeConversation,
    onDeleteConversation,
    activeConversationId,
  }: {
    conversations?: Array<{ id: number | string; title?: string | null }>;
    isLoading?: boolean;
    onNewConversation?: () => void;
    onResumeConversation?: (c: { id: number | string }) => void;
    onDeleteConversation?: (id: number | string) => void;
    activeConversationId?: number | string | null;
  }) => (
    <div data-testid="conversation-list">
      {isLoading && <span data-testid="conv-loading">Loading...</span>}
      <span data-testid="conv-count">{conversations?.length || 0}</span>
      <button data-testid="new-conv" onClick={onNewConversation}>New</button>
      {conversations?.map((c) => (
        <div key={c.id} data-testid={`conv-${c.id}`}>
          <button data-testid={`resume-${c.id}`} onClick={() => onResumeConversation?.(c)}>
            Resume
          </button>
          <button data-testid={`delete-${c.id}`} onClick={() => onDeleteConversation?.(c.id)}>
            Delete
          </button>
          {activeConversationId === c.id && <span data-testid="active-indicator">Active</span>}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('./ReviewRecording', () => ({
  default: ({ taskId, className }: { taskId: number; className?: string }) => (
    <div data-testid="review-recording" data-task-id={taskId} className={className}>
      ReviewRecording
    </div>
  ),
}));

// Mock the API client. Defaults return non-ok responses so the worktree / web
// server / PR fetches that fire on mount leave their state null — matching the
// behavior the other tests rely on (no fetch in jsdom). The "Switch Server"
// tests override the relevant methods to drive the button into view.
vi.mock('../utils/api', () => {
  const notOk = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  return {
    api: {
      tasks: {
        getWorktree: vi.fn(notOk),
        getPR: vi.fn(notOk),
        syncWorktree: vi.fn(notOk),
        createPR: vi.fn(notOk),
        mergeAndCleanup: vi.fn(notOk),
        discardWorktree: vi.fn(notOk),
        pushChanges: vi.fn(notOk),
      },
      projects: {
        getWebServer: vi.fn(notOk),
        switchWebServer: vi.fn(notOk),
      },
      conversations: {
        createWithMessage: vi.fn(notOk),
      },
    },
  };
});

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  FileText: () => <span data-testid="icon-file-text" />,
  ArrowLeft: () => <span data-testid="icon-arrow-left" />,
  ChevronDown: () => <span data-testid="icon-chevron-down" />,
  Check: () => <span data-testid="icon-check" />,
  Code: () => <span data-testid="icon-code" />,
  Play: () => <span data-testid="icon-play" />,
  Loader2: () => <span data-testid="icon-loader" />,
  CheckCircle: () => <span data-testid="icon-check-circle" />,
  CheckCircle2: () => <span data-testid="icon-check-circle-2" />,
  GitBranch: () => <span data-testid="icon-git-branch" />,
  ExternalLink: () => <span data-testid="icon-external-link" />,
  GitMerge: () => <span data-testid="icon-git-merge" />,
  Copy: () => <span data-testid="icon-copy" />,
  ArrowUpRight: () => <span data-testid="icon-arrow-up-right" />,
  ArrowDownLeft: () => <span data-testid="icon-arrow-down-left" />,
  Upload: () => <span data-testid="icon-upload" />,
  Server: () => <span data-testid="icon-server" />,
  X: () => <span data-testid="icon-x" />,
  ArrowDownToLine: () => <span data-testid="icon-arrow-down-to-line" />,
  AlertCircle: () => <span data-testid="icon-alert-circle" />,
  MessageCircle: () => <span data-testid="icon-message-circle" />,
  GitPullRequest: () => <span data-testid="icon-git-pull-request" />,
  Sparkles: () => <span data-testid="icon-sparkles" />,
  Zap: () => <span data-testid="icon-zap" />,
}));

describe('TaskDetailView Component', () => {
  const mockProject = { id: 'p1', name: 'Test Project' } as unknown as ProjectRow;
  const mockTask = { id: 't1', title: 'Test Task', status: 'pending' } as unknown as TaskRow;
  const mockConversations = [
    { id: 'c1', title: 'Conversation 1' },
    { id: 'c2', title: 'Conversation 2' },
  ] as unknown as ConversationRow[];

  const defaultProps = {
    project: mockProject,
    task: mockTask,
    taskDoc: '# Task Documentation',
    conversations: mockConversations,
    activeConversationId: null,
    isLoadingDoc: false,
    isLoadingConversations: false,
    onBack: vi.fn(),
    onProjectClick: vi.fn(),
    onHomeClick: vi.fn(),
    onSaveTaskDoc: vi.fn(),
    onStatusChange: vi.fn(),
    onWorkflowCompleteChange: vi.fn(),
    onNewConversation: vi.fn(),
    onResumeConversation: vi.fn(),
    onDeleteConversation: vi.fn(),
    onRunAgent: vi.fn(),
  } as unknown as TaskDetailViewProps;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should return null when task is null', () => {
      const { container } = render(<TaskDetailView {...defaultProps} task={null} />);
      expect(container.firstChild).toBeNull();
    });

    it('should render task title', () => {
      render(<TaskDetailView {...defaultProps} />);
      // Title appears in both breadcrumb and h1, verify at least one
      expect(screen.getAllByText('Test Task').length).toBeGreaterThanOrEqual(1);
    });

    it('should render fallback title when task.title is missing', () => {
      render(<TaskDetailView {...defaultProps} task={{ id: 't1', status: 'pending' } as unknown as TaskRow} />);
      expect(screen.getByText('Task t1')).toBeInTheDocument();
    });

    it('should render project name in subtitle', () => {
      render(<TaskDetailView {...defaultProps} />);
      expect(screen.getByText(/in Test Project/)).toBeInTheDocument();
    });

    it('should render breadcrumb', () => {
      render(<TaskDetailView {...defaultProps} />);
      expect(screen.getByTestId('breadcrumb')).toBeInTheDocument();
    });

    it('should render markdown editor with task doc', () => {
      render(<TaskDetailView {...defaultProps} />);
      expect(screen.getByTestId('doc-content')).toHaveTextContent('# Task Documentation');
    });

    it('should render conversation list', () => {
      render(<TaskDetailView {...defaultProps} />);
      expect(screen.getByTestId('conversation-list')).toBeInTheDocument();
      expect(screen.getByTestId('conv-count')).toHaveTextContent('2');
    });
  });

  describe('Status Display', () => {
    it('should show Pending status for pending task', () => {
      render(<TaskDetailView {...defaultProps} task={{ ...mockTask, status: 'pending' }} />);
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });

    it('should show In Progress status for in_progress task', () => {
      render(<TaskDetailView {...defaultProps} task={{ ...mockTask, status: 'in_progress' }} />);
      expect(screen.getByText('In Progress')).toBeInTheDocument();
    });

    it('should show In Review status for in_review task', () => {
      render(<TaskDetailView {...defaultProps} task={{ ...mockTask, status: 'in_review' }} />);
      expect(screen.getByText('In Review')).toBeInTheDocument();
    });

    it('should show Completed status for completed task', () => {
      render(<TaskDetailView {...defaultProps} task={{ ...mockTask, status: 'completed' }} />);
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('should default to Pending for unknown status', () => {
      render(<TaskDetailView {...defaultProps} task={{ ...mockTask, status: 'unknown' } as unknown as TaskRow} />);
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });
  });

  describe('Status Dropdown', () => {
    it('should open dropdown when status button is clicked', () => {
      render(<TaskDetailView {...defaultProps} />);

      // Dropdown should not be visible initially
      expect(screen.queryAllByText('In Progress').length).toBe(0);

      // Click the status button
      fireEvent.click(screen.getByText('Pending'));

      // Now dropdown should show all options
      expect(screen.getByText('In Progress')).toBeInTheDocument();
      expect(screen.getByText('In Review')).toBeInTheDocument();
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('should close dropdown when clicking outside', () => {
      render(<TaskDetailView {...defaultProps} />);

      // Open dropdown
      fireEvent.click(screen.getByText('Pending'));
      expect(screen.getByText('In Progress')).toBeInTheDocument();

      // Click overlay (fixed inset-0 div)
      const overlay = document.querySelector('.fixed.inset-0')!;
      fireEvent.click(overlay);

      // Dropdown should close (In Progress no longer visible in dropdown)
      expect(screen.queryAllByText('In Progress').length).toBe(0);
    });

    it('should call onStatusChange when new status is selected', async () => {
      const onStatusChange = vi.fn().mockResolvedValue(undefined);
      render(<TaskDetailView {...defaultProps} onStatusChange={onStatusChange} />);

      // Open dropdown
      fireEvent.click(screen.getByText('Pending'));

      // Select new status
      fireEvent.click(screen.getByText('In Progress'));

      await waitFor(() => {
        expect(onStatusChange).toHaveBeenCalledWith('t1', 'in_progress');
      });
    });

    it('should not call onStatusChange when same status is selected', async () => {
      const onStatusChange = vi.fn();
      render(<TaskDetailView {...defaultProps} onStatusChange={onStatusChange} />);

      // Open dropdown
      fireEvent.click(screen.getByText('Pending'));

      // Click the same status (Pending in dropdown)
      const pendingOptions = screen.getAllByText('Pending');
      fireEvent.click(pendingOptions[pendingOptions.length - 1]!); // Click the one in dropdown

      expect(onStatusChange).not.toHaveBeenCalled();
    });
  });

  describe('Navigation', () => {
    it('should call onBack when back button is clicked', () => {
      render(<TaskDetailView {...defaultProps} />);

      const backButton = screen.getByTestId('icon-arrow-left').closest('button')!;
      fireEvent.click(backButton);

      expect(defaultProps.onBack).toHaveBeenCalled();
    });

    it('should call onHomeClick from breadcrumb', () => {
      render(<TaskDetailView {...defaultProps} />);

      fireEvent.click(screen.getByTestId('home-click'));

      expect(defaultProps.onHomeClick).toHaveBeenCalled();
    });

    it('should call onProjectClick from breadcrumb', () => {
      render(<TaskDetailView {...defaultProps} />);

      fireEvent.click(screen.getByTestId('project-click'));

      expect(defaultProps.onProjectClick).toHaveBeenCalled();
    });
  });

  describe('Conversation Actions', () => {
    it('should call onNewConversation', () => {
      render(<TaskDetailView {...defaultProps} />);

      fireEvent.click(screen.getByTestId('new-conv'));

      expect(defaultProps.onNewConversation).toHaveBeenCalled();
    });

    it('should call onResumeConversation with conversation', () => {
      render(<TaskDetailView {...defaultProps} />);

      fireEvent.click(screen.getByTestId('resume-c1'));

      expect(defaultProps.onResumeConversation).toHaveBeenCalledWith(mockConversations[0]);
    });

    it('should call onDeleteConversation with id', () => {
      render(<TaskDetailView {...defaultProps} />);

      fireEvent.click(screen.getByTestId('delete-c2'));

      expect(defaultProps.onDeleteConversation).toHaveBeenCalledWith('c2');
    });
  });

  describe('Document Actions', () => {
    it('should call onSaveTaskDoc when save is clicked', () => {
      render(<TaskDetailView {...defaultProps} />);

      fireEvent.click(screen.getByTestId('save-doc'));

      expect(defaultProps.onSaveTaskDoc).toHaveBeenCalledWith('Updated docs');
    });
  });

  describe('Loading States', () => {
    it('should pass isLoadingDoc to MarkdownEditor', () => {
      render(<TaskDetailView {...defaultProps} isLoadingDoc={true} />);

      expect(screen.getByTestId('doc-loading')).toBeInTheDocument();
    });

    it('should pass isLoadingConversations to ConversationList', () => {
      render(<TaskDetailView {...defaultProps} isLoadingConversations={true} />);

      expect(screen.getByTestId('conv-loading')).toBeInTheDocument();
    });
  });

  describe('Active Conversation', () => {
    it('should highlight active conversation', () => {
      render(<TaskDetailView {...defaultProps} activeConversationId={'c1' as unknown as number} />);

      expect(screen.getByTestId('conv-c1').querySelector('[data-testid="active-indicator"]')).toBeInTheDocument();
    });
  });

  describe('Custom ClassName', () => {
    it('should apply custom className', () => {
      const { container } = render(<TaskDetailView {...defaultProps} className="custom-class" />);

      expect((container.firstChild as HTMLElement).className).toContain('custom-class');
    });
  });

  describe('Workflow Complete Toggle', () => {
    it('should render workflow toggle button with icon', () => {
      render(
        <TaskDetailView
          {...defaultProps}
          task={{ ...mockTask, workflow_complete: 0 }}
        />
      );

      // The button has the CheckCircle2 icon (mocked as icon-check-circle-2)
      expect(screen.getByTestId('icon-check-circle-2')).toBeInTheDocument();
    });

    it('should call onWorkflowCompleteChange with true when workflow_complete is 0', async () => {
      const onWorkflowCompleteChange = vi.fn().mockResolvedValue(undefined);
      render(
        <TaskDetailView
          {...defaultProps}
          onWorkflowCompleteChange={onWorkflowCompleteChange}
          task={{ ...mockTask, workflow_complete: 0 }}
        />
      );

      // Find the button by its icon
      const toggleButton = screen.getByTestId('icon-check-circle-2').closest('button')!;
      fireEvent.click(toggleButton);

      await waitFor(() => {
        // Component passes !task.workflow_complete, so 0 becomes true
        expect(onWorkflowCompleteChange).toHaveBeenCalledWith('t1', true);
      });
    });

    it('should call onWorkflowCompleteChange with false when workflow_complete is 1', async () => {
      const onWorkflowCompleteChange = vi.fn().mockResolvedValue(undefined);
      render(
        <TaskDetailView
          {...defaultProps}
          onWorkflowCompleteChange={onWorkflowCompleteChange}
          task={{ ...mockTask, workflow_complete: 1 }}
        />
      );

      const toggleButton = screen.getByTestId('icon-check-circle-2').closest('button')!;
      fireEvent.click(toggleButton);

      await waitFor(() => {
        // Component passes !task.workflow_complete, so 1 becomes false
        expect(onWorkflowCompleteChange).toHaveBeenCalledWith('t1', false);
      });
    });

    it('should apply green styling when workflow_complete is 1', () => {
      render(
        <TaskDetailView
          {...defaultProps}
          task={{ ...mockTask, workflow_complete: 1 }}
        />
      );

      const toggleButton = screen.getByTestId('icon-check-circle-2').closest('button')!;
      expect(toggleButton.className).toContain('bg-green');
    });

    it('should render ReviewRecording with correct taskId', () => {
      render(<TaskDetailView {...defaultProps} />);

      const reviewRecording = screen.getByTestId('review-recording');
      expect(reviewRecording).toBeInTheDocument();
      expect(reviewRecording).toHaveAttribute('data-task-id', 't1');
    });

    it('should apply gray styling when workflow_complete is 0', () => {
      render(
        <TaskDetailView
          {...defaultProps}
          task={{ ...mockTask, workflow_complete: 0 }}
        />
      );

      const toggleButton = screen.getByTestId('icon-check-circle-2').closest('button')!;
      expect(toggleButton.className).toContain('bg-gray');
    });
  });

  describe('Switch Server', () => {
    // Render the worktree panel with a configured web server. `activeTaskId`
    // controls which UI appears: != 't1' shows the gray "Switch Server" button,
    // == 't1' shows the green "Active Server" + close button group.
    const setupWebServer = (appUrl: string | null, activeTaskId: number | string) => {
      vi.mocked(api.tasks.getWorktree).mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            branch: 'feature/x',
            ahead: 0,
            behind: 0,
            mainBranch: 'main',
            worktreePath: '/tmp/wt',
          }),
      } as never);
      vi.mocked(api.projects.getWebServer).mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            activeTaskId,
            serveSymlinkPath: '/var/www/app',
            systemdServiceName: 'app',
            appUrl,
            isConfigured: true,
          }),
      } as never);
      vi.mocked(api.projects.switchWebServer).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      } as never);
    };

    // A stand-in for the WindowProxy returned by window.open — lets us assert
    // that the pre-opened tab is navigated (or closed) after the switch.
    const makeFakeTab = () =>
      ({ location: { href: '' }, opener: {}, close: vi.fn() }) as unknown as Window;

    it('opens a tab synchronously then navigates it to the app URL after a successful switch', async () => {
      const fakeTab = makeFakeTab();
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeTab);
      setupWebServer('https://app.example.com', 999);

      render(<TaskDetailView {...defaultProps} />);

      const switchButton = await screen.findByText('Switch Server');
      fireEvent.click(switchButton);

      // Tab is opened blank, synchronously within the click gesture.
      expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank');

      await waitFor(() => {
        expect(api.projects.switchWebServer).toHaveBeenCalledWith('p1', 't1');
      });
      // ...and navigated to the app URL once the switch resolves.
      await waitFor(() => {
        expect(fakeTab.location.href).toBe('https://app.example.com');
      });

      openSpy.mockRestore();
    });

    it('does not open a tab when no app URL is configured', async () => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      setupWebServer(null, 999);

      render(<TaskDetailView {...defaultProps} />);

      const switchButton = await screen.findByText('Switch Server');
      fireEvent.click(switchButton);

      await waitFor(() => {
        expect(api.projects.switchWebServer).toHaveBeenCalledWith('p1', 't1');
      });
      expect(openSpy).not.toHaveBeenCalled();

      openSpy.mockRestore();
    });

    it('closes the pre-opened tab when the switch fails', async () => {
      const fakeTab = makeFakeTab();
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeTab);
      setupWebServer('https://app.example.com', 999);
      vi.mocked(api.projects.switchWebServer).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: false, error: 'boom' }),
      } as never);

      render(<TaskDetailView {...defaultProps} />);

      const switchButton = await screen.findByText('Switch Server');
      fireEvent.click(switchButton);

      await waitFor(() => {
        expect(fakeTab.close).toHaveBeenCalled();
      });
      expect(fakeTab.location.href).toBe('');

      openSpy.mockRestore();
    });

    it('shows the green Active Server button when this task is the active server', async () => {
      setupWebServer('https://app.example.com', 't1');

      render(<TaskDetailView {...defaultProps} />);

      const activeButton = await screen.findByText('Active Server');
      expect(activeButton).toBeInTheDocument();
      // The gray "Switch Server" button should not be present.
      expect(screen.queryByText('Switch Server')).not.toBeInTheDocument();
    });

    it('opens the app in a new tab when the Active Server button is clicked', async () => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      setupWebServer('https://app.example.com', 't1');

      render(<TaskDetailView {...defaultProps} />);

      const activeButton = await screen.findByText('Active Server');
      fireEvent.click(activeButton);

      // Direct click → plain window.open with noopener, no switch call.
      expect(openSpy).toHaveBeenCalledWith(
        'https://app.example.com',
        '_blank',
        'noopener,noreferrer',
      );
      expect(api.projects.switchWebServer).not.toHaveBeenCalled();

      openSpy.mockRestore();
    });

    it('switches back to the main repo when the close button is clicked', async () => {
      setupWebServer('https://app.example.com', 't1');

      render(<TaskDetailView {...defaultProps} />);

      await screen.findByText('Active Server');
      const closeButton = screen.getByTestId('icon-x').closest('button')!;
      fireEvent.click(closeButton);

      await waitFor(() => {
        expect(api.projects.switchWebServer).toHaveBeenCalledWith('p1', null);
      });
    });
  });
});
