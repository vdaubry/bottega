import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BoardTaskCard, { type BoardTaskCardProps } from './BoardTaskCard';
import type { TaskRow } from '../../../shared/types/db';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  MessageSquare: () => <span data-testid="icon-message-square" />,
  FileText: () => <span data-testid="icon-file-text" />,
  Pencil: () => <span data-testid="icon-pencil" />,
}));

const asTask = <T extends Partial<TaskRow>>(t: T): TaskRow => t as unknown as TaskRow;

describe('BoardTaskCard Component', () => {
  const mockTask = asTask({
    id: 't1' as unknown as number,
    title: 'Test Task',
  });

  const defaultProps: BoardTaskCardProps = {
    task: mockTask,
    isLive: false,
    conversationCount: 0,
    docPreview: '',
    onClick: vi.fn(),
    onEditClick: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render task title', () => {
      render(<BoardTaskCard {...defaultProps} />);

      expect(screen.getByText('Test Task')).toBeInTheDocument();
    });

    it('should render fallback title when title is missing', () => {
      render(<BoardTaskCard {...defaultProps} task={asTask({ id: 't1' as unknown as number })} />);

      expect(screen.getByText('Task t1')).toBeInTheDocument();
    });

    it('should render with correct data-testid', () => {
      render(<BoardTaskCard {...defaultProps} />);

      expect(screen.getByTestId('board-task-card-t1')).toBeInTheDocument();
    });
  });

  describe('Live Indicator', () => {
    it('should show live indicator when isLive is true', () => {
      render(<BoardTaskCard {...defaultProps} isLive={true} />);

      // Live indicator has a pulsing animation
      const card = screen.getByTestId('board-task-card-t1');
      const pulsingElement = card.querySelector('.animate-ping');
      expect(pulsingElement).toBeInTheDocument();
    });

    it('should not show live indicator when isLive is false', () => {
      render(<BoardTaskCard {...defaultProps} isLive={false} />);

      const card = screen.getByTestId('board-task-card-t1');
      const pulsingElement = card.querySelector('.animate-ping');
      expect(pulsingElement).not.toBeInTheDocument();
    });

    it('should apply live border styling when isLive is true', () => {
      render(<BoardTaskCard {...defaultProps} isLive={true} />);

      const card = screen.getByTestId('board-task-card-t1');
      expect(card.className).toContain('border-red-500');
    });
  });

  describe('Conversation Count', () => {
    it('should not show conversation count when count is 0', () => {
      render(<BoardTaskCard {...defaultProps} conversationCount={0} />);

      expect(screen.queryByText(/conversation/)).not.toBeInTheDocument();
    });

    it('should show singular conversation text for count of 1', () => {
      render(<BoardTaskCard {...defaultProps} conversationCount={1} />);

      expect(screen.getByText('1 conversation')).toBeInTheDocument();
    });

    it('should show plural conversations text for count greater than 1', () => {
      render(<BoardTaskCard {...defaultProps} conversationCount={3} />);

      expect(screen.getByText('3 conversations')).toBeInTheDocument();
    });

    it('should show message icon when conversation count is shown', () => {
      render(<BoardTaskCard {...defaultProps} conversationCount={2} />);

      expect(screen.getByTestId('icon-message-square')).toBeInTheDocument();
    });
  });

  describe('Documentation Preview', () => {
    it('should not show preview when docPreview is empty', () => {
      render(<BoardTaskCard {...defaultProps} docPreview="" />);

      expect(screen.queryByTestId('icon-file-text')).not.toBeInTheDocument();
    });

    it('should show preview text when docPreview is provided', () => {
      render(<BoardTaskCard {...defaultProps} docPreview="This is documentation" />);

      expect(screen.getByText('This is documentation')).toBeInTheDocument();
      expect(screen.getByTestId('icon-file-text')).toBeInTheDocument();
    });

    it('should strip markdown formatting from preview', () => {
      render(<BoardTaskCard {...defaultProps} docPreview="This is **bold** text" />);

      expect(screen.getByText('This is bold text')).toBeInTheDocument();
    });

    it('should truncate long preview text with ellipsis', () => {
      const longText = 'A'.repeat(100);
      render(<BoardTaskCard {...defaultProps} docPreview={longText} />);

      const previewText = screen.getByText(/A+\.\.\./);
      expect(previewText).toBeInTheDocument();
    });

    it('should remove markdown headers', () => {
      render(<BoardTaskCard {...defaultProps} docPreview="# Task Documentation" />);

      expect(screen.getByText('Task Documentation')).toBeInTheDocument();
    });

    it('should remove code blocks', () => {
      render(<BoardTaskCard {...defaultProps} docPreview="Before ```code``` after" />);

      expect(screen.getByText('Before after')).toBeInTheDocument();
    });

    it('should preserve link text but remove URL', () => {
      render(<BoardTaskCard {...defaultProps} docPreview="Click [here](https://example.com)" />);

      expect(screen.getByText('Click here')).toBeInTheDocument();
    });
  });

  describe('Click Handlers', () => {
    it('should call onClick with task when card is clicked', () => {
      render(<BoardTaskCard {...defaultProps} />);

      fireEvent.click(screen.getByTestId('board-task-card-t1'));

      expect(defaultProps.onClick).toHaveBeenCalledWith(mockTask);
      expect(defaultProps.onClick).toHaveBeenCalledTimes(1);
    });

    it('should call onEditClick with task when edit button is clicked', () => {
      render(<BoardTaskCard {...defaultProps} />);

      const editButton = screen.getByTestId('icon-pencil').closest('button')!;
      fireEvent.click(editButton);

      expect(defaultProps.onEditClick).toHaveBeenCalledWith(mockTask);
    });

    it('should stop propagation on edit click', () => {
      render(<BoardTaskCard {...defaultProps} />);

      const editButton = screen.getByTestId('icon-pencil').closest('button')!;
      fireEvent.click(editButton);

      // onClick should not be called because stopPropagation is called
      expect(defaultProps.onClick).not.toHaveBeenCalled();
    });
  });

  describe('Keyboard Navigation', () => {
    it('should call onClick when Enter key is pressed', () => {
      render(<BoardTaskCard {...defaultProps} />);

      const card = screen.getByTestId('board-task-card-t1');
      fireEvent.keyDown(card, { key: 'Enter' });

      expect(defaultProps.onClick).toHaveBeenCalledWith(mockTask);
    });

    it('should call onClick when Space key is pressed', () => {
      render(<BoardTaskCard {...defaultProps} />);

      const card = screen.getByTestId('board-task-card-t1');
      fireEvent.keyDown(card, { key: ' ' });

      expect(defaultProps.onClick).toHaveBeenCalledWith(mockTask);
    });

    it('should not call onClick for other keys', () => {
      render(<BoardTaskCard {...defaultProps} />);

      const card = screen.getByTestId('board-task-card-t1');
      fireEvent.keyDown(card, { key: 'Tab' });

      expect(defaultProps.onClick).not.toHaveBeenCalled();
    });
  });

  describe('Accessibility', () => {
    it('should have role="button"', () => {
      render(<BoardTaskCard {...defaultProps} />);

      const card = screen.getByTestId('board-task-card-t1');
      expect(card).toHaveAttribute('role', 'button');
    });

    it('should have tabIndex=0 for keyboard focus', () => {
      render(<BoardTaskCard {...defaultProps} />);

      const card = screen.getByTestId('board-task-card-t1');
      expect(card).toHaveAttribute('tabIndex', '0');
    });
  });
});
