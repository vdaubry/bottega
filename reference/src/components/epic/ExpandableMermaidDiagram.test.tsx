import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: vi.fn() },
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleTheme: vi.fn() }),
}));

import mermaid from 'mermaid';
import ExpandableMermaidDiagram from './ExpandableMermaidDiagram';

const SOURCE = 'flowchart LR\n  Importer --> Queue';
const SVG = '<svg data-testid="rendered-svg" viewBox="0 0 1962 1337" width="100%"></svg>';
const AFFORDANCE = 'Open the diagram in the full-screen viewer';

describe('ExpandableMermaidDiagram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mermaid.render).mockResolvedValue({ svg: SVG } as never);
  });

  it('renders the thumbnail with the affordance, and no dialog', async () => {
    render(<ExpandableMermaidDiagram source={SOURCE} />);

    await waitFor(() => expect(screen.getByTestId('rendered-svg')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: AFFORDANCE })).toBeInTheDocument();
    expect(screen.getByText('Open full size')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the viewer on the same source, and Close removes it', async () => {
    render(<ExpandableMermaidDiagram source={SOURCE} />);
    await waitFor(() => expect(screen.getByTestId('rendered-svg')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: AFFORDANCE }));

    expect(await screen.findByRole('dialog', { name: 'Diagram viewer' })).toBeInTheDocument();
    // Thumbnail + viewer: two renders of the one source.
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    expect(vi.mocked(mermaid.render).mock.calls[1]![1]).toBe(SOURCE);
    await waitFor(() => expect(screen.getAllByTestId('rendered-svg')).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getAllByTestId('rendered-svg')).toHaveLength(1);
  });

  it('keeps the affordance when the thumbnail failed to render', async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error('Parse error on line 2'));

    render(<ExpandableMermaidDiagram source={SOURCE} />);

    await waitFor(() => expect(screen.getByText('Diagram failed to render')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: AFFORDANCE })).toBeInTheDocument();
  });
});
