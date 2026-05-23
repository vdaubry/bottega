import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import InProgressSection from './InProgressSection';
import type { DisplayTask } from './TaskRow';

// Mock TaskRow component
vi.mock('./TaskRow', () => ({
  default: ({
    task,
    onClick,
    onDelete,
    onComplete,
    showProject,
  }: {
    task: { id: number; title?: string | null; project_name?: string };
    onClick?: () => void;
    onDelete?: () => void;
    onComplete?: () => void;
    showProject?: boolean;
  }) => (
    <div data-testid={`task-row-${task.id}`}>
      <span data-testid="task-title">{task.title}</span>
      {showProject && <span data-testid="task-project">{task.project_name}</span>}
      <button data-testid={`click-${task.id}`} onClick={onClick}>Click</button>
      <button data-testid={`delete-${task.id}`} onClick={onDelete}>Delete</button>
      <button data-testid={`complete-${task.id}`} onClick={onComplete}>Complete</button>
    </div>
  ),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Clock: () => <span data-testid="icon-clock" />,
  RefreshCw: ({ className }: { className?: string }) => (
    <span data-testid="icon-refresh" className={className} />
  ),
}));

describe('InProgressSection Component', () => {
  const mockTasks = [
    { id: 1, title: 'Task 1', status: 'in_progress', project_name: 'Project A' },
    { id: 2, title: 'Task 2', status: 'in_progress', project_name: 'Project B' },
    { id: 3, title: 'Task 3', status: 'in_progress', project_name: 'Project A' },
  ] as unknown as DisplayTask[];

  const defaultProps = {
    tasks: mockTasks,
    isLoading: false,
    onTaskClick: vi.fn(),
    onDeleteTask: vi.fn(),
    onCompleteTask: vi.fn(),
    onRefresh: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Loading State', () => {
    it('should render loading spinner when isLoading=true and no tasks', () => {
      render(<InProgressSection {...defaultProps} tasks={[]} isLoading={true} />);

      expect(screen.getByText('Loading in-progress tasks...')).toBeInTheDocument();
    });

    it('should show tasks when isLoading=true but tasks exist', () => {
      render(<InProgressSection {...defaultProps} isLoading={true} />);

      // Should show tasks, not loading state
      expect(screen.queryByText('Loading in-progress tasks...')).not.toBeInTheDocument();
      expect(screen.getByTestId('task-row-1')).toBeInTheDocument();
    });
  });

  describe('Empty State', () => {
    it('should render empty state when no tasks and not loading', () => {
      render(<InProgressSection {...defaultProps} tasks={[]} isLoading={false} />);

      expect(screen.getByText('No tasks in progress')).toBeInTheDocument();
      expect(screen.getByText('Tasks move here when you start a conversation')).toBeInTheDocument();
      expect(screen.getByTestId('icon-clock')).toBeInTheDocument();
    });
  });

  describe('Task List', () => {
    it('should render all tasks', () => {
      render(<InProgressSection {...defaultProps} />);

      expect(screen.getByTestId('task-row-1')).toBeInTheDocument();
      expect(screen.getByTestId('task-row-2')).toBeInTheDocument();
      expect(screen.getByTestId('task-row-3')).toBeInTheDocument();
    });

    it('should render task count in header', () => {
      render(<InProgressSection {...defaultProps} />);

      expect(screen.getByText('(3)')).toBeInTheDocument();
      expect(screen.getByText('In Progress')).toBeInTheDocument();
    });

    it('should call onTaskClick when task is clicked', () => {
      render(<InProgressSection {...defaultProps} />);

      fireEvent.click(screen.getByTestId('click-1'));

      expect(defaultProps.onTaskClick).toHaveBeenCalledWith(mockTasks[0]);
      expect(defaultProps.onTaskClick).toHaveBeenCalledTimes(1);
    });

    it('should pass showProject prop to TaskRow', () => {
      render(<InProgressSection {...defaultProps} />);

      // TaskRow should receive showProject=true and display project name
      expect(screen.getByTestId('task-row-1').querySelector('[data-testid="task-project"]')).toBeInTheDocument();
    });
  });

  describe('Refresh Button', () => {
    it('should render refresh button when onRefresh is provided', () => {
      render(<InProgressSection {...defaultProps} />);

      expect(screen.getByTestId('icon-refresh')).toBeInTheDocument();
    });

    it('should not render refresh button when onRefresh is not provided', () => {
      render(<InProgressSection {...defaultProps} onRefresh={undefined} />);

      expect(screen.queryByTestId('icon-refresh')).not.toBeInTheDocument();
    });

    it('should call onRefresh when refresh button is clicked', () => {
      render(<InProgressSection {...defaultProps} />);

      const refreshButton = screen.getByTestId('icon-refresh').closest('button')!;
      fireEvent.click(refreshButton);

      expect(defaultProps.onRefresh).toHaveBeenCalledTimes(1);
    });

    it('should disable refresh button when loading', () => {
      render(<InProgressSection {...defaultProps} isLoading={true} />);

      const refreshButton = screen.getByTestId('icon-refresh').closest('button');
      expect(refreshButton).toBeDisabled();
    });

    it('should animate refresh icon when loading', () => {
      render(<InProgressSection {...defaultProps} isLoading={true} />);

      const refreshIcon = screen.getByTestId('icon-refresh');
      expect(refreshIcon.className).toContain('animate-spin');
    });
  });

  describe('Delete Task', () => {
    it('should call onDeleteTask with task id when delete is clicked', () => {
      render(<InProgressSection {...defaultProps} />);

      fireEvent.click(screen.getByTestId('delete-2'));

      expect(defaultProps.onDeleteTask).toHaveBeenCalledWith(2);
    });
  });

  describe('Complete Task', () => {
    it('should call onCompleteTask with task id when complete is clicked', () => {
      render(<InProgressSection {...defaultProps} />);

      fireEvent.click(screen.getByTestId('complete-3'));

      expect(defaultProps.onCompleteTask).toHaveBeenCalledWith(3);
    });
  });
});
