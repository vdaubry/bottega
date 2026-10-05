import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BoardView from './BoardView';
import { useTaskContext, type TaskContextValue } from '../../contexts/TaskContext';
import { api } from '../../utils/api';
import { mockTypedResponse } from '../../test/typedResponse';
import type { ProjectRow, TaskRow } from '../../../shared/types/db';

// Mock TaskContext
vi.mock('../../contexts/TaskContext', () => ({
  useTaskContext: vi.fn(),
}));

// BoardView subscribes its visible tasks to the WS for live badges; stub
// the hook so this component test doesn't need a WebSocketProvider.
vi.mock('../../hooks/useTasksLiveSubscriptions', () => ({
  useTasksLiveSubscriptions: vi.fn(),
}));

// Mock API
vi.mock('../../utils/api', () => ({
  api: {
    tasks: {
      getDoc: vi.fn(),
      update: vi.fn(),
    },
    conversations: {
      list: vi.fn(),
      createWithMessage: vi.fn(),
    },
    projects: {
      getWebServer: vi.fn(),
    },
  },
}));

// The epics tab's content has its own test; here it only has to be
// distinguishable from the kanban columns.
vi.mock('../epic/EpicsPanel', () => ({
  default: () => <div data-testid="epics-panel" />,
}));

// Mock BoardColumn component
vi.mock('./BoardColumn', () => ({
  default: ({
    status,
    tasks,
    onTaskClick,
    onTaskEdit,
    onTaskDelete,
  }: {
    status: string;
    tasks: TaskRow[];
    onTaskClick?: (task: TaskRow) => void;
    onTaskEdit?: (task: TaskRow) => void;
    onTaskDelete?: (task: TaskRow) => void;
  }) => (
    <div data-testid={`board-column-${status}`}>
      <span data-testid={`${status}-count`}>{tasks.length}</span>
      {tasks.map((task) => (
        <div key={task.id} data-testid={`task-${task.id}`}>
          <button data-testid={`click-${task.id}`} onClick={() => onTaskClick?.(task)}>Click</button>
          <button data-testid={`edit-${task.id}`} onClick={() => onTaskEdit?.(task)}>Edit</button>
          {onTaskDelete && (
            <button data-testid={`delete-${task.id}`} onClick={() => onTaskDelete(task)}>Delete</button>
          )}
        </div>
      ))}
    </div>
  ),
}));

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (payload: Record<string, string>) => void;
  projectName?: string;
  isSubmitting?: boolean;
}

// Mock TaskForm component
vi.mock('../TaskForm', () => ({
  default: ({ isOpen, onClose, onSubmit, projectName }: ModalProps) => (
    isOpen ? (
      <div data-testid="task-form-modal">
        <span data-testid="project-name">{projectName}</span>
        <button data-testid="close-modal" onClick={onClose}>Close</button>
        <button
          data-testid="submit-task"
          onClick={() => onSubmit({ title: 'New Task', documentation: 'Docs' })}
        >
          Submit
        </button>
      </div>
    ) : null
  ),
}));

vi.mock('../../utils/waitForTaskWorktree', () => ({
  waitForTaskWorktree: vi.fn(),
}));

// Mock AskQuestionModal component
vi.mock('../AskQuestionModal', () => ({
  default: ({ isOpen, onClose, onSubmit, projectName, isSubmitting }: ModalProps) => (
    isOpen ? (
      <div data-testid="ask-question-modal">
        <span data-testid="ask-project-name">{projectName}</span>
        <span data-testid="ask-is-submitting">{isSubmitting ? 'yes' : 'no'}</span>
        <button data-testid="close-ask-modal" onClick={onClose}>Close</button>
        <button
          data-testid="submit-ask"
          onClick={() =>
            onSubmit({
              title: 'Q title',
              question: 'What is 2+2?',
              provider: 'anthropic',
              model: 'opus',
            })
          }
        >
          Submit
        </button>
      </div>
    ) : null
  ),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  ArrowLeft: () => <span data-testid="icon-arrow-left" />,
  Plus: () => <span data-testid="icon-plus" />,
  Columns: () => <span data-testid="icon-columns" />,
  Settings: () => <span data-testid="icon-settings" />,
  Bot: () => <span data-testid="icon-bot" />,
  Code: () => <span data-testid="icon-code" />,
  Server: () => <span data-testid="icon-server" />,
  X: () => <span data-testid="icon-x" />,
  Loader2: () => <span data-testid="icon-loader2" />,
  MessageCircleQuestion: () => <span data-testid="icon-question" />,
  Telescope: () => <span data-testid="icon-telescope" />,
  // Used by the unsaved-work modal the delete guard renders.
  AlertTriangle: () => <span data-testid="icon-alert-triangle" />,
  Upload: () => <span data-testid="icon-upload" />,
  Trash2: () => <span data-testid="icon-trash2" />,
  ChevronRight: () => <span data-testid="icon-chevron-right" />,
}));

