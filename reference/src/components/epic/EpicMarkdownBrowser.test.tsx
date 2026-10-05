import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mermaid itself is exercised by MermaidDiagram.test and the viewer by
// DiagramModal.test; here the question is only whether a fence in a DOCUMENT
// is routed to a diagram rather than a code block. Stubbing the affordance —
// not MermaidDiagram — keeps that assertion meaningful and keeps `mermaid`
// (reached through DiagramModal) out of this test entirely.
vi.mock('./ExpandableMermaidDiagram', () => ({
  default: ({ source }: { source: string }) => <div data-testid="mermaid">{source}</div>,
}));

import EpicMarkdownBrowser from './EpicMarkdownBrowser';

function doc(name: string) {
  return { name, size: 10, mimeType: 'text/markdown', modifiedAtMs: 1 };
}

const loadFile = vi.fn<(filename: string) => Promise<string>>();

function renderBrowser(files: ReturnType<typeof doc>[], emptyNote = 'Nothing written yet.') {
  return render(<EpicMarkdownBrowser files={files} loadFile={loadFile} emptyNote={emptyNote} />);
}

beforeEach(() => vi.clearAllMocks());

describe('EpicMarkdownBrowser', () => {
  it('shows the empty note and loads nothing when there are no files', () => {
    renderBrowser([], 'No architecture document yet.');

    expect(screen.getByText('No architecture document yet.')).toBeInTheDocument();
    expect(loadFile).not.toHaveBeenCalled();
  });

  it('opens the first file without being asked', async () => {
    loadFile.mockResolvedValue('# Master\n\nOverview.');

    renderBrowser([doc('00-master.md'), doc('01-data-model.md')]);

    await waitFor(() => expect(loadFile).toHaveBeenCalledWith('00-master.md'));
    expect(await screen.findByRole('heading', { name: 'Master' })).toBeInTheDocument();
    expect(loadFile).toHaveBeenCalledTimes(1);
  });

  it('renders a mermaid fence as a diagram, and other fences as code', async () => {
    loadFile.mockResolvedValue('```mermaid\nflowchart LR\n  A-->B\n```\n\n```ts\nconst x = 1;\n```');

    renderBrowser([doc('architecture.md')]);

    const diagram = await screen.findByTestId('mermaid');
    expect(diagram).toHaveTextContent('flowchart LR');
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
    expect(screen.getAllByTestId('mermaid')).toHaveLength(1);
  });

  it('switches files on click and caches what it already read', async () => {
    loadFile.mockResolvedValueOnce('# Master').mockResolvedValueOnce('# Data model');

    renderBrowser([doc('00-master.md'), doc('01-data-model.md')]);
    await screen.findByRole('heading', { name: 'Master' });

    fireEvent.click(screen.getByRole('button', { name: '01-data-model.md' }));
    await screen.findByRole('heading', { name: 'Data model' });

    fireEvent.click(screen.getByRole('button', { name: '00-master.md' }));
    await screen.findByRole('heading', { name: 'Master' });
    expect(loadFile).toHaveBeenCalledTimes(2);
  });

  it('reports a file it could not read instead of rendering nothing', async () => {
    loadFile.mockRejectedValue(new Error('HTTP 404'));

    renderBrowser([doc('01-gone.md')]);

    expect(await screen.findByText(/Could not read 01-gone.md/)).toBeInTheDocument();
  });
});
