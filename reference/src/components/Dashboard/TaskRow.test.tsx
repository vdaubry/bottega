import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskRow, { type DisplayTask } from './TaskRow';
import type { TaskContextValue } from '../../contexts/TaskContext';

// Mock useTaskContext
vi.mock('../../contexts/TaskContext', () => ({
  useTaskContext: vi.fn(() => ({
    isTaskLive: vi.fn(() => false),
  })),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  FileText: () => <span data-testid="icon-file-text" />,
  Trash2: () => <span data-testid="icon-trash" />,
  ChevronRight: () => <span data-testid="icon-chevron-right" />,
  Circle: () => <span data-testid="icon-circle" />,
  CheckCircle: () => <span data-testid="icon-check-circle" />,
}));

import { useTaskContext } from '../../contexts/TaskContext';

const asTask = <T extends Partial<DisplayTask>>(t: T): DisplayTask => t as unknown as DisplayTask;

describe('TaskRow Component', () => {
  const mockTask = asTask({
    id: 't1' as unknown as number,
    title: 'Test Task',
    status: 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    conversation_count: 0,
  });

  const defaultProps = {
    task: mockTask,
    onClick: vi.fn(),
    onDelete: vi.fn(),
    onComplete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTaskContext).mockReturnValue({
      isTaskLive: vi.fn(() => false),
    } as unknown as TaskContextValue);
  });

  describe('Rendering', () => {
    it('should render task title', () => {
      render(<TaskRow {...defaultProps} />);

      expect(screen.getByText('Test Task')).toBeInTheDocument();
    });

    it('should render fallback title when no title provided', () => {
      render(<TaskRow {...defaultProps} task={{ ...mockTask, title: null }} />);

      expect(screen.getByText('Task t1')).toBeInTheDocument();
    });

    it('should render with data-testid', () => {
      render(<TaskRow {...defaultProps} />);

      expect(screen.getByTestId('task-row-t1')).toBeInTheDocument();
    });
  });

  describe('Status Badge', () => {
    it('should show Pending badge for pending status', () => {
      render(<TaskRow {...defaultProps} task={{ ...mockTask, status: 'pending' }} />);

      expect(screen.getByText('Pending')).toBeInTheDocument();
    });

    it('should show In Progress badge for in_progress status', () => {
      render(<TaskRow {...defaultProps} task={{ ...mockTask, status: 'in_progress' }} />);

      expect(screen.getByText('In Progress')).toBeInTheDocument();
    });

    it('should show Completed badge for completed status', () => {
      render(<TaskRow {...defaultProps} task={{ ...mockTask, status: 'completed' }} />);

      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('should show LIVE badge when task is live', () => {
      render(<TaskRow {...defaultProps} task={{ ...mockTask, is_live: true }} />);

      expect(screen.getByTestId('live-badge')).toBeInTheDocument();
      expect(screen.getByText('LIVE')).toBeInTheDocument();
    });

    it('should show LIVE badge when isTaskLive returns true', () => {
      vi.mocked(useTaskContext).mockReturnValue({
        isTaskLive: vi.fn((id: number | string) => id === 't1'),
      } as unknown as TaskContextValue);

      render(<TaskRow {...defaultProps} />);

      expect(screen.getByText('LIVE')).toBeInTheDocument();
    });

    it('should prioritize LIVE over status badges', () => {
      render(<TaskRow {...defaultProps} task={{ ...mockTask, status: 'completed', is_live: true }} />);

      expect(screen.getByText('LIVE')).toBeInTheDocument();
      expect(screen.queryByText('Completed')).not.toBeInTheDocument();
    });
  });

  describe('Status Indicator', () => {
    it('should show empty circle icon when no conversations', () => {
      render(<TaskRow {...defaultProps} task={{ ...mockTask, conversation_count: 0, has_conversations: false }} />);

      expect(screen.getByTestId('icon-circle')).toBeInTheDocument();
    });

    it('should show filled dot when has conversations', () => {
      render(<TaskRow {...defaultProps} task={{ ...mockTask, conversation_count: 2 }} />);

      // Filled dot is a div with rounded-full class, not an icon
      const row = screen.getByTestId('task-row-t1');
      const filledDot = row.querySelector('.rounded-full.bg-primary');
      expect(filledDot).toBeInTheDocument();
    });
  });

  describe('Click Handlers', () => {
    it('should call onClick when task row is clicked', () => {
      render(<TaskRow {...defaultProps} />);

      fireEvent.click(screen.getByTestId('task-row-t1'));

      expect(defaultProps.onClick).toHaveBeenCalledTimes(1);
    });

    it('should call onDelete when delete button is clicked and confirmed', () => {
      window.confirm = vi.fn(() => true);
      render(<TaskRow {...defaultProps} />);

      const deleteButton = screen.getByTestId('icon-trash').closest('button')!;
      fireEvent.click(deleteButton);

      expect(defaultProps.onDelete).toHaveBeenCalled();
    });

    it('should not call onDelete when delete is cancelled', () => {
      window.confirm = vi.fn(() => false);
      render(<TaskRow {...defaultProps} />);

      const deleteButton = screen.getByTestId('icon-trash').closest('button')!;
      fireEvent.click(deleteButton);

      expect(defaultProps.onDelete).not.toHaveBeenCalled();
    });

    it('should stop propagation when delete button is clicked', () => {
      window.confirm = vi.fn(() => true);
      render(<TaskRow {...defaultProps} />);

      const deleteButton = screen.getByTestId('icon-trash').closest('button')!;
      fireEvent.click(deleteButton);

      // onClick should not be called because stopPropagation is called
      expect(defaultProps.onClick).not.toHaveBeenCalled();
    });

    it('should call onComplete when complete button is clicked and confirmed', () => {
      window.confirm = vi.fn(() => true);
      render(<TaskRow {...defaultProps} />);

      const completeButton = screen.getByTestId('icon-check-circle').closest('button')!;
      fireEvent.click(completeButton);

      expect(defaultProps.onComplete).toHaveBeenCalled();
    });

    it('should not render complete button when onComplete is not provided', () => {
      render(<TaskRow {...defaultProps} onComplete={undefined} />);

      expect(screen.queryByTestId('icon-check-circle')).not.toBeInTheDocument();
    });
  });

  describe('Project Display (showProject=true)', () => {
    it('should show project name when showProject is true and project provided', () => {
      render(
        <TaskRow
          {...defaultProps}
          showProject={true}
          project={{ name: 'My Project' }}
        />
      );

      expect(screen.getByText('My Project')).toBeInTheDocument();
    });

    it('should show task.project_name when showProject is true', () => {
      render(
        <TaskRow
          {...defaultProps}
          showProject={true}
          task={{ ...mockTask, project_name: 'Task Project' }}
        />
      );

      expect(screen.getByText('Task Project')).toBeInTheDocument();
    });
  });

  describe('Time Display', () => {
    it('should show relative time for recent tasks', () => {
      const recentTask = {
        ...mockTask,
        updated_at: new Date().toISOString(),
      };

      render(<TaskRow {...defaultProps} task={recentTask} />);

      expect(screen.getByText('Just now')).toBeInTheDocument();
    });

    it('should show minutes ago for tasks updated minutes ago', () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const task = { ...mockTask, updated_at: fiveMinutesAgo };

      render(<TaskRow {...defaultProps} task={task} />);

      expect(screen.getByText('5m ago')).toBeInTheDocument();
    });

    it('should show hours ago for tasks updated hours ago', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const task = { ...mockTask, updated_at: twoHoursAgo };

      render(<TaskRow {...defaultProps} task={task} />);

      expect(screen.getByText('2h ago')).toBeInTheDocument();
    });

    it('should show days ago for tasks updated days ago', () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const task = { ...mockTask, updated_at: threeDaysAgo };

      render(<TaskRow {...defaultProps} task={task} />);

      expect(screen.getByText('3d ago')).toBeInTheDocument();
    });
  });

  describe('Live Task Styling', () => {
    it('should have live background styling when task is live', () => {
      render(<TaskRow {...defaultProps} task={{ ...mockTask, is_live: true }} />);

      const row = screen.getByTestId('task-row-t1');
      expect(row.className).toContain('bg-red-500/5');
    });
  });
});
