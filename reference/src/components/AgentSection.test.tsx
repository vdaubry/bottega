import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AgentSection from './AgentSection';
import type { AgentRunRow } from '../../shared/types/db';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Play: () => <span data-testid="icon-play" />,
  Check: () => <span data-testid="icon-check" />,
  Loader2: () => <span data-testid="icon-loader" />,
  FileText: () => <span data-testid="icon-file-text" />,
  Code: () => <span data-testid="icon-code" />,
  CheckCircle: () => <span data-testid="icon-check-circle" />,
  MessageCircle: () => <span data-testid="icon-message-circle" />,
  AlertCircle: () => <span data-testid="icon-alert-circle" />,
  GitPullRequest: () => <span data-testid="icon-git-pull-request" />,
  Sparkles: () => <span data-testid="icon-sparkles" />,
  Zap: () => <span data-testid="icon-zap" />,
}));

// Mock UI components
vi.mock('./ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    className,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    className?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  ),
}));

vi.mock('../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Tests use partial agent-run shapes (and string-coerced ids) for readability;
// cast through unknown so the strict AgentRunRow shape doesn't fight us.
const asAgentRun = (run: Record<string, unknown>): AgentRunRow => run as unknown as AgentRunRow;

describe('AgentSection', () => {
  const defaultProps = {
    agentRuns: [],
    isLoading: false,
    onRunAgent: vi.fn(),
    onResumeAgent: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Agent Types Rendering', () => {
    it('should render all five agent types', () => {
      render(<AgentSection {...defaultProps} />);

      expect(screen.getByText('Planification')).toBeInTheDocument();
      expect(screen.getByText('Implementation')).toBeInTheDocument();
      expect(screen.getByText('Review')).toBeInTheDocument();
      expect(screen.getByText('Refinement')).toBeInTheDocument();
      expect(screen.getByText('PR')).toBeInTheDocument();
    });

    it('should show correct descriptions for each agent', () => {
      render(<AgentSection {...defaultProps} />);

      expect(screen.getByText('Create a detailed implementation plan')).toBeInTheDocument();
      expect(screen.getByText('Implement the next phase from the plan')).toBeInTheDocument();
      expect(screen.getByText('Review implementation and run tests')).toBeInTheDocument();
      expect(screen.getByText('Simplify code and fix security issues')).toBeInTheDocument();
      expect(screen.getByText('Create PR, monitor CI, fix failures')).toBeInTheDocument();
    });

    it('should render icons for each agent type', () => {
      render(<AgentSection {...defaultProps} />);

      expect(screen.getByTestId('icon-file-text')).toBeInTheDocument();
      expect(screen.getByTestId('icon-code')).toBeInTheDocument();
      expect(screen.getByTestId('icon-check-circle')).toBeInTheDocument();
      expect(screen.getByTestId('icon-sparkles')).toBeInTheDocument();
      expect(screen.getByTestId('icon-git-pull-request')).toBeInTheDocument();
    });

    it('should hide the YOLO agent when yoloMode is false (default)', () => {
      render(<AgentSection {...defaultProps} />);
      expect(screen.queryByText('YOLO')).not.toBeInTheDocument();
    });

    it('should render only the YOLO agent when yoloMode is true', () => {
      render(<AgentSection {...defaultProps} yoloMode={true} />);

      expect(screen.getByText('YOLO')).toBeInTheDocument();
      expect(screen.queryByText('Planification')).not.toBeInTheDocument();
      expect(screen.queryByText('Implementation')).not.toBeInTheDocument();
      expect(screen.queryByText('Review')).not.toBeInTheDocument();
      expect(screen.queryByText('Refinement')).not.toBeInTheDocument();
      expect(screen.queryByText('PR')).not.toBeInTheDocument();
    });

    it('should invoke onRunAgent with "yolo" when the YOLO Run button is clicked', async () => {
      const onRunAgent = vi.fn();
      render(<AgentSection {...defaultProps} onRunAgent={onRunAgent} yoloMode={true} />);

      fireEvent.click(screen.getByText('Run'));

      await waitFor(() => {
        expect(onRunAgent).toHaveBeenCalledWith('yolo');
      });
    });

    it('should show the YOLO agent as Completed when its run status is completed', () => {
      render(
        <AgentSection
          {...defaultProps}
          yoloMode={true}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'yolo', status: 'completed' })]}
        />
      );
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });
  });

  describe('Running Planification Agent', () => {
    it('should call onRunAgent with planification type when Run button clicked', async () => {
      const onRunAgent = vi.fn();
      render(<AgentSection {...defaultProps} onRunAgent={onRunAgent} />);

      const runButtons = screen.getAllByText('Run');
      fireEvent.click(runButtons[0]!); // First Run button is for Planification

      await waitFor(() => {
        expect(onRunAgent).toHaveBeenCalledWith('planification');
      });
    });
  });

  describe('Running Implementation Agent', () => {
    it('should call onRunAgent with implementation type when Run button clicked', async () => {
      const onRunAgent = vi.fn();
      render(<AgentSection {...defaultProps} onRunAgent={onRunAgent} />);

      const runButtons = screen.getAllByText('Run');
      fireEvent.click(runButtons[1]!); // Second Run button is for Implementation

      await waitFor(() => {
        expect(onRunAgent).toHaveBeenCalledWith('implementation');
      });
    });
  });

  describe('Running Review Agent', () => {
    it('should call onRunAgent with review type when Run button clicked', async () => {
      const onRunAgent = vi.fn();
      render(<AgentSection {...defaultProps} onRunAgent={onRunAgent} />);

      const runButtons = screen.getAllByText('Run');
      fireEvent.click(runButtons[2]!); // Third Run button is for Review

      await waitFor(() => {
        expect(onRunAgent).toHaveBeenCalledWith('review');
      });
    });
  });

  describe('Agent Status Display', () => {
    it('should show Completed for a step based on its own run status, independent of other steps', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'implementation', status: 'completed' })]}
        />
      );

      // Only implementation has a completed run; review has no run yet, so it
      // is NOT shown as completed (each step is keyed to its own run status).
      const completedButtons = screen.getAllByText('Completed');
      expect(completedButtons.length).toBe(1);
    });

    it('keeps a finished step green while a later step runs (the regression)', () => {
      // The reported bug: review has finished but stays grey while refinement
      // runs, because completion used to be gated on the un-broadcast
      // workflow_complete flag. Now review reflects its own completed run.
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[
            asAgentRun({ id: 1, agent_type: 'review', status: 'completed' }),
            asAgentRun({ id: 2, agent_type: 'refinement', status: 'running' }),
          ]}
        />
      );

      expect(screen.getByText('Completed')).toBeInTheDocument(); // review
      expect(screen.getByText('Running')).toBeInTheDocument(); // refinement
    });

    it('should show Run button for a step that has no agent run yet', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'planification', status: 'completed' })]}
        />
      );

      // planification is completed; the other four steps have no runs → 4 Run buttons.
      expect(screen.getAllByText('Run')).toHaveLength(4);
    });

    it('should show Running status for running implementation agent', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'implementation', status: 'running' })]}
        />
      );

      expect(screen.getByText('Running')).toBeInTheDocument();
    });

    it('should show Running status for pending implementation agent', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'implementation', status: 'pending' })]}
        />
      );

      expect(screen.getByText('Running')).toBeInTheDocument();
    });

    it('should show Failed status for failed implementation agent', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'implementation', status: 'failed' })]}
        />
      );

      expect(screen.getByText('Failed')).toBeInTheDocument();
    });

    it('should show Completed status for completed planification agent', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'planification', status: 'completed' })]}
        />
      );

      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('should show Completed status for planification based on its agent run status', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'planification', status: 'completed' })]}
        />
      );

      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('should show Completed for every step that has a completed run', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[
            asAgentRun({ id: 1, agent_type: 'implementation', status: 'completed' }),
            asAgentRun({ id: 2, agent_type: 'review', status: 'completed' }),
            asAgentRun({ id: 3, agent_type: 'refinement', status: 'completed' }),
            asAgentRun({ id: 4, agent_type: 'pr', status: 'completed' }),
          ]}
        />
      );

      // implementation, review, refinement, pr each have a completed run.
      const completedButtons = screen.getAllByText('Completed');
      expect(completedButtons.length).toBe(4);
    });

    it('should show Run for steps without a completed run', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[
            asAgentRun({ id: 1, agent_type: 'implementation', status: 'completed' }),
            asAgentRun({ id: 2, agent_type: 'review', status: 'completed' }),
          ]}
        />
      );

      // implementation and review are completed; the rest have no run.
      const completedButtons = screen.getAllByText('Completed');
      expect(completedButtons.length).toBe(2); // implementation + review

      const runButtons = screen.getAllByText('Run');
      expect(runButtons.length).toBe(3); // planification + refinement + PR
    });

    it('should show Completed status for refinement when its run status is completed', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'refinement', status: 'completed' })]}
        />
      );

      const completedButtons = screen.getAllByText('Completed');
      expect(completedButtons.length).toBe(1);
    });

    it('should show Running status for running review agent', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'review', status: 'running' })]}
        />
      );

      expect(screen.getByText('Running')).toBeInTheDocument();
    });
  });

  describe('Resume Agent', () => {
    it('should call onResumeAgent when clicking conversation button', () => {
      const onResumeAgent = vi.fn();
      render(
        <AgentSection
          {...defaultProps}
          onResumeAgent={onResumeAgent}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'implementation', status: 'running', conversation_id: 'conv-123' })]}
        />
      );

      // Click the conversation (message) button
      fireEvent.click(screen.getByTestId('icon-message-circle').closest('button')!);

      expect(onResumeAgent).toHaveBeenCalledWith('conv-123');
    });

    it('should call onResumeAgent when clicking conversation button for completed agent', () => {
      const onResumeAgent = vi.fn();
      render(
        <AgentSection
          {...defaultProps}
          onResumeAgent={onResumeAgent}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'implementation', status: 'completed', conversation_id: 'conv-456' })]}
        />
      );

      // Click the conversation (message) button
      fireEvent.click(screen.getByTestId('icon-message-circle').closest('button')!);

      expect(onResumeAgent).toHaveBeenCalledWith('conv-456');
    });

    it('should show conversation button when agent has conversation_id', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'implementation', status: 'completed', conversation_id: 'conv-123' })]}
        />
      );

      expect(screen.getByTestId('icon-message-circle')).toBeInTheDocument();
    });

    it('should not show conversation button when agent has no conversation_id', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'implementation', status: 'completed' })]} // No conversation_id
        />
      );

      expect(screen.queryByTestId('icon-message-circle')).not.toBeInTheDocument();
    });

    it('should not call onRunAgent when clicking Running button (disabled)', () => {
      const onRunAgent = vi.fn();
      render(
        <AgentSection
          {...defaultProps}
          onRunAgent={onRunAgent}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'implementation', status: 'running', conversation_id: 'conv-123' })]}
        />
      );

      // Running button should be disabled
      fireEvent.click(screen.getByText('Running'));

      expect(onRunAgent).not.toHaveBeenCalled();
    });

    it('should call onRunAgent when clicking Completed button (starts new run)', async () => {
      const onRunAgent = vi.fn();
      render(
        <AgentSection
          {...defaultProps}
          onRunAgent={onRunAgent}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'planification', status: 'completed', conversation_id: 'conv-456' })]}
        />
      );

      // Click Completed button - should start new agent run (use planification for single Completed)
      fireEvent.click(screen.getByText('Completed'));

      await waitFor(() => {
        expect(onRunAgent).toHaveBeenCalledWith('planification');
      });
    });

    it('should call onRunAgent when clicking Failed button (starts new run)', async () => {
      const onRunAgent = vi.fn();
      render(
        <AgentSection
          {...defaultProps}
          onRunAgent={onRunAgent}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'implementation', status: 'failed', conversation_id: 'conv-789' })]}
        />
      );

      // Click Failed button - should start new agent run
      fireEvent.click(screen.getByText('Failed'));

      await waitFor(() => {
        expect(onRunAgent).toHaveBeenCalledWith('implementation');
      });
    });
  });

  describe('Loading State', () => {
    it('should show loading skeleton when isLoading is true', () => {
      render(<AgentSection {...defaultProps} isLoading={true} />);

      expect(screen.getByText('Agents')).toBeInTheDocument();
      // Should show loading skeleton instead of agent list
      expect(screen.queryByText('Planification')).not.toBeInTheDocument();
      expect(screen.queryByText('Implementation')).not.toBeInTheDocument();
      expect(screen.queryByText('Review')).not.toBeInTheDocument();
    });
  });

  describe('Button Disabled State', () => {
    it('should disable button while agent is starting', async () => {
      const onRunAgent = vi.fn(() => new Promise<void>(resolve => setTimeout(resolve, 100)));
      render(<AgentSection {...defaultProps} onRunAgent={onRunAgent} />);

      const runButtons = screen.getAllByText('Run');
      fireEvent.click(runButtons[0]!);

      // Button should show Starting... state
      await waitFor(() => {
        expect(screen.getByText('Starting...')).toBeInTheDocument();
      });
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should prevent double-clicking run button', async () => {
      let resolvePromise: ((value: void) => void) | undefined;
      const slowPromise = new Promise<void>(resolve => { resolvePromise = resolve; });
      const onRunAgent = vi.fn(() => slowPromise);

      render(<AgentSection {...defaultProps} onRunAgent={onRunAgent} />);

      const runButtons = screen.getAllByText('Run');

      // First click
      fireEvent.click(runButtons[0]!);

      // Try to click again while first is still processing
      fireEvent.click(runButtons[0]!);
      fireEvent.click(runButtons[0]!);

      // Should only have been called once due to internal guard
      expect(onRunAgent).toHaveBeenCalledTimes(1);

      // Cleanup: resolve the promise
      resolvePromise!();
    });

    it('should reset starting state after onRunAgent completes', async () => {
      const onRunAgent = vi.fn(() => Promise.resolve());
      render(<AgentSection {...defaultProps} onRunAgent={onRunAgent} />);

      const runButtons = screen.getAllByText('Run');
      fireEvent.click(runButtons[0]!);

      // Wait for the promise to resolve and state to reset
      await waitFor(() => {
        expect(screen.queryByText('Starting...')).not.toBeInTheDocument();
      });

      // Run button should be visible again
      expect(screen.getAllByText('Run')).toHaveLength(5);
    });

    it('should pass correct agent type to onRunAgent for all agent types', async () => {
      const onRunAgent = vi.fn(() => Promise.resolve());
      render(<AgentSection {...defaultProps} onRunAgent={onRunAgent} />);

      const runButtons = screen.getAllByText('Run');

      // Click all five buttons in sequence
      fireEvent.click(runButtons[0]!); // Planification
      await waitFor(() => expect(onRunAgent).toHaveBeenCalledWith('planification'));

      fireEvent.click(runButtons[1]!); // Implementation
      await waitFor(() => expect(onRunAgent).toHaveBeenCalledWith('implementation'));

      fireEvent.click(runButtons[2]!); // Review
      await waitFor(() => expect(onRunAgent).toHaveBeenCalledWith('review'));

      fireEvent.click(runButtons[3]!); // Refinement
      await waitFor(() => expect(onRunAgent).toHaveBeenCalledWith('refinement'));

      fireEvent.click(runButtons[4]!); // PR
      await waitFor(() => expect(onRunAgent).toHaveBeenCalledWith('pr'));
    });
  });

  describe('Multiple Agent Runs Display', () => {
    it('should show status for multiple agents at different states', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[
            asAgentRun({ id: 1, agent_type: 'planification', status: 'completed', conversation_id: 'conv-1' }),
            asAgentRun({ id: 2, agent_type: 'implementation', status: 'running', conversation_id: 'conv-2' }),
            // Review and PR have no run yet
          ]}
        />
      );

      // Should show Completed for planification
      expect(screen.getByText('Completed')).toBeInTheDocument();

      // Should show Running for implementation
      expect(screen.getByText('Running')).toBeInTheDocument();

      // Should show Run for review, refinement, and PR (no agent run exists)
      const runButtons = screen.getAllByText('Run');
      expect(runButtons).toHaveLength(3); // Review, Refinement, and PR should have Run buttons
    });

    it('should use the most recent agent run (highest id) when multiple exist for the same type', () => {
      // The implementation↔review loop produces several runs per type, and WS
      // updates append the newest to the end of the array. Selection must be by
      // id (newest run), not array position, so a re-run shows as Running again
      // rather than sticking on the older completed run.
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[
            asAgentRun({ id: 1, agent_type: 'planification', status: 'completed', conversation_id: 'conv-1' }),
            asAgentRun({ id: 2, agent_type: 'planification', status: 'running', conversation_id: 'conv-2' }),
          ]}
        />
      );

      // Newest run (id 2) is running → Running, not the older completed run.
      expect(screen.getByText('Running')).toBeInTheDocument();
      expect(screen.queryByText('Completed')).not.toBeInTheDocument();
    });
  });

  describe('Resume Agent with WebSocket Event Handling', () => {
    it('should not show conversation button when conversation_id is missing', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'implementation', status: 'running' })]} // No conversation_id
        />
      );

      // No conversation button should be shown
      expect(screen.queryByTestId('icon-message-circle')).not.toBeInTheDocument();
    });

    it('should not throw when onResumeAgent prop is not provided', () => {
      render(
        <AgentSection
          {...defaultProps}
          onResumeAgent={undefined}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'implementation', status: 'running', conversation_id: 'conv-123' })]}
        />
      );

      // Should not throw when clicking conversation button
      const conversationButton = screen.getByTestId('icon-message-circle').closest('button')!;
      fireEvent.click(conversationButton);
      // If we get here without error, the test passes
    });
  });

  describe('Agent Run Status Transitions', () => {
    it('should show Failed button for failed agent (allows retry)', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'implementation', status: 'failed', conversation_id: 'conv-123' })]}
        />
      );

      // Failed status shows Failed button which can be clicked to retry
      expect(screen.getByText('Failed')).toBeInTheDocument();
      // Planification, Review, Refinement, and PR should still show Run buttons
      const runButtons = screen.getAllByText('Run');
      expect(runButtons.length).toBe(4);
    });

    it('should show conversation button for failed agent with conversation_id', () => {
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'implementation', status: 'failed', conversation_id: 'conv-123' })]}
        />
      );

      // Should show conversation button to view what went wrong
      expect(screen.getByTestId('icon-message-circle')).toBeInTheDocument();
    });

    it('should handle agent run with no conversation_id gracefully', () => {
      // A completed run with no conversation_id still renders Completed.
      render(
        <AgentSection
          {...defaultProps}
          agentRuns={[asAgentRun({ id: 1, agent_type: 'planification', status: 'completed' })]} // No conversation_id
        />
      );

      // Should still show Completed button
      expect(screen.getByText('Completed')).toBeInTheDocument();
      // But no conversation button
      expect(screen.queryByTestId('icon-message-circle')).not.toBeInTheDocument();
    });
  });
});
