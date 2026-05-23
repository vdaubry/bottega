import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ViewToggle, { type DashboardViewMode } from './ViewToggle';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  LayoutGrid: () => <span data-testid="icon-layout-grid" />,
  Clock: () => <span data-testid="icon-clock" />,
}));

describe('ViewToggle Component', () => {
  const defaultProps = {
    viewMode: 'project' as DashboardViewMode,
    onViewModeChange: vi.fn(),
    inProgressCount: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render both view mode buttons', () => {
      render(<ViewToggle {...defaultProps} />);

      expect(screen.getByText('By Project')).toBeInTheDocument();
      expect(screen.getByText('In Progress')).toBeInTheDocument();
    });

    it('should render icons for each button', () => {
      render(<ViewToggle {...defaultProps} />);

      expect(screen.getByTestId('icon-layout-grid')).toBeInTheDocument();
      expect(screen.getByTestId('icon-clock')).toBeInTheDocument();
    });
  });

  describe('Active State', () => {
    it('should style project button as active when viewMode is project', () => {
      render(<ViewToggle {...defaultProps} viewMode="project" />);

      const projectButton = screen.getByText('By Project').closest('button');
      expect(projectButton?.className).toContain('bg-background');
      expect(projectButton?.className).toContain('shadow-sm');
    });

    it('should style in-progress button as active when viewMode is in_progress', () => {
      render(<ViewToggle {...defaultProps} viewMode="in_progress" />);

      const inProgressButton = screen.getByText('In Progress').closest('button');
      expect(inProgressButton?.className).toContain('bg-background');
      expect(inProgressButton?.className).toContain('shadow-sm');
    });

    it('should style inactive button differently', () => {
      render(<ViewToggle {...defaultProps} viewMode="project" />);

      const inProgressButton = screen.getByText('In Progress').closest('button');
      expect(inProgressButton?.className).toContain('text-muted-foreground');
      expect(inProgressButton?.className).not.toContain('shadow-sm');
    });
  });

  describe('Click Handlers', () => {
    it('should call onViewModeChange with project when project button is clicked', () => {
      render(<ViewToggle {...defaultProps} viewMode="in_progress" />);

      fireEvent.click(screen.getByText('By Project'));

      expect(defaultProps.onViewModeChange).toHaveBeenCalledWith('project');
      expect(defaultProps.onViewModeChange).toHaveBeenCalledTimes(1);
    });

    it('should call onViewModeChange with in_progress when in-progress button is clicked', () => {
      render(<ViewToggle {...defaultProps} viewMode="project" />);

      fireEvent.click(screen.getByText('In Progress'));

      expect(defaultProps.onViewModeChange).toHaveBeenCalledWith('in_progress');
      expect(defaultProps.onViewModeChange).toHaveBeenCalledTimes(1);
    });
  });

  describe('In Progress Count Badge', () => {
    it('should not show count badge when inProgressCount is 0', () => {
      render(<ViewToggle {...defaultProps} inProgressCount={0} />);

      expect(screen.queryByText('0')).not.toBeInTheDocument();
    });

    it('should show count badge when inProgressCount is greater than 0', () => {
      render(<ViewToggle {...defaultProps} inProgressCount={5} />);

      expect(screen.getByText('5')).toBeInTheDocument();
    });

    it('should style the count badge with yellow colors', () => {
      render(<ViewToggle {...defaultProps} inProgressCount={3} />);

      const badge = screen.getByText('3');
      expect(badge.className).toContain('bg-yellow-500');
      expect(badge.className).toContain('text-yellow-600');
    });
  });
});
