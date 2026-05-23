import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import EmptyColumnIllustration from './EmptyColumnIllustration';

describe('EmptyColumnIllustration Component', () => {
  describe('Pending Status', () => {
    it('should render pending illustration with correct title', () => {
      render(<EmptyColumnIllustration status="pending" />);

      expect(screen.getByText('No pending tasks')).toBeInTheDocument();
    });

    it('should render pending illustration with correct subtitle', () => {
      render(<EmptyColumnIllustration status="pending" />);

      expect(screen.getByText('All clear! Add new tasks to get started.')).toBeInTheDocument();
    });
  });

  describe('In Progress Status', () => {
    it('should render in_progress illustration with correct title', () => {
      render(<EmptyColumnIllustration status="in_progress" />);

      expect(screen.getByText('No tasks in progress')).toBeInTheDocument();
    });

    it('should render in_progress illustration with correct subtitle', () => {
      render(<EmptyColumnIllustration status="in_progress" />);

      expect(screen.getByText('Pick a task to start working on.')).toBeInTheDocument();
    });
  });

  describe('Completed Status', () => {
    it('should render completed illustration with correct title', () => {
      render(<EmptyColumnIllustration status="completed" />);

      expect(screen.getByText('No completed tasks')).toBeInTheDocument();
    });

    it('should render completed illustration with correct subtitle', () => {
      render(<EmptyColumnIllustration status="completed" />);

      expect(screen.getByText('Finished tasks will appear here.')).toBeInTheDocument();
    });
  });

  describe('Fallback Behavior', () => {
    it('should fallback to pending illustration for unknown status', () => {
      render(<EmptyColumnIllustration status={'unknown_status' as never} />);

      expect(screen.getByText('No pending tasks')).toBeInTheDocument();
    });

    it('should fallback to pending illustration when status is undefined', () => {
      render(<EmptyColumnIllustration />);

      expect(screen.getByText('No pending tasks')).toBeInTheDocument();
    });
  });

  describe('SVG Illustration', () => {
    it('should render an SVG element', () => {
      const { container } = render(<EmptyColumnIllustration status="pending" />);

      const svg = container.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('should render different SVG for each status', () => {
      const { container: pendingContainer } = render(<EmptyColumnIllustration status="pending" />);
      const { container: inProgressContainer } = render(<EmptyColumnIllustration status="in_progress" />);
      const { container: completedContainer } = render(<EmptyColumnIllustration status="completed" />);

      // Each status has different SVG content
      const pendingSvg = pendingContainer.querySelector('svg');
      const inProgressSvg = inProgressContainer.querySelector('svg');
      const completedSvg = completedContainer.querySelector('svg');

      expect(pendingSvg).toBeInTheDocument();
      expect(inProgressSvg).toBeInTheDocument();
      expect(completedSvg).toBeInTheDocument();
    });
  });

  describe('Custom ClassName', () => {
    it('should apply custom className to container', () => {
      const { container } = render(
        <EmptyColumnIllustration status="pending" className="custom-class" />
      );

      const wrapper = container.firstChild as HTMLElement | null;
      expect(wrapper?.className).toContain('custom-class');
    });
  });
});
