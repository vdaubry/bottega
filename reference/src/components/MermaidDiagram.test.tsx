import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleTheme: vi.fn() }),
}));

import mermaid from 'mermaid';
import MermaidDiagram from './MermaidDiagram';

describe('MermaidDiagram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the SVG returned by mermaid', async () => {
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: '<svg data-testid="rendered-svg"></svg>',
    } as never);

    render(<MermaidDiagram source={'flowchart LR\n  A --> B'} />);

    await waitFor(() => {
      expect(screen.getByTestId('rendered-svg')).toBeInTheDocument();
    });
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', theme: 'default' }),
    );
  });

  it('shows an inline error card with the source when mermaid rejects (LLM output is untrusted)', async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error('Parse error on line 2'));

    render(<MermaidDiagram source={'not mermaid at all'} />);

    await waitFor(() => {
      expect(screen.getByText('Diagram failed to render')).toBeInTheDocument();
    });
    expect(screen.getByText('Parse error on line 2')).toBeInTheDocument();
    expect(screen.getByText('not mermaid at all')).toBeInTheDocument();
  });

  it('does not blame the source when the renderer chunk fails to load (stale build)', async () => {
    // Mermaid lazily imports its per-type renderers; a page held open across a
    // rebuild asks for a chunk URL that no longer exists.
    vi.mocked(mermaid.render).mockRejectedValue(
      new Error(
        'Failed to fetch dynamically imported module: ' +
          'https://example.test/node_modules/.vite/deps/flowDiagram-23GEKE2U-G342IMBX.js?v=a48b8fba',
      ),
    );

    render(<MermaidDiagram source={'flowchart LR\n  A --> B'} />);

    await waitFor(() => {
      expect(screen.getByText("Diagram couldn't load")).toBeInTheDocument();
    });
    // The old card would have printed the (perfectly valid) source as evidence.
    expect(screen.queryByText('Diagram failed to render')).not.toBeInTheDocument();
    expect(screen.queryByText('flowchart LR\n  A --> B')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload page/i })).toBeInTheDocument();
  });

  it('re-renders when the source changes', async () => {
    vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg></svg>' } as never);

    const { rerender } = render(<MermaidDiagram source="flowchart LR\n A --> B" />);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));

    rerender(<MermaidDiagram source="flowchart LR\n A --> C" />);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    expect(vi.mocked(mermaid.render).mock.calls[1]![1]).toContain('A --> C');
  });
});