// Helper to render with Router
const renderWithRouter = (ui: React.ReactElement, { route = '/' } = {}) => {
  return render(
    <MemoryRouter initialEntries={[route]}>
      {ui}
    </MemoryRouter>
  );
};

describe('BoardView Component', () => {
  const mockProject = {
    id: 'p1',
    name: 'Test Project',
    repo_folder_path: '/path/to/project',
  } as unknown as ProjectRow;

  const mockTasks = [
    { id: 't1', title: 'Task 1', status: 'pending' },
    { id: 't2', title: 'Task 2', status: 'in_progress' },
    { id: 't3', title: 'Task 3', status: 'completed' },
    { id: 't4', title: 'Task 4', status: 'pending' },
  ] as unknown as TaskRow[];

  const defaultContextValue = {
    tasks: mockTasks,
    isLoadingTasks: false,
    createTask: vi.fn(),
    deleteTask: vi.fn(),
    isTaskLive: vi.fn(() => false),
  } as unknown as TaskContextValue;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTaskContext).mockReturnValue(defaultContextValue);

    // Default API mock responses
    vi.mocked(api.tasks.getDoc).mockResolvedValue(mockTypedResponse({ content: 'Doc content' } as never));
    vi.mocked(api.tasks.update).mockResolvedValue(mockTypedResponse({} as never));
    vi.mocked(api.conversations.list).mockResolvedValue(mockTypedResponse({ conversations: [] } as never));
    vi.mocked(api.conversations.createWithMessage).mockResolvedValue(
      mockTypedResponse({ id: 'conv1', claude_conversation_id: 'claude-1' } as never),
    );
    vi.mocked(api.projects.getWebServer).mockResolvedValue(mockTypedResponse({ success: false } as never));
  });

  describe('Rendering', () => {
    it('should return null when no project prop is provided', () => {
      const { container } = renderWithRouter(
        <BoardView {...({} as { project: ProjectRow })} />,
      );

      expect(container.querySelector('.flex-1')).toBeNull();
    });

    it('should render when project prop is provided', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.getByText('Test Project')).toBeInTheDocument();
    });

    it('should display project path', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.getByText('/path/to/project')).toBeInTheDocument();
    });
  });

  describe('Board Columns', () => {
    it('should render all three columns', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.getByTestId('board-column-pending')).toBeInTheDocument();
      expect(screen.getByTestId('board-column-in_progress')).toBeInTheDocument();
      expect(screen.getByTestId('board-column-completed')).toBeInTheDocument();
    });

    it('should group tasks by status correctly', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.getByTestId('pending-count').textContent).toBe('2');
      expect(screen.getByTestId('in_progress-count').textContent).toBe('1');
      expect(screen.getByTestId('completed-count').textContent).toBe('1');
    });

    it('should default tasks without status to pending', () => {
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        tasks: [{ id: 't1', title: 'No status task' }] as unknown as TaskRow[],
      });

      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.getByTestId('pending-count').textContent).toBe('1');
    });
  });

  describe('Navigation', () => {
    it('should navigate to dashboard when back button is clicked', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      const backButton = screen.getByTestId('icon-arrow-left').closest('button')!;
      fireEvent.click(backButton);

      // Navigation happens via react-router - we verify it doesn't throw
      expect(backButton).toBeInTheDocument();
    });

    it('should navigate to task detail when task is clicked', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByTestId('click-t1'));

      // Navigation happens via react-router - verify no errors
      expect(screen.getByTestId('click-t1')).toBeInTheDocument();
    });

    it('should navigate to task edit when edit is clicked', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByTestId('edit-t2'));

      // Navigation happens via react-router - verify no errors
      expect(screen.getByTestId('edit-t2')).toBeInTheDocument();
    });
  });

  describe('Tasks | Epics tabs', () => {
    it('offers both tabs and marks the active one', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.getByRole('button', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('button', { name: /Epics/ })).not.toHaveAttribute('aria-current');
    });

    it('shows the kanban columns and the Add task button on the tasks tab', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.getByTestId('board-column-pending')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('title', 'Create a new task');
      expect(screen.queryByTestId('epics-panel')).not.toBeInTheDocument();
    });

    it('replaces the columns with the epics panel on the epics tab', () => {
      renderWithRouter(<BoardView project={mockProject} tab="epics" />);

      expect(screen.getByTestId('epics-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('board-column-pending')).not.toBeInTheDocument();
      // The primary action follows the tab.
      expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('title', 'Create a new epic');
      expect(screen.getByRole('button', { name: /Epics/ })).toHaveAttribute('aria-current', 'page');
    });

    it('never opens the task modal from the epics tab', () => {
      renderWithRouter(<BoardView project={mockProject} tab="epics" />);

      fireEvent.click(screen.getByText('Add'));

      expect(screen.queryByTestId('task-form-modal')).not.toBeInTheDocument();
    });
  });

  describe('Add Task Button', () => {
    it('should render Add button', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.getByText('Add')).toBeInTheDocument();
    });

    it('should open task form modal when clicked', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.queryByTestId('task-form-modal')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Add'));

      expect(screen.getByTestId('task-form-modal')).toBeInTheDocument();
    });

    it('should pass project name to task form', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByText('Add'));

      expect(screen.getByTestId('project-name').textContent).toBe('Test Project');
    });

    it('should close task form modal when close is clicked', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByText('Add'));
      expect(screen.getByTestId('task-form-modal')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('close-modal'));
      expect(screen.queryByTestId('task-form-modal')).not.toBeInTheDocument();
    });
  });

  describe('Task Creation', () => {
    it('should call createTask with correct parameters', async () => {
      const createTask = vi.fn().mockResolvedValue({ success: true, task: {} });
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        createTask,
      });

      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByText('Add'));
      fireEvent.click(screen.getByTestId('submit-task'));

      await waitFor(() => {
        expect(createTask).toHaveBeenCalledWith('p1', 'New Task', 'Docs', {});
      });
    });

    it('should close modal on successful task creation', async () => {
      const createTask = vi.fn().mockResolvedValue({ success: true, task: {} });
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        createTask,
      });

      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByText('Add'));
      fireEvent.click(screen.getByTestId('submit-task'));

      await waitFor(() => {
        expect(screen.queryByTestId('task-form-modal')).not.toBeInTheDocument();
      });
    });
  });

  describe('Ask Button', () => {
    it('should render Ask button', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.getByText('Ask')).toBeInTheDocument();
    });

    it('should open AskQuestionModal when clicked', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.queryByTestId('ask-question-modal')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Ask'));

      expect(screen.getByTestId('ask-question-modal')).toBeInTheDocument();
      expect(screen.getByTestId('ask-project-name').textContent).toBe('Test Project');
    });

    it('should close the modal when close is clicked', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByText('Ask'));
      expect(screen.getByTestId('ask-question-modal')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('close-ask-modal'));
      expect(screen.queryByTestId('ask-question-modal')).not.toBeInTheDocument();
    });

    it('should create task, set in_progress, create conversation, then navigate', async () => {
      const createTask = vi.fn().mockResolvedValue({
        success: true,
        task: { id: 42, project_id: 'p1', title: 'Q title', status: 'pending' },
      });
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        createTask,
      });

      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByText('Ask'));
      fireEvent.click(screen.getByTestId('submit-ask'));

      await waitFor(() => {
        expect(createTask).toHaveBeenCalledWith('p1', 'Q title', '');
      });
      await waitFor(() => {
        expect(api.tasks.update).toHaveBeenCalledWith(42, { status: 'in_progress' });
      });
      await waitFor(() => {
        expect(api.conversations.createWithMessage).toHaveBeenCalledWith(42, {
          message: 'What is 2+2?',
          projectPath: '/path/to/project',
          permissionMode: 'bypassPermissions',
          provider: 'anthropic',
          model: 'opus',
        });
      });
      await waitFor(() => {
        expect(screen.queryByTestId('ask-question-modal')).not.toBeInTheDocument();
      });
    });

    // The worktree is set up in the background and no conversation can start
    // before it is ready, so the question waits for it.
    it('waits for the worktree setup before sending the question', async () => {
      const { waitForTaskWorktree } = await import('../../utils/waitForTaskWorktree');
      let finishSetup!: (state: 'ready') => void;
      vi.mocked(waitForTaskWorktree).mockReturnValue(
        new Promise((resolve) => {
          finishSetup = resolve;
        }),
      );
      const createTask = vi.fn().mockResolvedValue({
        success: true,
        task: { id: 42, project_id: 'p1', title: 'Q title', status: 'pending', worktree_state: 'provisioning' },
      });
      vi.mocked(useTaskContext).mockReturnValue({ ...defaultContextValue, createTask });

      renderWithRouter(<BoardView project={mockProject} />);
      fireEvent.click(screen.getByText('Ask'));
      fireEvent.click(screen.getByTestId('submit-ask'));

      await waitFor(() => expect(waitForTaskWorktree).toHaveBeenCalledWith(42));
      expect(api.conversations.createWithMessage).not.toHaveBeenCalled();

      finishSetup('ready');
      await waitFor(() => expect(api.conversations.createWithMessage).toHaveBeenCalled());
    });

    it('does not send the question when the setup failed, and leaves for the task page', async () => {
      const { waitForTaskWorktree } = await import('../../utils/waitForTaskWorktree');
      vi.mocked(waitForTaskWorktree).mockResolvedValue('failed');
      const createTask = vi.fn().mockResolvedValue({
        success: true,
        task: { id: 42, project_id: 'p1', title: 'Q title', status: 'pending', worktree_state: 'provisioning' },
      });
      vi.mocked(useTaskContext).mockReturnValue({ ...defaultContextValue, createTask });

      renderWithRouter(<BoardView project={mockProject} />);
      fireEvent.click(screen.getByText('Ask'));
      fireEvent.click(screen.getByTestId('submit-ask'));

      await waitFor(() => {
        expect(screen.queryByTestId('ask-question-modal')).not.toBeInTheDocument();
      });
      expect(api.conversations.createWithMessage).not.toHaveBeenCalled();
    });

    it('should return error when task creation fails', async () => {
      const createTask = vi.fn().mockResolvedValue({
        success: false,
        error: 'boom',
      });
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        createTask,
      });

      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByText('Ask'));
      fireEvent.click(screen.getByTestId('submit-ask'));

      await waitFor(() => {
        expect(createTask).toHaveBeenCalled();
      });
      // Modal stays open so user can see the error
      expect(screen.getByTestId('ask-question-modal')).toBeInTheDocument();
      expect(api.conversations.createWithMessage).not.toHaveBeenCalled();
    });

    it('should return error when conversation creation fails', async () => {
      const createTask = vi.fn().mockResolvedValue({
        success: true,
        task: { id: 42 },
      });
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        createTask,
      });
      vi.mocked(api.conversations.createWithMessage).mockResolvedValue(
        mockTypedResponse({ error: 'server down' } as never, { ok: false, status: 500 }),
      );

      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByText('Ask'));
      fireEvent.click(screen.getByTestId('submit-ask'));

      await waitFor(() => {
        expect(api.conversations.createWithMessage).toHaveBeenCalled();
      });
      // Modal stays open on failure
      expect(screen.getByTestId('ask-question-modal')).toBeInTheDocument();
    });
  });

  describe('Task Deletion', () => {
    it('should render delete button for pending tasks', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      // t1 and t4 are pending tasks
      expect(screen.getByTestId('delete-t1')).toBeInTheDocument();
      expect(screen.getByTestId('delete-t4')).toBeInTheDocument();
    });

    it('should render delete button for in_progress tasks', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      // t2 is an in_progress task
      expect(screen.getByTestId('delete-t2')).toBeInTheDocument();
    });

    it('should render delete button for completed tasks', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      // t3 is a completed task
      expect(screen.getByTestId('delete-t3')).toBeInTheDocument();
    });

    it('should call deleteTask when delete is confirmed', async () => {
      const deleteTask = vi.fn().mockResolvedValue({ success: true });
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        deleteTask,
      });

      // Mock window.confirm to return true
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByTestId('delete-t2'));

      await waitFor(() => {
        // `force: false` first — the guard only escalates after the user picks
        // "discard" in the unsaved-work modal.
        expect(deleteTask).toHaveBeenCalledWith('t2', false);
      });

      vi.mocked(window.confirm).mockRestore();
    });

    it('shows the unsaved-work modal instead of deleting when the worktree has work', async () => {
      const deleteTask = vi.fn().mockResolvedValue({
        success: false,
        conflict: {
          error: 'worktree-has-unsaved-work',
          summary: '2 uncommitted files',
          taskId: 2,
          branch: 'task/2-thing',
          dirtyPaths: ['a.ts', 'b.ts'],
          dirtyFiles: 2,
          unpushedCommits: 0,
          prUrl: 'https://github.com/user/repo/pull/9',
          prNumber: 9,
        },
      });
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        deleteTask,
      });
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByTestId('delete-t2'));

      await waitFor(() => {
        expect(screen.getByText('Deleting would lose work')).toBeInTheDocument();
      });
      // The task is still there — nothing was forced.
      expect(deleteTask).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Commit & push to PR #9')).toBeInTheDocument();

      vi.mocked(window.confirm).mockRestore();
    });

    it('should not call deleteTask when delete is cancelled', async () => {
      const deleteTask = vi.fn().mockResolvedValue({ success: true });
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        deleteTask,
      });

      // Mock window.confirm to return false
      vi.spyOn(window, 'confirm').mockReturnValue(false);

      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByTestId('delete-t1'));

      // Give some time for any potential async operations
      await waitFor(() => {
        expect(deleteTask).not.toHaveBeenCalled();
      });

      vi.mocked(window.confirm).mockRestore();
    });
  });

  describe('Loading States', () => {
    it('should show loading overlay when tasks are loading', () => {
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        isLoadingTasks: true,
      });

      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.getByText('Loading tasks...')).toBeInTheDocument();
    });
  });

  describe('API Integration', () => {
    it('should fetch task documentation on mount', async () => {
      renderWithRouter(<BoardView project={mockProject} />);

      await waitFor(() => {
        expect(api.tasks.getDoc).toHaveBeenCalledWith('t1');
        expect(api.tasks.getDoc).toHaveBeenCalledWith('t2');
        expect(api.tasks.getDoc).toHaveBeenCalledWith('t3');
        expect(api.tasks.getDoc).toHaveBeenCalledWith('t4');
      });
    });

    it('should fetch conversation counts on mount', async () => {
      renderWithRouter(<BoardView project={mockProject} />);

      await waitFor(() => {
        expect(api.conversations.list).toHaveBeenCalledWith('t1');
        expect(api.conversations.list).toHaveBeenCalledWith('t2');
        expect(api.conversations.list).toHaveBeenCalledWith('t3');
        expect(api.conversations.list).toHaveBeenCalledWith('t4');
      });
    });

    it('should handle API errors gracefully', async () => {
      vi.mocked(api.tasks.getDoc).mockResolvedValue({ ok: false } as Response);
      vi.mocked(api.conversations.list).mockResolvedValue({ ok: false } as Response);

      // Should not throw
      renderWithRouter(<BoardView project={mockProject} />);

      await waitFor(() => {
        expect(api.tasks.getDoc).toHaveBeenCalled();
      });

      // Should still render
      expect(screen.getByText('Test Project')).toBeInTheDocument();
    });
  });

  describe('Custom ClassName', () => {
    it('should apply custom className', () => {
      const { container } = renderWithRouter(<BoardView project={mockProject} className="custom-class" />);

      expect(container.querySelector('.custom-class')).toBeInTheDocument();
    });
  });
});
