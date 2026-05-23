import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import BoardColumn, { type BoardColumnProps } from './BoardColumn';
import type { TaskRow } from '../../../shared/types/db';

// Mock BoardTaskCard component
vi.mock('./BoardTaskCard', () => ({
  default: ({
    task,
    isLive,
    conversationCount,
    onClick,
    onEditClick,
  }: {
    task: TaskRow;
    isLive?: boolean;
    conversationCount?: number;
    onClick?: (task: TaskRow) => void;
    onEditClick?: (task: TaskRow) => void;
  }) => (
    <div data-testid={`task-card-${task.id}`}>
      <span data-testid="task-title">{task.title}</span>
      {isLive && <span data-testid="live-indicator">LIVE</span>}
      <span data-testid="conv-count">{conversationCount}</span>
      <button data-testid={`click-${task.id}`} onClick={() => onClick?.(task)}>Click</button>
      <button data-testid={`edit-${task.id}`} onClick={() => onEditClick?.(task)}>Edit</button>
    </div>
  ),
}));

// Mock EmptyColumnIllustration component
vi.mock('./EmptyColumnIllustration', () => ({
  default: ({ status }: { status: string }) => (
    <div data-testid={`empty-illustration-${status}`}>Empty {status}</div>
  ),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Circle: () => <span data-testid="icon-circle" />,
  Loader2: () => <span data-testid="icon-loader" />,
  CheckCircle2: () => <span data-testid="icon-check-circle" />,
  Eye: () => <span data-testid="icon-eye" />,
}));

