import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WorktreeSetupBanner from './WorktreeSetupBanner';

describe('WorktreeSetupBanner', () => {
  it('renders nothing for a ready worktree', () => {
    const { container } = render(
      <WorktreeSetupBanner state="ready" error={null} onRetry={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('explains that the worktree is being set up, with no actions', () => {
    render(<WorktreeSetupBanner state="provisioning" error={null} onRetry={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getByTestId('worktree-setup-provisioning')).toHaveTextContent(
      'Setting up the worktree',
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows why the setup failed, with Retry and Delete', async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn();
    render(
      <WorktreeSetupBanner
        state="failed"
        error={'git worktree add timed out after 600s\n\nBuilding assets…'}
        onRetry={onRetry}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByTestId('worktree-setup-failed')).toHaveTextContent('Building assets…');
    fireEvent.click(screen.getByRole('button', { name: /Retry setup/ }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: /Delete task/ }));
    expect(onDelete).toHaveBeenCalledOnce();
  });
});
