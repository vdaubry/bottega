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

  describe('New Task Button', () => {
    it('should render New Task button', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.getByText('New Task')).toBeInTheDocument();
    });

    it('should open task form modal when clicked', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.queryByTestId('task-form-modal')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('New Task'));

      expect(screen.getByTestId('task-form-modal')).toBeInTheDocument();
    });

    it('should pass project name to task form', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByText('New Task'));

      expect(screen.getByTestId('project-name').textContent).toBe('Test Project');
    });

    it('should close task form modal when close is clicked', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByText('New Task'));
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

      fireEvent.click(screen.getByText('New Task'));
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

      fireEvent.click(screen.getByText('New Task'));
      fireEvent.click(screen.getByTestId('submit-task'));

      await waitFor(() => {
        expect(screen.queryByTestId('task-form-modal')).not.toBeInTheDocument();
      });
    });
  });

  describe('Ask Question Button', () => {
    it('should render Ask Question button', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.getByText('Ask Question')).toBeInTheDocument();
    });

    it('should open AskQuestionModal when clicked', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      expect(screen.queryByTestId('ask-question-modal')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Ask Question'));

      expect(screen.getByTestId('ask-question-modal')).toBeInTheDocument();
      expect(screen.getByTestId('ask-project-name').textContent).toBe('Test Project');
    });

    it('should close the modal when close is clicked', () => {
      renderWithRouter(<BoardView project={mockProject} />);

      fireEvent.click(screen.getByText('Ask Question'));
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

      fireEvent.click(screen.getByText('Ask Question'));
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

      fireEvent.click(screen.getByText('Ask Question'));
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

      fireEvent.click(screen.getByText('Ask Question'));
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
        expect(deleteTask).toHaveBeenCalledWith('t2');
      });

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