describe('BoardColumn Component', () => {
  const mockTasks = [
    { id: 't1', title: 'Task 1' },
    { id: 't2', title: 'Task 2' },
    { id: 't3', title: 'Task 3' },
  ] as unknown as TaskRow[];

  const defaultProps: BoardColumnProps = {
    status: 'pending',
    tasks: mockTasks,
    taskDocs: {},
    taskConversationCounts: {},
    isTaskLive: vi.fn(() => false),
    onTaskClick: vi.fn(),
    onTaskEdit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render with correct data-testid for pending status', () => {
      render(<BoardColumn {...defaultProps} status="pending" />);

      expect(screen.getByTestId('board-column-pending')).toBeInTheDocument();
    });

    it('should render with correct data-testid for in_progress status', () => {
      render(<BoardColumn {...defaultProps} status="in_progress" />);

      expect(screen.getByTestId('board-column-in_progress')).toBeInTheDocument();
    });

    it('should render with correct data-testid for in_review status', () => {
      render(<BoardColumn {...defaultProps} status="in_review" />);

      expect(screen.getByTestId('board-column-in_review')).toBeInTheDocument();
    });

    it('should render with correct data-testid for completed status', () => {
      render(<BoardColumn {...defaultProps} status="completed" />);

      expect(screen.getByTestId('board-column-completed')).toBeInTheDocument();
    });
  });

  describe('Status Header', () => {
    it('should display Pending title for pending status', () => {
      render(<BoardColumn {...defaultProps} status="pending" />);

      expect(screen.getByText('Pending')).toBeInTheDocument();
    });

    it('should display In Progress title for in_progress status', () => {
      render(<BoardColumn {...defaultProps} status="in_progress" />);

      expect(screen.getByText('In Progress')).toBeInTheDocument();
    });

    it('should display In Review title for in_review status', () => {
      render(<BoardColumn {...defaultProps} status="in_review" />);

      expect(screen.getByText('In Review')).toBeInTheDocument();
    });

    it('should display Completed title for completed status', () => {
      render(<BoardColumn {...defaultProps} status="completed" />);

      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('should fallback to Pending for unknown status', () => {
      render(<BoardColumn {...defaultProps} status={'unknown' as never} />);

      expect(screen.getByText('Pending')).toBeInTheDocument();
    });
  });

  describe('Task Count', () => {
    it('should display task count in header', () => {
      render(<BoardColumn {...defaultProps} tasks={mockTasks} />);

      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('should display 0 for empty task list', () => {
      render(<BoardColumn {...defaultProps} tasks={[]} />);

      expect(screen.getByText('0')).toBeInTheDocument();
    });
  });

  describe('Task Cards', () => {
    it('should render all task cards', () => {
      render(<BoardColumn {...defaultProps} />);

      expect(screen.getByTestId('task-card-t1')).toBeInTheDocument();
      expect(screen.getByTestId('task-card-t2')).toBeInTheDocument();
      expect(screen.getByTestId('task-card-t3')).toBeInTheDocument();
    });

    it('should pass isLive status to task cards', () => {
      const isTaskLive = vi.fn((id) => id === 't2');
      render(<BoardColumn {...defaultProps} isTaskLive={isTaskLive} />);

      expect(screen.getByTestId('task-card-t2').querySelector('[data-testid="live-indicator"]')).toBeInTheDocument();
      expect(screen.getByTestId('task-card-t1').querySelector('[data-testid="live-indicator"]')).not.toBeInTheDocument();
    });

    it('should pass conversation count from taskConversationCounts', () => {
      const taskConversationCounts = { t1: 5, t2: 3 };
      render(<BoardColumn {...defaultProps} taskConversationCounts={taskConversationCounts} />);

      expect(screen.getByTestId('task-card-t1').querySelector('[data-testid="conv-count"]')?.textContent).toBe('5');
      expect(screen.getByTestId('task-card-t2').querySelector('[data-testid="conv-count"]')?.textContent).toBe('3');
    });

    it('should fallback to task.conversation_count if not in taskConversationCounts', () => {
      const tasks = [{ id: 't1', title: 'Task 1', conversation_count: 7 }] as unknown as TaskRow[];
      render(<BoardColumn {...defaultProps} tasks={tasks} taskConversationCounts={{}} />);

      expect(screen.getByTestId('task-card-t1').querySelector('[data-testid="conv-count"]')?.textContent).toBe('7');
    });
  });

  describe('Empty State', () => {
    it('should show empty illustration when no tasks', () => {
      render(<BoardColumn {...defaultProps} tasks={[]} status="pending" />);

      expect(screen.getByTestId('empty-illustration-pending')).toBeInTheDocument();
    });

    it('should not show empty illustration when tasks exist', () => {
      render(<BoardColumn {...defaultProps} />);

      expect(screen.queryByTestId('empty-illustration-pending')).not.toBeInTheDocument();
    });

    it('should show correct status in empty illustration', () => {
      render(<BoardColumn {...defaultProps} tasks={[]} status="in_progress" />);

      expect(screen.getByTestId('empty-illustration-in_progress')).toBeInTheDocument();
    });
  });

  describe('Status Icons', () => {
    it('should show Circle icon for pending status', () => {
      render(<BoardColumn {...defaultProps} status="pending" />);

      expect(screen.getByTestId('icon-circle')).toBeInTheDocument();
    });

    it('should show Loader2 icon for in_progress status', () => {
      render(<BoardColumn {...defaultProps} status="in_progress" />);

      expect(screen.getByTestId('icon-loader')).toBeInTheDocument();
    });

    it('should show Eye icon for in_review status', () => {
      render(<BoardColumn {...defaultProps} status="in_review" />);

      expect(screen.getByTestId('icon-eye')).toBeInTheDocument();
    });

    it('should show CheckCircle2 icon for completed status', () => {
      render(<BoardColumn {...defaultProps} status="completed" />);

      expect(screen.getByTestId('icon-check-circle')).toBeInTheDocument();
    });
  });

  describe('Click Handlers', () => {
    it('should pass onTaskClick to task cards', () => {
      render(<BoardColumn {...defaultProps} />);

      const clickButton = screen.getByTestId('click-t1');
      clickButton.click();

      expect(defaultProps.onTaskClick).toHaveBeenCalledWith(mockTasks[0]);
    });

    it('should pass onTaskEdit to task cards', () => {
      render(<BoardColumn {...defaultProps} />);

      const editButton = screen.getByTestId('edit-t2');
      editButton.click();

      expect(defaultProps.onTaskEdit).toHaveBeenCalledWith(mockTasks[1]);
    });
  });

  describe('Custom ClassName', () => {
    it('should apply custom className', () => {
      render(<BoardColumn {...defaultProps} className="custom-class" />);

      const column = screen.getByTestId('board-column-pending');
      expect(column.className).toContain('custom-class');
    });
  });
});
